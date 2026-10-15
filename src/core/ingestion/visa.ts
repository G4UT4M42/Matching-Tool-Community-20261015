import { readFirstSheet } from './xlsx-reader.js';

export interface VisaRawRow {
  buchungsdatum: Date | number;
  buchungs_details: string;
  eingehender_betrag: number | string | null;
  ausgehender_betrag: number | null;
  waehrung: string;
  buchungsreferenz: string;
  // Legacy match columns
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
  const keys = Object.keys(r);
  for (const n of names) {
    const lower = n.toLowerCase();
    const found = keys.find(k => k.toLowerCase() === lower || k.toLowerCase().replace(/[^a-zäöü0-9]/g, '') === lower.replace(/[^a-zäöü0-9]/g, ''));
    if (found && r[found] != null) return r[found];
  }
  return null;
}

export function parseVisa(filePath: string): VisaRawRow[] {
  const rows = readFirstSheet(filePath);
  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    console.log(`[visa] Parsing ${rows.length} rows, columns: ${headers.join(', ')}`);
  }
  const result: VisaRawRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const buchungsdatum = col(r, 'Buchungsdatum', 'Buchungstag', 'Datum', 'Valutadatum', 'Wertstellungsdatum', 'Transaktionsdatum');
    if (buchungsdatum == null) continue;

    const eingehend = col(r, 'Eingehender Betrag', 'Haben') ?? parseBetrag(col(r, 'Betrag', 'Umsatz'), true);
    const ausgehend = parseNum(col(r, 'Ausgehender Betrag', 'Soll')) ?? parseBetrag(col(r, 'Betrag', 'Umsatz'), false);

    result.push({
      buchungsdatum: buchungsdatum as Date | number,
      buchungs_details: String(col(r, 'Buchungs-Details', 'Verwendungszweck', 'Buchungstext', 'Beschreibung', 'Transaktionsbeschreibung') ?? ''),
      eingehender_betrag: eingehend as number | string | null,
      ausgehender_betrag: ausgehend,
      waehrung: (col(r, 'Währung', 'Waehrung', 'W\u00e4hrung') ?? 'EUR') as string,
      buchungsreferenz: String(col(r, 'Buchungsreferenz', 'Referenz', 'Kundenreferenz') ?? ''),
      file_match: (col(r, 'File Match', 'file match')) as string | null,
      type: col(r, 'type', 'Type', 'Art') as string | null,
      source: col(r, 'source', 'Source') as string | null,
      row_index: i + 1,
    });
  }
  console.log(`[visa] Parsed ${result.length} valid rows from ${rows.length} total`);
  return result;
}

function parseNum(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseBetrag(val: unknown, eingehend: boolean): number | null {
  if (val == null) return null;
  const n = parseNum(val);
  if (n == null || n === 0) return null;
  if (eingehend && n > 0) return n;
  if (!eingehend && n < 0) return n;
  return null;
}
