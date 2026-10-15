import { readXlsx, type RawRow } from './xlsx-reader.js';

export interface ExtractedInvoiceRawRow {
  filename: string;
  invoice_date: Date | number | null;
  vendor: string | null;
  invoice_number: string | null;
  amount: number | null;
  vat_percent: number | null;
  vat_value: number | null;
  country: string | null;
  category: string | null;
  row_index: number;
  // All raw fields for flexible matching
  raw: Record<string, unknown>;
}

/**
 * Parse the "extracted_invoice" sheet from matched.xlsm
 * This sheet contains outgoing payment documents (receipts/invoices from vendors)
 */
export function parseExtractedInvoices(filePath: string): ExtractedInvoiceRawRow[] {
  const sheets = readXlsx(filePath, 'extracted_invoice');
  if (sheets.length === 0) return [];

  const rows = sheets[0].rows;
  const result: ExtractedInvoiceRawRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // Filter out empty rows - check if at least some meaningful data exists
    const vals = Object.values(r).filter((v) => v != null);
    if (vals.length <= 2) continue;

    // The column names may vary - try to detect them
    const filename = findVal(r, ['filename', 'Filename', 'file', 'File']) as string ?? '';
    const invoice_date = findVal(r, ['invoice_date', 'date', 'Date', 'Datum']);
    const vendor = findVal(r, ['vendor', 'Vendor', 'supplier', 'Supplier', 'Lieferant']) as string | null;
    const invoice_number = findVal(r, ['invoice_number', 'Invoice Number', 'Rechnungsnummer', 'number']) as string | null;
    const amount = parseNum(findVal(r, ['amount', 'Amount', 'sum_value', 'Betrag', 'total']));
    const vat_percent = parseNum(findVal(r, ['vat_%', 'vat_percent', 'MwSt %']));
    const vat_value = parseNum(findVal(r, ['vat_value', 'vat', 'MwSt']));
    const country = findVal(r, ['country', 'Country', 'Land', 'invoice_country']) as string | null;
    const category = findVal(r, ['category', 'Kategorie', 'Ausgaben Kategorie']) as string | null;

    result.push({
      filename,
      invoice_date: invoice_date as Date | number | null,
      vendor,
      invoice_number: invoice_number != null ? String(invoice_number) : null,
      amount,
      vat_percent,
      vat_value,
      country,
      category,
      row_index: i + 1, // Use original sheet position for validate alignment
      raw: r,
    });
  }

  return result;
}

function findVal(row: RawRow, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] != null) return row[key];
  }
  return null;
}

function parseNum(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
