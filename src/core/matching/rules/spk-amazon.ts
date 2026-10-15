import type { MatchRule } from '../engine.js';
import type { MatchingState } from '../../types.js';
import { createMatch, findSparkasse, findUnmatchedDocs } from '../engine.js';
import { isAvailable } from '../../pipeline.js';
import type { Document } from '../../types.js';

/** Extract Amazon order numbers from text.
 * Standard: 028-XXXXXXX-XXXXXXX, 302-XXXXXXX-XXXXXXX, 305-..., 303-..., D01-...
 * Non-standard: 62-I-NNNNNNNNNNNN
 */
function extractAmazonOrderNumber(text: string): string | null {
  // Standard format: NNN-NNNNNNN-NNNNNNN
  const stdMatch = text.match(/(\d{3}-\d{7}-\d{7})/);
  if (stdMatch) return stdMatch[1];
  // D01-format: D01-NNNNNNN-NNNNNNN
  const d01Match = text.match(/(D\d{2}-\d{7}-\d{7})/);
  if (d01Match) return d01Match[1];
  // Non-standard: 62-I-NNNNNNNNNNNN
  const altMatch = text.match(/(62-I-\d{10,})/);
  if (altMatch) return altMatch[1];
  return null;
}

/**
 * R-BANK-SPK_AMZN-001: Sparkasse ↔ extracted_invoice by Amazon order number
 * Parse "028-XXXXXXX-XXXXXXX" from Sparkasse description → match extracted_invoice
 */
export const spkAmazonRefRule: MatchRule = {
  rule_id: 'R-BANK-SPK_AMZN-001',
  description: 'Match Sparkasse Amazon transactions to extracted invoices by order number',
  apply(state: MatchingState) {
    // Search across all Amazon-relevant document sources
    const allDocs: Document[] = [
      ...findUnmatchedDocs(state, 'extracted_invoice'),
      ...findUnmatchedDocs(state, 'amazon'),
      ...findUnmatchedDocs(state, 'invoice_scan'),
    ];

    // Build index by order number from source_document_ref
    const docsByRef = new Map<string, Document[]>();
    for (const doc of allDocs) {
      const ref = doc.source_document_ref;
      const orderNum = extractAmazonOrderNumber(ref);
      const key = orderNum ?? ref;
      if (!docsByRef.has(key)) docsByRef.set(key, []);
      docsByRef.get(key)!.push(doc);
    }

    // Find Sparkasse Amazon transactions
    const spkAmazon = findSparkasse(state, (s) => {
      const partner = (s.counterparty_name ?? '').toUpperCase();
      return partner.includes('AMAZON') && extractAmazonOrderNumber(String(s.description_raw ?? '')) != null;
    });

    for (const spk of spkAmazon) {
      const orderNum = extractAmazonOrderNumber(String(spk.description_raw ?? ''));
      if (!orderNum) continue;

      const docs = docsByRef.get(orderNum);
      if (!docs || docs.length === 0) continue;

      // Prevent matching a refund (positive bank txn) to an expense invoice (negative doc).
      const eligibleDocs = spk.amount_minor > 0
        ? docs.filter(d => d.total_amount_minor > 0)
        : docs.filter(d => d.total_amount_minor <= 0);
      if (eligibleDocs.length === 0) continue;

      // 1:1 match — pick the first eligible doc with matching amount
      const exactIdx = eligibleDocs.findIndex(d => Math.abs(spk.amount_minor) === Math.abs(d.total_amount_minor));
      if (exactIdx >= 0) {
        const doc = eligibleDocs[exactIdx];
        createMatch(state, this.rule_id, [spk.transaction_id], [doc.document_id], {
          type: 'amazon_invoice',
          order_number: orderNum,
        });
        // Remove consumed doc from pool
        const origIdx = docs.indexOf(doc);
        if (origIdx >= 0) docs.splice(origIdx, 1);
        if (docs.length === 0) docsByRef.delete(orderNum);
      }
    }
  },
};

/**
 * R-BANK-SPK_AMZN-002: Sparkasse Amazon ↔ invoices.xlsx by order number
 * Match Amazon order numbers to the standalone invoices file
 */
