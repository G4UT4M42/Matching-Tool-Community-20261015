import type { MatchRule } from '../engine.js';
import type { MatchingState, Transaction } from '../../types.js';
import { createMatch, findSparkasse, findUnmatched } from '../engine.js';
import { daysBetween } from '../../normalization/dates.js';

/**
 * R-BANK-SPK_STRIPE-001: Sparkasse ↔ Stripe payout
 * Sparkasse has "STRIPE XXXXX" in description → match Stripe payout by exact amount.
 * Stripe payouts are negative (money leaving Stripe), Sparkasse incoming is positive.
 */
export const spkStripePayoutRule: MatchRule = {
  rule_id: 'R-BANK-SPK_STRIPE-001',
  description: 'Match Sparkasse incoming transfers from Stripe to Stripe payout rows',
  apply(state: MatchingState) {
    const stripePayouts = findUnmatched(state, 'stripe', (t) =>
      (t.meta.stripe_type === 'payout')
    );

    for (const payout of stripePayouts) {
      // Stripe payout amount is negative (leaving Stripe), Sparkasse is positive (incoming)
      const payoutAmount = Math.abs(payout.amount_minor);

      // Find matching Sparkasse entry with "STRIPE" in description and same amount
      const spkMatches = findSparkasse(state, (s) => {
        const desc = String(s.description_raw ?? '').toUpperCase();
        return (
          (desc.includes('STRIPE') || (s.counterparty_name ?? '').toUpperCase().includes('STRIPE')) &&
          s.amount_minor === payoutAmount
        );
      });

      if (spkMatches.length === 1) {
        createMatch(state, this.rule_id, [spkMatches[0].transaction_id, payout.transaction_id], [], {
          type: 'transfer',
          stripe_ref: payout.source_row_ref,
        });
      } else if (spkMatches.length > 1) {
        // Multiple Sparkasse entries with same amount — pick the closest by date (typically 1 day before)
        const sorted = spkMatches
          .map(s => ({ s, days: daysBetween(payout.posting_at, s.posting_at) }))
          .sort((a, b) => a.days - b.days);
        if (sorted[0].days <= 3) {
          createMatch(state, this.rule_id, [sorted[0].s.transaction_id, payout.transaction_id], [], {
            type: 'transfer',
            stripe_ref: payout.source_row_ref,
          });
        }
      }
    }
  },
};

/**
 * R-BANK-SPK_STRIPE-002: Sparkasse ↔ Stripe fee debit
 * STRIPE debit from Sparkasse (negative) → matches Stripe stripe_fee row.
 * The Sparkasse description contains "STRIPE MDID:" pattern.
 */
export const spkStripeFeeRule: MatchRule = {
  rule_id: 'R-BANK-SPK_STRIPE-002',
  description: 'Match Sparkasse Stripe fee debits to Stripe stripe_fee rows',
  apply(state: MatchingState) {
    const stripeFees = findUnmatched(state, 'stripe', (t) =>
      t.meta.stripe_type === 'stripe_fee' && t.amount_minor < 0
    );

    // Only handle STRIPE debits from Sparkasse (negative amounts, "STRIPE" counterparty with IE IBAN)
    const spkStripeDebits = findSparkasse(state, (s) =>
      s.amount_minor < 0 &&
      (String(s.description_raw ?? '').includes('STRIPE MDID:') ||
       (s.counterparty_name === 'STRIPE' && (s.counterparty_iban ?? '').startsWith('IE')))
    );

    for (const spk of spkStripeDebits) {
      // Sum all unmatched stripe fees for the period to see if they match the bank debit
      const totalFees = stripeFees.reduce((sum, f) => sum + f.amount_minor, 0);
      if (totalFees === spk.amount_minor && stripeFees.length > 0) {
        const feeIds = stripeFees.map((f) => f.transaction_id);
        createMatch(state, this.rule_id, [spk.transaction_id, ...feeIds], [], {
          type: 'fee_transfer',
        });
        break;
      }
    }
  },
};

/**
 * R-BANK-SPK_STRIPE-003: Sparkasse positive Stripe → Stripe payout (reverse)
 * Handle Stripe refund payouts that result in negative Sparkasse amounts
 */
export const spkStripeRefundRule: MatchRule = {
  rule_id: 'R-BANK-SPK_STRIPE-003',
  description: 'Match Sparkasse Stripe payouts with positive amounts (refund-based)',
  apply(state: MatchingState) {
    const stripePayouts = findUnmatched(state, 'stripe', (t) =>
      t.meta.stripe_type === 'payout' && t.amount_minor > 0
    );

    for (const payout of stripePayouts) {
      const spkMatches = findSparkasse(state, (s) => {
        const desc = String(s.description_raw ?? '').toUpperCase();
        return (
          (desc.includes('STRIPE') || (s.counterparty_name ?? '').toUpperCase().includes('STRIPE')) &&
          s.amount_minor === -payout.amount_minor
        );
      });

      if (spkMatches.length === 1) {
        createMatch(state, this.rule_id, [spkMatches[0].transaction_id, payout.transaction_id], [], {
          type: 'refund_transfer',
        });
      }
    }
  },
};
