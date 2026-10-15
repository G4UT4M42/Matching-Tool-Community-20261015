import type { MatchRule } from '../engine.js';
import type { MatchingState } from '../../types.js';
import { createMatch, findUnmatched, findUnmatchedDocs } from '../engine.js';

/**
 * R-PAYPAL-PAYPAL_REFUND-001: PayPal Rückzahlung → Income CN- credit note
 * PayPal "Rückzahlung" transactions match Income credit notes (CN- prefix)
 * by rechnungsnummer = order_id.
 *
 * Example:
 *   PayPal: typ="Rückzahlung", rechnungsnummer=16977, amt=-17800
 *   Income: ref="CN-25000248", order_id=16977, amt=-17800
 */
export const paypalRefundIncomeRule: MatchRule = {
  rule_id: 'R-PAYPAL-PAYPAL_REFUND-001',
  description: 'Match PayPal refunds (Rückzahlung) to Income credit notes (CN-) by order ID',
  apply(state: MatchingState) {
    const ppRefunds = findUnmatched(state, 'paypal', (t) =>
      (t.meta.typ as string ?? '').includes('ckzahlung') && // Rückzahlung
      t.meta.rechnungsnummer != null && t.meta.rechnungsnummer !== ''
    );

    const incomeDocs = findUnmatchedDocs(state, 'income');

    // Build index of CN- income docs by order_id
    const incomeByOrderId = new Map<string, typeof incomeDocs[0]>();
    for (const doc of incomeDocs) {
      const ref = doc.source_document_ref;
      if (ref.startsWith('CN-') && doc.meta.order_id != null) {
        incomeByOrderId.set(String(doc.meta.order_id), doc);
      }
    }

    for (const pp of ppRefunds) {
      const rechnr = String(pp.meta.rechnungsnummer);
      const matchDoc = incomeByOrderId.get(rechnr);
      if (matchDoc && matchDoc.total_amount_minor === pp.amount_minor) {
        createMatch(state, this.rule_id, [pp.transaction_id], [matchDoc.document_id], {
          type: 'paypal_refund_income',
          order_id: rechnr,
        });
        incomeByOrderId.delete(rechnr);
      }
    }
  },
};
