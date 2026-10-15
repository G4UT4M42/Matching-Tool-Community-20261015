/**
 * R-ALI-COMBO-001: Match AliExpress orders (individual or combinations) to Visa transactions.
 *
 * AliExpress often charges multiple orders placed on the same day as a single
 * Visa transaction. This rule tries:
 *  1. Single order match (exact amount + date within 7 days)
 *  2. Combinations of 2-5 orders from the same date whose sum matches a Visa charge
 *
 * Date tolerance: 10 days (AliExpress charges may post a few days after order date).
 * Amount tolerance: exact first, then 2% (AliExpress amounts may differ due to coupons/FX).
 */
import type { MatchRule } from '../engine.js';
import type { MatchingState, Transaction, Document } from '../../types.js';
import { createMatch, findUnmatched, findUnmatchedDocs } from '../engine.js';
import { daysBetween } from '../../normalization/dates.js';

const DATE_TOLERANCE_DAYS = 10;
const AMOUNT_TOLERANCE_PCT = 0.03; // 3% — AliExpress amounts vary due to coupons, shipping, FX rounding

/** Check if a document is from AliExpress (by supplier or source) */
function isAliExpressDoc(doc: Document): boolean {
  const name = (doc.supplier_name ?? '').toLowerCase();
  const ref = (doc.source_document_ref ?? '').toLowerCase();
  const fn = (doc.filename ?? '').toLowerCase();
  return name.includes('aliexpress') || ref.includes('aliexpress') || fn.includes('aliexpress');
}

/** Check if a transaction is an AliExpress/Alipay charge */
function isAliExpressTxn(txn: Transaction): boolean {
  const desc = String(txn.description_raw ?? '').toUpperCase();
  const name = String(txn.counterparty_name ?? '').toUpperCase();
  const haystack = desc + ' ' + name;
  if (haystack.includes('ALIEXPRESS') || haystack.includes('ALIEXPRESSCOM') || haystack.includes('ALIPAY')) return true;
  // PayPal payments to Alipay — check payer_email in meta
  const email = String((txn.meta as any)?.payer_email ?? '').toLowerCase();
  if (email.includes('alibaba') || email.includes('alipay') || email.includes('aliexpress')) return true;
  return false;
}

/**
 * Generate all combinations of size k from array.
 * Limits to max 5 items to avoid combinatorial explosion.
 */
function* combinations<T>(arr: T[], k: number): Generator<T[]> {
  if (k > arr.length || k > 5) return;
  if (k === 1) {
    for (const item of arr) yield [item];
    return;
  }
  for (let i = 0; i <= arr.length - k; i++) {
    for (const rest of combinations(arr.slice(i + 1), k - 1)) {
      yield [arr[i], ...rest];
    }
  }
}

/**
 * Find the best combination of documents that sums to the target amount.
 * Tries exact match first, then 2% tolerance. Returns null if no match.
 */
function findBestCombo(
  docs: Document[], target: number, _days: number,
): { docs: Document[]; sum: number; tolerancePct: number } | null {
  // Phase 1: exact match
  for (let size = 1; size <= Math.min(docs.length, 6); size++) {
    for (const combo of combinations(docs, size)) {
      const sum = combo.reduce((s, d) => s + Math.abs(d.total_amount_minor), 0);
      if (sum === target) return { docs: combo, sum, tolerancePct: 0 };
    }
  }
  // Phase 2: 2% tolerance (prefer smaller tolerance)
  let best: { docs: Document[]; sum: number; tolerancePct: number } | null = null;
  for (let size = 1; size <= Math.min(docs.length, 6); size++) {
    for (const combo of combinations(docs, size)) {
      const sum = combo.reduce((s, d) => s + Math.abs(d.total_amount_minor), 0);
      const pct = Math.abs(sum - target) / target;
      if (pct <= AMOUNT_TOLERANCE_PCT) {
        if (!best || pct < best.tolerancePct) {
          best = { docs: combo, sum, tolerancePct: Math.round(pct * 1000) / 10 };
        }
      }
    }
  }
  return best;
}

