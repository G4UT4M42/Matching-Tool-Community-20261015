import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, lstat, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Document, MatchingState } from '../../core/types.js';
import { currencyPrecision, statementDate, statementMinor } from '../../import/statement-parser.js';
import { DocumentInputError, documentHash, inspectDocument, recognizeDocument, type RecognizedInvoice } from './recognition.js';
import { recordAudit } from '../../observability/audit.js';
import {checkedDocumentAmounts,type InvoiceDocumentType} from './amount-contract.js';
import { parseDocumentTable, tableDocumentId, type TableKind } from './tabular.js';

export interface Principal { subject: string; workspace_id: string; permissions?: unknown }
export interface ReviewFields { document_type?:InvoiceDocumentType; invoice_number?: string; supplier_name?: string; document_date?: string; total_amount_minor?: number; net_amount_minor?: number; vat_amount_minor?: number; currency_code?: string; payment_reference?: string; iban?: string; due_date?: string }
export type DocumentSourceKind='user-supplied'|'invoice-bot';
export interface DocumentRecord {
  id: string; workspace_id: string; owner_subject: string; filename: string; hash: string; mime: string;
  bytes: number; pages: number; status: 'review' | 'confirmed' | 'rejected' | 'archived';
  archived_from?: 'review' | 'confirmed' | 'rejected';
  fields: ReviewFields; recognition: RecognizedInvoice; source_id?: string; source_kind?:DocumentSourceKind; source_refs?:Array<{source_id:string;kind:DocumentSourceKind}>;
  history: Array<{ at: string; actor: string; action: string; fields?: ReviewFields }>;
  created_at: string;
}
type Index = { version: 1; records: DocumentRecord[] };
export interface DocumentServiceOptions {
  root: string;
  getState: () => MatchingState;
  persistAndActivate: (expectedState: MatchingState, nextState: MatchingState, actor: string) => void | Promise<void>;
  localLanguageDir?: string;
}
const problem = (code: string, message: string): never => { throw new DocumentInputError(code, message); };
const scope = (principal: Principal) => {
  if (!principal?.subject || !principal.workspace_id || !/^[\w.:-]{1,100}$/.test(principal.subject) || !/^[\w.:-]{1,100}$/.test(principal.workspace_id)) problem('AUTHENTICATION_REQUIRED', 'Authenticated workspace is required');
};
const cloneState = (state: MatchingState): MatchingState => ({ ...state, documents: new Map(state.documents), audit_events: [...state.audit_events] });
const now = () => new Date().toISOString();
const minorText = (value: number | undefined, currency: string | undefined): string | undefined => {
  if (value === undefined || !currency || !Number.isSafeInteger(value)) return undefined;
  const precision = currencyPrecision(currency); const scale = 10n ** BigInt(precision); const amount = BigInt(value);
  const absolute=amount<0n?-amount:amount,sign=amount<0n?'-':'';const whole = absolute / scale; const fraction = (absolute % scale).toString().padStart(precision, '0');
  return sign+(precision ? `${whole}.${fraction}` : String(whole));
};
const validFields = (input: Record<string, unknown>): ReviewFields => {
  const allowed = new Set(['invoice_number','supplier_name','document_date','total_amount','net_amount','vat_amount','currency_code','payment_reference','iban','due_date','document_type']);
  if (Object.keys(input).some(key => !allowed.has(key))) problem('INVALID_FIELDS', 'Unknown document field');
  const currency = input.currency_code;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new DocumentInputError('INVALID_CURRENCY', 'Select a currency');
  const req = (key: string): string => { const value = input[key]; if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new DocumentInputError('INVALID_FIELDS', `Enter ${key}`); return value.trim(); };
  const date = statementDate(req('document_date'));
  const total = statementMinor(req('total_amount'), currency);

  const net = input.net_amount === undefined || input.net_amount === '' ? undefined : statementMinor(input.net_amount, currency);
  const vat = input.vat_amount === undefined || input.vat_amount === '' ? undefined : statementMinor(input.vat_amount, currency);
  const documentType=checkedDocumentAmounts(input.document_type,total,net,vat);
  const optional = (key: string) => input[key] === undefined || input[key] === '' ? undefined : req(key);
  const dueDate = optional('due_date');
  return { ...(documentType==='credit_note'?{document_type:documentType}:{}),invoice_number: req('invoice_number'), supplier_name: req('supplier_name'), document_date: date, total_amount_minor: total, ...(net !== undefined ? { net_amount_minor: net } : {}), ...(vat !== undefined ? { vat_amount_minor: vat } : {}), currency_code: currency, ...(optional('payment_reference') ? { payment_reference: optional('payment_reference') } : {}), ...(optional('iban') ? { iban: optional('iban') } : {}), ...(dueDate ? {due_date: statementDate(dueDate)} : {}) };
};

