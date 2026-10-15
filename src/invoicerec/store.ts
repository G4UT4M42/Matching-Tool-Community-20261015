/**
 * SQLite CRUD for invoice recognition tables.
 */
import { getDb } from '../storage/db.js';
import { documentId } from '../core/ids.js';
import type {
  InvoiceScan, ExtractedFields, InvoiceTemplate, ReviewEdit,
  ScanStatus, TaxLine, ExtractedLineItem, FieldRegion, FieldConfidence, ValidationResult, TemplatePatterns,
} from './types.js';
import { editId } from './ids.js';

// ==================== SCANS ====================

export function insertScan(scan: InvoiceScan): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO invoice_scans (
      scan_id, created_at, original_filename, stored_filename, file_hash,
      file_type, page_count, extraction_method, ocr_confidence, status,
      template_id, document_id, raw_text, meta
    ) VALUES (
      @scan_id, @created_at, @original_filename, @stored_filename, @file_hash,
      @file_type, @page_count, @extraction_method, @ocr_confidence, @status,
      @template_id, @document_id, @raw_text, @meta
    )
  `).run({
    ...scan,
    meta: JSON.stringify(scan.meta),
  });
}

export function updateScanStatus(scanId: string, status: ScanStatus): void {
  getDb().prepare('UPDATE invoice_scans SET status = ? WHERE scan_id = ?').run(status, scanId);
}

export function updateScanDocumentId(scanId: string, documentId: string): void {
  getDb().prepare('UPDATE invoice_scans SET document_id = ?, status = ? WHERE scan_id = ?')
    .run(documentId, 'confirmed', scanId);
}

export function updateScanTemplateId(scanId: string, templateId: string): void {
  getDb().prepare('UPDATE invoice_scans SET template_id = ? WHERE scan_id = ?').run(templateId, scanId);
}

export function getScan(scanId: string): InvoiceScan | null {
  const row = getDb().prepare('SELECT * FROM invoice_scans WHERE scan_id = ?').get(scanId) as any;
  return row ? deserializeScan(row) : null;
}

export function getScanByHash(fileHash: string): InvoiceScan | null {
  const row = getDb().prepare('SELECT * FROM invoice_scans WHERE file_hash = ?').get(fileHash) as any;
  return row ? deserializeScan(row) : null;
}

export function listScans(status?: ScanStatus, limit = 50, offset = 0): { items: InvoiceScan[]; total: number } {
  const db = getDb();
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];

  const total = (db.prepare(`SELECT COUNT(*) as c FROM invoice_scans ${where}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM invoice_scans ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as any[];

  return { items: rows.map(deserializeScan), total };
}

export function deleteScan(scanId: string): boolean {
  const result = getDb().prepare('DELETE FROM invoice_scans WHERE scan_id = ?').run(scanId);
  return result.changes > 0;
}

function deserializeScan(row: any): InvoiceScan {
  return {
    ...row,
    meta: JSON.parse(row.meta || '{}'),
  };
}

// ==================== EXTRACTED FIELDS ====================

