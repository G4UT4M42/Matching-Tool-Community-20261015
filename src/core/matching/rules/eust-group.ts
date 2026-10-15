import type { MatchRule } from '../engine.js';
import type { MatchingState, Document } from '../../types.js';
import { createMatch, findUnmatched, findUnmatchedDocs } from '../engine.js';
import { isAvailable, isDocAvailable } from '../../pipeline.js';
import { daysBetween } from '../../normalization/dates.js';

/**
 * R-EUST-GROUP-001: Match EUSt split document pairs together with a bank transaction.
 *
 * When an invoice is split into SVC (service, 20%) + EUST (import VAT, 0%),
 * the bank transaction has the combined total. This rule finds EUSt groups
 * (via meta.eust_group) and matches both documents together with the bank
 * transaction whose amount equals the sum of both parts.
 */
export const eustGroupRule: MatchRule = {
  rule_id: 'R-EUST-GROUP-001',
  description: 'Match EUSt split document pairs (service + import VAT) with bank transaction by combined amount',
  apply(state: MatchingState) {
    // Find all unmatched docs with eust_group in meta
    const allDocs = findUnmatchedDocs(state);
    const groups = new Map<string, Document[]>();

    for (const doc of allDocs) {
      const groupId = (doc.meta as any)?.eust_group;
      if (!groupId) continue;
      // Use groupId + document_date as key to separate docs with same generic group name
      // (e.g. "EUST-Frachtbriefnummer" used by multiple invoices on different dates)
      const dateKey = doc.document_date?.slice(0, 10) ?? '';
      const key = `${groupId}|${dateKey}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(doc);
    }

    // For each group with 2 docs, find a bank transaction matching the combined amount
    const bankTxns = [
      ...findUnmatched(state, 'sparkasse'),
      ...findUnmatched(state, 'visa'),
      ...findUnmatched(state, 'paypal'),
    ];

    for (const [groupId, docs] of groups) {
      if (docs.length < 2) continue;
      // Check all docs in group are still available
      if (!docs.every(d => isDocAvailable(state, d.document_id))) continue;

      // Combined amount (both negative for expenses)
      const combinedAmount = docs.reduce((sum, d) => sum + d.total_amount_minor, 0);
      const absAmount = Math.abs(combinedAmount);
      const docDate = docs[0].document_date;

      // Find bank transaction with matching amount, expanding date window
      for (const window of [5, 14, 30]) {
        const candidates = bankTxns.filter(t => {
          if (!isAvailable(state, t.transaction_id)) return false;
          if (Math.abs(t.amount_minor) !== absAmount) return false;
          if (docDate) {
            const days = daysBetween(t.posting_at, docDate);
            if (days > window) return false;
          }
          return true;
        });

        if (candidates.length === 1) {
          createMatch(
            state,
            this.rule_id,
            [candidates[0].transaction_id],
            docs.map(d => d.document_id),
            { type: 'eust_group', eust_group: groupId, window_days: window },
          );
          break;
        }
      }
    }
  },
};
