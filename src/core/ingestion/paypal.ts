import { readFirstSheet } from './xlsx-reader.js';

export interface PaypalRawRow {
  datum: Date | number;
  typ: string;
  transaktionscode: string;
  name: string | null;
  rechnungsnummer: string | number | null;
  brutto: number;
  // Legacy match columns
  file_match?: string | null;
  type?: string | null;
  source?: string | null;
  row_index: number;
}

export function parsePaypal(filePath: string): PaypalRawRow[] {
  const rows = readFirstSheet(filePath);
  const result: PaypalRawRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r['Datum'] == null || r['Typ'] == null) continue;
    result.push({
      datum: r['Datum'] as Date | number,
      typ: String(r['Typ'] ?? ''),
      transaktionscode: String(r['Transaktionscode'] ?? ''),
      name: r['Name'] as string | null,
      rechnungsnummer: r['Rechnungsnummer'] as string | number | null,
      brutto: parseNum(r['Brutto']) ?? 0,
      file_match: r['File Match'] as string | null,
      type: r['Type'] as string | null,
      source: r['Source'] as string | null,
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
