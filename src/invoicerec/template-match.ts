/**
 * Match raw text against stored vendor templates.
 */
import type { InvoiceTemplate, ExtractedFields, FieldConfidence, StoredOcrWord } from './types.js';
import { listTemplates, incrementTemplateUseCount } from './store.js';
import { toMinor, parseGermanNumber } from '../core/normalization/amount.js';
import { layoutFingerprint } from './template-learn.js';

const OWNER_ANCHORS = new Set(['fictional business demo', 'demo invoice recipient', 'DEMO_INVALID_TAX_ID']);

export interface TemplateMatchResult {
  template: InvoiceTemplate;
  matchScore: number;
}

export function findMatchingTemplate(rawText: string, words: StoredOcrWord[] = []): TemplateMatchResult | null {
  const templates = listTemplates();
  const textLower = rawText.toLowerCase();

  let best: TemplateMatchResult | null = null;

  for (const tmpl of templates) {
    // Legacy templates were learned without spatial evidence and frequently
    // contain buyer/product text. They remain in the DB for audit/rollback but
    // are not used for extraction.
    if ((tmpl.meta as any)?.template_version !== 2) continue;
    const expectedLayout = (tmpl.meta as any)?.layout_fingerprint;
    if (expectedLayout && expectedLayout !== layoutFingerprint(rawText, words)) continue;
    if (OWNER_ANCHORS.has(tmpl.vendor_name.trim().toLowerCase())) continue;
    if (tmpl.vendor_vat_id && OWNER_ANCHORS.has(tmpl.vendor_vat_id.replace(/\s/g, '').toLowerCase())) continue;
    const anchors = (tmpl.patterns.vendor_anchors ?? [])
      .filter(anchor => !OWNER_ANCHORS.has(anchor.trim().toLowerCase()));
    if (anchors.length === 0) continue;

    let matched = 0;
    for (const anchor of anchors) {
      if (textLower.includes(anchor.toLowerCase())) matched++;
    }

    // All anchors must match
    if (matched < anchors.length) continue;

    const score = matched + (tmpl.use_count * 0.01);
    if (!best || score > best.matchScore) {
      best = { template: tmpl, matchScore: score };
    }
  }

  return best;
}

/** Extract text from OCR words that fall within a spatial region (with padding) */
export function extractTextFromRegion(words: StoredOcrWord[], region: { page: number; x: number; y: number; w: number; h: number }, pad = 0.02): string {
  const filtered = words.filter(w =>
    w.page === region.page &&
    w.x >= region.x - pad &&
    w.y >= region.y - pad &&
    (w.x + w.w) <= (region.x + region.w + pad) &&
    (w.y + w.h) <= (region.y + region.h + pad)
  );
  // Sort by y then x to reconstruct reading order
  filtered.sort((a, b) => {
    const dy = a.y - b.y;
    return Math.abs(dy) > 0.01 ? dy : a.x - b.x;
  });
  return filtered.map(w => w.text).join(' ');
}

export function applyTemplate(scanId: string, rawText: string, tmpl: InvoiceTemplate, ocrWords?: StoredOcrWord[]): Partial<ExtractedFields> {
  const result: Record<string, any> = {};
  const confidence: Record<string, FieldConfidence> = {};

  const patterns = tmpl.patterns.field_patterns ?? {};
  const pageRegions = tmpl.patterns.page_regions ?? {};

  const fields = new Set([...Object.keys(patterns), ...Object.keys(pageRegions)]);
  for (const field of fields) {
    const pattern = patterns[field];
    try {
      // If spatial region exists and OCR words available, try region-based extraction first
      let searchText = rawText;
      let usedSpatial = false;
      if (pageRegions[field] && ocrWords && ocrWords.length > 0) {
        const regionText = extractTextFromRegion(ocrWords, pageRegions[field]);
        if (regionText.length > 0) {
          searchText = regionText;
          usedSpatial = true;
        }
      }

      if (usedSpatial) {
        const spatialValue = parseSpatialValue(field, searchText);
        if (spatialValue != null) {
          result[field] = spatialValue;
          confidence[field] = { value: 0.98, source: 'template_rule' };
          continue;
        }
      }

      if (!pattern) continue;
      const re = new RegExp(pattern.regex, 'im');
      let m = re.exec(searchText);

      // Fallback to full text if spatial extraction didn't match
      if (!m && usedSpatial) {
        m = re.exec(rawText);
      }

      if (m) {
        const groupIdx = parseInt(pattern.group, 10);
        const value = m[groupIdx]?.trim();
        if (value) {
          // Normalize based on field type
          if (field.includes('date')) {
            result[field] = normalizeTemplateDate(value, pattern.format);
          } else if (field.includes('amount') || field === 'net' || field === 'gross' || field === 'vat') {
            const parsed = parseGermanNumber(value);
            if (parsed != null) result[field.endsWith('_minor') ? field : field + '_minor'] = toMinor(parsed);
          } else if (field === 'vat_rate') {
            const rate = parseFloat(value.replace(',', '.'));
            if (!isNaN(rate)) result[field] = rate > 1 ? rate / 100 : rate;
          } else {
            result[field] = value;
          }
          confidence[field] = { value: usedSpatial ? 0.95 : 0.9, source: 'template_rule' };
        }
      }
    } catch {
      // Invalid regex in template, skip
    }
  }

  // Always set seller_name from template if not already extracted
  if (tmpl.vendor_name && tmpl.vendor_name !== 'Unknown') {
    result.seller_name = tmpl.vendor_name;
    confidence.seller_name = { value: 0.95, source: 'template_rule' };
  }

  // Set seller_country from template meta if available
  if ((tmpl.meta as any)?.seller_country) {
    result.seller_country = (tmpl.meta as any).seller_country;
    confidence.seller_country = { value: 0.9, source: 'template_rule' };
  }

  // Set currency from template meta (USD, CHF, GBP)
  if ((tmpl.meta as any)?.currency_code) {
    result.currency_code = (tmpl.meta as any).currency_code;
  }

  // Set EUSt flag from template meta
  if ((tmpl.meta as any)?.carrier_eust_split) {
    if (!result.meta) result.meta = {};
    (result as any).meta.carrier_eust_split = true;
  }

  incrementTemplateUseCount(tmpl.template_id);

  return { ...result, confidence } as Partial<ExtractedFields>;
}

export function parseSpatialValue(field: string, text: string): string | number | null {
  const value = text.trim();
  if (!value) return null;
  if (field.includes('amount')) {
    const match = value.match(/-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+(?:[.,]\d{2})/);
    const parsed = match ? parseGermanNumber(match[0]) : null;
    return parsed == null ? null : toMinor(parsed);
  }
  if (field === 'vat_rate') {
    const match = value.match(/\d{1,2}(?:[.,]\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0].replace(',', '.'));
    return Number.isFinite(parsed) ? (parsed > 1 ? parsed / 100 : parsed) : null;
  }
  if (field.includes('date')) return normalizeTemplateDate(value);
  return value.replace(/^(?:Rechnung|Invoice|Nr\.?|Nummer)\s*[:#]?\s*/i, '').trim();
}

function normalizeTemplateDate(value: string, format?: string): string | null {
  const iso = value.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  // DD.MM.YYYY
  const m = value.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) {
    const day = m[1].padStart(2, '0');
    const month = m[2].padStart(2, '0');
    let year = m[3];
    if (year.length === 2) year = (parseInt(year) > 50 ? '19' : '20') + year;
    return `${year}-${month}-${day}`;
  }
  return null;
}
