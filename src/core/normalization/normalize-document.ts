import type { Document } from '../types.js';
import { documentId } from '../ids.js';
import { toMinor } from './amount.js';
import { normalizeDate } from './dates.js';
import type { IncomeRawRow } from '../ingestion/income.js';
import type { InvoiceRawRow } from '../ingestion/invoices.js';
import type { ExtractedInvoiceRawRow } from '../ingestion/extracted-invoices.js';

/**
 * Normalize an Income order into a Document.
 * Income rows represent customer orders (incoming payments) with invoice PDFs.
 */
export function normalizeIncomeDocument(row: IncomeRawRow): Document {
  const amount = toMinor(row.brutto);
  const docDate = normalizeDate(row.rechnungsdatum);

  return {
    document_id: documentId('income', row.belegnummer, row.file_name),
    source_system: 'income',
    source_document_ref: row.belegnummer,
    captured_at: new Date().toISOString(),
    document_date: docDate,
    total_amount_minor: amount, // income is positive
    currency_code: 'EUR',
    supplier_name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || undefined,
    vat_amount_minor: toMinor(row.steuer),
    vat_rate: row.steuersatz > 0 ? row.steuersatz / 100 : undefined,
    filename: row.file_name,
    meta: {
      row_index: row.row_index,
      order_id: row.order_id,
      transaktionsnummer: row.transaktionsnummer,
      land: row.land,
      netto: row.netto,
      text: row.text,
      file_match: row.file_match,
      verknuepfte_belegnr: row.verknuepfte_belegnr,
    },
  };
}

/**
 * Normalize a vendor invoice from invoices.xlsx.
 * These are outgoing payment documents (expenses).
 */
export function normalizeInvoiceDocument(row: InvoiceRawRow): Document {
  // Detect USD-tagged invoices: vendor contains "[USD $]"
  const isUsd = row.vendor.includes('[USD $]') || row.vendor.includes('[USD]') || row.vendor.includes('[dollar');
  const currency = isUsd ? 'USD' : 'EUR';
  const amount = -toMinor(row.sum_value); // expense = negative

  return {
    document_id: documentId('invoice_file', row.invoice_number, row.filename),
    source_system: 'invoice_file',
    source_document_ref: row.invoice_number,
    captured_at: new Date().toISOString(),
    document_date: normalizeDate(row.invoice_date),
    total_amount_minor: amount,
    currency_code: currency,
    supplier_name: row.vendor.replace(/\s*\[.*?\]\s*/g, '').trim(),
    vat_amount_minor: row.vat_value > 0 ? -toMinor(row.vat_value) : undefined,
    vat_rate: row.vat_percent > 0 ? row.vat_percent / 100 : undefined,
    filename: row.filename,
    meta: {
      row_index: row.row_index,
      invoice_country: row.invoice_country,
      ausgaben_kategorie: row.ausgaben_kategorie,
      invoice_number_2: row.invoice_number_2,
      is_usd: isUsd,
    },
  };
}

/**
 * Normalize an extracted invoice from matched.xlsm's extracted_invoice sheet.
 * These are outgoing payment documents (receipts from vendors).
 */
export function normalizeExtractedInvoice(row: ExtractedInvoiceRawRow): Document {
  const amount = row.amount != null ? -toMinor(Math.abs(row.amount)) : 0; // expense = negative

  return {
    document_id: documentId('extracted_invoice', row.invoice_number ?? row.filename, row.filename),
    source_system: 'extracted_invoice',
    source_document_ref: row.invoice_number ?? row.filename,
    captured_at: new Date().toISOString(),
    document_date: normalizeDate(row.invoice_date),
    total_amount_minor: amount,
    currency_code: 'EUR',
    supplier_name: row.vendor ?? undefined,
    vat_amount_minor: row.vat_value != null ? -toMinor(Math.abs(row.vat_value)) : undefined,
    vat_rate: row.vat_percent != null && row.vat_percent > 0 ? row.vat_percent / 100 : undefined,
    filename: row.filename,
    meta: {
      row_index: row.row_index,
      country: row.country,
      category: row.category,
      raw: row.raw,
    },
  };
}
