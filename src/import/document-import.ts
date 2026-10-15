/**
 * Document import service: parses uploaded XLS/CSV files for income or invoice
 * documents and upserts them into SQLite.
 */

import { getDb } from '../storage/db.js';
import { parseIncome } from '../core/ingestion/income.js';
import { parseInvoices } from '../core/ingestion/invoices.js';
import { normalizeIncomeDocument, normalizeInvoiceDocument } from '../core/normalization/normalize-document.js';
import type { Document } from '../core/types.js';

export type DocImportType = 'income' | 'invoice';

export interface DocImportResult {
  type: DocImportType;
  filename: string;
  fetched: number;
  imported: number;
  skipped: number;
  documents: Array<{
    id: string;
    date: string;
    ref: string;
    name: string;
    filename: string;
    amount_minor: number;
    currency: string;
    is_new: boolean;
  }>;
}

export function importDocumentFile(filePath: string, type: DocImportType, originalFilename: string): DocImportResult {
  let normalized: Document[];
  if (type === 'income') {
    const rows = parseIncome(filePath);
    normalized = rows.map(normalizeIncomeDocument);
  } else {
    const rows = parseInvoices(filePath);
    normalized = rows.map(normalizeInvoiceDocument);
  }

  const db = getDb();
  let imported = 0;
  let skipped = 0;

  const checkDoc = db.prepare('SELECT 1 FROM documents WHERE document_id = ?');
  const insertDoc = db.prepare(`
    INSERT INTO documents (
      document_id, source_system, source_document_ref, captured_at,
      document_date, total_amount_minor, currency_code,
      supplier_name, vat_amount_minor, vat_rate, file_hash, filename, meta
    ) VALUES (
      @document_id, @source_system, @source_document_ref, @captured_at,
      @document_date, @total_amount_minor, @currency_code,
      @supplier_name, @vat_amount_minor, @vat_rate, @file_hash, @filename, @meta
    )
  `);
  const upsertDoc = db.prepare(`
    UPDATE documents SET
      document_date = @document_date,
      total_amount_minor = @total_amount_minor,
      currency_code = @currency_code,
      supplier_name = @supplier_name,
      vat_amount_minor = @vat_amount_minor,
      vat_rate = @vat_rate,
      filename = @filename,
      meta = @meta,
      captured_at = @captured_at
    WHERE document_id = @document_id
  `);
  const insertDocDisp = db.prepare(`
    INSERT OR IGNORE INTO document_dispositions (document_id, disposition, set_by)
    VALUES (?, 'open', 'system')
  `);

  const resultDocs: DocImportResult['documents'] = [];

  const run = db.transaction(() => {
    for (const doc of normalized) {
      const exists = checkDoc.get(doc.document_id);
      const docData = {
        document_id: doc.document_id,
        source_system: doc.source_system,
        source_document_ref: doc.source_document_ref,
        captured_at: doc.captured_at,
        document_date: doc.document_date,
        total_amount_minor: doc.total_amount_minor,
        currency_code: doc.currency_code,
        supplier_name: doc.supplier_name ?? null,
        vat_amount_minor: doc.vat_amount_minor ?? null,
        vat_rate: doc.vat_rate ?? null,
        file_hash: doc.file_hash ?? null,
        filename: doc.filename ?? null,
        meta: JSON.stringify(doc.meta),
      };

      const docResult = {
        id: doc.document_id,
        date: doc.document_date,
        ref: doc.source_document_ref,
        name: doc.supplier_name ?? '',
        filename: doc.filename ?? '',
        amount_minor: doc.total_amount_minor,
        currency: doc.currency_code,
        is_new: false,
      };

      if (exists) {
        upsertDoc.run(docData);
        skipped++;
        resultDocs.push(docResult);
        continue;
      }

      insertDoc.run(docData);
      insertDocDisp.run(doc.document_id);
      imported++;
      docResult.is_new = true;
      resultDocs.push(docResult);
    }
  });

  run();

  return {
    type,
    filename: originalFilename,
    fetched: normalized.length,
    imported,
    skipped,
    documents: resultDocs,
  };
}
