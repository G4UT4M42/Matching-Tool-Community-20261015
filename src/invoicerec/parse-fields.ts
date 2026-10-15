/**
 * Regex-based field extraction from raw invoice text.
 * Supports German and English invoice formats.
 */
import type { ExtractedFields, FieldConfidence, ExtractionSource, TaxLine } from './types.js';
import { toMinor, parseGermanNumber } from '../core/normalization/amount.js';

// ==================== Amount parsing ====================

/** Parse an English-format number string: 1,234.56 → 1234.56 */
function parseEnglishNumber(s: string): number | null {
  // Must have a dot as decimal separator
  if (!s.includes('.')) return null;
  // Remove thousand separators (commas), keep decimal dot
  const cleaned = s.replace(/,/g, '');
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

/** Parse Alibaba's payment-line amounts, including malformed grouped output such as 2.293.01. */
function parseAlibabaPaymentNumber(value: string): number | null {
  const compact = value.replace(/\s/g, '');
  const decimalIndex = Math.max(compact.lastIndexOf('.'), compact.lastIndexOf(','));
  if (decimalIndex < 0 || compact.length - decimalIndex - 1 !== 2) return null;
  const integer = compact.slice(0, decimalIndex).replace(/[.,]/g, '');
  const fraction = compact.slice(decimalIndex + 1);
  if (!/^\d+$/.test(integer) || !/^\d{2}$/.test(fraction)) return null;
  const parsed = Number(`${integer}.${fraction}`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Detect whether text predominantly uses English number format (1,234.56) vs German (1.234,56) */
function detectNumberFormat(text: string): 'de' | 'en' {
  // Count German-format amounts: digits + comma + 2 digits (not preceded by dot-digit pattern like 1.234,56 which is ambiguous)
  const germanHits = (text.match(/\d{1,3}(?:\.\d{3})+,\d{2}/g) ?? []).length;
  // Count English-format amounts: digits + dot + 2 digits after comma-separated thousands
  const englishHits = (text.match(/\d{1,3}(?:,\d{3})+\.\d{2}/g) ?? []).length;
  // Also count simple decimal-dot patterns like 123.45 near $ or USD
  const dollarDot = (text.match(/\$\s*\d+\.\d{2}/g) ?? []).length;
  return (englishHits + dollarDot) > germanHits ? 'en' : 'de';
}

function findAmounts(text: string, fmt?: 'de' | 'en'): number[] {
  const format = fmt ?? detectNumberFormat(text);
  const amounts: number[] = [];
  let m;

  if (format === 'en') {
    // English format: 1,234.56 or 123.45
    const re = /\b(\d{1,3}(?:,\d{3})*\.\d{2})\b/g;
    while ((m = re.exec(text)) !== null) {
      const val = parseEnglishNumber(m[1]);
      if (val != null && val > 0) amounts.push(val);
    }
  }

  // German format: 1.234,56 or 123,45
  const re = /\b(\d{1,3}(?:\.\d{3})*,\d{2})\b/g;
  while ((m = re.exec(text)) !== null) {
    const val = parseGermanNumber(m[1]);
    if (val != null && val > 0) amounts.push(val);
  }

  return amounts;
}

function findAmountNear(text: string, labels: string[], fmt?: 'de' | 'en'): number | null {
  const format = fmt ?? detectNumberFormat(text);
  const candidates: Array<{ value: number; score: number }> = [];

  for (let labelIndex = 0; labelIndex < labels.length; labelIndex++) {
    const label = labels[labelIndex];
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match label followed by optional whitespace/colon/currency and a number
    const re = new RegExp(escaped + '[:\\s]*(?:EUR|USD|CHF|GBP|€|\\$|£)?\\s*([\\d.,]+)', 'ig');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 16);
      // Freight dimensions and quantities are never monetary amounts.
      if (/^\s*(?:KG|LDM|CBM|STK|STÜCK|COLLI|EINHEIT)\b/i.test(after)) continue;
      let value: number | null = null;
      if (format === 'en') {
        value = parseEnglishNumber(m[1]);
      }
      if (value == null) value = parseGermanNumber(m[1]);
      if (value == null) continue;
      const around = text.slice(Math.max(0, m.index - 8), m.index + m[0].length + 20);
      const hasCurrency = /EUR|USD|CHF|GBP|€|\$|£/i.test(around);
      const specificity = Math.max(0, 30 - labelIndex);
      candidates.push({ value, score: specificity + (hasCurrency ? 50 : 0) + Math.min(label.length, 25) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.value ?? null;
}

// ==================== Date parsing ====================

const MONTH_NAMES: Record<string, string> = {
  jan: '01', january: '01', januar: '01', jän: '01',
  feb: '02', february: '02', februar: '02',
  mar: '03', march: '03', mär: '03', märz: '03',
  apr: '04', april: '04',
  may: '05', mai: '05',
  jun: '06', june: '06', juni: '06',
  jul: '07', july: '07', juli: '07',
  aug: '08', august: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', october: '10', okt: '10', oktober: '10',
  nov: '11', november: '11',
  dec: '12', december: '12', dez: '12', dezember: '12',
};

function findDate(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isoRe = new RegExp(escaped + '[\\s\\S]{0,120}?(20\\d{2})-(\\d{1,2})-(\\d{1,2})', 'i');
    const isoMatch = isoRe.exec(text);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
    const re = new RegExp(escaped + '[:\\s]*(\\d{1,2})[./-](\\d{1,2})[./-](\\d{2,4})', 'i');
    const m = re.exec(text);
    if (m) {
      const day = m[1].padStart(2, '0');
      const month = m[2].padStart(2, '0');
      let year = m[3];
      if (year.length === 2) year = (parseInt(year) > 50 ? '19' : '20') + year;
      return `${year}-${month}-${day}`;
    }
    const namedRe = new RegExp(
      escaped + '[:\\s]*(\\d{1,2})\\.?\\s*([A-Za-zäöüÄÖÜ]+)\\s+(\\d{4})',
      'i',
    );
    const named = namedRe.exec(text);
    if (named) {
      const month = MONTH_NAMES[named[2].toLowerCase()];
      if (month) return `${named[3]}-${month}-${named[1].padStart(2, '0')}`;
    }
  }

  // Try English text date formats: "March 15, 2025" or "Jan 5, 2024"
  const textDateRe = /\b([A-Za-zäöüÄÖÜ]+)\s+(\d{1,2}),?\s+(\d{4})\b/g;
  let textDateMatch;
  while ((textDateMatch = textDateRe.exec(text)) !== null) {
    const monthStr = textDateMatch[1].toLowerCase();
    const month = MONTH_NAMES[monthStr];
    if (month) {
      const day = textDateMatch[2].padStart(2, '0');
      return `${textDateMatch[3]}-${month}-${day}`;
    }
  }

  // Try "15. März 2025" / "15 March 2025" format
  const deDateRe = /\b(\d{1,2})\.?\s*([A-Za-zäöüÄÖÜ]+)\s+(\d{4})\b/g;
  let deMatch;
  while ((deMatch = deDateRe.exec(text)) !== null) {
    const monthStr = deMatch[2].toLowerCase();
    const month = MONTH_NAMES[monthStr];
    if (month) {
      const day = deMatch[1].padStart(2, '0');
      return `${deMatch[3]}-${month}-${day}`;
    }
  }

  // Prefer an ISO document date (often printed after a location) over an
  // unrelated footer revision date.
  const isoFallback = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (isoFallback) return `${isoFallback[1]}-${isoFallback[2]}-${isoFallback[3]}`;

  // Fallback: find any DD.MM.YYYY date
  const fallback = /(\d{2})\.(\d{2})\.(\d{4})/.exec(text);
  if (fallback) {
    return `${fallback[3]}-${fallback[2]}-${fallback[1]}`;
  }
  return null;
}

/**
 * Cash-register receipts often contain a second date from the card terminal.
 * Prefer the date printed in the receipt header before the total; terminal OCR
 * can otherwise turn a 2025 receipt into a 2026 document.
 */
function findCashReceiptDate(text: string): string | null {
  if (!/kassenbon|kundenbeleg|bon-id|lieferdatum\s*=\s*kassenbondatum/i.test(text)) return null;
  const totalIndex = text.search(/endsumme|summe\s+in|bruttoumsatz|total\s*-?eft/i);
  const header = totalIndex > 0 ? text.slice(0, totalIndex) : text.slice(0, Math.ceil(text.length * 0.65));
  const match = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(header);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

// ==================== String extraction ====================

function findAfterLabel(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped + '[:\\s]*([^\\n]{2,60})', 'i');
    const m = re.exec(text);
    if (m) return m[1].trim();
  }
  return null;
}

function findVatId(text: string): string | null {
  const ownerIds = new Set(['DEMO_INVALID_TAX_ID']);
  const ids = [...text.matchAll(/\b(AT\s?U\d{8}|DE\s?\d{9}|[A-Z]{2}\s?\d{8,12})\b/gi)]
    .map(match => match[1].replace(/\s/g, '').toUpperCase());
  return ids.find(id => !ownerIds.has(id)) ?? null;
}

function findBuyerVatId(text: string): string | null {
  return /\bAT\s?U75251905\b/i.test(text) ? 'DEMO_INVALID_TAX_ID' : null;
}

function findInvoiceNumber(text: string): string | null {
  // A direct "Rechnung: 123" / "Invoice: 123" marker is stronger than
  // columns whose labels and values may be emitted in a different PDF order.
  const direct = /(?:^|\n)\s*(?:Rechnung|Invoice)\s*[:#]\s*([A-Z0-9][A-Z0-9./_-]{3,39})\b/im.exec(text);
  if (direct) return direct[1].trim();

  // Carrier OCR commonly abbreviates the label ("Rechnungsnr.") and credit
  // notes use "Kreditnummer". Keep this stricter than the generic fallback so
  // prose such as "Rechnung ... an" cannot become the invoice number.
  const labelled = /(?:Rechnungs(?:nummer|nr\.?)|Kredit(?:nummer|nr\.?)|Invoice\s*(?:Number|No\.?|#))\s*[:.]?\s*([A-Z0-9][A-Z0-9./_-]{2,39})\b/i.exec(text);
  if (labelled && /\d/.test(labelled[1])) return labelled[1].trim();

  const labels = [
    'Rechnungsnummer', 'Rechnung Nr', 'Rechnung-Nr', 'Rechnungs-Nr',
    'Invoice Number', 'Invoice No', 'Invoice #', 'Beleg-Nr', 'Belegnummer',
    'Re\\.?-Nr', 'Faktura-Nr',
  ];
  const result = findAfterLabel(text, labels);
  if (result) {
    // Clean: take first token-like value, stop at whitespace + known words
    const clean = result
      .replace(/^[:\s.]+/, '')
      .split(/\s{2,}|\s+(?:Zahlbetrag|Betrag|Datum|Seite|vom)\b/i)[0]
      .trim();
    if (clean.length > 0 && clean.length < 40 && /\d/.test(clean)) return clean;
  }
  return null;
}

// ==================== Country detection ====================

function detectCountry(text: string, vatId: string | null): string | null {
  // From VAT ID prefix
  if (vatId && vatId.length >= 2) {
    const prefix = vatId.slice(0, 2).toUpperCase();
    if (/^[A-Z]{2}$/.test(prefix)) return prefix;
  }

  // From address keywords
  const countryPatterns: [RegExp, string][] = [
    [/\bösterreich\b/i, 'AT'],
    [/\baustria\b/i, 'AT'],
    [/\bwien\b/i, 'AT'],
    [/\bgraz\b/i, 'AT'],
    [/\bdeutschland\b/i, 'DE'],
    [/\bgermany\b/i, 'DE'],
    [/\bberlin\b/i, 'DE'],
    [/\bmünchen\b/i, 'DE'],
    [/\bschweiz\b/i, 'CH'],
    [/\bswitzerland\b/i, 'CH'],
    [/\bunited states\b/i, 'US'],
    [/\busa\b/i, 'US'],
  ];

  for (const [re, code] of countryPatterns) {
    if (re.test(text)) return code;
  }
  return null;
}

// ==================== Seller detection ====================

function detectSeller(text: string): string | null {
  // 1. Try "Verkauft von" / "Sold by" label
  const soldByResult = findAfterLabel(text, ['Verkauft von', 'Sold by', 'Seller', 'Lieferant', 'Absender']);
  if (soldByResult && soldByResult.length > 3 && soldByResult.length < 80) {
    return soldByResult.replace(/[,;]$/, '').trim();
  }

  // 2. Look for company legal form keywords
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 3 && l.length < 120);
  const companyRe = /\b(GmbH|AG|KG|OG|Ltd|Inc|LLC|e\.U\.|SE|S\.A\.|S\.à\.?r\.l|B\.V\.|S\.r\.l)\b/i;
  const skipRe = /^(rechnung|invoice|datum|date|seite|page|bestelldatum|order|nr\.|zwischensumme|ust|mwst)/i;

  // Prefer a standalone legal company line. Native PDF reading order may put
  // the issuer below recipient metadata, so limiting this search to 20 lines
  // incorrectly favors the buyer.
  for (let i = 0; i < lines.length; i++) {
    if (skipRe.test(lines[i])) continue;
    if (/michael\s+Fictional/i.test(lines[i])) continue;
    if (companyRe.test(lines[i])) {
      // Extract just the company name part (up to the legal form + a few chars)
      const match = lines[i].match(/^(.{3,60}?\b(?:GmbH|AG|KG|OG|Ltd|Inc|LLC|e\.U\.|SE|S\.A\.|S\.à\.?r\.l|B\.V\.|S\.r\.l))\b/i);
      if (match) return match[1].replace(/^[-–\s]+/, '').trim();
      if (lines[i].length <= 90) return lines[i].slice(0, 80).replace(/[,;]$/, '').trim();
    }
  }

  return null;
}

// ==================== Tax rate detection ====================

function findTaxRate(text: string): number | null {
  // Match patterns like "20% MwSt", "19% USt", "MwSt 20%", "USt.-Satz: 20,00%"
  const patterns = [
    /(\d{1,2})[,.]?\d*\s*%\s*(?:MwSt|USt|Ust|Mwst|VAT|Steuer)/i,
    /(?:MwSt|USt|Ust|Mwst|VAT|Steuer)[^0-9]*(\d{1,2})[,.]?\d*\s*%/i,
    /Steuersatz[:\s]*(\d{1,2})[,.]?\d*\s*%/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return parseInt(m[1]) / 100;
  }
  return null;
}

function findLabeledTaxSummary(text: string): { net: number; vat: number; gross: number; rate: number } | null {
  const start = text.search(/Nettobetrag\s+Ust-Betrag\s+%\s+Gesamtbetrag\s+Brutto/i);
  if (start < 0) return null;
  const section = text.slice(start, start + 500);
  const values = [...section.matchAll(/(?:EUR|€)\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi)]
    .map(match => parseGermanNumber(match[1]))
    .filter((value): value is number => value != null);
  if (values.length < 3) return null;
  for (let i = 0; i <= values.length - 3; i++) {
    const [net, vat, gross] = values.slice(i, i + 3);
    if (Math.abs((net + vat) - gross) > 0.03) continue;
    const rate = net > 0 ? vat / net : 0;
    if (rate < 0 || rate > 0.30) continue;
    return { net, vat, gross, rate };
  }
  return null;
}

// ==================== EUSt (Einfuhrumsatzsteuer) detection ====================

const CARRIER_NAMES = [
  'ups', 'dhl', 'dhl express', 'dpd', 'td express', 'fedex', 'tnt', 'gls', 'hermes', 'post',
  'österreichische post', 'austrian post',
];

/** EUSt keywords — any of these indicate an import VAT invoice */
const EUST_KEYWORDS = /eust|einfuhrumsatzsteuer|import\s*(?:vat|tax|sales\s*tax)|zoll|customs|verzollung|importabgabe|einfuhrzoll/i;

/** Detect mixed-tax split: service/handling (20% VAT) + EUSt/import (0% or separate) */
export function detectCarrierEustSplit(text: string, taxLines: TaxLine[], grossMinor?: number | null): {
  isCarrierEust: boolean;
  serviceLine: TaxLine | null;  // taxable part (20%)
  eustLine: TaxLine | null;     // EUSt / MwSt-frei part (0%)
} {
  const textLower = text.toLowerCase();
  const isCarrier = CARRIER_NAMES.some(c => textLower.includes(c));

  /** Parse a number that could be German (264,29) or English (264.29) format */
  function parseFlexNumber(s: string): number | null {
    if (/,\d{1,2}$/.test(s)) return parseGermanNumber(s);
    if (/\.\d{2}$/.test(s) && !s.includes(',')) {
      const val = parseFloat(s);
      return isNaN(val) ? null : val;
    }
    // Scanned tables occasionally lose only the decimal comma ("3623" for
    // "36,23"). Amount columns on these carrier summaries always have cents.
    if (/^\d{3,6}$/.test(s)) return Number(s) / 100;
    return parseGermanNumber(s);
  }

  // Check for EUSt keywords — trigger on ANY invoice with EUSt, not just carriers
  const hasEust = EUST_KEYWORDS.test(text);
  // OCR tolerant: MwSt/MwsSt/MWSt, and various OCR artifacts like {, (, [, |
  const mwstPre = /mws+t[.\s\-{(|\[]*/.source;
  const hasMwstSplit = new RegExp(`${mwstPre}fre[il]|${mwstPre}pflichtig|steuer[\\s.-]*fre[il]|tax[\\s.-]*free|0[,.]00\\s*%`, 'i').test(text);

  if (!hasEust && !hasMwstSplit) {
    return { isCarrierEust: false, serviceLine: null, eustLine: null };
  }

  // Try to find two separate amount blocks: MwSt-pflichtig and MwSt-frei
  const taxableMatch = text.match(/MwS+t[.\s\-{(|\[]*pflichtig[^\d\n]{0,15}([0-9.,]+)/i);
  const taxFreeMatch = text.match(/MwS+t[.\s\-{(|\[]*fre[il][^\d\n]{0,15}([0-9.,]+)/i);
  const vatMatch = text.match(/(\d{1,2})\s*%\s*MwSt[\.\s:]*([0-9.,]+)/i);

  if (taxableMatch && taxFreeMatch) {
    const taxableNet = parseFlexNumber(taxableMatch[1]);
    const taxFreeNet = parseFlexNumber(taxFreeMatch[1]);
    const vatRate = vatMatch ? parseInt(vatMatch[1]) / 100 : 0.20;
    const vatAmount = vatMatch ? parseFlexNumber(vatMatch[2]) : null;

    if (taxableNet != null && taxFreeNet != null) {
      return {
        isCarrierEust: true,
        serviceLine: {
          rate: vatRate,
          net_minor: toMinor(taxableNet),
          vat_minor: vatAmount != null ? toMinor(vatAmount) : Math.round(toMinor(taxableNet) * vatRate),
        },
        eustLine: {
          rate: 0,
          net_minor: toMinor(taxFreeNet),
          vat_minor: 0,
        },
      };
    }
  }

  // OCR may completely lose the taxable-net row while retaining gross,
  // tax-free amount and VAT. The missing taxable net is then unambiguous.
  if (!taxableMatch && taxFreeMatch && vatMatch && grossMinor != null) {
    const taxFreeNet = parseFlexNumber(taxFreeMatch[1]);
    const vatRate = parseInt(vatMatch[1]) / 100;
    const vatAmount = parseFlexNumber(vatMatch[2]);
    if (taxFreeNet != null && vatAmount != null) {
      const taxableMinor = Math.abs(grossMinor) - toMinor(taxFreeNet) - toMinor(vatAmount);
      if (taxableMinor > 0) {
        return {
          isCarrierEust: true,
          serviceLine: { rate: vatRate, net_minor: taxableMinor, vat_minor: toMinor(vatAmount) },
          eustLine: { rate: 0, net_minor: toMinor(taxFreeNet), vat_minor: 0 },
        };
      }
    }
  }

  // Try alternate patterns: "EUSt ... <amount>" — skip percentage and capture the EUR amount
  // Pattern: "Einfuhrumsatzsteuer  0.00%  €  8.21" → capture 8.21 (after € sign)
  // Also:    "EUSt: 8.21" or "EUSt  €  8.21"
  const eustLabel = /(?:EUSt|EUSL|Einfuhrumsatzsteuer|Import\s*VAT|Importabgabe)/.source;
  const eustSeparators = '[.:\\s/\\-]*';
  const eustAmountMatch = text.match(new RegExp(`(?:EUS[TL]|EUSt)${eustSeparators}(?:Import\\s*VAT)?${eustSeparators}€?\\s*([0-9.,]+)`, 'im'))
    ?? text.match(new RegExp(`${eustLabel}${eustSeparators}(?:\\d+[.,]\\d+\\s*%\\s*)?€?\\s*(?:\\d+[.,]\\d+\\s*)?€\\s*([0-9.,]+)`, 'im'))
    ?? text.match(new RegExp(`(?:^|\\s|[^a-zäöü])${eustLabel}${eustSeparators}€?\\s*([0-9.,]+)`, 'im'))
    ?? text.match(/(?:^|\s)\bZoll\b[:\s]*€?\s*([0-9.,]+)/im);
  const handlingMatch = text.match(/(?:Handling|Abfertigung|Bearbeitung|Bearbeitungsgebühr|Abfertigungsgebühr|Einfuhrzollabfertigungsgebühr|Aufwendungspauschale|Service)[:\s]*€?\s*([0-9.,]+)/i);

  if (eustAmountMatch) {
    const eustVal = parseFlexNumber(eustAmountMatch[1]);
    if (eustVal != null && eustVal > 0) {
      // We have at least the EUSt amount — try to find the service part
      let serviceTaxLine: TaxLine | null = null;
      if (handlingMatch) {
        const handlingVal = parseFlexNumber(handlingMatch[1]);
        const svcVatRate = vatMatch ? parseInt(vatMatch[1]) / 100 : 0.20;
        if (handlingVal != null) {
          serviceTaxLine = {
            rate: svcVatRate,
            net_minor: toMinor(handlingVal),
            vat_minor: Math.round(toMinor(handlingVal) * svcVatRate),
          };
        }
      } else if (taxLines.length > 0) {
        // Use existing parsed tax line as service part
        const withTax = taxLines.find(t => t.rate > 0);
        if (withTax) serviceTaxLine = withTax;
      }

      return {
        isCarrierEust: true,
        serviceLine: serviceTaxLine,
        eustLine: { rate: 0, net_minor: toMinor(eustVal), vat_minor: 0 },
      };
    }
  }

  // Fallback: if we have two tax lines already parsed (one with rate > 0, one with rate 0)
  if (taxLines.length >= 2) {
    const withTax = taxLines.find(t => t.rate > 0);
    const noTax = taxLines.find(t => t.rate === 0);
    if (withTax && noTax) {
      return { isCarrierEust: true, serviceLine: withTax, eustLine: noTax };
    }
  }

  // If carrier + EUSt keyword but no amounts parsed: still flag it for review
  if (isCarrier && hasEust) {
    return { isCarrierEust: true, serviceLine: null, eustLine: null };
  }

  return { isCarrierEust: false, serviceLine: null, eustLine: null };
}

// ==================== Main extraction ====================

export function parseFields(scanId: string, rawText: string, source: ExtractionSource): ExtractedFields {
  const confidence: Record<string, FieldConfidence> = {};
  const confVal = source === 'template_rule' ? 0.9 : source === 'pdf_text' ? 0.7 : 0.5;

  const setConf = (field: string, val?: number) => {
    confidence[field] = { value: val ?? confVal, source };
  };

  // Invoice number
  let invoiceNumber = findInvoiceNumber(rawText);
  if (invoiceNumber) setConf('invoice_number');

  // Date
  let invoiceDate = findCashReceiptDate(rawText) ?? findDate(rawText, [
    'Rechnungsdatum', 'Datum', 'Invoice Date', 'Date', 'Belegdatum', 'Fakturadatum',
  ]);
  if (invoiceDate) setConf('invoice_date');

  // Seller
  let sellerVatId = findVatId(rawText);
  if (sellerVatId) setConf('seller_vat_id');

  let sellerName = detectSeller(rawText);
  if (sellerName) setConf('seller_name', sellerName ? confVal : 0.3);

  let sellerCountry = detectCountry(rawText, sellerVatId);
  if (sellerCountry) setConf('seller_country');

  // Stable issuer fingerprints for the carrier layouts used by the business.
  // OCR often damages the legal suffix or one VAT-ID digit, while the carrier
  // name and the issuer-specific VAT label remain unambiguous.
  if (/FedEx\s+Express\s+Austria|\bFedEx\b/i.test(rawText)) {
    sellerName = 'FedEx Express Austria GmbH';
    sellerVatId = 'DEMO_INVALID_TAX_ID';
    sellerCountry = 'AT';
    setConf('seller_name', 0.99);
    setConf('seller_vat_id', 0.99);
    setConf('seller_country', 0.99);
  } else if (/United\s+Parcel\s+Service|UPS\s+USt-ID-Nr/i.test(rawText)) {
    sellerName = 'United Parcel Service Speditionsgesellschaft m.b.H.';
    sellerVatId = 'DEMO_INVALID_TAX_ID';
    sellerCountry = 'AT';
    setConf('seller_name', 0.99);
    setConf('seller_vat_id', 0.99);
    setConf('seller_country', 0.99);
  }

  // --- Alibaba.com B2B receipt detection (NOT AliExpress) ---
  // Alibaba.com B2B receipts have specific markers: Trade Assurance, biz.alibaba.com,
  // "Alibaba.com order protection", Order Management. AliExpress is a DIFFERENT platform.
  const hasAliExpress = /\baliexpress\b/i.test(rawText);
  const isAlibabaCom = !hasAliExpress && (
    /biz\.alibaba\.com/i.test(rawText) ||
    /alibaba\.com\s*order\s*protection/is.test(rawText) ||
    /alibaba\.com\s*reserves\s*the\s*right/is.test(rawText) ||
    /Payment\s*processing\s*fee.*alibaba\.com/is.test(rawText) ||
    /Trade\s*Assurance/i.test(rawText) ||
    (/alibaba\.com/i.test(rawText) && /Order\s*Management/i.test(rawText))
  );

  if (isAlibabaCom) {
    sellerName = 'Alibaba.com';
    sellerCountry = 'SG';
    // The VAT number printed in this receipt section belongs to the buyer.
    sellerVatId = null;
    setConf('seller_name', 0.95);
    setConf('seller_country', 0.95);

    const orderNumber = rawText.match(
      /(?:Receipt|Order)\s*(?:number|#)?\s*[:#]?\s*#?(\d{10,})/i,
    )?.[1];
    if (orderNumber) {
      invoiceNumber = orderNumber;
      setConf('invoice_number', 0.99);
    }
  }

  // Currency — detect early so we can use the right number format for amounts
  const euroMatches = (rawText.match(/€|EUR\b/gi) ?? []).length;
  const usdMatches = (rawText.match(/\$\s?\d|USD\b/gi) ?? []).length;
  const gbpMatches = (rawText.match(/£\s?\d|GBP\b/gi) ?? []).length;
  const hasCHF = /CHF/i.test(rawText);
  const currency = hasCHF ? 'CHF'
    : (usdMatches > euroMatches && usdMatches > 0) ? 'USD'
    : (gbpMatches > euroMatches && gbpMatches > 0) ? 'GBP'
    : 'EUR';

  // Detect number format from text (English: 1,234.56 vs German: 1.234,56)
  const numFmt = detectNumberFormat(rawText);
  // For USD/GBP invoices, prefer English format even if autodetect is ambiguous
  const fmt: 'de' | 'en' = (currency === 'USD' || currency === 'GBP') ? 'en' : numFmt;

  // Amounts — use detected number format
  const dueAmountMatch = /F.lliger\s+(?:Gesamt)?betrag\s*(?:EUR\s*)?([0-9][\d.,]*)\s*(?:EUR)?/i.exec(rawText);
  const dueAmount = dueAmountMatch
    ? (fmt === 'en' ? parseEnglishNumber(dueAmountMatch[1]) : parseGermanNumber(dueAmountMatch[1]))
    : null;
  const grossAmount = dueAmount ?? findAmountNear(rawText, [
    'Fälliger Gesamtbetrag', 'Faelliger Gesamtbetrag', 'Fälliger Betrag', 'Faelliger Betrag',
    'Gesamtkreditbetrag', 'Gesamtbetrag', 'Bruttobetrag', 'Rechnungsbetrag', 'Endbetrag',
    'Total', 'Grand Total', 'Invoice Total', 'Amount Due', 'Balance Due',
    'Total Due', 'Summe brutto', 'Brutto', 'Gesamtsumme', 'Zahlbetrag', 'Gesamtpreis',
  ], fmt);
  if (grossAmount != null) setConf('gross_amount');

  const netAmount = findAmountNear(rawText, [
    'Nettobetrag', 'Summe netto', 'Netto', 'Subtotal', 'Net Total',
    'Zwischensumme', 'Warenwert',
  ], fmt);
  if (netAmount != null) setConf('net_amount');

  const vatSummaryMatch = /(?:Umsatzsteuer|Mehrwertsteuer|MwSt|USt)\s*\d{1,2}[.,]\d{1,2}\s*%\s*(?:EUR|€)?\s*([0-9][\d.,]*)/i.exec(rawText);
  const vatSummaryAmount = vatSummaryMatch
    ? (fmt === 'en' ? parseEnglishNumber(vatSummaryMatch[1]) : parseGermanNumber(vatSummaryMatch[1]))
    : null;
  const vatAmount = vatSummaryAmount ?? findAmountNear(rawText, [
    'MwSt', 'USt', 'Ust', 'Mwst', 'Umsatzsteuer', 'Mehrwertsteuer',
    'VAT', 'Tax', 'Sales Tax', 'Steuer', 'davon MwSt', 'zzgl. MwSt',
  ], fmt);
  if (vatAmount != null) setConf('vat_amount');

  const vatRate = findTaxRate(rawText);
  if (vatRate != null) setConf('vat_rate');

  const labeledTaxSummary = findLabeledTaxSummary(rawText);

  // --- USD/GBP fallback: if no label matched, find largest $-prefixed amount ---
  let finalGrossAmount = grossAmount;
  if (finalGrossAmount == null && (currency === 'USD' || currency === 'GBP')) {
    const symbol = currency === 'USD' ? '\\$' : '£';
    const dollarRe = new RegExp(symbol + '\\s*(\\d{1,3}(?:,\\d{3})*\\.\\d{2})', 'g');
    let maxVal = 0;
    let dm;
    while ((dm = dollarRe.exec(rawText)) !== null) {
      const v = parseEnglishNumber(dm[1]);
      if (v != null && v > maxVal) maxVal = v;
    }
    if (maxVal > 0) {
      finalGrossAmount = maxVal;
      setConf('gross_amount', 0.4); // lower confidence for fallback
    }
  }

  // --- Plausibility: Netto must not exceed Brutto ---
  let finalNet = netAmount != null ? toMinor(netAmount) : null;
  let finalVat = vatAmount != null ? toMinor(vatAmount) : null;
  let finalVatRate = vatRate;
  let finalGross = finalGrossAmount != null ? toMinor(finalGrossAmount) : null;

  // A rate printed immediately after the VAT label is sometimes mistaken for
  // the VAT amount by OCR (for example "Umsatzsteuer 20,00 %"). It can never
  // be greater than or equal to the invoice total.
  if (finalVat != null && finalGross != null && Math.abs(finalVat) >= Math.abs(finalGross)) {
    finalVat = null;
  }

  if (labeledTaxSummary && (finalGross == null || Math.abs(finalGross - toMinor(labeledTaxSummary.gross)) <= 2)) {
    finalNet = toMinor(labeledTaxSummary.net);
    finalVat = toMinor(labeledTaxSummary.vat);
    finalGross = toMinor(labeledTaxSummary.gross);
    finalVatRate = Math.round(labeledTaxSummary.rate * 10_000) / 10_000;
    setConf('net_amount', 0.9);
    setConf('vat_amount', 0.9);
    setConf('gross_amount', 0.9);
    setConf('vat_rate', 0.9);
  }

  if (finalNet != null && finalGross != null && Math.abs(finalNet) > Math.abs(finalGross)) {
    // Netto > Brutto is impossible — discard Netto and USt, keep only Brutto
    finalNet = null;
    finalVat = null;
    finalVatRate = null;
  }

  // Fallback: if gross is null but net exists (e.g. pro-forma without VAT), use net as gross
  if (finalGross == null && finalNet != null) {
    finalGross = finalNet;
    setConf('gross_amount', 0.5);
  }

  // --- If no clear tax rate: keep only Brutto, clear Netto/USt ---
  if (finalVatRate == null) {
    finalNet = null;
    finalVat = null;
  }

  // Build tax lines
  const taxLines: TaxLine[] = [];
  if (finalVatRate != null && finalNet != null && finalVat != null) {
    taxLines.push({
      rate: finalVatRate,
      net_minor: finalNet,
      vat_minor: finalVat,
    });
  }

  // --- USD invoices: store USD amount in meta, leave EUR empty ---
  const metaExtra: Record<string, unknown> = {};
  const isCreditNote = /\b(?:Rechnungskorrektur|Gutschrift|Kredit(?:nummer|betrag|datum)|credit\s+note)\b/i.test(rawText);
  if (isCreditNote) {
    metaExtra.is_refund = true;
    metaExtra.is_credit_note = true;
  }
  if (currency === 'EUR' && finalGross != null) {
    // Payment amount remains the invoice's full payable total even when the
    // accounting representation is split into service and import VAT parts.
    metaExtra.payable_amount_minor = Math.abs(finalGross);
  }
  if (currency === 'USD' && finalGross != null) {
    metaExtra.original_currency = 'USD';
    metaExtra.original_amount_minor = finalGross;
    metaExtra.original_net_minor = finalNet;
    metaExtra.original_vat_minor = finalVat;
    // EUR amounts unknown until matched with a bank transaction
    finalGross = null;
    finalNet = null;
    finalVat = null;
  }

  // --- Alibaba.com B2B receipt: extract EUR paid amount and correct order date ---
  if (isAlibabaCom) {
    metaExtra.is_alibaba = true;
    if (invoiceNumber) metaExtra.alibaba_order_number = invoiceNumber;

    // Use the dated payment lines, not Alibaba's sometimes malformed printed
    // aggregate ("Amount paid EUR 6922.31" for an actual EUR 2,384.24).
    const paymentBreakdown: Array<{ date?: string; amount_minor: number }> = [];
    const paymentLine = /Paid on ([^\n]*?)\s+EUR\s*([\d.,]+)/gi;
    let paymentMatch;
    while ((paymentMatch = paymentLine.exec(rawText)) !== null) {
      const parsed = parseAlibabaPaymentNumber(paymentMatch[2]);
      if (parsed == null || parsed <= 0) continue;
      const dateText = paymentMatch[1].match(/[A-Za-z]+\s+\d{1,2},\s+\d{4}/)?.[0];
      const timestamp = dateText ? Date.parse(`${dateText} UTC`) : Number.NaN;
      paymentBreakdown.push({
        ...(Number.isNaN(timestamp) ? {} : { date: new Date(timestamp).toISOString().slice(0, 10) }),
        amount_minor: Math.round(parsed * 100),
      });
    }

    // Older OCR output can put the EUR value before "Paid on".
    if (paymentBreakdown.length === 0) {
      const legacyPaid = rawText.match(/EUR\s*([\d,.]+)\s*Paid\s+on/i);
      const parsed = legacyPaid ? parseAlibabaPaymentNumber(legacyPaid[1]) : null;
      if (parsed != null && parsed > 0) {
        paymentBreakdown.push({ amount_minor: Math.round(parsed * 100) });
      }
    }
    if (paymentBreakdown.length > 0) {
      metaExtra.alibaba_payment_breakdown = paymentBreakdown;
      metaExtra.alibaba_eur_paid = paymentBreakdown.reduce(
        (sum, payment) => sum + payment.amount_minor,
        0,
      );
    } else {
      // USD-only receipts still need the exact paid amount for FX matching.
      const usdPaid = rawText.match(/Amount\s+paid\s+USD\s*([\d,.]+)/i);
      const parsed = usdPaid ? parseAlibabaPaymentNumber(usdPaid[1]) : null;
      if (parsed != null && parsed > 0) {
        metaExtra.original_currency = 'USD';
        metaExtra.original_amount_minor = Math.round(parsed * 100);
        metaExtra.original_net_minor = null;
        metaExtra.original_vat_minor = null;
        finalGross = null;
        finalNet = null;
        finalVat = null;
      }
    }

    // Extract correct Order date (not receipt generation date)
    // Format 1: "Order Date: 2025-09-26 ..." (OCR text)
    const aliOrderDate = rawText.match(/Order\s*[Dd]ate[:\s]*(\d{4}-\d{2}-\d{2})/);
    if (aliOrderDate) {
      metaExtra.alibaba_order_date = aliOrderDate[1];
      invoiceDate = aliOrderDate[1];
    } else {
      // Format 2: "Order date\n8:58 PM, Sep 26th, 2025 (PDT)" (PDF text extraction)
      const aliDateAlt = rawText.match(/Order\s*date[\s\n\r:]+[\d:]+\s*(?:AM|PM),\s*(\w{3,9})\s+(\d{1,2})\w*,\s*(\d{4})/i);
      if (aliDateAlt) {
        const months: Record<string, string> = {
          Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
          Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'
        };
        const mm = months[aliDateAlt[1].slice(0, 3)] ?? '01';
        const dd = aliDateAlt[2].padStart(2, '0');
        metaExtra.alibaba_order_date = `${aliDateAlt[3]}-${mm}-${dd}`;
        invoiceDate = `${aliDateAlt[3]}-${mm}-${dd}`;
      }
    }
  }

  // --- Detect EUSt split (e.g. UPS, DHL, Zoll with service 20% + EUSt 0%) ---
  // When detected: split the invoice into service part + EUSt part.
  // Main fields show ONLY the service part (Netto: 15, USt 20%: 3, Brutto: 18).
  // EUSt amount stored in meta for the separate EUSt document.
  const eustSplit = detectCarrierEustSplit(rawText, taxLines, finalGross);
  if (eustSplit.isCarrierEust) {
    metaExtra.carrier_eust_split = true;
    metaExtra.expense_category = 'Versand';

    if (eustSplit.eustLine) {
      metaExtra.eust_amount_minor = eustSplit.eustLine.net_minor;
      metaExtra.eust_expense_category = 'EUSt';
    }

    if (eustSplit.serviceLine) {
      metaExtra.service_amount_minor = eustSplit.serviceLine.net_minor;
      metaExtra.service_vat_minor = eustSplit.serviceLine.vat_minor;

      // Keep gross_amount_minor as the full amount shown on the invoice. The
      // tax lines and metadata carry the accounting split; payment creation
      // must never silently reduce the transfer to the service-only amount.
      finalNet = eustSplit.serviceLine.net_minor;
      finalVat = eustSplit.serviceLine.vat_minor;
      finalVatRate = eustSplit.serviceLine.rate;
    }

    // Replace tax lines with structured data
    taxLines.length = 0;
    if (eustSplit.serviceLine) {
      taxLines.push(eustSplit.serviceLine);
    }
    if (eustSplit.eustLine) {
      taxLines.push(eustSplit.eustLine);
    }
  }

  // --- Extract seller email ---
  const emailMatch = rawText.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/);
  if (emailMatch) {
    metaExtra.seller_email = emailMatch[0].toLowerCase();
  }

  // --- Generate internal invoice number if none detected ---
  const finalInvoiceNumber = invoiceNumber ?? `INT-${scanId.slice(5, 21)}`;
  if (!invoiceNumber) setConf('invoice_number', 0.3);

  return {
    scan_id: scanId,
    invoice_number: finalInvoiceNumber,
    invoice_date: invoiceDate,
    seller_name: sellerName,
    seller_address: null,
    seller_country: sellerCountry,
    seller_vat_id: sellerVatId,
    buyer_name: null,
    buyer_vat_id: findBuyerVatId(rawText),
    currency_code: currency,
    net_amount_minor: finalNet,
    vat_amount_minor: finalVat,
    vat_rate: finalVatRate,
    gross_amount_minor: finalGross,
    tax_lines: taxLines,
    line_items: [],
    field_regions: {},
    confidence,
    validation: { warnings: [], errors: [] },
    meta: metaExtra,
  };
}