export const aliexpressComboRule: MatchRule = {
  rule_id: 'R-ALI-COMBO-001',
  description: 'Match AliExpress orders (single or combined) to Visa/bank charges by amount + date',
  apply(state: MatchingState) {
    // Find unmatched AliExpress documents
    const aliDocs = findUnmatchedDocs(state).filter(isAliExpressDoc);
    if (aliDocs.length === 0) return;

    // Find unmatched AliExpress-related transactions across ALL sources (Visa, Sparkasse, PayPal)
    const aliTxns = [
      ...findUnmatched(state, 'visa', t => isAliExpressTxn(t)),
      ...findUnmatched(state, 'sparkasse', t => isAliExpressTxn(t)),
      ...findUnmatched(state, 'paypal', t => isAliExpressTxn(t)),
    ];
    if (aliTxns.length === 0) return;

    // Group documents by date
    const docsByDate = new Map<string, Document[]>();
    for (const doc of aliDocs) {
      const date = doc.document_date?.slice(0, 10);
      if (!date) continue;
      if (!docsByDate.has(date)) docsByDate.set(date, []);
      docsByDate.get(date)!.push(doc);
    }

    // Phase 1: Match expense transactions (negative) to order documents
    const expenseTxns = aliTxns.filter(t => t.amount_minor < 0);
    const refundTxns = aliTxns.filter(t => t.amount_minor > 0);

    for (const txn of expenseTxns) {
      if (state.matched_transaction_ids.has(txn.transaction_id)) continue;
      const txnAmount = Math.abs(txn.amount_minor);
      const txnDate = txn.posting_at?.slice(0, 10);
      if (!txnDate || txnAmount === 0) continue;

      let matched = false;

      // Try each date group that's within date tolerance
      for (const [dateKey, docs] of docsByDate) {
        if (matched) break;
        const days = daysBetween(txnDate, dateKey);
        if (days > DATE_TOLERANCE_DAYS) continue;

        // Filter to only unmatched docs in this group
        const available = docs.filter(d => !state.matched_document_ids.has(d.document_id));
        if (available.length === 0) continue;

        // Try single + combo matching (exact first, then 2% tolerance)
        const result = findBestCombo(available, txnAmount, days);
        if (result) {
          const docIds = result.docs.map(d => d.document_id);
          createMatch(state, this.rule_id, [txn.transaction_id], docIds, {
            type: result.docs.length === 1 ? 'aliexpress_single' : 'aliexpress_combo',
            combo_size: result.docs.length,
            amount: txnAmount,
            combo_sum: result.sum,
            tolerance_pct: result.tolerancePct,
            individual_amounts: result.docs.map(d => Math.abs(d.total_amount_minor)),
            date_diff_days: days,
          });
          matched = true;
        }
      }

      // Also try across date groups (orders from different days in one charge)
      if (!matched) {
        const allAvailable = aliDocs.filter(d =>
          !state.matched_document_ids.has(d.document_id) &&
          d.document_date &&
          daysBetween(txnDate, d.document_date) <= DATE_TOLERANCE_DAYS
        );

        const crossResult = findBestCombo(allAvailable, txnAmount, 0);
        if (crossResult) {
          const docIds = crossResult.docs.map(d => d.document_id);
          createMatch(state, this.rule_id, [txn.transaction_id], docIds, {
            type: 'aliexpress_combo_cross_date',
            combo_size: crossResult.docs.length,
            amount: txnAmount,
            combo_sum: crossResult.sum,
            tolerance_pct: crossResult.tolerancePct,
            individual_amounts: crossResult.docs.map(d => Math.abs(d.total_amount_minor)),
            date_diff_days: Math.max(...crossResult.docs.map(d => daysBetween(txnDate, d.document_date!))),
          });
          matched = true;
        }
      }
    }

    // Phase 2: Match refund transactions (positive) to AliExpress refund documents
    // Refund documents are created by the AliExpress adapter when it finds orders with
    // "Refund Details" button on the order detail page.
    const refundDocs = aliDocs.filter(d => {
      const meta = (d.meta ?? {}) as Record<string, any>;
      return meta.type === 'refund' || (d.supplier_name ?? '').includes('Refund');
    });

    for (const refund of refundTxns) {
      if (state.matched_transaction_ids.has(refund.transaction_id)) continue;
      const refundAmount = Math.abs(refund.amount_minor);
      const refundDate = refund.posting_at?.slice(0, 10);
      if (!refundDate || refundAmount === 0) continue;

      // Find a refund document matching by amount + date proximity
      for (const doc of refundDocs) {
        if (state.matched_document_ids.has(doc.document_id)) continue;
        if (Math.abs(doc.total_amount_minor) !== refundAmount) continue;
        const days = doc.document_date ? daysBetween(refundDate, doc.document_date) : 999;
        if (days > 60) continue;

        createMatch(state, this.rule_id, [refund.transaction_id], [doc.document_id], {
          type: 'aliexpress_refund',
          amount: refundAmount,
          date_diff_days: days,
        });
        break;
      }
    }
  },
};
