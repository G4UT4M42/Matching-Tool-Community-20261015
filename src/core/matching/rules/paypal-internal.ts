import type { MatchRule } from '../engine.js';
import type { MatchingState, Transaction } from '../../types.js';
import { createMatch, findUnmatched, findSparkasse } from '../engine.js';
import { isAvailable } from '../../pipeline.js';
import { daysBetween } from '../../normalization/dates.js';
import { recordAudit } from '../../../observability/audit.js';

/**
 * R-PAYPAL-PAYPAL_INTERNAL-001: PayPal internal transfer pairs
 * PayPal purchase + Bankgutschrift with same Rechnungsnummer → auto-pair.
 * These are internal transfers where money is moved from bank to PayPal to pay for something.
 */
export const paypalInternalPairRule: MatchRule = {
  rule_id: 'R-PAYPAL-PAYPAL_INTERNAL-001',
  description: 'Pair PayPal purchase + Bankgutschrift with same invoice number',
  apply(state: MatchingState) {
    const ppAll = findUnmatched(state, 'paypal');

    // Group by Rechnungsnummer
    const byInvoice = new Map<string, Transaction[]>();
    for (const pp of ppAll) {
      const invNum = pp.meta.rechnungsnummer;
      if (invNum == null || invNum === '') continue;
      const key = String(invNum);
      if (!byInvoice.has(key)) byInvoice.set(key, []);
      byInvoice.get(key)!.push(pp);
    }

    for (const [invNum, group] of byInvoice) {
      if (group.length < 2) continue;

      // Find pairs: one negative (purchase) + one positive (Bankgutschrift)
      const negatives = group.filter((t) => t.amount_minor < 0 && isAvailable(state, t.transaction_id));
      const positives = group.filter((t) => t.amount_minor > 0 && isAvailable(state, t.transaction_id));

      for (const neg of negatives) {
        // Case 1: Exact match (100% funded from card/bank)
        // Only match "Bankgutschrift" entries, not customer incoming payments
        const exactMatch = positives.find((p) =>
          isAvailable(state, p.transaction_id) && p.amount_minor === -neg.amount_minor &&
          (String(p.meta.typ ?? '')).includes('Bankgutschrift')
        );
        if (exactMatch) {
          createMatch(state, this.rule_id, [neg.transaction_id, exactMatch.transaction_id], [], {
            type: 'paypal_internal_pair',
            invoice_number: invNum,
            funding: 'card',
          });
          continue;
        }

        // Case 2: Partial Bankgutschrift — split payment (part from balance, part from card)
        // The Bankgutschrift is SMALLER than the purchase → balance covered the rest
        // IMPORTANT: Only match actual "Bankgutschrift" entries, not customer payments
        const partialMatch = positives.find((p) =>
          isAvailable(state, p.transaction_id) &&
          p.amount_minor > 0 && p.amount_minor < -neg.amount_minor &&
          (String(p.meta.typ ?? '')).includes('Bankgutschrift')
        );
        if (partialMatch) {
          const totalMinor = Math.abs(neg.amount_minor);
          const cardPortion = partialMatch.amount_minor;
          const balancePortion = totalMinor - cardPortion;
          createMatch(state, this.rule_id, [neg.transaction_id, partialMatch.transaction_id], [], {
            type: 'paypal_split_payment',
            invoice_number: invNum,
            funding: 'split',
            total: totalMinor,
            card_portion: cardPortion,
            balance_portion: balancePortion,
          });
        }
      }
    }
  },
};

/**
 * R-PAYPAL-PAYPAL_FX-001: PayPal currency conversion groups
 * Allgemeine Währungsumrechnung pairs - groups of 2-4 transactions for FX conversion
 */
