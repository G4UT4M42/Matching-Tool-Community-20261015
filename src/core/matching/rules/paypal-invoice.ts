import type { MatchRule } from '../engine.js';
import type { MatchingState } from '../../types.js';
import { createMatch, findUnmatched, findUnmatchedDocs } from '../engine.js';
import { isAvailable } from '../../pipeline.js';

/**
 * R-PAYPAL-PAYPAL_INV-001: PayPal ↔ extracted_invoice by reference or amount
 * Match PayPal payment entries to extracted invoices
 */
export const paypalInvoiceRule: MatchRule = {
  rule_id: 'R-PAYPAL-PAYPAL_INV-001',
  description: 'Match PayPal payments to extracted invoices',
  apply(state: MatchingState) {
    // PayPal outgoing payments (negative amounts, not Bankgutschrift or Währungsumrechnung)
    const ppPayments = findUnmatched(state, 'paypal', (t) =>
      t.amount_minor < 0 &&
      !(t.meta.typ as string ?? '').includes('Bankgutschrift') &&
      !(t.meta.typ as string ?? '').includes('hrungsumrechnung')
    );

    const extractedDocs = findUnmatchedDocs(state, 'extracted_invoice');

    // Build amount index
    const docsByAmount = new Map<number, typeof extractedDocs[0][]>();
    for (const doc of extractedDocs) {
      const key = Math.abs(doc.total_amount_minor);
      if (!docsByAmount.has(key)) docsByAmount.set(key, []);
      docsByAmount.get(key)!.push(doc);
    }

    for (const pp of ppPayments) {
      if (!isAvailable(state, pp.transaction_id)) continue;
      const absAmount = Math.abs(pp.amount_minor);

      const candidates = docsByAmount.get(absAmount);
      if (!candidates || candidates.length === 0) continue;

      // Try vendor name matching
      const ppName = (pp.counterparty_name ?? '').toUpperCase();
      const bestMatch = candidates.find((d) => {
        if (state.matched_document_ids.has(d.document_id)) return false;
        const vendor = (d.supplier_name ?? '').toUpperCase();
        // Check if any significant word from PayPal name appears in vendor
        const words = ppName.split(/\s+/).filter((w) => w.length > 3);
        return words.some((w) => vendor.includes(w));
      });

      if (bestMatch) {
        createMatch(state, this.rule_id, [pp.transaction_id], [bestMatch.document_id], {
          type: 'paypal_invoice',
          counterparty: pp.counterparty_name,
        });
      }
    }
  },
};
