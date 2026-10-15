import XLSX from 'xlsx';
import { readFileSync } from 'fs';

export type RawRow = Record<string, unknown>;

export interface SheetData {
  sheetName: string;
  headers: string[];
  rows: RawRow[];
  /** Rows with all values as formatted strings (raw: false). Useful for German number parsing. */
  formattedRows: RawRow[];
}

/** Read an XLSX file and return all sheets as typed row arrays */
export function readXlsx(filePath: string, sheetName?: string): SheetData[] {
  // For CSV files: detect encoding and separator
  const ext = filePath.toLowerCase();
  let wb;
  if (ext.endsWith('.csv')) {
    let raw: string;
    const buf = readFileSync(filePath);

    // Detect UTF-16 LE BOM (FF FE) or UTF-16 BE BOM (FE FF)
    if ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF)) {
      const encoding: BufferEncoding = buf[0] === 0xFF ? 'utf16le' : 'utf16le';
      raw = buf.toString(encoding);
      // Remove BOM
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    } else {
      raw = buf.toString('utf-8');
      // Remove UTF-8 BOM
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    }

    // Detect separator: tab, semicolon, or comma
    const firstLine = raw.split('\n')[0] ?? '';
    const FS = firstLine.includes('\t') ? '\t' : firstLine.includes(';') ? ';' : ',';
    wb = XLSX.read(raw, { type: 'string', cellDates: true, cellNF: true, FS });
  } else {
    wb = XLSX.readFile(filePath, { cellDates: true, cellNF: true });
  }
  const sheetNames = sheetName ? [sheetName] : wb.SheetNames;

  return sheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws) throw new Error(`Sheet "${name}" not found in ${filePath}`);

    // Get raw JSON with headers
    const jsonRows = XLSX.utils.sheet_to_json<RawRow>(ws, { defval: null, raw: false });
    const headers = jsonRows.length > 0 ? Object.keys(jsonRows[0]) : [];

    // Also get raw values (numbers, dates preserved)
    const rawRows = XLSX.utils.sheet_to_json<RawRow>(ws, { defval: null });

    return { sheetName: name, headers, rows: rawRows, formattedRows: jsonRows };
  });
}

/** Read a single sheet, return just the rows */
export function readSheet(filePath: string, sheetName: string): RawRow[] {
  const sheets = readXlsx(filePath, sheetName);
  return sheets[0]?.rows ?? [];
}

/** Read first sheet */
export function readFirstSheet(filePath: string): RawRow[] {
  const sheets = readXlsx(filePath);
  if (sheets.length === 0) return [];
  // Merge: for numeric values where the xlsx library may have misinterpreted
  // German number format (e.g. "1.234,56" → wrong raw number), keep the
  // formatted string so that downstream parseNum() can handle it correctly.
  const { rows, formattedRows } = sheets[0];
  return rows.map((raw, i) => {
    const fmt = formattedRows[i];
    if (!fmt) return raw;
    const merged: RawRow = { ...raw };
    for (const key of Object.keys(raw)) {
      if (typeof raw[key] === 'number' && typeof fmt[key] === 'string') {
        const fmtStr = fmt[key] as string;
        // Detect German number format: contains comma as decimal separator
        // e.g. "669,22" or "1.234,56" or "-11,59"
        if (/^-?[\d.]+,\d{2}$/.test(fmtStr)) {
          merged[key] = fmtStr;
        }
      }
    }
    return merged;
  });
}