export function upsertFields(fields: ExtractedFields): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO invoice_extracted_fields (
      scan_id, invoice_number, invoice_date, seller_name, seller_address,
      seller_country, seller_vat_id, buyer_name, buyer_vat_id, currency_code,
      net_amount_minor, vat_amount_minor, vat_rate, gross_amount_minor,
      tax_lines_json, line_items_json, field_regions_json, confidence_json,
      validation_json, meta
    ) VALUES (
      @scan_id, @invoice_number, @invoice_date, @seller_name, @seller_address,
      @seller_country, @seller_vat_id, @buyer_name, @buyer_vat_id, @currency_code,
      @net_amount_minor, @vat_amount_minor, @vat_rate, @gross_amount_minor,
      @tax_lines_json, @line_items_json, @field_regions_json, @confidence_json,
      @validation_json, @meta
    )
  `).run({
    scan_id: fields.scan_id,
    invoice_number: fields.invoice_number,
    invoice_date: fields.invoice_date,
    seller_name: fields.seller_name,
    seller_address: fields.seller_address,
    seller_country: fields.seller_country,
    seller_vat_id: fields.seller_vat_id,
    buyer_name: fields.buyer_name,
    buyer_vat_id: fields.buyer_vat_id,
    currency_code: fields.currency_code,
    net_amount_minor: fields.net_amount_minor,
    vat_amount_minor: fields.vat_amount_minor,
    vat_rate: fields.vat_rate,
    gross_amount_minor: fields.gross_amount_minor,
    tax_lines_json: JSON.stringify(fields.tax_lines),
    line_items_json: JSON.stringify(fields.line_items),
    field_regions_json: JSON.stringify(fields.field_regions),
    confidence_json: JSON.stringify(fields.confidence),
    validation_json: JSON.stringify(fields.validation),
    meta: JSON.stringify(fields.meta),
  });
}

export function getFields(scanId: string): ExtractedFields | null {
  const row = getDb().prepare('SELECT * FROM invoice_extracted_fields WHERE scan_id = ?').get(scanId) as any;
  return row ? deserializeFields(row) : null;
}

function deserializeFields(row: any): ExtractedFields {
  return {
    scan_id: row.scan_id,
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    seller_name: row.seller_name,
    seller_address: row.seller_address,
    seller_country: row.seller_country,
    seller_vat_id: row.seller_vat_id,
    buyer_name: row.buyer_name,
    buyer_vat_id: row.buyer_vat_id,
    currency_code: row.currency_code ?? 'EUR',
    net_amount_minor: row.net_amount_minor,
    vat_amount_minor: row.vat_amount_minor,
    vat_rate: row.vat_rate,
    gross_amount_minor: row.gross_amount_minor,
    tax_lines: JSON.parse(row.tax_lines_json || '[]'),
    line_items: JSON.parse(row.line_items_json || '[]'),
    field_regions: JSON.parse(row.field_regions_json || '{}'),
    confidence: JSON.parse(row.confidence_json || '{}'),
    validation: JSON.parse(row.validation_json || '{}'),
    meta: JSON.parse(row.meta || '{}'),
  };
}

// ==================== TEMPLATES ====================

export function upsertTemplate(tmpl: InvoiceTemplate): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO invoice_templates (
      template_id, vendor_name, vendor_vat_id, created_at, updated_at,
      use_count, patterns_json, meta
    ) VALUES (
      @template_id, @vendor_name, @vendor_vat_id, @created_at, @updated_at,
      @use_count, @patterns_json, @meta
    ) ON CONFLICT(template_id) DO UPDATE SET
      vendor_name = @vendor_name,
      vendor_vat_id = @vendor_vat_id,
      updated_at = @updated_at,
      use_count = @use_count,
      patterns_json = @patterns_json,
      meta = @meta
  `).run({
    template_id: tmpl.template_id,
    vendor_name: tmpl.vendor_name,
    vendor_vat_id: tmpl.vendor_vat_id,
    created_at: tmpl.created_at,
    updated_at: tmpl.updated_at,
    use_count: tmpl.use_count,
    patterns_json: JSON.stringify(tmpl.patterns),
    meta: JSON.stringify(tmpl.meta),
  });
}

export function getTemplate(templateId: string): InvoiceTemplate | null {
  const row = getDb().prepare('SELECT * FROM invoice_templates WHERE template_id = ?').get(templateId) as any;
  return row ? deserializeTemplate(row) : null;
}

export function listTemplates(): InvoiceTemplate[] {
  const rows = getDb().prepare('SELECT * FROM invoice_templates ORDER BY use_count DESC').all() as any[];
  return rows.map(deserializeTemplate);
}

export function incrementTemplateUseCount(templateId: string): void {
  getDb().prepare('UPDATE invoice_templates SET use_count = use_count + 1 WHERE template_id = ?').run(templateId);
}

export function deleteTemplate(templateId: string): boolean {
  const result = getDb().prepare('DELETE FROM invoice_templates WHERE template_id = ?').run(templateId);
  return result.changes > 0;
}

function deserializeTemplate(row: any): InvoiceTemplate {
  return {
    template_id: row.template_id,
    vendor_name: row.vendor_name,
    vendor_vat_id: row.vendor_vat_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    use_count: row.use_count,
    patterns: JSON.parse(row.patterns_json),
    meta: JSON.parse(row.meta || '{}'),
  };
}

// ==================== REVIEW EDITS ====================

export function insertReviewEdit(scanId: string, fieldName: string, oldValue: string | null, newValue: string | null): void {
  getDb().prepare(`
    INSERT INTO invoice_review_edits (edit_id, scan_id, field_name, old_value, new_value, edited_by, edited_at)
    VALUES (?, ?, ?, ?, ?, 'user', datetime('now'))
  `).run(editId(), scanId, fieldName, oldValue, newValue);
}

export function getReviewEdits(scanId: string): ReviewEdit[] {
  return getDb().prepare('SELECT * FROM invoice_review_edits WHERE scan_id = ? ORDER BY edited_at')
    .all(scanId) as ReviewEdit[];
}