export class CommunityDocumentService {
  private readonly root: string;
  private readonly blobs: string;
  private readonly indexPath: string;
  private busy: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: DocumentServiceOptions) {
    this.root = resolve(options.root);
    this.blobs = join(this.root, 'attachments');
    this.indexPath = join(this.root, 'document-index-v1.json');
  }
  private async lock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.busy.then(work, work);
    this.busy = next.catch(() => undefined);
    return next;
  }
  private async ensureRoot(): Promise<void> {
    let path = this.root;
    while (true) {
      try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) problem('UNSAFE_STORAGE', 'Document storage ancestry is unsafe'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = dirname(path); if (parent === path) break; path = parent;
    }
    await mkdir(this.root, { recursive: true });
  }
  private async readIndex(): Promise<Index> {
    await this.ensureRoot();
    let index: Index;
    try {
      const stat = await lstat(this.indexPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) problem('UNSAFE_STORAGE', 'Document index must be a bounded regular file');
      index = JSON.parse(await readFile(this.indexPath, 'utf8')) as Index;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      index = { version: 1, records: [] };
    }
    if (index.version !== 1 || !Array.isArray(index.records) || index.records.length > 100000) problem('INVALID_STORAGE', 'Unsupported document index');
    const ids = new Set<string>();
    for (const record of index.records) {
      if (!record || typeof record.id !== 'string' || ids.has(record.id) || typeof record.workspace_id !== 'string' || !/^[\w.:-]{1,100}$/.test(record.workspace_id) || !/^[a-f0-9]{64}$/.test(record.hash) || !Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > 256 * 1024 * 1024 || !['review','confirmed','rejected','archived'].includes(record.status) || !Array.isArray(record.history) || !record.fields) problem('INVALID_STORAGE', 'Invalid document index record');
      ids.add(record.id);
    }
    const financial = this.options.getState().documents;
    for (const record of index.records) {
      const doc = financial.get(record.id);
      if (doc && doc.meta.workspace_id === record.workspace_id) {
        if (doc.file_hash !== record.hash) problem('SOURCE_CONFLICT', 'Document index disagrees with financial evidence');
        if (record.status === 'review') record.status = 'confirmed';
        if (doc.meta.document_review_status === 'archived') { record.status = 'archived'; record.archived_from = 'confirmed'; }
        else if (doc.meta.document_review_status === 'confirmed' && record.status === 'archived') { record.status = 'confirmed'; delete record.archived_from; }
      }
    }
    // Reconstruct confirmed records only from verified canonical financial
    // evidence. Missing attachment errors are never mistaken for a missing index.
    for (const doc of financial.values()) {
      if (index.records.some(record => record.id === doc.document_id) || typeof doc.meta.workspace_id !== 'string' || typeof doc.file_hash !== 'string' || !doc.filename || typeof doc.meta.attachment_path !== 'string') continue;
      const workspaceHash = createHash('sha256').update(doc.meta.workspace_id).digest('hex');
      const file = join(this.blobs, workspaceHash, doc.file_hash);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || documentHash(await readFile(file)) !== doc.file_hash) problem('UNSAFE_STORAGE', 'Document attachment recovery failed');
      const sourceRefs=Array.isArray(doc.meta.document_source_refs)?structuredClone(doc.meta.document_source_refs) as Array<{source_id:string;kind:DocumentSourceKind}>:[];
      if(sourceRefs.length>100||sourceRefs.some(ref=>!ref||!/^[\w.:-]{1,160}$/.test(ref.source_id)||!['user-supplied','invoice-bot'].includes(ref.kind)))problem('INVALID_STORAGE','Invalid canonical document provenance');
      const mime = doc.filename.toLowerCase().endsWith('.csv') ? 'text/csv' : doc.filename.toLowerCase().endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : doc.filename.toLowerCase().endsWith('.png') ? 'image/png' : doc.filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
      index.records.push({ id: doc.document_id, workspace_id: doc.meta.workspace_id, owner_subject: String(doc.meta.owner_subject ?? ''), filename: doc.filename, hash: doc.file_hash, mime, bytes: stat.size, pages: 0,
        status: doc.meta.document_review_status === 'archived' ? 'archived' : 'confirmed', ...(doc.meta.document_review_status === 'archived' ? {archived_from: 'confirmed' as const} : {}), ...(sourceRefs.length?{source_id:sourceRefs[0].source_id,source_kind:sourceRefs[0].kind,source_refs:sourceRefs}:{}),
        fields: { ...(doc.meta.document_type==='credit_note'?{document_type:'credit_note' as const}:{}),invoice_number: String(doc.meta.invoice_number ?? doc.source_document_ref), supplier_name: doc.supplier_name, document_date: doc.document_date, total_amount_minor: doc.total_amount_minor, vat_amount_minor: doc.vat_amount_minor, net_amount_minor: typeof doc.meta.net_amount_minor === 'number' ? doc.meta.net_amount_minor : undefined, currency_code: doc.currency_code, iban: typeof doc.meta.iban === 'string' ? doc.meta.iban : undefined, payment_reference: typeof doc.meta.payment_reference === 'string' ? doc.meta.payment_reference : undefined, due_date: typeof doc.meta.due_date === 'string' ? doc.meta.due_date : undefined },
        recognition: { confidence: 1, raw_text: '', warnings: [] }, created_at: doc.captured_at, history: [{ at: now(), actor: 'system', action: 'index_recovered_from_canonical_state' }] });
    }
    // Reads return a recovered view; only serialized mutations replace the index.
    return index;
  }
  private async writeIndex(index: Index): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(index)); if (bytes.length > 64 * 1024 * 1024) problem('STORAGE_LIMIT', 'Document index exceeds supported size');
    const temp = join(this.root, `.document-index-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temp, this.indexPath); } finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  private find(index: Index, principal: Principal, id: string): DocumentRecord {
    scope(principal);
    const record = index.records.find(item => item.id === id && item.workspace_id === principal.workspace_id);
    if (!record) throw new DocumentInputError('NOT_FOUND', 'Document not found');
    return record;
  }
  async list(principal: Principal, search = ''): Promise<DocumentRecord[]> {
    scope(principal);
    const index = await this.readIndex();
    const needle = search.trim().toLowerCase().slice(0, 100);
    return index.records.filter(item => item.workspace_id === principal.workspace_id && (!needle || [item.filename, item.fields.invoice_number, item.fields.supplier_name, item.source_id].some(value => value?.toLowerCase().includes(needle))));
  }
  async get(principal: Principal, id: string): Promise<DocumentRecord> { return this.find(await this.readIndex(), principal, id); }
  async upload(principal: Principal, buffer: Buffer, filename: string, sourceId?: string, sourceKind:DocumentSourceKind='user-supplied'): Promise<{ record: DocumentRecord; duplicate: boolean }> {
    scope(principal);
    const inspected = await inspectDocument(buffer, filename);
    const hash = documentHash(buffer);
    if (sourceId && (!/^[\w.:-]{1,160}$/.test(sourceId))) problem('INVALID_SOURCE_ID', 'Invalid source identifier');
    return this.lock(async () => {
      const index = await this.readIndex();
      const prior = index.records.find(item => item.workspace_id === principal.workspace_id && (item.hash === hash || sourceId && (item.source_id === sourceId||item.source_refs?.some(ref=>ref.source_id===sourceId))));
      if (prior) {
        if (sourceId && (prior.source_id === sourceId||prior.source_refs?.some(ref=>ref.source_id===sourceId)) && prior.hash !== hash) problem('SOURCE_CONFLICT', 'An existing source identifier contains different document bytes');
        if(sourceId&&!prior.source_refs?.some(ref=>ref.source_id===sourceId&&ref.kind===sourceKind)){
          if((prior.source_refs?.length??0)>=100)problem('SOURCE_LIMIT','Too many document source observations');
          prior.source_refs=[...(prior.source_refs??[]),{source_id:sourceId,kind:sourceKind}];
          prior.history.push({at:now(),actor:principal.subject,action:'source_observed:'+sourceKind});
          const expected=this.options.getState();if(expected.documents.has(prior.id)){
            const next=cloneState(expected);const canonical=next.documents.get(prior.id)!;const portalRefs=prior.source_refs.filter(ref=>ref.kind==='invoice-bot').map(ref=>ref.source_id);canonical.meta={...canonical.meta,document_source_refs:structuredClone(prior.source_refs),...(portalRefs.length?{portal_source_id:portalRefs[0],portal_source_refs:portalRefs}:{})};recordAudit(next,'STATE_COMMITTED','Document',prior.id,{actor_type:'user',actor_id:principal.subject,reason:'Additional document source observed',after:{source_id:sourceId,source_kind:sourceKind,attachment_hash:hash}});await this.options.persistAndActivate(expected,next,principal.subject);
          }
          await this.writeIndex(index);
        }
        return {record:prior,duplicate:true};
      }
      let recognition: RecognizedInvoice;
      try { recognition = await recognizeDocument(buffer, inspected.kind, this.options.localLanguageDir); }
      catch (error) {
        recognition = { confidence: 0, raw_text: '', warnings: [error instanceof DocumentInputError ? error.message : 'Recognition failed; review fields manually'] };
      }
      const workspaceHash = createHash('sha256').update(principal.workspace_id).digest('hex');
      const dir = join(this.blobs, workspaceHash);
      await mkdir(dir, { recursive: true });
      for (const folder of [this.blobs, dir]) { const stat = await lstat(folder); if (!stat.isDirectory() || stat.isSymbolicLink()) problem('UNSAFE_STORAGE', 'Attachment directory is unsafe'); }
      const file = join(dir, hash);
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== buffer.length) problem('UNSAFE_STORAGE', 'Attachment path is unsafe');
        if (documentHash(await readFile(file)) !== hash) problem('UNSAFE_STORAGE', 'Attachment checksum mismatch');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeFile(file, buffer, { flag: 'wx', mode: 0o600 });
      }
      const record: DocumentRecord = {
        id: `doc_${randomUUID()}`, workspace_id: principal.workspace_id, owner_subject: principal.subject,
        filename, hash, mime: inspected.kind === 'pdf' ? 'application/pdf' : inspected.kind === 'png' ? 'image/png' : 'image/jpeg',
        bytes: buffer.length, pages: inspected.pages, status: 'review', source_id: sourceId, ...(sourceId?{source_kind:sourceKind,source_refs:[{source_id:sourceId,kind:sourceKind}]}:{}),
        fields: Object.fromEntries(Object.entries(recognition).filter(([key]) => ['invoice_number','supplier_name','document_date','total_amount_minor','net_amount_minor','vat_amount_minor','currency_code','payment_reference','iban','due_date'].includes(key))) as ReviewFields,
        recognition, created_at: now(), history: [{ at: now(), actor: principal.subject, action: 'uploaded' }],
      };
      index.records.push(record);
      await this.writeIndex(index);
      return { record, duplicate: false };
    });
  }
  async importTable(principal: Principal, buffer: Buffer, filename: string, kind: TableKind): Promise<{ imported: number; duplicates: number; records: DocumentRecord[] }> {
    scope(principal);
    if (!filename || filename.length > 200 || /[\\/\u0000-\u001f]/.test(filename)) problem('INVALID_FILENAME', 'Invalid table filename');
    const extension = filename.toLowerCase().endsWith('.csv') ? '.csv' : filename.toLowerCase().endsWith('.xlsx') ? '.xlsx' : '';
    const rows = parseDocumentTable(buffer, extension, kind);
    const hash = documentHash(buffer);
    return this.lock(async () => {
      const index = await this.readIndex();
      const expected = this.options.getState(); const next = cloneState(expected);
      const created: DocumentRecord[] = []; let duplicates = 0;
      for (const row of rows) {
        const id = tableDocumentId(principal.workspace_id, kind, row.source_id);
        const prior = next.documents.get(id);
        if (prior) {
          if (prior.meta.workspace_id !== principal.workspace_id || prior.source_document_ref !== row.source_id || prior.total_amount_minor !== row.total_amount_minor || prior.currency_code !== row.currency_code || prior.document_date !== row.document_date || prior.supplier_name !== row.supplier_name || prior.source_document_ref !== row.source_id || prior.vat_amount_minor !== row.vat_amount_minor || prior.meta.invoice_number !== row.invoice_number || prior.meta.net_amount_minor !== row.net_amount_minor || prior.meta.document_type !== row.document_type) problem('SOURCE_CONFLICT', 'Source identifier has conflicting document values');
          duplicates++; continue;
        }
        const document: Document = { document_id: id, source_system: kind === 'income' ? 'income' : 'invoice_file', source_document_ref: row.source_id, captured_at: now(), document_date: row.document_date, total_amount_minor: row.total_amount_minor, currency_code: row.currency_code, supplier_name: row.supplier_name, vat_amount_minor: row.vat_amount_minor, file_hash: hash, filename, meta: { workspace_id: principal.workspace_id, owner_subject: principal.subject, invoice_number: row.invoice_number, net_amount_minor: row.net_amount_minor, table_kind: kind,...(row.document_type?{document_type:row.document_type}:{}), settlement_convention: kind === 'invoice' ? 'payable-face-v1' : 'signed-cashflow-v1', document_review_status: 'confirmed', attachment_path: 'attachments/' + createHash('sha256').update(principal.workspace_id).digest('hex') + '/' + hash } };
        next.documents.set(id, document);
        created.push({ id, workspace_id: principal.workspace_id, owner_subject: principal.subject, filename, hash, mime: extension === '.csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: buffer.length, pages: 0, status: 'confirmed', source_id: row.source_id, fields: { ...(row.document_type?{document_type:row.document_type}:{}),invoice_number: row.invoice_number, supplier_name: row.supplier_name, document_date: row.document_date, total_amount_minor: row.total_amount_minor, net_amount_minor: row.net_amount_minor, vat_amount_minor: row.vat_amount_minor, currency_code: row.currency_code }, recognition: { confidence: 1, raw_text: '', warnings: [] }, created_at: now(), history: [{ at: now(), actor: principal.subject, action: 'imported' }] });
      }
      if (!created.length) return { imported: 0, duplicates, records: [] };
      const workspaceHash = createHash('sha256').update(principal.workspace_id).digest('hex');
      const dir = join(this.blobs, workspaceHash); await mkdir(dir, { recursive: true });
      for (const folder of [this.blobs, dir]) { const stat = await lstat(folder); if (!stat.isDirectory() || stat.isSymbolicLink()) problem('UNSAFE_STORAGE', 'Attachment directory is unsafe'); }
      const file = join(dir, hash);
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== buffer.length || documentHash(await readFile(file)) !== hash) problem('UNSAFE_STORAGE', 'Attachment path is unsafe');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeFile(file, buffer, { flag: 'wx', mode: 0o600 });
      }
      await this.options.persistAndActivate(expected, next, principal.subject);
      index.records.push(...created); await this.writeIndex(index);
      return { imported: created.length, duplicates, records: created };
    });
  }
  async download(principal: Principal, id: string): Promise<{ record: DocumentRecord; buffer: Buffer }> {
    const record = await this.get(principal, id);
    const workspaceHash = createHash('sha256').update(principal.workspace_id).digest('hex');
    const file = join(this.blobs, workspaceHash, record.hash);
    for (const folder of [this.blobs, join(this.blobs, workspaceHash)]) { const stat = await lstat(folder); if (!stat.isDirectory() || stat.isSymbolicLink()) problem('UNSAFE_STORAGE', 'Attachment directory is unsafe'); }
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.bytes) problem('UNSAFE_STORAGE', 'Attachment is unavailable');
    const buffer = await readFile(file);
    if (documentHash(buffer) !== record.hash) problem('UNSAFE_STORAGE', 'Attachment checksum mismatch');
    return { record, buffer };
  }
  async correct(principal: Principal, id: string, input: Record<string, unknown>): Promise<DocumentRecord> {
    scope(principal);
    const fields = validFields(input);
    return this.lock(async () => {
      const index = await this.readIndex(); const record = this.find(index, principal, id);
      if (record.status !== 'review') problem('INVALID_STATUS', 'Only review documents can be edited');
      record.fields = fields; record.history.push({ at: now(), actor: principal.subject, action: 'corrected', fields: { ...fields } });
      await this.writeIndex(index); return record;
    });
  }
  async confirm(principal: Principal, id: string): Promise<DocumentRecord> {
    scope(principal);
    return this.lock(async () => {
      const index = await this.readIndex(); const record = this.find(index, principal, id);
      if (record.status === 'confirmed') return record;
      if (record.status !== 'review') problem('INVALID_STATUS', 'Document is not under review');
      const fields = validFields({ document_type:record.fields.document_type,invoice_number: record.fields.invoice_number, supplier_name: record.fields.supplier_name, document_date: record.fields.document_date, total_amount: minorText(record.fields.total_amount_minor, record.fields.currency_code), net_amount: minorText(record.fields.net_amount_minor, record.fields.currency_code), vat_amount: minorText(record.fields.vat_amount_minor, record.fields.currency_code), currency_code: record.fields.currency_code, payment_reference: record.fields.payment_reference, iban: record.fields.iban, due_date: record.fields.due_date });
      const expected = this.options.getState(); const next = cloneState(expected);
      const document: Document = { document_id: record.id, source_system: 'upload', source_document_ref: record.source_id ?? fields.invoice_number!, captured_at: record.created_at, document_date: fields.document_date!, total_amount_minor: fields.total_amount_minor!, currency_code: fields.currency_code!, supplier_name: fields.supplier_name, vat_amount_minor: fields.vat_amount_minor, file_hash: record.hash, filename: record.filename, meta: { workspace_id: principal.workspace_id, owner_subject: record.owner_subject, ...(record.source_refs?{document_source_refs:structuredClone(record.source_refs)}:{}), ...(record.source_refs?.some(ref=>ref.kind==='invoice-bot') ? {portal_source_id:record.source_refs.find(ref=>ref.kind==='invoice-bot')!.source_id,portal_source_refs:record.source_refs.filter(ref=>ref.kind==='invoice-bot').map(ref=>ref.source_id)} : {}), net_amount_minor: fields.net_amount_minor, payment_reference: fields.payment_reference, iban: fields.iban, due_date: fields.due_date, recognition_confidence: record.recognition.confidence, invoice_number: fields.invoice_number, ...(fields.document_type?{document_type:fields.document_type}:{}),settlement_convention: 'payable-face-v1', document_review_status: 'confirmed', attachment_path: 'attachments/' + createHash('sha256').update(principal.workspace_id).digest('hex') + '/' + record.hash } };
      next.documents.set(record.id, document);
      recordAudit(next,'STATE_COMMITTED','Document',record.id,{actor_type:'user',actor_id:principal.subject,reason:'Document confirmed after review',after:{status:'confirmed',source_document_ref:document.source_document_ref,attachment_hash:record.hash}});
      await this.options.persistAndActivate(expected, next, principal.subject);
      record.status = 'confirmed'; record.history.push({ at: now(), actor: principal.subject, action: 'confirmed', fields: { ...fields } });
      await this.writeIndex(index); return record;
    });
  }
  async disposition(principal: Principal, id: string, action: 'reject' | 'archive' | 'restore'): Promise<DocumentRecord> {
    scope(principal);
    return this.lock(async () => {
      const index = await this.readIndex(); const record = this.find(index, principal, id);
      if (action === 'reject' && record.status !== 'review') problem('INVALID_STATUS', 'Only review documents can be rejected');
      if (action === 'archive') {
        const accepted = [...this.options.getState().match_groups.values()].some(group => ['accepted','confirmed','manual'].includes(group.status) && group.document_ids.includes(id));
        const partial = this.options.getState().accounting?.allocations.some(allocation => allocation.status === 'accepted' && allocation.document_id === id);
        if (accepted || partial) problem('MATCHED_EVIDENCE', 'Accepted match evidence requires a separate archival workflow');
      }
      if (action === 'restore' && record.status !== 'archived') problem('INVALID_STATUS', 'Only archived documents can be restored');
      if (action === 'archive' && record.status === 'archived') problem('INVALID_STATUS', 'Document is already archived');
      if (action === 'archive') { record.archived_from = record.status as 'review' | 'confirmed' | 'rejected'; record.status = 'archived'; }
      else if (action === 'restore') { record.status = record.archived_from ?? 'review'; delete record.archived_from; }
      else record.status = 'rejected';
      const expected = this.options.getState(); const existing = expected.documents.get(id);
      if (existing && (action === 'archive' || action === 'restore')) {
        const next = cloneState(expected);
        const meta: Record<string, unknown> = { ...existing.meta, document_review_status: action === 'archive' ? 'archived' : 'confirmed' };
        if (action === 'archive') { meta.accounting_status = 'cancelled'; meta.archived_by_documents = true; }
        else if (meta.archived_by_documents === true) { delete meta.accounting_status; delete meta.archived_by_documents; }
        next.documents.set(id, { ...existing, meta });
        await this.options.persistAndActivate(expected, next, principal.subject);
      }
      record.history.push({ at: now(), actor: principal.subject, action });
      await this.writeIndex(index); return record;
    });
  }
}
