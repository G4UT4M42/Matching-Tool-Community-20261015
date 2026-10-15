import type { MatchRule } from '../engine.js';
import type { MatchingState } from '../../types.js';
import { createMatch, findSparkasse, findUnmatched } from '../engine.js';

/**
 * R-BANK-SPK_VISA-001: Sparkasse ↔ Visa card payment
 * Sparkasse has "Kreditkartenrechnung" in description → match Visa "Ihre Zahlung Vormonat".
 * Sparkasse amount is negative (outgoing), Visa incoming amount is positive.
 */
export const spkVisaRule: MatchRule = {
  rule_id: 'R-BANK-SPK_VISA-001',
  description: 'Match Sparkasse credit card bill payment to Visa monthly payment',
  apply(state: MatchingState) {
    // Find Visa "Ihre Zahlung Vormonat" entries (incoming payments)
    const visaPayments = findUnmatched(state, 'visa', (t) =>
      String(t.description_raw ?? '').includes('Ihre Zahlung Vormonat') && t.amount_minor > 0
    );

    for (const visa of visaPayments) {
      // Sparkasse outgoing (negative) should match Visa incoming (positive) exactly
      const spkMatches = findSparkasse(state, (s) =>
        s.amount_minor < 0 &&
        String(s.description_raw ?? '').toLowerCase().includes('kreditkartenrechnung') &&
        Math.abs(s.amount_minor) === visa.amount_minor
      );

      if (spkMatches.length === 1) {
        createMatch(state, this.rule_id, [spkMatches[0].transaction_id, visa.transaction_id], [], {
          type: 'transfer',
          description: 'Visa card monthly payment',
        });
      }
    }
  },
};
