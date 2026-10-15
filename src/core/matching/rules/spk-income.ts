import type { MatchRule } from '../engine.js';
import type { MatchingState } from '../../types.js';
import { createMatch, findSparkasse, findUnmatchedDocs } from '../engine.js';
import { isAvailable, isDocAvailable } from '../../pipeline.js';
import { daysBetween } from '../../normalization/dates.js';

/**
 * R-BANK-SPK_INCOME-001: Sparkasse ↔ Income direct bank transfer
 * Phase 1: Order ID in Sparkasse description → Income order_id
 * Phase 2: Amount + date range (60 days) fallback
 */
export const spkIncomeRule: MatchRule = {
  rule_id: 'R-BANK-SPK_INCOME-001',
  description: 'Match Sparkasse direct bank transfers to Income orders by order ID or amount+date',
  apply(state: MatchingState) {
    const incomeDocs = findUnmatchedDocs(state, 'income');

    // Phase 1: Match by order_id in Sparkasse description
    for (const doc of incomeDocs) {
      if (!isDocAvailable(state, doc.document_id)) continue;
      const orderId = String(doc.meta.order_id ?? '');
      if (!orderId) continue;

      const spkMatches = findSparkasse(state, (s) =>
        s.amount_minor === doc.total_amount_minor &&
        String(s.description_raw ?? '').includes(orderId)
      );

      if (spkMatches.length === 1) {
        createMatch(state, this.rule_id, [spkMatches[0].transaction_id], [doc.document_id], {
          type: 'income_direct',
          order_id: orderId,
        });
      }
    }

    // Phase 2: Amount + date range (60 days) for remaining unmatched income docs
    const remainingDocs = findUnmatchedDocs(state, 'income');
    const spkPositive = findSparkasse(state, (s) => s.amount_minor > 0);
    const spkNegative = findSparkasse(state, (s) => s.amount_minor < 0);

    for (const doc of remainingDocs) {
      if (!isDocAvailable(state, doc.document_id)) continue;

      // Positive income → positive Sparkasse, negative (refund) → negative Sparkasse
      const spkPool = doc.total_amount_minor > 0 ? spkPositive : spkNegative;

      const candidates = spkPool.filter(s => {
        if (!isAvailable(state, s.transaction_id)) return false;
        if (s.amount_minor !== doc.total_amount_minor) return false;
        if (!doc.document_date) return true;
        return daysBetween(s.posting_at, doc.document_date) <= 60;
      });

      if (candidates.length === 1) {
        createMatch(state, this.rule_id, [candidates[0].transaction_id], [doc.document_id], {
          type: 'income_direct_amount_date',
        });
      }
    }
  },
};
