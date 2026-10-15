import type { MatchRule } from '../engine.js';
import type { MatchingState } from '../../types.js';
import { createMatch, findSparkasse, findUnmatched } from '../engine.js';
import { daysBetween } from '../../normalization/dates.js';

/**
 * R-BANK-SPK_PAYPAL-001: Sparkasse ↔ PayPal bank transfer
 * Sparkasse has "/PAYPAL" or "PAYPAL" reference → match PayPal "Bankgutschrift" by exact amount.
 *
 * Sparkasse outgoing (negative) = PayPal "Bankgutschrift" (positive, money moved to PayPal for spending)
 * Sparkasse incoming (positive) = PayPal "Bankgutschrift auf PayPal-Konto" amount transferred to bank
 */
export const spkPaypalRule: MatchRule = {
  rule_id: 'R-BANK-SPK_PAYPAL-001',
  description: 'Match Sparkasse PayPal transfers to PayPal Bankgutschrift entries',
  apply(state: MatchingState) {
    // Find PayPal bank transfer entries:
    // - "Bankgutschrift auf PayPal-Konto" (money moved from bank to PayPal)
    // - "Von Nutzer eingeleitete Abbuchung" (money withdrawn from PayPal to bank)
    const ppBankgutschriften = findUnmatched(state, 'paypal', (t) => {
      const typ = (t.meta.typ as string ?? '');
      const eventCode = (t.meta.paypal_event_code as string ?? '');
      // CSV import: typ contains 'Bankgutschrift', 'Abbuchung', or 'Auszahlung'
      // API import: event_code T0300 = bank funding, T0400 = bank withdrawal,
      //             T0500 = general withdrawal, T1107 = payout
      return typ.includes('Bankgutschrift') || typ.includes('Von Nutzer eingeleitete Abbuchung') ||
             typ.includes('Auszahlung') ||
             eventCode === 'T0300' || eventCode === 'T0400' ||
             eventCode === 'T0500' || eventCode === 'T1107';
    });

    for (const pp of ppBankgutschriften) {
      // Find matching Sparkasse entry:
      // - Must mention PAYPAL in description or counterparty
      // - Amount must be opposite sign (SpK outgoing matches PP incoming, and vice versa)
      const spkMatches = findSparkasse(state, (s) => {
        const desc = (s.description_raw ?? '').toUpperCase();
        const partner = (s.counterparty_name ?? '').toUpperCase();
        const isPaypal = desc.includes('PAYPAL') || partner.includes('PAYPAL');
        // Sparkasse amount should be the negative of PayPal amount
        // PP Bankgutschrift positive = SpK outgoing negative (or vice versa)
        return isPaypal && s.amount_minor === -pp.amount_minor;
      });

      if (spkMatches.length === 1) {
        createMatch(state, this.rule_id, [spkMatches[0].transaction_id, pp.transaction_id], [], {
          type: 'transfer',
          paypal_txn: pp.source_row_ref,
        });
      } else if (spkMatches.length > 1) {
        // Multiple matches — pick closest by date (typically 1-3 days apart)
        const sorted = spkMatches
          .map(s => ({ s, days: daysBetween(pp.posting_at, s.posting_at) }))
          .sort((a, b) => a.days - b.days);
        if (sorted[0].days <= 5) {
          createMatch(state, this.rule_id, [sorted[0].s.transaction_id, pp.transaction_id], [], {
            type: 'transfer',
            paypal_txn: pp.source_row_ref,
          });
        }
      }
    }

    // Phase 2: PayPal T0403 refunds ↔ Sparkasse YYW return transfers
    const ppRefunds = findUnmatched(state, 'paypal', (t) =>
      (t.meta.paypal_event_code as string) === 'T0403' && t.amount_minor < 0
    );

    for (const pp of ppRefunds) {
      const absAmt = Math.abs(pp.amount_minor);
      const spkYyw = findSparkasse(state, (s) =>
        String(s.description_raw ?? '').includes('YYW') &&
        s.amount_minor === absAmt &&
        daysBetween(pp.posting_at, s.posting_at) <= 3
      );

      if (spkYyw.length === 1) {
        createMatch(state, this.rule_id, [spkYyw[0].transaction_id, pp.transaction_id], [], {
          type: 'paypal_refund_return',
          paypal_txn: pp.source_row_ref,
        });
      }
    }

    // Phase 3: Fallback — SPK with YYW/PAYPAL ↔ any unmatched PayPal by opposite amount
    // Covers cases where PayPal side is a regular payment (not Bankgutschrift/T0403)
    // but bank shows a corresponding YYW return or PAYPAL transfer
    const spkPaypalRemaining = findSparkasse(state, (s) => {
      const desc = String(s.description_raw ?? '').toUpperCase();
      const partner = (s.counterparty_name ?? '').toUpperCase();
      return desc.includes('YYW') || desc.includes('PAYPAL') || partner.includes('PAYPAL');
    });

    const allPpUnmatched = findUnmatched(state, 'paypal');

    for (const spk of spkPaypalRemaining) {
      const candidates = allPpUnmatched.filter(pp =>
        pp.amount_minor === -spk.amount_minor &&
        daysBetween(spk.posting_at, pp.posting_at) <= 14
      );

      if (candidates.length === 1) {
        createMatch(state, this.rule_id, [spk.transaction_id, candidates[0].transaction_id], [], {
          type: 'paypal_fallback',
          paypal_txn: candidates[0].source_row_ref,
        });
      } else if (candidates.length > 1) {
        const sorted = candidates
          .map(pp => ({ pp, days: daysBetween(spk.posting_at, pp.posting_at) }))
          .sort((a, b) => a.days - b.days);
        if (sorted[0].days <= 10) {
          createMatch(state, this.rule_id, [spk.transaction_id, sorted[0].pp.transaction_id], [], {
            type: 'paypal_fallback',
            paypal_txn: sorted[0].pp.source_row_ref,
          });
        }
      }
    }
  },
};
