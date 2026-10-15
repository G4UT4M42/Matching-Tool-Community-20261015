import { getDb } from '../storage/db.js';
import type { ExtractedFields } from './types.js';

type VendorOverride = {
  vendor_key: string;
  name: string | null;
  country: string | null;
  address: string | null;
  vat_id: string | null;
};

const OWNER_VAT_IDS = new Set(['DEMO_INVALID_TAX_ID']);

function normalizeIdentifier(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeAddress(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function issuerVatScore(rawText: string, vatId: string): number {
  const pattern = vatId.split('').join('[^A-Z0-9]{0,3}');
  const re = new RegExp(pattern, 'gi');
  let score = -1;
  for (const match of rawText.matchAll(re)) {
    const context = rawText.slice(Math.max(0, (match.index ?? 0) - 100), match.index).toLowerCase();
    let occurrenceScore = 10;
    if (/(unsere|unser|our|seller|supplier|vendor).{0,45}(uid|vat|ust|mwst)/i.test(context)) occurrenceScore += 100;
    if (/(ihre|ihr|your|buyer|customer|kund).{0,45}(uid|vat|ust|mwst)/i.test(context)) occurrenceScore -= 100;
    score = Math.max(score, occurrenceScore);
  }
  return score;
}

/**
 * Manual supplier records take precedence over OCR/AI results when the issuer
 * UID (or, as a fallback, the issuer address) is present in the document.
 */
export function applyVendorOverride(rawText: string, fields: ExtractedFields): boolean {
  const overrides = getDb().prepare(`
    SELECT vendor_key, name, country, address, vat_id
    FROM vendor_overrides
    WHERE name IS NOT NULL OR vat_id IS NOT NULL OR address IS NOT NULL
  `).all() as VendorOverride[];
  const vatCounts = new Map<string, number>();
  for (const row of overrides) {
    const vat = normalizeIdentifier(row.vat_id);
    if (vat) vatCounts.set(vat, (vatCounts.get(vat) ?? 0) + 1);
  }

  const extractedVatId = normalizeIdentifier(fields.seller_vat_id);
  const textAddress = normalizeAddress(rawText);
  // The raw document is authoritative. AI can mistake a buyer's UID for the
  // seller's UID, which must not select that buyer's vendor record.
  let override: VendorOverride | undefined = overrides
    .filter(row => {
      const vat = normalizeIdentifier(row.vat_id);
      return vat.length >= 6 && !OWNER_VAT_IDS.has(vat) && vatCounts.get(vat) === 1;
    })
    .map(row => ({ row, score: issuerVatScore(rawText, normalizeIdentifier(row.vat_id)) }))
    .filter(({ score }) => score >= 100)
    .sort((a, b) => b.score - a.score)[0]?.row;

  if (!override) {
    override = overrides.find(row => {
      const address = normalizeAddress(row.address);
      return address.length >= 12 && textAddress.includes(address);
    });
  }

  if (!override && extractedVatId.length >= 6 && !OWNER_VAT_IDS.has(extractedVatId) && vatCounts.get(extractedVatId) === 1) {
    override = overrides.find(row => normalizeIdentifier(row.vat_id) === extractedVatId);
  }

  if (!override) return false;

  if (override.name) fields.seller_name = override.name;
  if (override.country) fields.seller_country = override.country;
  if (override.address) fields.seller_address = override.address;
  if (override.vat_id) fields.seller_vat_id = override.vat_id;
  fields.confidence.seller_name = { value: 0.99, source: 'template_rule' };
  fields.confidence.seller_country = { value: 0.99, source: 'template_rule' };
  fields.confidence.seller_address = { value: 0.99, source: 'template_rule' };
  fields.confidence.seller_vat_id = { value: 0.99, source: 'template_rule' };
  fields.meta = { ...fields.meta, vendor_override_key: override.vendor_key };
  return true;
}
