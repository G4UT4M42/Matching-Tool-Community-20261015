/**
 * Amount parsing and conversion utilities.
 * All amounts stored as integer minor units (cents).
 */

/** Convert a number (float EUR) to integer minor units (cents). Rounds to nearest cent. */
export function toMinor(amount: number): number {
  return Math.round(amount * 100);
}

/** Convert integer minor units back to float */
export function fromMinor(minor: number): number {
  return minor / 100;
}

/**
 * Parse a German-format number string to float.
 * "1.234,56" → 1234.56
 * "37,86" → 37.86
 * "-18,00" → -18.00
 */
export function parseGermanNumber(val: string | number | null | undefined): number | null {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  const s = String(val).trim();
  if (s === '' || s === '-') return null;
  // Remove thousand separators (dots), then replace decimal comma with dot
  const normalized = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(normalized);
  return isNaN(n) ? null : n;
}

/**
 * Parse any numeric value to cents.
 * Handles: number, German-format string, null.
 */
export function toCents(val: string | number | null | undefined): number {
  if (val == null) return 0;
  if (typeof val === 'number') return toMinor(val);
  const parsed = parseGermanNumber(val);
  return parsed != null ? toMinor(parsed) : 0;
}

/**
 * Compute Sparkasse amount from Eingehender/Ausgehender Betrag.
 * Eingehender = incoming (positive), Ausgehender = outgoing (negative).
 */
export function sparkasseAmount(eingehend: number | null, ausgehend: number | null): number {
  if (eingehend != null && eingehend !== 0) return toMinor(eingehend);
  if (ausgehend != null && ausgehend !== 0) return toMinor(ausgehend);
  return 0;
}

/**
 * Compute Visa amount from Eingehender/Ausgehender Betrag.
 * Eingehender can be a string (German format) for "Ihre Zahlung Vormonat".
 */
export function visaAmount(eingehend: string | number | null, ausgehend: number | null): number {
  if (eingehend != null) {
    const val = typeof eingehend === 'string' ? parseGermanNumber(eingehend) : eingehend;
    if (val != null && val !== 0) return toMinor(val);
  }
  if (ausgehend != null && ausgehend !== 0) return toMinor(ausgehend);
  return 0;
}
