import { readFirstSheet } from './xlsx-reader.js';

export interface StripeRawRow {
  id: string;
  type: string; // 'charge' | 'payout' | 'stripe_fee' | 'refund'
  source: string | null;
  amount: number;
  fee: number;
  currency: string;
  created_utc: Date | number;
  available_on_utc: Date | number | null;
  order_id: number | string | null;
  // Legacy match columns
  file_match?: string | null;
  type2?: string | null;
  source2?: string | null;
  row_index: number;
}

export function parseStripe(filePath: string): StripeRawRow[] {
  const rows = readFirstSheet(filePath);
  const result: StripeRawRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r['id'] == null) continue;
    result.push({
      id: String(r['id']),
      type: String(r['Type'] ?? ''),
      source: r['Source'] as string | null,
      amount: parseNum(r['Amount']) ?? 0,
      fee: parseNum(r['Fee']) ?? 0,
      currency: String(r['Currency'] ?? 'eur').toUpperCase(),
      created_utc: r['Created (UTC)'] as Date | number,
      available_on_utc: r['Available On (UTC)'] as Date | number | null,
      order_id: (r['order_id (metadata)'] ?? r['order_id'] ?? null) as number | string | null,
      file_match: r['File Match'] as string | null,
      type2: r['Type2'] as string | null,
      source2: r['Source2'] as string | null,
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
