import { readFirstSheet } from './xlsx-reader.js';

export interface IncomeRawRow {
  file_name: string;
  bestelldatum: Date | number;
  land: string | null;
  first_name: string | null;
  last_name: string | null;
  transaktionsnummer: string | null; // PayPal txn code or Stripe charge ID
  shipping_method: string | null;
  belegnummer: string; // invoice ref e.g. "IN-25002335"
  verknuepfte_belegnr: string | null;
  order_id: number | string;
  rechnungsdatum: Date | number;
  steuersatz: number;
  brutto: number;
  netto: number;
  steuer: number;
  text: string | null;
  // Legacy match columns
  file_match?: string | null;
  type?: string | null;
  row_index: number;
}

export function parseIncome(filePath: string): IncomeRawRow[] {
  const rows = readFirstSheet(filePath);
  const result: IncomeRawRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r['Bestelldatum'] == null || r['Brutto'] == null) continue;
    result.push({
      file_name: String(r['file name'] ?? ''),
      bestelldatum: r['Bestelldatum'] as Date | number,
      land: r['Land'] as string | null,
      first_name: (r['First Name (Shipping)'] ?? r['First Name']) as string | null,
      last_name: (r['Last Name (Shipping)'] ?? r['Last Name']) as string | null,
      transaktionsnummer: r['Transaktionsnummer'] != null ? String(r['Transaktionsnummer']) : null,
      shipping_method: (r['Shipping Method Title'] ?? r['Shipping Method']) as string | null,
      belegnummer: String(r['Belegnummer'] ?? ''),
      verknuepfte_belegnr: r['verknüpfte Belegnr.'] != null ? String(r['verknüpfte Belegnr.']) : null,
      order_id: r['Order ID'] as number | string,
      rechnungsdatum: r['Rechnungsdatum'] as Date | number,
      steuersatz: parseNum(r['Steuersatz #1'] ?? r['Steuersatz']) ?? 0,
      brutto: parseNum(r['Brutto']) ?? 0,
      netto: parseNum(r['Netto']) ?? 0,
      steuer: parseNum(r['Steuer']) ?? 0,
      text: r['text'] as string | null,
      file_match: r['File Match'] as string | null,
      type: r['Type'] as string | null,
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
