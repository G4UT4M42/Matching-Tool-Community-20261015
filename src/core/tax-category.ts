/**
 * Tax category classification for expense invoices.
 *
 * AT  = Austrian supplier (domestic)
 * IGL = Innergemeinschaftliche Lieferung (EU, 0% or no tax)
 * RC  = Reverse Charge (non-EU, 0% or no tax)
 *
 * If tax > 0% and country is not AT, no category is assigned (null).
 */

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

/**
 * Determine tax category from country code and tax rate.
 * @param country  ISO 2-letter country code (e.g. "AT", "DE", "US") or country name
 * @param taxRate  Tax rate as whole number percent (e.g. 20, 0) or null/undefined
 * @returns "AT" | "IGL" | "RC" | null
 */
export function getTaxCategory(country: string | undefined | null, taxRate: number | undefined | null): string | null {
  if (!country) return null;

  // Normalize: take first 2 chars, uppercase
  const code = normalizeCountryCode(country);
  if (!code) return null;

  if (code === 'AT') return 'AT';

  const isZeroTax = taxRate == null || taxRate === 0;
  if (!isZeroTax) return null;

  if (EU_COUNTRIES.has(code)) return 'IGL';
  return 'RC';
}

/** Try to extract a 2-letter ISO country code from various formats */
function normalizeCountryCode(input: string): string | null {
  const s = input.trim().toUpperCase();
  if (s.length === 2 && /^[A-Z]{2}$/.test(s)) return s;

  // Common German names → codes
  const MAP: Record<string, string> = {
    'ÖSTERREICH': 'AT', 'AUSTRIA': 'AT',
    'DEUTSCHLAND': 'DE', 'GERMANY': 'DE',
    'FRANKREICH': 'FR', 'FRANCE': 'FR',
    'ITALIEN': 'IT', 'ITALY': 'IT',
    'SPANIEN': 'ES', 'SPAIN': 'ES',
    'NIEDERLANDE': 'NL', 'NETHERLANDS': 'NL', 'HOLLAND': 'NL',
    'BELGIEN': 'BE', 'BELGIUM': 'BE',
    'LUXEMBURG': 'LU', 'LUXEMBOURG': 'LU',
    'POLEN': 'PL', 'POLAND': 'PL',
    'TSCHECHIEN': 'CZ', 'CZECH REPUBLIC': 'CZ', 'CZECHIA': 'CZ',
    'UNGARN': 'HU', 'HUNGARY': 'HU',
    'RUMÄNIEN': 'RO', 'ROMANIA': 'RO',
    'BULGARIEN': 'BG', 'BULGARIA': 'BG',
    'KROATIEN': 'HR', 'CROATIA': 'HR',
    'SLOWAKEI': 'SK', 'SLOVAKIA': 'SK',
    'SLOWENIEN': 'SI', 'SLOVENIA': 'SI',
    'GRIECHENLAND': 'GR', 'GREECE': 'GR',
    'PORTUGAL': 'PT',
    'IRLAND': 'IE', 'IRELAND': 'IE',
    'DÄNEMARK': 'DK', 'DENMARK': 'DK',
    'SCHWEDEN': 'SE', 'SWEDEN': 'SE',
    'FINNLAND': 'FI', 'FINLAND': 'FI',
    'ESTLAND': 'EE', 'ESTONIA': 'EE',
    'LETTLAND': 'LV', 'LATVIA': 'LV',
    'LITAUEN': 'LT', 'LITHUANIA': 'LT',
    'MALTA': 'MT',
    'ZYPERN': 'CY', 'CYPRUS': 'CY',
    'VEREINIGTE STAATEN': 'US', 'USA': 'US', 'UNITED STATES': 'US',
    'VEREINIGTES KÖNIGREICH': 'GB', 'GROSSBRITANNIEN': 'GB', 'UNITED KINGDOM': 'GB', 'UK': 'GB',
    'SCHWEIZ': 'CH', 'SWITZERLAND': 'CH',
    'CHINA': 'CN',
    'JAPAN': 'JP',
    'KANADA': 'CA', 'CANADA': 'CA',
    'AUSTRALIEN': 'AU', 'AUSTRALIA': 'AU',
    'INDIEN': 'IN', 'INDIA': 'IN',
    'TÜRKEI': 'TR', 'TURKEY': 'TR', 'TÜRKIYE': 'TR',
    'SINGAPUR': 'SG', 'SINGAPORE': 'SG',
    'HONGKONG': 'HK', 'HONG KONG': 'HK',
  };

  return MAP[s] ?? null;
}

export { EU_COUNTRIES, normalizeCountryCode };