export const paypalFxPairRule: MatchRule = {
  rule_id: 'R-PAYPAL-PAYPAL_FX-001',
  description: 'Group PayPal currency conversion transactions',
  apply(state: MatchingState) {
    const ppFx = findUnmatched(state, 'paypal', (t) =>
      (t.meta.typ as string ?? '').includes('hrungsumrechnung')
    );

    // FX conversions come in pairs: one negative + one positive
    const negFx = ppFx.filter((t) => t.amount_minor < 0);
    const posFx = ppFx.filter((t) => t.amount_minor > 0);

    for (const neg of negFx) {
      if (!isAvailable(state, neg.transaction_id)) continue;

      // Find matching positive FX entry (often same amount or close)
      const match = posFx.find((p) =>
        isAvailable(state, p.transaction_id) &&
        p.amount_minor === -neg.amount_minor
      );

      if (match) {
        createMatch(state, this.rule_id, [neg.transaction_id, match.transaction_id], [], {
          type: 'paypal_fx_conversion',
        });
      }
    }
  },
};

/**
 * R-PAYPAL-PAYPAL_SMALL-001: PayPal small transaction pairs (Lehrerkolleg, etc.)
 * Small PayPal debits + their Bankgutschrift pair with no invoice number
 */
export const paypalSmallPairRule: MatchRule = {
  rule_id: 'R-PAYPAL-PAYPAL_SMALL-001',
  description: 'Pair PayPal small transactions with their Bankgutschrift',
  apply(state: MatchingState) {
    const ppAll = findUnmatched(state, 'paypal');

    // Look for Bankgutschrift entries without Rechnungsnummer
    const bankgutschriften = ppAll.filter((t) =>
      (t.meta.typ as string ?? '').includes('Bankgutschrift') &&
      (t.meta.rechnungsnummer == null || t.meta.rechnungsnummer === '') &&
      isAvailable(state, t.transaction_id)
    );

    for (const bg of bankgutschriften) {
      if (!isAvailable(state, bg.transaction_id)) continue;

      // Find a purchase with opposite amount on the same date
      const match = ppAll.find((p) =>
        p.transaction_id !== bg.transaction_id &&
        isAvailable(state, p.transaction_id) &&
        p.amount_minor === -bg.amount_minor &&
        p.posting_at.slice(0, 10) === bg.posting_at.slice(0, 10) &&
        !(p.meta.typ as string ?? '').includes('Bankgutschrift')
      );

      if (match) {
        createMatch(state, this.rule_id, [bg.transaction_id, match.transaction_id], [], {
          type: 'paypal_small_pair',
        });
      }
    }
  },
};

/**
 * R-PAYPAL-INTERNAL_FUNDING-001: PayPal Purchase + Instant Bank Funding Pair
 * When a PayPal purchase (T0006/T0003/T0007) is funded by an instant bank transfer (T0300)
 * on the same day with the exact same absolute amount, pair them as internal transfer.
 */
