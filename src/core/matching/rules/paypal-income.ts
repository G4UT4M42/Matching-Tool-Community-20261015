import type { MatchRule } from '../engine.js';
import type { MatchingState, Document } from '../../types.js';
import { createMatch, findUnmatched, findUnmatchedDocs } from '../engine.js';
import { isAvailable } from '../../pipeline.js';

function daysDiff(a: string, b: string): number {
  const da = new Date(a.slice(0, 10));
  const db = new Date(b.slice(0, 10));
  return Math.abs(Math.round((da.getTime() - db.getTime()) / 86400000));
}

/**
 * R-PAYPAL-PAYPAL_INCOME-001: PayPal ↔ Income by multiple strategies
 * 1. PayPal transaction code → Income transaktionsnummer
 * 2. PayPal invoice_id → Income order_id
 * 3. Name + amount match
 * 4. Amount + date range fallback (4 months)
 */
export const paypalIncomeRule: MatchRule = {
  rule_id: 'R-PAYPAL-PAYPAL_INCOME-001',
  description: 'Match PayPal transactions to Income orders by ID, name+amount, or amount+date',
  apply(state: MatchingState) {
    // All unmatched PayPal transactions (payments AND payouts/refunds)
    const ppAll = findUnmatched(state, 'paypal');
    const incomeDocs = findUnmatchedDocs(state, 'income');

    // Build indexes
    const incomeByTxn = new Map<string, Document>();
    const incomeByOrderId = new Map<string, Document>();
    for (const doc of incomeDocs) {
      const txnNum = doc.meta.transaktionsnummer as string | undefined;
      if (txnNum) incomeByTxn.set(txnNum, doc);
      const orderId = doc.meta.order_id;
      if (orderId != null) incomeByOrderId.set(String(orderId), doc);
    }

    const consumeDoc = (doc: Document) => {
      const txnNum = doc.meta.transaktionsnummer as string;
      if (txnNum) incomeByTxn.delete(txnNum);
      const oid = doc.meta.order_id;
      if (oid != null) incomeByOrderId.delete(String(oid));
    };

    // Phase 1+2: Match by transaction code or order_id
    for (const pp of ppAll) {
      if (!isAvailable(state, pp.transaction_id)) continue;

      const txnCode = pp.source_row_ref;
      let matchDoc = incomeByTxn.get(txnCode);

      if (!matchDoc) {
        const invoiceId = pp.meta.invoice_id as string | undefined;
        if (invoiceId) matchDoc = incomeByOrderId.get(invoiceId);
      }

      if (matchDoc && matchDoc.total_amount_minor === pp.amount_minor) {
        createMatch(state, this.rule_id, [pp.transaction_id], [matchDoc.document_id], {
          type: 'income_paypal',
          txn_code: txnCode,
          invoice_id: pp.meta.invoice_id,
          order_id: matchDoc.meta.order_id,
        });
        consumeDoc(matchDoc);
      }
    }

    // Phase 3: Name + amount match
    for (const pp of ppAll) {
      if (!isAvailable(state, pp.transaction_id)) continue;
      const ppName = (pp.counterparty_name ?? '').toLowerCase().trim();
      if (!ppName || ppName.length < 3) continue;

      const candidates = incomeDocs.filter(d => {
        if (state.matched_document_ids.has(d.document_id)) return false;
        if (d.total_amount_minor !== pp.amount_minor) return false;
        const docName = (d.supplier_name ?? '').toLowerCase().trim();
        // Name must have significant overlap
        return docName.includes(ppName) || ppName.includes(docName) ||
          (ppName.split(' ').length >= 2 && docName.split(' ').some(part => part.length > 2 && ppName.includes(part)));
      });

      if (candidates.length === 1) {
        createMatch(state, this.rule_id, [pp.transaction_id], [candidates[0].document_id], {
          type: 'income_paypal_name',
          name: pp.counterparty_name,
        });
        consumeDoc(candidates[0]);
      }
    }

    // Phase 4: Amount + date range fallback (within 120 days / 4 months)
    for (const pp of ppAll) {
      if (!isAvailable(state, pp.transaction_id)) continue;

      const candidates = incomeDocs.filter(d => {
        if (state.matched_document_ids.has(d.document_id)) return false;
        if (d.total_amount_minor !== pp.amount_minor) return false;
        if (!d.document_date) return true;
        return daysDiff(pp.posting_at, d.document_date) <= 120;
      });

      if (candidates.length === 1) {
        createMatch(state, this.rule_id, [pp.transaction_id], [candidates[0].document_id], {
          type: 'income_paypal_amount_date',
        });
        consumeDoc(candidates[0]);
      }
    }
  },
};
