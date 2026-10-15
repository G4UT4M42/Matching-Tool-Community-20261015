import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import XLSX from 'xlsx';
import type { MatchingState } from '../src/core/types.js';
import { CommunityDocumentService, type Principal } from '../src/community/documents/service.js';
import { inspectDocument, parseRecognizedInvoice, recognizeDocument } from '../src/community/documents/recognition.js';
import { parseDocumentTable } from '../src/community/documents/tabular.js';

const alice: Principal = { subject: 'alice', workspace_id: 'workspace-a' };
const bob: Principal = { subject: 'bob', workspace_id: 'workspace-b' };
const emptyState = (): MatchingState => ({ run_id: 'synthetic', transactions: new Map(), documents: new Map(), match_groups: new Map(), exclusion_rules: [], audit_events: [], matched_transaction_ids: new Set(), matched_document_ids: new Set(), excluded_transaction_ids: new Set() });
const svg = `<svg width="1400" height="700" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g font-family="Arial" font-size="44" fill="black"><text x="40" y="85">Invoice number: SYN-2026-001</text><text x="40" y="160">Supplier: Example Components GmbH</text><text x="40" y="235">Invoice date: 2026-10-14</text><text x="40" y="310">Net total: EUR 100.00</text><text x="40" y="385">VAT: EUR 20.00</text><text x="40" y="460">Grand total: EUR 120.00</text><text x="40" y="535">Payment reference: SYN-2026-001</text></g></svg>`;
const image = () => sharp(Buffer.from(svg)).png().toBuffer();
async function pdf(text: string): Promise<Buffer> {
  const doc = new PDFDocument({ autoFirstPage: true, compress: false });
  const parts: Buffer[] = [];
  doc.on('data', part => parts.push(part));
  const done = new Promise<Buffer>(resolve => doc.on('end', () => resolve(Buffer.concat(parts))));
  doc.fontSize(16).text(text); doc.end(); return done;
}

