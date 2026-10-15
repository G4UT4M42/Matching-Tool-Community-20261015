/**
 * Learn extraction templates from confirmed reviews.
 */
import type { ExtractedFields, InvoiceTemplate, TemplatePatterns, TemplateFieldPattern, FieldRegion, StoredOcrWord } from './types.js';
import { templateId as makeTemplateId } from './ids.js';
import { getTemplate, upsertTemplate } from './store.js';
import { fromMinor } from '../core/normalization/amount.js';
import { createHash } from 'crypto';

const OWNER_NAMES = /^(?:firma\s+)?michael\s+Fictional$/i;
const OWNER_VAT_IDS = new Set(['DEMO_INVALID_TAX_ID']);

export function layoutFingerprint(rawText: string, words: StoredOcrWord[] = []): string {
  const labelPattern = /^(?:rechnung|invoice|belegdatum|belegnummer|rechnungsdatum|gesamtbetrag|brutto|netto|nettobetrag|mwst|ust-betrag|uid-nr|iban|total)$/i;
  const spatialLabels = words
    .filter(word => labelPattern.test(word.text.replace(/[:.]/g, '')))
    .map(word => `${word.text.toLowerCase().replace(/[:.]/g, '')}@${Math.round(word.x * 50)},${Math.round(word.y * 50)}`)
    .sort()
    .join('|');
  const semanticLabels = (rawText.toLowerCase().match(/rechnung|invoice|belegdatum|belegnummer|rechnungsdatum|gesamtbetrag|brutto|netto|nettobetrag|mwst|ust-betrag|uid-nr|iban|total/g) ?? []).join('|');
  return createHash('sha256').update(spatialLabels || semanticLabels).digest('hex').slice(0, 12);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildContextPattern(rawText: string, value: string, fieldHint: string): TemplateFieldPattern | null {
  const idx = rawText.indexOf(value);
  if (idx === -1) return null;

  // Get up to 30 chars before the value as context anchor
  const beforeStart = Math.max(0, idx - 30);
  const before = rawText.slice(beforeStart, idx).trim();

  // Use the last meaningful word/phrase before the value
  const contextWords = before.split(/\s+/).filter(w => w.length > 2);
  const anchorWords = contextWords.length > 0 ? contextWords.slice(-2) : [fieldHint];
  const escapedAnchor = anchorWords.map(escapeRegex).join('\\s+');
  const regex = `${escapedAnchor}[:\\s]*([^\\n]{1,60})`;

  return { regex, group: '1' };
}

function buildAmountPattern(rawText: string, amountMinor: number): TemplateFieldPattern | null {
  const amountStr = formatGerman(fromMinor(amountMinor));
  return buildContextPattern(rawText, amountStr, 'Betrag');
}

function formatGerman(n: number): string {
  // Format as German number: 1.234,56
  const parts = Math.abs(n).toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (n < 0 ? '-' : '') + intPart + ',' + parts[1];
}

export function learnTemplate(fields: ExtractedFields, rawText: string, fieldRegions?: Record<string, FieldRegion>, words: StoredOcrWord[] = []): InvoiceTemplate {
  const vendorName = fields.seller_name ?? 'Unknown';
  const vendorVatId = fields.seller_vat_id ?? undefined;
  if (OWNER_NAMES.test(vendorName) || (vendorVatId && OWNER_VAT_IDS.has(vendorVatId.replace(/\s/g, '').toUpperCase()))) {
    throw new Error('Die eigene Firma bzw. Käufer-UID darf nicht als Lieferantenvorlage gespeichert werden');
  }
  const fingerprint = layoutFingerprint(rawText, words);
  const tmplId = makeTemplateId(vendorName, vendorVatId, fingerprint);

  // Build vendor anchors
  const anchors: string[] = [];
  if (fields.seller_name && !OWNER_NAMES.test(fields.seller_name)) anchors.push(fields.seller_name);
  if (fields.seller_vat_id && !OWNER_VAT_IDS.has(fields.seller_vat_id.replace(/\s/g, '').toUpperCase())) anchors.push(fields.seller_vat_id);

  // Build field patterns from confirmed values
  const fieldPatterns: Record<string, TemplateFieldPattern> = {};

  if (fields.invoice_number) {
    const p = buildContextPattern(rawText, fields.invoice_number, 'Rechnungsnummer');
    if (p) fieldPatterns['invoice_number'] = p;
  }

  if (fields.invoice_date) {
    // Find the original date format in text (DD.MM.YYYY)
    const dateRe = /(\d{2}\.\d{2}\.\d{4})/;
    const dateMatch = rawText.match(dateRe);
    if (dateMatch) {
      const p = buildContextPattern(rawText, dateMatch[1], 'Datum');
      if (p) {
        fieldPatterns['invoice_date'] = { ...p, format: 'DD.MM.YYYY' };
      }
    }
  }

  if (fields.gross_amount_minor != null) {
    const p = buildAmountPattern(rawText, Math.abs(fields.gross_amount_minor));
    if (p) fieldPatterns['gross_amount_minor'] = p;
  }

  if (fields.net_amount_minor != null) {
    const p = buildAmountPattern(rawText, Math.abs(fields.net_amount_minor));
    if (p) fieldPatterns['net_amount_minor'] = p;
  }

  const now = new Date().toISOString();
  const existing = getTemplate(tmplId);
  const patterns: TemplatePatterns = {
    vendor_anchors: anchors,
    field_patterns: { ...(existing?.patterns.field_patterns ?? {}), ...fieldPatterns },
    page_regions: { ...(existing?.patterns.page_regions ?? {}), ...(fieldRegions ?? {}) },
  };

  const template: InvoiceTemplate = {
    template_id: tmplId,
    vendor_name: vendorName,
    vendor_vat_id: vendorVatId ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    use_count: (existing?.use_count ?? 0) + 1,
    patterns,
    meta: {
      ...(fields.seller_country ? { seller_country: fields.seller_country } : {}),
      ...(fields.currency_code && fields.currency_code !== 'EUR' ? { currency_code: fields.currency_code } : {}),
      ...((fields.meta as any)?.carrier_eust_split ? { carrier_eust_split: true } : {}),
      template_version: 2,
      layout_fingerprint: fingerprint,
      examples: [
        ...(((existing?.meta as any)?.examples ?? []) as any[]),
        { scan_id: fields.scan_id, confirmed_at: now },
      ].slice(-5),
    },
  };

  upsertTemplate(template);
  return template;
}
