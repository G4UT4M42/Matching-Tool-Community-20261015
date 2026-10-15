import { readFirstSheet, type RawRow } from './xlsx-reader.js';

export interface SparkasseRawRow {
  buchungsdatum: Date | number;
  partnername: string | null;
  partner_iban: string | null;
  eingehender_betrag: number | null;
  ausgehender_betrag: number | null;
  waehrung: string;
  buchungsreferenz: string;
  zahlungsreferenz: string | null;
  buchungs_details: string | null;
  // Legacy match columns (for ground truth comparison)
  file_match?: string | null;
  type?: string | null;
  source?: string | null;
  row_index: number;
}

/** Flexible column lookup — tries multiple possible names */
function col(r: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (r[n] != null) return r[n];
  }
  // Case-insensitive fallback
  const keys = Object.keys(r);
  for (const n of names) {
    const lower = n.toLowerCase();
    const found = keys.find(k => k.toLowerCase() === lower || k.toLowerCase().replace(/[^a-zäöü0-9]/g, '') === lower.replace(/[^a-zäöü0-9]/g, ''));
    if (found && r[found] != null) return r[found];
  }
  return null;
}

export function parseSparkasse(filePath: string): SparkasseRawRow[] {
  const rows = readFirstSheet(filePath);
  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    console.log(`[sparkasse] Parsing ${rows.length} rows, columns: ${headers.join(', ')}`);
  }
  const result: SparkasseRawRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const buchungsdatum = col(r, 'Buchungsdatum', 'Buchungstag', 'Valutadatum', 'Datum', 'Wertstellungsdatum');
    if (buchungsdatum == null) continue;

    const eingehend = parseNum(col(r, 'Eingehender Betrag', 'Haben')) ?? parseBetrag(col(r, 'Betrag', 'Umsatz'), true);
    const ausgehend = parseNum(col(r, 'Ausgehender Betrag', 'Soll')) ?? parseBetrag(col(r, 'Betrag', 'Umsatz'), false);

    result.push({
      buchungsdatum: buchungsdatum as Date | number,
      partnername: col(r, 'Partnername', 'Auftraggeber/Empfänger', 'Beguenstigter/Zahlungspflichtiger', 'Name', 'Empfänger', 'Begünstigter') as string | null,
      partner_iban: col(r, 'Partner IBAN', 'IBAN', 'Kontonummer/IBAN') as string | null,
      eingehender_betrag: eingehend,
      ausgehender_betrag: ausgehend,
      waehrung: (col(r, 'Währung', 'Waehrung', 'W\u00e4hrung') ?? 'EUR') as string,
      buchungsreferenz: String(col(r, 'Buchungsreferenz', 'Referenz', 'Kundenreferenz') ?? ''),
      zahlungsreferenz: col(r, 'Zahlungsreferenz', 'Primanota') as string | null,
      buchungs_details: col(r, 'Buchungs-Details', 'Verwendungszweck', 'Buchungstext', 'Vorgang/Verwendungszweck') as string | null,
      file_match: (col(r, 'File Match', 'MATCH')) as string | null,
      type: (col(r, 'Type', 'Art', 'Buchungsart', 'Geschäftsvorfall')) as string | null,
      source: col(r, 'Source') as string | null,
      row_index: i + 1,
    });
  }
  console.log(`[sparkasse] Parsed ${result.length} valid rows from ${rows.length} total`);
  return result;
}

function parseNum(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/**
 * Fallback: single "Betrag" column (signed, German format).
 * Returns the value only for the matching sign:
 *   eingehend=true  → positive values (incoming)
 *   eingehend=false → negative values (outgoing)
 */
function parseBetrag(val: unknown, eingehend: boolean): number | null {
  if (val == null) return null;
  const n = parseNum(val);
  if (n == null || n === 0) return null;
  if (eingehend && n > 0) return n;
  if (!eingehend && n < 0) return n;
  return null;
}