describe('Community documents', () => {
  let root: string;
  let state = emptyState();
  let service: CommunityDocumentService;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'community-documents-'));
    service = new CommunityDocumentService({ root, localLanguageDir: undefined, getState: () => state, persistAndActivate: (expected, next) => { if (expected !== state) throw Error('stale'); state = next; } });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  it('rejects content/type mismatch, path names, malformed and active PDFs', async () => {
    await expect(inspectDocument(Buffer.from('MZ executable'), 'a.pdf')).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
    await expect(inspectDocument(await image(), '../invoice.png')).rejects.toMatchObject({ code: 'INVALID_FILENAME' });
    await expect(inspectDocument(await image(), 'invoice.pdf')).rejects.toMatchObject({ code: 'TYPE_MISMATCH' });
    await expect(inspectDocument(Buffer.from('%PDF-1.7\n/JavaScript\n%%EOF'), 'a.pdf')).rejects.toMatchObject({ code: 'UNSAFE_PDF' });
    await expect(inspectDocument(Buffer.from('%PDF-1.7\n%%EOF'), 'a.pdf')).rejects.toMatchObject({ code: 'MALFORMED_PDF' });
  }, 30_000);
  it('extracts real text from a generated PDF and exact fields', async () => {
    const bytes = await pdf('Invoice number: PDF-123\nSupplier: Synthetic Ltd\nInvoice date: 2026-10-14\nGrand total: EUR 120.00');
    expect((await inspectDocument(bytes, 'synthetic.pdf')).pages).toBe(1);
    const result = await recognizeDocument(bytes, 'pdf');
    expect(result.raw_text).toContain('PDF-123');
    expect(result.total_amount_minor).toBe(12000);
  });
  it('uses a real OCR engine on a generated invoice image, then persists review and confirmation', async () => {
    const bytes = await image();
    const first = await service.upload(alice, bytes, 'invoice.png');
    expect(first.duplicate).toBe(false);
    expect(first.record.recognition.raw_text).toMatch(/SYN-2026-001/);
    expect(first.record.recognition.total_amount_minor).toBe(12000);
    expect((await service.upload(alice, bytes, 'invoice.png')).duplicate).toBe(true);
    await expect(service.get(bob, first.record.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await service.download(alice, first.record.id)).buffer.equals(bytes)).toBe(true);
    await service.correct(alice, first.record.id, { invoice_number: 'SYN-2026-001', supplier_name: 'Example Components GmbH', document_date: '2026-10-14', total_amount: '120.00', net_amount: '100.00', vat_amount: '20.00', currency_code: 'EUR' });
    const confirmed = await service.confirm(alice, first.record.id);
    expect(confirmed.status).toBe('confirmed');
    expect(state.documents.get(first.record.id)?.total_amount_minor).toBe(12000);
    expect((await new CommunityDocumentService({ root, getState: () => state, persistAndActivate: () => {} }).get(alice, first.record.id)).status).toBe('confirmed');
  }, 60_000);
  it('recognizes a generated scanned PDF with the local OCR engine', async () => {
    const png = await image();
    const doc = new PDFDocument({ size: [700, 350], margin: 0 }); const parts: Buffer[] = [];
    doc.on('data', part => parts.push(part));
    const completed = new Promise<Buffer>(resolve => doc.on('end', () => resolve(Buffer.concat(parts))));
    doc.image(png, 0, 0, { width: 700 }); doc.end();
    const bytes = await completed;
    const result = await recognizeDocument(bytes, 'pdf', undefined);
    expect(result.raw_text).toMatch(/SYN-2026-001/);
    expect(result.total_amount_minor).toBe(12000);
  }, 60_000);
  it('keeps ambiguous money and dates unconfirmed', () => {
    const result = parseRecognizedInvoice('Invoice number: A\nInvoice date: 14/10/2026\nInvoice date: 15/10/2026\nGrand total: EUR 10.00\nGrand total: EUR 20.00');
    expect(result.document_date).toBeUndefined();
    expect(result.total_amount_minor).toBeUndefined();
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it('validates tabular IDs, exact decimals, dates and formula cells atomically', async () => {
    const csv = Buffer.from('source_id,invoice_number,supplier_name,document_date,total_amount,currency_code,net_amount,vat_amount\nSRC-1,INV-1,Synthetic Seller,2026-10-14,120.00,EUR,100.00,20.00\n');
    expect(parseDocumentTable(csv, '.csv', 'invoice')[0].total_amount_minor).toBe(12000);
    const first = await service.importTable(alice, csv, 'invoices.csv', 'invoice');
    expect(first.imported).toBe(1);
    expect((await service.importTable(alice, csv, 'invoices.csv', 'invoice')).duplicates).toBe(1);
    expect(state.documents.get(first.records[0].id)?.source_document_ref).toBe('SRC-1');
    await expect(service.get(bob, first.records[0].id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await service.download(alice, first.records[0].id)).buffer.equals(csv)).toBe(true);
    expect((await service.disposition(alice, first.records[0].id, 'archive')).status).toBe('archived');
    expect((await service.disposition(alice, first.records[0].id, 'restore')).status).toBe('confirmed');
    expect(() => parseDocumentTable(Buffer.from('source_id,invoice_number,supplier_name,document_date,total_amount,currency_code\n=cmd,INV-1,Seller,2026-10-14,1.00,EUR'), '.csv', 'invoice')).toThrow();
    expect(() => parseDocumentTable(Buffer.from('source_id,invoice_number,supplier_name,document_date,total_amount,currency_code\nS,INV-1,Seller,2026-02-30,1.00,EUR'), '.csv', 'invoice')).toThrow();
    expect(() => parseDocumentTable(Buffer.from('source_id,invoice_number,supplier_name,document_date,total_amount,currency_code\nS,INV-1,Seller,2026-10-14,1.001,EUR'), '.csv', 'invoice')).toThrow();
  });
  it('retains review evidence on financial persistence failure', async () => {
    const failed = new CommunityDocumentService({ root, getState: () => state, persistAndActivate: (_before,next) => { if(next.documents.size>state.documents.size)throw Error('interrupted'); state=next; } });
    const record = (await failed.upload(alice, await pdf('Invoice number: FAIL-1\nSupplier: Synthetic\nInvoice date: 2026-10-14\nGrand total: EUR 1.00'), 'failure.pdf')).record;
    await failed.correct(alice, record.id, { invoice_number: 'FAIL-1', supplier_name: 'Synthetic', document_date: '2026-10-14', total_amount: '1.00', currency_code: 'EUR' });
    await expect(failed.confirm(alice, record.id)).rejects.toThrow('interrupted');
    expect((await failed.get(alice, record.id)).status).toBe('review');
    expect(state.documents.has(record.id)).toBe(false);
  });
  it('records a rejection without creating financial data', async () => {
    const bytes = await sharp({ create: { width: 120, height: 120, channels: 3, background: '#eeeeee' } }).png().toBuffer();
    const record = (await service.upload(alice, bytes, 'reject.png')).record;
    const rejected = await service.disposition(alice, record.id, 'reject');
    expect(rejected.status).toBe('rejected');
    expect(rejected.history.at(-1)?.actor).toBe(alice.subject);
    expect(state.documents.has(record.id)).toBe(false);
  });
  it('protects accepted match evidence and bounds uploaded pages and bytes', async () => {
    const confirmed = (await service.list(alice)).find(item => item.status === 'confirmed' && item.filename === 'invoice.png')!;
    state.match_groups.set('match-test', { match_group_id: 'match-test', status: 'accepted', created_at: new Date().toISOString(), created_by: 'synthetic', rule_id: 'MANUAL', transaction_ids: [], document_ids: [confirmed.id], amount_total_minor: 12000, currency_code: 'EUR', reason_codes: [] });
    await expect(service.disposition(alice, confirmed.id, 'archive')).rejects.toMatchObject({ code: 'MATCHED_EVIDENCE' });
    await expect(inspectDocument(Buffer.alloc(10 * 1024 * 1024 + 1), 'large.png')).rejects.toMatchObject({ code: 'FILE_LIMIT' });
    const oversizedPixels = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#fff' }, limitInputPixels: false }).png().toBuffer();
    await expect(inspectDocument(oversizedPixels, 'large.png')).rejects.toMatchObject({ code: 'PIXEL_LIMIT' });
    const many = new PDFDocument({ autoFirstPage: false });
    const pieces: Buffer[] = []; many.on('data', part => pieces.push(part));
    const finished = new Promise<Buffer>(resolve => many.on('end', () => resolve(Buffer.concat(pieces))));
    for (let i = 0; i < 11; i++) many.addPage().text('Synthetic'); many.end();
    await expect(inspectDocument(await finished, 'many.pdf')).rejects.toMatchObject({ code: 'PAGE_LIMIT' });
  }, 30_000);
  it('rejects a symlinked storage root and spreadsheet formula cells', async () => {
    const real = await mkdtemp(join(tmpdir(), 'community-doc-link-'));
    const link = `${real}-link`;
    try {
      await symlink(real, link, 'junction');
      const unsafe = new CommunityDocumentService({ root: link, getState: () => state, persistAndActivate: () => {} });
      await expect(unsafe.list(alice)).rejects.toMatchObject({ code: 'UNSAFE_STORAGE' });
    } finally { await rm(link, { force: true }); await rm(real, { recursive: true, force: true }); }
    const sheet = XLSX.utils.aoa_to_sheet([['source_id','invoice_number','supplier_name','document_date','total_amount','currency_code'], ['S1','I1','Supplier','2026-10-14', { f: '1+1', v: 2 },'EUR']]);
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Invoices');
    expect(() => parseDocumentTable(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer, '.xlsx', 'invoice')).toThrow();
  }, 30_000);
});
