import type { MatchRule } from '../engine.js';
import type { MatchingState } from '../../types.js';
import { createMatch, findUnmatched, findUnmatchedDocs } from '../engine.js';
import { isAvailable } from '../../pipeline.js';
import { daysBetween } from '../../normalization/dates.js';
import { fxAmountsMatch } from '../../normalization/fx.js';

/** Parse date that may be YYYY-MM-DD or YYYY-DD-MM (malformed Amazon dates) */
function parseFlexDate(s: string): Date | null {
  // Try ISO first
  let d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  // Try YYYY-DD-MM → YYYY-MM-DD
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    d = new Date(`${m[1]}-${m[3]}-${m[2]}`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/** Safe daysBetween that handles malformed dates, returns null on failure */
function safeDaysBetween(a: string, b: string): number | null {
  const da = parseFlexDate(a);
  const db = parseFlexDate(b);
  if (!da || !db) return null;
  return Math.round(Math.abs(da.getTime() - db.getTime()) / 86400000);
}

/**
 * R-VISA-VISA_INV-001: Visa ↔ invoice/extracted_invoice by amount + date window
 */
export const visaInvoiceAmountRule: MatchRule = {
  rule_id: 'R-VISA-VISA_INV-001',
  description: 'Match Visa transactions to invoices by amount and date proximity',
  apply(state: MatchingState) {
    const visaTxns = findUnmatched(state, 'visa', (t) =>
      t.amount_minor < 0 && !t.tags.includes('fx')
    );

    const allDocs = [
      ...findUnmatchedDocs(state, 'invoice_file'),
      ...findUnmatchedDocs(state, 'extracted_invoice'),
    ];

    for (const visa of visaTxns) {
      if (!isAvailable(state, visa.transaction_id)) continue;
      const absAmount = Math.abs(visa.amount_minor);

      // Find docs with exact amount match within ±5 days
      let candidates = allDocs.filter((d) =>
        !state.matched_document_ids.has(d.document_id) &&
        Math.abs(d.total_amount_minor) === absAmount &&
        d.document_date &&
        daysBetween(visa.posting_at, d.document_date) <= 5
      );

      // Fallback: relax date window to 30 days if no match within 5 days
      if (candidates.length === 0) {
        candidates = allDocs.filter((d) =>
          !state.matched_document_ids.has(d.document_id) &&
          Math.abs(d.total_amount_minor) === absAmount &&
          d.document_date &&
          daysBetween(visa.posting_at, d.document_date) <= 30
        );
      }

      if (candidates.length === 1) {
        createMatch(state, this.rule_id, [visa.transaction_id], [candidates[0].document_id], {
          type: 'visa_invoice_amount_date',
        });
      }
    }
  },
};

/**
 * R-VISA-VISA_INV-002: Visa FX ↔ USD-tagged invoice
 * Visa FX transactions (with "inkl. Fremdwährungsentgelt") → match [USD $] invoices
 */
export const visaFxInvoiceRule: MatchRule = {
  rule_id: 'R-VISA-VISA_INV-002',
  description: 'Match Visa FX transactions to USD-tagged invoices',
  apply(state: MatchingState) {
    const visaFx = findUnmatched(state, 'visa', (t) =>
      t.tags.includes('fx') && t.fx != null && t.amount_minor < 0
    );

    const usdDocs = findUnmatchedDocs(state).filter((d) =>
      d.currency_code === 'USD' || (d.meta.is_usd === true)
    );

    for (const visa of visaFx) {
      if (!visa.fx || !isAvailable(state, visa.transaction_id)) continue;

      for (const doc of usdDocs) {
        if (state.matched_document_ids.has(doc.document_id)) continue;

        // Check if the FX amounts match within tolerance
        if (fxAmountsMatch(visa.amount_minor, doc.total_amount_minor, visa.fx)) {
          createMatch(state, this.rule_id, [visa.transaction_id], [doc.document_id], {
            type: 'visa_fx_invoice',
            rate: visa.fx.rate,
            original_usd: doc.total_amount_minor,
            billed_eur: visa.amount_minor,
          });
          break;
        }
      }
    }
  },
};

/**
 * R-VISA-VISA_AMZN-001: Visa ↔ unmatched Amazon docs
 * Primary: match by fee_recognition field (e.g. "Visa 1234" → Visa booking ref)
 * Fallback: match by amount + date proximity
 */
export const visaAmazonRule: MatchRule = {
  rule_id: 'R-VISA-VISA_AMZN-001',
  description: 'Match Visa transactions to unmatched Amazon invoices by fee recognition or amount+date',
  apply(state: MatchingState) {
    const amazonDocs = findUnmatchedDocs(state, 'amazon');
    if (amazonDocs.length === 0) return;

    // All unmatched Visa transactions (both purchases and refunds)
    const visaTxns = findUnmatched(state, 'visa');

    // Phase 1: Match by fee_recognition reference code
    // Amazon Abgleich "Gebührenerkennung" contains a reference code (e.g. "ZP2PX3GK4")
    // that appears in the Visa description (e.g. "AMZN Mktp DE*ZP2PX3GK4")
    const feeIndex = new Map<string, typeof amazonDocs[0]>();
    for (const doc of amazonDocs) {
      const feeRec = String((doc.meta as any)?.fee_recognition ?? '').trim();
      if (feeRec.length >= 4) feeIndex.set(feeRec.toUpperCase(), doc);
    }

    for (const visa of visaTxns) {
      if (!isAvailable(state, visa.transaction_id)) continue;
      const visaDesc = String(visa.description_raw ?? '').toUpperCase();

      // Search for any fee_recognition code in the visa description
      for (const [code, doc] of feeIndex) {
        if (state.matched_document_ids.has(doc.document_id)) continue;
        if (visaDesc.includes(code)) {
          createMatch(state, this.rule_id, [visa.transaction_id], [doc.document_id], {
            type: 'visa_amazon_fee_recognition',
            fee_recognition: code,
          });
          feeIndex.delete(code);
          break;
        }
      }
    }

    // Phase 2: Fallback — match remaining by amount + date (purchases AND refunds)
    // For purchases (negative): match negative docs within 30 days
    // For refunds (positive): match positive docs within 90 days (refunds arrive late)
    for (const visa of visaTxns) {
      if (!isAvailable(state, visa.transaction_id)) continue;
      const absAmount = Math.abs(visa.amount_minor);
      const isRefund = visa.amount_minor > 0;
      const maxDays = isRefund ? 90 : 30;

      const candidates = amazonDocs.filter((d) => {
        if (state.matched_document_ids.has(d.document_id)) return false;
        if (Math.abs(d.total_amount_minor) !== absAmount) return false;
        // Sign must match: expense → negative doc, refund → positive doc
        if (isRefund && d.total_amount_minor <= 0) return false;
        if (!isRefund && d.total_amount_minor >= 0) return false;
        // Date check (flexible for malformed Amazon dates)
        if (d.document_date) {
          const days = safeDaysBetween(visa.posting_at, d.document_date);
          if (days !== null && days > maxDays) return false;
        }
        return true;
      });

      if (candidates.length >= 1) {
        // Pick closest by date
        const best = candidates.sort((a, b) => {
          const daysA = safeDaysBetween(visa.posting_at, a.document_date) ?? 999;
          const daysB = safeDaysBetween(visa.posting_at, b.document_date) ?? 999;
          return daysA - daysB;
        })[0];
        createMatch(state, this.rule_id, [visa.transaction_id], [best.document_id], {
          type: isRefund ? 'visa_amazon_refund' : 'visa_amazon_amount_date',
        });
      }
    }
  },
};

/**
 * R-VISA-VISA_INV-003: Visa ↔ extracted_invoice by merchant name + amount
 */
export const visaInvoiceMerchantRule: MatchRule = {
  rule_id: 'R-VISA-VISA_INV-003',
  description: 'Match Visa transactions to invoices by merchant name and amount',
  apply(state: MatchingState) {
    const visaTxns = findUnmatched(state, 'visa', (t) => t.amount_minor !== 0);

    const allDocs = [
      ...findUnmatchedDocs(state, 'invoice_file'),
      ...findUnmatchedDocs(state, 'extracted_invoice'),
    ];

    for (const visa of visaTxns) {
      if (!isAvailable(state, visa.transaction_id)) continue;
      const absAmount = Math.abs(visa.amount_minor);
      const desc = String(visa.description_raw ?? '').toUpperCase();

      // Extract merchant name (first part before "inkl." or other markers)
      const merchantName = desc.split(/\s+inkl\./)[0].trim();
      if (merchantName.length < 3) continue;

      const candidates = allDocs.filter((d) => {
        if (state.matched_document_ids.has(d.document_id)) return false;
        if (Math.abs(d.total_amount_minor) !== absAmount) return false;

        const supplierUp = (d.supplier_name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const filenameUp = (d.filename ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const merchantClean = merchantName.replace(/[^A-Z0-9]/g, '');

        // Check if merchant name appears in supplier or filename
        return supplierUp.includes(merchantClean.slice(0, 6)) ||
               filenameUp.includes(merchantClean.slice(0, 6)) ||
               merchantClean.includes(supplierUp.slice(0, 6));
      });

      if (candidates.length === 1) {
        createMatch(state, this.rule_id, [visa.transaction_id], [candidates[0].document_id], {
          type: 'visa_merchant_amount',
          merchant: merchantName,
        });
      }
    }
  },
};
