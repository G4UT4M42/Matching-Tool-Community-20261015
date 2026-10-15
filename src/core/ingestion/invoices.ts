import { readFirstSheet } from './xlsx-reader.js';

export interface InvoiceRawRow {
  filename: string;
  invoice_date: Date | number;
  vendor: string;
  invoice_number: string;
  sum_value: number;
  vat_percent: number;
  vat_value: number;
  invoice_country: string;
  anlagegut: string | null;
  steuer_kategorie: string | null;
  ausgaben_kategorie: string | null;
  invoice_number_2: string | null;
  row_index: number;
}

export function parseInvoices(filePath: string): InvoiceRawRow[] {
  const rows = readFirstSheet(filePath);
  const result: InvoiceRawRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r['filename'] == null || r['vendor'] == null) continue;
    result.push({
      filename: String(r['filename'] ?? ''),
      invoice_date: r['invoice_date'] as Date | number,
      vendor: String(r['vendor'] ?? ''),
      invoice_number: String(r['invoice_number'] ?? ''),
      sum_value: parseNum(r['sum_value']) ?? 0,
      vat_percent: parseNum(r['vat_%']) ?? 0,
      vat_value: parseNum(r['vat_value']) ?? 0,
      invoice_country: String(r['invoice_country'] ?? ''),
      anlagegut: r['anlagegut'] as string | null,
      steuer_kategorie: r['Steuer Kategorie'] as string | null,
      ausgaben_kategorie: r['Ausgaben Kategorie'] as string | null,
      invoice_number_2: r['invoice_number_2'] as string | null,
      row_index: i + 1,
    });
  }
  return result;
}

function parseNum(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
