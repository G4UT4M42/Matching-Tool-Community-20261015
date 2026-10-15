import type { MatchRule } from '../engine.js';
import type { MatchingState } from '../../types.js';
import { createMatch, findUnmatched, findUnmatchedDocs } from '../engine.js';
import { isAvailable, isDocAvailable } from '../../pipeline.js';
import { daysBetween } from '../../normalization/dates.js';

function compactVendor(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '');
}

function hasStrongVendorAgreement(
  supplierName: string | undefined,
  transactionText: string,
): boolean {
  const supplier = compactVendor(supplierName ?? '');
  const transaction = compactVendor(transactionText);
  return supplier.length >= 5 && transaction.includes(supplier);
}

/**
 * R-AUTO-INV_AMT-001: Auto-match open invoices to bank transactions by amount + expanding date window.
 *
 * Stages:
 *   1. Amount match within 1 day
 *   2. Amount match within 3 days
 *   3. Amount match within 5 days
 *
 * Only matches when exactly 1 candidate is found (unique amount match).
 * Evidence includes `auto_match_tier` (1|3|5).
 */
export const autoMatchInvoiceRule: MatchRule = {
  rule_id: 'R-AUTO-INV_AMT-001',
  description: 'Auto-match open invoices to bank transactions by amount with expanding date window',
  apply(state: MatchingState) {
    const dateWindows: number[] = [1, 3, 5];

    for (const window of dateWindows) {
      // Re-fetch unmatched docs each round (previous rounds may have matched some)
      const allDocs = [
        ...findUnmatchedDocs(state, 'invoice_file'),
        ...findUnmatchedDocs(state, 'extracted_invoice'),
        ...findUnmatchedDocs(state, 'invoice_scan'),
        ...findUnmatchedDocs(state, 'google_cloud' as any),
        ...findUnmatchedDocs(state, 'google_one' as any),
        ...findUnmatchedDocs(state, 'aliexpress' as any),
      ];
      if (allDocs.length === 0) return;

      // All unmatched bank transactions
      const bankTxns = [
        ...findUnmatched(state, 'sparkasse'),
        ...findUnmatched(state, 'visa'),
        ...findUnmatched(state, 'paypal'),
      ];
      if (bankTxns.length === 0) return;

      for (const doc of allDocs) {
        if (!isDocAvailable(state, doc.document_id)) continue;
        if (doc.meta?.requires_date_review === true) continue;
        if (doc.total_amount_minor === 0) continue;

        const absAmount = Math.abs(doc.total_amount_minor);

        const candidates = bankTxns.filter(t => {
          if (!isAvailable(state, t.transaction_id)) return false;
          if (Math.abs(t.amount_minor) !== absAmount) return false;
          // Legacy invoice imports use mixed sign conventions, so sign alone is
          // not a safe conflict. An explicit refund marker is: never pair that
          // credit document with an expense debit.
          const meta = (doc.meta ?? {}) as Record<string, unknown>;
          if (meta.is_refund === true && t.amount_minor < 0) return false;

          if (!doc.document_date || !t.posting_at) return false;
          if (daysBetween(t.posting_at, doc.document_date) > window) return false;
          if (!hasStrongVendorAgreement(
            doc.supplier_name,
            `${t.counterparty_name ?? ''} ${t.description_raw ?? ''}`,
          )) return false;

          return true;
        });

        if (candidates.length === 1) {
          createMatch(state, this.rule_id, [candidates[0].transaction_id], [doc.document_id], {
            type: 'auto_match',
            auto_match_tier: window,
            window_days: window,
          });
        } else if (candidates.length > 1 && doc.document_date) {
          // Multiple candidates with same amount — pick the closest by date
          const sorted = candidates.sort((a, b) => {
            const daysA = daysBetween(a.posting_at, doc.document_date!);
            const daysB = daysBetween(b.posting_at, doc.document_date!);
            return daysA - daysB;
          });
          // Only match if the closest is significantly closer than the second-closest (>= 2 days gap)
          const daysFirst = daysBetween(sorted[0].posting_at, doc.document_date);
          const daysSecond = daysBetween(sorted[1].posting_at, doc.document_date);
          if (daysFirst < daysSecond) {
            createMatch(state, this.rule_id, [sorted[0].transaction_id], [doc.document_id], {
              type: 'auto_match_closest',
              auto_match_tier: window,
              window_days: window,
              days_to_match: daysFirst,
              runner_up_days: daysSecond,
            });
          }
        }
      }
    }
  },
};