// ==================== DOCUMENT CREATION ON CONFIRM ====================

export interface CreatedDocument {
  docId: string;
  doc: import('../core/types.js').Document;
}

export interface CreateResult {
  documents: CreatedDocument[];
  primaryDocId: string;
}

function insertDoc(db: ReturnType<typeof getDb>, doc: import('../core/types.js').Document, meta: Record<string, unknown>): void {
  db.prepare(`
    INSERT OR IGNORE INTO documents (
      document_id, source_system, source_document_ref, captured_at,
      document_date, total_amount_minor, currency_code,
      supplier_name, vat_amount_minor, vat_rate, file_hash, filename, meta
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    doc.document_id, doc.source_system, doc.source_document_ref, doc.captured_at,
    doc.document_date, doc.total_amount_minor, doc.currency_code,
    doc.supplier_name ?? null, doc.vat_amount_minor ?? null, doc.vat_rate ?? null,
    null, doc.filename ?? null, JSON.stringify(meta),
  );
  db.prepare(`INSERT OR IGNORE INTO document_dispositions (document_id, disposition, set_by) VALUES (?, 'open', 'system')`)
    .run(doc.document_id);
}

export function createDocumentFromScan(scanId: string, fields: ExtractedFields, storedFilename?: string): CreateResult {
  const db = getDb();
  const now = new Date().toISOString();
  const baseMeta = {
    scan_id: scanId,
    invoice_country: fields.seller_country,
    seller_vat_id: fields.seller_vat_id,
    document_date_source: fields.invoice_date ? 'invoice_date' : 'capture_date_fallback',
    requires_date_review: !fields.invoice_date,
  };
  const results: CreatedDocument[] = [];

  // Check for EUSt split (e.g. UPS/DHL/Zoll with service 20% + EUSt 0%)
  const isEustSplit = fields.meta?.carrier_eust_split === true;

  if (isEustSplit && fields.tax_lines?.length >= 1) {
    const serviceLine = fields.tax_lines.find(t => t.rate > 0);
    const eustLine = fields.tax_lines.find(t => t.rate === 0);

    // Case 1: Both service + EUSt lines — create two documents with shared group ID
    if (serviceLine && eustLine) {
      const groupId = `EUST-${(fields.invoice_number ?? scanId)}`;

      // 1. Service document (20% VAT)
      const serviceDocId = documentId('invoice_scan', (fields.invoice_number ?? scanId) + '-SVC', fields.scan_id);
      const payableTotal = Number.isSafeInteger(fields.meta?.payable_amount_minor)
        ? Math.abs(fields.meta.payable_amount_minor as number)
        : null;
      // The invoice may contain non-taxable customs duties in addition to the
      // taxable handling fee and EUSt. Preserve the full payable total across
      // the two accounting documents instead of silently dropping that part.
      const serviceGross = payableTotal != null && payableTotal >= eustLine.net_minor
        ? payableTotal - eustLine.net_minor
        : serviceLine.net_minor + serviceLine.vat_minor;
      const svcMeta = { ...baseMeta, split_type: 'service', eust_group: groupId, expense_category: (fields.meta as any)?.expense_category ?? 'Versand' };
      const serviceDoc: import('../core/types.js').Document = {
        document_id: serviceDocId,
        source_system: 'invoice_scan' as any,
        source_document_ref: (fields.invoice_number ?? scanId) + '-SVC',
        captured_at: now,
        document_date: fields.invoice_date ?? now.slice(0, 10),
        total_amount_minor: -Math.abs(serviceGross),
        currency_code: fields.currency_code,
        supplier_name: fields.seller_name ?? undefined,
        vat_amount_minor: -Math.abs(serviceLine.vat_minor),
        vat_rate: serviceLine.rate,
        filename: storedFilename ?? undefined,
        meta: svcMeta,
      };
      insertDoc(db, serviceDoc, svcMeta);
      results.push({ docId: serviceDocId, doc: serviceDoc });

      // 2. EUSt document (0% VAT, tagged eust)
      const eustDocId = documentId('invoice_scan', (fields.invoice_number ?? scanId) + '-EUST', fields.scan_id);
      const eustMeta = { ...baseMeta, split_type: 'eust', eust_group: groupId, tags: ['eust'], expense_category: (fields.meta as any)?.eust_expense_category ?? 'EUSt' };
      const eustDoc: import('../core/types.js').Document = {
        document_id: eustDocId,
        source_system: 'invoice_scan' as any,
        source_document_ref: (fields.invoice_number ?? scanId) + '-EUST',
        captured_at: now,
        document_date: fields.invoice_date ?? now.slice(0, 10),
        total_amount_minor: -Math.abs(eustLine.net_minor),
        currency_code: fields.currency_code,
        supplier_name: fields.seller_name ?? undefined,
        vat_amount_minor: undefined,
        vat_rate: undefined,
        filename: storedFilename ?? undefined,
        meta: eustMeta,
      } as any;
      insertDoc(db, eustDoc, eustMeta);
      results.push({ docId: eustDocId, doc: eustDoc });

      return { documents: results, primaryDocId: serviceDocId };
    }

    // Case 2: Only EUSt line (no separate service line) — create single EUSt-tagged document
    if (eustLine && !serviceLine) {
      const eustDocId = documentId('invoice_scan', (fields.invoice_number ?? scanId) + '-EUST', fields.scan_id);
      const eustDoc: import('../core/types.js').Document = {
        document_id: eustDocId,
        source_system: 'invoice_scan' as any,
        source_document_ref: (fields.invoice_number ?? scanId) + '-EUST',
        captured_at: now,
        document_date: fields.invoice_date ?? now.slice(0, 10),
        total_amount_minor: -Math.abs(eustLine.net_minor),
        currency_code: fields.currency_code,
        supplier_name: fields.seller_name ?? undefined,
        vat_amount_minor: undefined,
        vat_rate: undefined,
        filename: storedFilename ?? undefined,
        meta: { ...baseMeta, split_type: 'eust', tags: ['eust'], expense_category: 'EUSt' },
        tags: ['eust'],
      } as any;
      insertDoc(db, eustDoc, { ...baseMeta, split_type: 'eust', tags: ['eust'] });
      results.push({ docId: eustDocId, doc: eustDoc });
      return { documents: results, primaryDocId: eustDocId };
    }
  }

  // Standard: single document
  const docId = documentId('invoice_scan', fields.invoice_number ?? scanId, fields.scan_id);
  const isUsd = fields.meta?.original_currency === 'USD' || fields.currency_code === 'USD';
  const alibabaEurPaid = (fields.meta as any)?.alibaba_eur_paid as number | undefined;

  // Alibaba special case: if explicit EUR paid amount exists, use it as primary amount
  // even though the invoice is nominally in USD
  const useAlibabaEur = isUsd && alibabaEurPaid != null && alibabaEurPaid > 0;

  const usdAmount = isUsd
    ? (fields.meta?.original_amount_minor as number ?? fields.gross_amount_minor ?? 0)
    : 0;
  const docMeta = {
    ...baseMeta,
    ...fields.meta,
    ...(isUsd ? {
      original_currency: 'USD',
      original_amount_minor: usdAmount,
      original_net_minor: fields.meta?.original_net_minor ?? fields.net_amount_minor,
      original_vat_minor: fields.meta?.original_vat_minor ?? fields.vat_amount_minor,
    } : {}),
    ...((fields.meta as any)?.is_alibaba ? { is_alibaba: true } : {}),
    ...(alibabaEurPaid ? { alibaba_eur_paid: alibabaEurPaid } : {}),
  };
  const doc: import('../core/types.js').Document = {
    document_id: docId,
    source_system: 'invoice_scan' as any,
    source_document_ref: fields.invoice_number ?? scanId,
    captured_at: now,
    document_date: fields.invoice_date ?? now.slice(0, 10),
    // Alibaba with EUR paid: use EUR amount directly (negative for expense)
    // USD invoices without EUR: EUR amount stays 0 until matched with bank transaction
    total_amount_minor: useAlibabaEur ? -Math.abs(alibabaEurPaid)
      : isUsd ? 0
      : fields.gross_amount_minor != null
        ? (fields.meta?.is_refund ? Math.abs(fields.gross_amount_minor) : -Math.abs(fields.gross_amount_minor))
        : 0,
    currency_code: useAlibabaEur ? 'EUR' : isUsd ? 'USD' : fields.currency_code,
    supplier_name: fields.seller_name ?? undefined,
    vat_amount_minor: fields.vat_amount_minor != null
      ? (fields.meta?.is_refund ? Math.abs(fields.vat_amount_minor) : -Math.abs(fields.vat_amount_minor))
      : undefined,
    vat_rate: fields.vat_rate ?? undefined,
    filename: storedFilename ?? undefined,
    meta: docMeta,
  };
  insertDoc(db, doc, docMeta);
  results.push({ docId, doc });

  return { documents: results, primaryDocId: docId };
}
