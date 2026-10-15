import type { MatchRule } from '../engine.js';
import type { MatchingState } from '../../types.js';
import { createMatch, findUnmatched, findUnmatchedDocs } from '../engine.js';

/**
 * R-FEE-STRIPE_MONTHLY-001: Stripe fee transactions ↔ monthly fee summary doc
 * Groups all Stripe standalone_fee transactions of a month and matches them
 * to the corresponding monthly fee summary document.
 */
export const stripeFeeMonthlyRule: MatchRule = {
  rule_id: 'R-FEE-STRIPE_MONTHLY-001',
  description: 'Match Stripe fee transactions to monthly fee summary documents',
  apply(state: MatchingState) {
    // Find unmatched Stripe fee transactions (standalone_fee or stripe_fee type)
    const stripeFees = findUnmatched(state, 'stripe', (t) => {
      const typ = t.meta.stripe_type as string;
      return typ === 'standalone_fee' || typ === 'stripe_fee';
    });
    if (stripeFees.length === 0) return;

    // Find unmatched Stripe fee summary documents
    const feeDocs = findUnmatchedDocs(state, 'stripe_fee').filter(d =>
      d.supplier_name === 'Stripe'
    );
    if (feeDocs.length === 0) return;

    // Index fee docs by month
    const docsByMonth = new Map<string, typeof feeDocs[0]>();
    for (const doc of feeDocs) {
      const month = doc.source_document_ref.replace('stripe-fees-', '');
      docsByMonth.set(month, doc);
    }

    // Group fee transactions by month
    const feesByMonth = new Map<string, typeof stripeFees>();
    for (const fee of stripeFees) {
      const month = fee.posting_at.slice(0, 7);
      if (!feesByMonth.has(month)) feesByMonth.set(month, []);
      feesByMonth.get(month)!.push(fee);
    }

    // Match each month's fees to its summary doc
    for (const [month, fees] of feesByMonth) {
      const doc = docsByMonth.get(month);
      if (!doc) continue;
      if (state.matched_document_ids.has(doc.document_id)) continue;

      const txnIds = fees.map(f => f.transaction_id);
      createMatch(state, this.rule_id, txnIds, [doc.document_id], {
        type: 'stripe_fee_monthly',
        month,
        fee_count: fees.length,
      });
    }
  },
};

/**
 * R-FEE-PAYPAL_MONTHLY-001: PayPal fee entries ↔ monthly fee summary doc
 * Matches the monthly PayPal fee summary document to charge transactions
 * that had fees deducted in that month.
 */
export const paypalFeeMonthlyRule: MatchRule = {
  rule_id: 'R-FEE-PAYPAL_MONTHLY-001',
  description: 'Match PayPal fee summary documents to PayPal transactions with fees',
  apply(state: MatchingState) {
    // Find unmatched PayPal fee summary documents
    // Find PayPal fee docs in both old (stripe_fee) and new (bank_fee) source systems
    const feeDocs = [
      ...findUnmatchedDocs(state, 'stripe_fee'),
      ...findUnmatchedDocs(state, 'bank_fee'),
    ].filter(d => d.supplier_name === 'PayPal');
    if (feeDocs.length === 0) return;

    // Mark PayPal fee docs as matched (self-contained expense docs).
    // The fees are already deducted from PayPal payment amounts — no transaction link needed.
    for (const doc of feeDocs) {
      if (state.matched_document_ids.has(doc.document_id)) continue;
      const month = doc.source_document_ref.replace('paypal-fees-', '');

      state.matched_document_ids.add(doc.document_id);
      state.match_groups.set(`MG-paypal-fee-${month}`, {
        match_group_id: `MG-paypal-fee-${month}`,
        status: 'proposed',
        created_at: new Date().toISOString(),
        created_by: 'system',
        rule_id: this.rule_id,
        transaction_ids: [],
        document_ids: [doc.document_id],
        amount_total_minor: doc.total_amount_minor,
        currency_code: 'EUR',
        evidence: { type: 'paypal_fee_monthly', month },
        reason_codes: [],
      });
    }
  },
};