export const paypalInstantFundingRule: MatchRule = {
  rule_id: 'R-PAYPAL-INTERNAL_FUNDING-001',
  description: 'Pair PayPal purchases with their instant bank funding (T0300) by amount + same day',
  apply(state: MatchingState) {
    const ppOpen = findUnmatched(state, 'paypal');

    const purchases = ppOpen.filter(t =>
      ['T0006', 'T0003', 'T0007'].includes(t.meta.paypal_event_code as string) &&
      t.amount_minor < 0
    );
    const fundings = ppOpen.filter(t =>
      t.meta.paypal_event_code === 'T0300' && t.amount_minor > 0
    );

    const usedFunding = new Set<string>();

    if (purchases.length > 0 && fundings.length > 0) {
      for (const purchase of purchases) {
        if (!isAvailable(state, purchase.transaction_id)) continue;
        const absAmt = Math.abs(purchase.amount_minor);
        const pDate = new Date(purchase.posting_at.slice(0, 10)).getTime();

        // Find exactly one matching funding: same amount, ±1 day
        const candidates = fundings.filter(f => {
          if (usedFunding.has(f.transaction_id)) return false;
          if (!isAvailable(state, f.transaction_id)) return false;
          if (f.amount_minor !== absAmt) return false;
          const fDate = new Date(f.posting_at.slice(0, 10)).getTime();
          return Math.abs(pDate - fDate) / 86400000 <= 1;
        });

        if (candidates.length === 1) {
          const funding = candidates[0];
          // Look for matching SPK entry: negative PAYPAL transfer with same amount, ±5 days
          const spkMatch = findSparkasse(state, (s) => {
            const desc = String(s.description_raw ?? '').toUpperCase();
            const partner = (s.counterparty_name ?? '').toUpperCase();
            const isPaypal = desc.includes('PAYPAL') || partner.includes('PAYPAL');
            return isPaypal && s.amount_minor === -funding.amount_minor &&
              daysBetween(s.posting_at, purchase.posting_at) <= 5;
          });

          // Only create match if SPK counterpart exists (3-way: SPK + T0300 + Payment)
          // Without SPK, leave both sides unmatched for individual matching
          if (spkMatch.length === 1) {
            createMatch(state, this.rule_id,
              [purchase.transaction_id, funding.transaction_id, spkMatch[0].transaction_id], [], {
                type: 'paypal_instant_funding_with_bank',
                purchase_event: purchase.meta.paypal_event_code,
              });
            usedFunding.add(funding.transaction_id);
          }
        }
      }
    }

    // A purchase may already be matched to its invoice by an earlier waterfall rule.
    // In that case, attach an unmatched T0300 funding entry to the existing expense
    // match only when PayPal supplies the same non-empty invoice reference and the
    // amount/date/currency evidence leaves exactly one candidate.
    const allPaypalPurchases = [...state.transactions.values()].filter(t =>
      t.source_system === 'paypal' &&
      ['T0006', 'T0003', 'T0007'].includes(t.meta.paypal_event_code as string) &&
      t.amount_minor < 0
    );

    for (const funding of fundings) {
      if (usedFunding.has(funding.transaction_id) || !isAvailable(state, funding.transaction_id)) continue;

      const invoiceRef = String(funding.meta.invoice_id ?? '').trim();
      if (!invoiceRef) continue;

      const candidates = allPaypalPurchases.filter(purchase =>
        String(purchase.meta.invoice_id ?? '').trim() === invoiceRef &&
        purchase.amount_minor === -funding.amount_minor &&
        purchase.currency_code === funding.currency_code &&
        daysBetween(purchase.posting_at, funding.posting_at) <= 1
      );
      if (candidates.length !== 1) continue;

      const purchase = candidates[0];
      const existingGroups = [...state.match_groups.values()].filter(group =>
        group.transaction_ids.includes(purchase.transaction_id)
      );
      if (existingGroups.length !== 1) continue;

      const group = existingGroups[0];
      if (
        group.document_ids.length === 0 ||
        group.transaction_ids.length !== 1 ||
        group.amount_total_minor !== purchase.amount_minor
      ) continue;

      const before = {
        ...group,
        transaction_ids: [...group.transaction_ids],
        document_ids: [...group.document_ids],
        evidence: group.evidence ? { ...group.evidence } : undefined,
        reason_codes: [...group.reason_codes],
      };

      group.transaction_ids.push(funding.transaction_id);
      group.amount_total_minor += funding.amount_minor;
      group.evidence = {
        ...(group.evidence ?? {}),
        paypal_funding: {
          type: 'paypal_referenced_internal_funding',
          funding_transaction_id: funding.transaction_id,
          purchase_transaction_id: purchase.transaction_id,
          invoice_reference: invoiceRef,
          amount_minor: funding.amount_minor,
          date_window_days: 1,
        },
      };
      state.matched_transaction_ids.add(funding.transaction_id);

      recordAudit(state, 'MATCHGROUP_MERGE', 'MatchGroup', group.match_group_id, {
        before: before as unknown as Record<string, unknown>,
        after: group as unknown as Record<string, unknown>,
        reason: 'Unique PayPal T0300 funding merged by exact invoice reference, opposite amount, currency, and date.',
      });
    }
  },
};
