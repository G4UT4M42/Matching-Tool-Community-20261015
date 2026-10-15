/**
 * Date normalization utilities.
 * All dates normalized to ISO-8601 with CET timezone offset.
 */

const CET_OFFSET = '+01:00';

/**
 * Convert Excel serial date number to ISO-8601 string.
 * Excel dates: days since 1900-01-01 (with the infamous 1900 leap year bug).
 * 45659 = Jan 2, 2025
 */
export function excelSerialToIso(serial: number): string {
  // Excel serial date to JS Date
  // Excel epoch: 1899-12-30 (accounting for Excel's 1900 leap year bug)
  const excelEpoch = new Date(Date.UTC(1899, 11, 30));
  const ms = excelEpoch.getTime() + serial * 86400000;
  const d = new Date(ms);
  return formatDateIso(d);
}

/**
 * Convert Excel serial date with time fraction to ISO-8601.
 * e.g., 45838.71805555555 = date + time of day
 */
export function excelSerialToIsoDateTime(serial: number): string {
  const excelEpoch = new Date(Date.UTC(1899, 11, 30));
  const ms = excelEpoch.getTime() + serial * 86400000;
  const d = new Date(ms);
  return d.toISOString().replace('Z', CET_OFFSET);
}

/**
 * Convert a Date object or Excel serial to ISO-8601 date string.
 */
export function normalizeDate(val: Date | number | string | null | undefined): string {
  if (val == null) return '';
  if (val instanceof Date) return formatDateIso(val);
  if (typeof val === 'number') return excelSerialToIso(val);

  const s = String(val).trim();

  // German date format: DD.MM.YYYY or DD.MM.YY
  const deMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (deMatch) {
    const day = parseInt(deMatch[1]);
    const month = parseInt(deMatch[2]);
    let year = parseInt(deMatch[3]);
    if (year < 100) year += year > 50 ? 1900 : 2000;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (!isNaN(d.getTime())) return formatDateIso(d);
  }

  // Slash format: DD/MM/YYYY or MM/DD/YYYY (assume DD/MM for European context)
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const day = parseInt(slashMatch[1]);
    const month = parseInt(slashMatch[2]);
    let year = parseInt(slashMatch[3]);
    if (year < 100) year += year > 50 ? 1900 : 2000;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (!isNaN(d.getTime())) return formatDateIso(d);
  }

  // Try parsing ISO string or other formats
  const d = new Date(s);
  if (!isNaN(d.getTime())) return formatDateIso(d);
  return '';
}

/** Format a JS Date as "YYYY-MM-DDT00:00:00+01:00" */
function formatDateIso(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}T00:00:00${CET_OFFSET}`;
}

/** Extract just the date portion "YYYY-MM-DD" */
export function toDateOnly(isoString: string): string {
  return isoString.slice(0, 10);
}

/** Compute day difference between two ISO date strings */
export function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1.slice(0, 10));
  const d2 = new Date(date2.slice(0, 10));
  return Math.abs(Math.round((d1.getTime() - d2.getTime()) / 86400000));
}