export const spkAmazonInvoiceRule: MatchRule = {
  rule_id: 'R-BANK-SPK_AMZN-002',
  description: 'Match Sparkasse Amazon transactions to invoices.xlsx by order number',
  apply(state: MatchingState) {
    // Search invoice_file + amazon sources
    const invoiceDocs: Document[] = [
      ...findUnmatchedDocs(state, 'invoice_file'),
      ...findUnmatchedDocs(state, 'amazon'),
    ];

    // Build index by order number
    const docsByOrderNum = new Map<string, Document>();
    for (const doc of invoiceDocs) {
      const orderNum = extractAmazonOrderNumber(doc.source_document_ref);
      if (orderNum && !docsByOrderNum.has(orderNum)) docsByOrderNum.set(orderNum, doc);
    }

    const spkAmazon = findSparkasse(state, (s) => {
      const partner = (s.counterparty_name ?? '').toUpperCase();
      return partner.includes('AMAZON') && extractAmazonOrderNumber(String(s.description_raw ?? '')) != null;
    });

    for (const spk of spkAmazon) {
      const orderNum = extractAmazonOrderNumber(String(spk.description_raw ?? ''));
      if (!orderNum) continue;

      const doc = docsByOrderNum.get(orderNum);
      if (doc && Math.abs(spk.amount_minor) === Math.abs(doc.total_amount_minor)) {
        createMatch(state, this.rule_id, [spk.transaction_id], [doc.document_id], {
          type: 'amazon_invoice_file',
          order_number: orderNum,
        });
        docsByOrderNum.delete(orderNum);
      }
    }
  },
};

/** Parse date flexibly — handles YYYY-MM-DD and YYYY-DD-MM (malformed Amazon dates) */
function parseFlexDate(s: string): Date | null {
  let d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) { d = new Date(`${m[1]}-${m[3]}-${m[2]}`); if (!isNaN(d.getTime())) return d; }
  return null;
}

/**
 * R-BANK-SPK_AMZN-003: Sparkasse Amazon ↔ Amazon docs by amount + date (fallback)
 * For cases where the Sparkasse description has a non-standard ref (e.g. 62-I-xxx)
 * that doesn't match any Amazon doc ref. Falls back to amount + date proximity.
 */
export const spkAmazonAmountRule: MatchRule = {
  rule_id: 'R-BANK-SPK_AMZN-003',
  description: 'Match Sparkasse Amazon transactions to Amazon docs by amount and date (fallback)',
  apply(state: MatchingState) {
    // Only unmatched Sparkasse Amazon transactions
    const spkAmazon = findSparkasse(state, (s) => {
      const partner = (s.counterparty_name ?? '').toUpperCase();
      return partner.includes('AMAZON');
    });

    const amazonDocs = findUnmatchedDocs(state, 'amazon');
    if (amazonDocs.length === 0) return;

    for (const spk of spkAmazon) {
      if (!isAvailable(state, spk.transaction_id)) continue;
      const absAmount = Math.abs(spk.amount_minor);
      const spkDate = parseFlexDate(spk.posting_at);
      if (!spkDate) continue;

      // Find Amazon docs with same absolute amount, matching sign, and close date
      const isRefund = spk.amount_minor > 0;
      const candidates = amazonDocs.filter(d => {
        if (state.matched_document_ids.has(d.document_id)) return false;
        // Sign must match: expense txn → negative doc, refund txn → positive doc
        if (isRefund && d.total_amount_minor <= 0) return false;
        if (!isRefund && d.total_amount_minor >= 0) return false;
        if (Math.abs(d.total_amount_minor) !== absAmount) return false;
        if (!d.document_date) return true; // no date → allow on amount alone
        const docDate = parseFlexDate(d.document_date);
        if (!docDate) return true; // unparseable date → allow
        const diffDays = Math.abs(spkDate.getTime() - docDate.getTime()) / 86400000;
        return diffDays <= 30;
      });

      if (candidates.length === 1) {
        createMatch(state, this.rule_id, [spk.transaction_id], [candidates[0].document_id], {
          type: 'spk_amazon_amount_date',
        });
      }
    }
  },
};
