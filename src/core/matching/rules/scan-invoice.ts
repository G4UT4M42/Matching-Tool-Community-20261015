import type { MatchRule } from '../engine.js';
import type { MatchingState, Document } from '../../types.js';
import { createMatch, findUnmatched, findUnmatchedDocs } from '../engine.js';
import { isAvailable, isDocAvailable } from '../../pipeline.js';
import { daysBetween } from '../../normalization/dates.js';

function compactVendor(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '');
}

function hasStrongVendorAgreement(doc: Document, transactionText: string): boolean {
  const supplier = compactVendor(doc.supplier_name ?? '');
  const transaction = compactVendor(transactionText);
  return supplier.length >= 5 && transaction.includes(supplier);
}

/**
 * Extract invoice number candidates from filename and source_document_ref.
 * Returns codes that are at least 5 chars and look like real invoice numbers.
 */
function extractInvoiceCodes(doc: Document): string[] {
  const codes: string[] = [];
  const ref = (doc.source_document_ref ?? '').trim();
  const fn = (doc.filename ?? '');
  const isSpecificInvoiceCode = (code: string) =>
    code.length >= 5 && /\d/.test(code);

  // source_document_ref is usually the best candidate (already extracted by OCR)
  if (isSpecificInvoiceCode(ref) && !/^(Frachtbrief|INT-)/.test(ref)) {
    codes.push(ref);
  }

  // From filename: "Rechnung RE4605.pdf" → "RE4605"
  // "Rechnung Nr. 2025122804.pdf" → "2025122804"
  // "Rechnung_R2523202_xxx.pdf" → "R2523202"
  // "Rechnung_Dampfdorado_4042821_xxx.pdf" → "4042821"
  const patterns = [
    /\b((?:RE|RG|INV)[-_ ]?(?=[A-Z0-9-]*\d)[A-Z0-9][-A-Z0-9]{3,})\b/gi, // RE4605, INV-123, RG2024-001
    /(?:Rechnung|Invoice)\s*(?:Nr\.?\s*)?([A-Z0-9][-A-Z0-9]{4,})/gi, // Rechnung Nr. 2025122804
    /(?:Rechnung)_([A-Z]?\d{5,})/gi,                         // Rechnung_R2523202
    /(?:Zahlungsbeleg|Beleg)\s*(?:Nr\.?\s*)?([A-Z0-9]{6,})/gi, // Zahlungsbeleg Nr. B2011218741
  ];

  for (const pattern of patterns) {
    for (const m of fn.matchAll(pattern)) {
      const code = m[1].replace(/_[a-f0-9]{6,}$/i, ''); // strip hash suffixes
      if (isSpecificInvoiceCode(code)) codes.push(code);
    }
  }

  return [...new Set(codes)];
}

/**
 * R-SCAN-INV_REF-001: Scanned invoice ↔ bank transaction by invoice reference in description
 * Searches for the invoice number (from filename/ref) in Sparkasse/Visa/PayPal descriptions.
 * Also matches by amount if ref is found.
 */
export const scanInvoiceRefRule: MatchRule = {
  rule_id: 'R-SCAN-INV_REF-001',
  description: 'Match scanned invoices to bank transactions by invoice number in description',
  apply(state: MatchingState) {
    const scanDocs = findUnmatchedDocs(state, 'invoice_scan');
    if (scanDocs.length === 0) return;

    // All unmatched bank transactions
    const bankTxns = [
      ...findUnmatched(state, 'sparkasse'),
      ...findUnmatched(state, 'visa'),
      ...findUnmatched(state, 'paypal'),
    ];
    if (bankTxns.length === 0) return;

    for (const doc of scanDocs) {
      if (!isDocAvailable(state, doc.document_id)) continue;
      if (doc.meta?.requires_date_review === true) continue;
      const codes = extractInvoiceCodes(doc);
      if (codes.length === 0) continue;

      const absDocAmount = Math.abs(doc.total_amount_minor);

      for (const code of codes) {
        const codeUpper = code.toUpperCase();
        // Codes without a digit are usually words such as "Rechnung", not invoice IDs.
        if (codeUpper.length < 5 || !/\d/.test(codeUpper)) continue;

        // Find bank transactions where description/booking_ref/payment_ref contains the code
        const candidates = bankTxns.filter(t => {
          if (!isAvailable(state, t.transaction_id)) return false;
          const desc = String(t.description_raw ?? '').toUpperCase();
          const bookRef = (t.booking_reference ?? '').toUpperCase();
          const payRef = (t.payment_reference ?? '').toUpperCase();
          // Must contain the exact code (not a substring of a word)
          return desc.includes(codeUpper) || bookRef.includes(codeUpper) || payRef.includes(codeUpper);
        });

        // If exactly one match with same amount → strong match
        const amountMatches = candidates.filter(t => Math.abs(t.amount_minor) === absDocAmount);
        if (amountMatches.length === 1) {
          createMatch(state, this.rule_id, [amountMatches[0].transaction_id], [doc.document_id], {
            type: 'scan_ref_amount',
            invoice_code: code,
          });
          break;
        }

        // If exactly one ref match (regardless of amount) and date is close → ok
        if (candidates.length === 1 && doc.document_date) {
          const days = daysBetween(candidates[0].posting_at, doc.document_date);
          if (days <= 60) {
            createMatch(state, this.rule_id, [candidates[0].transaction_id], [doc.document_id], {
              type: 'scan_ref_date',
              invoice_code: code,
            });
            break;
          }
        }
      }
    }

    // Phase 2: Amount + expanding date range (1 → 3 → 10 → 30 → 60 days)
    const dateWindows = [1, 3, 10, 30, 60];
    const remainingDocs = findUnmatchedDocs(state, 'invoice_scan');

    for (const window of dateWindows) {
      for (const doc of remainingDocs) {
        if (!isDocAvailable(state, doc.document_id)) continue;
        if (doc.meta?.requires_date_review === true) continue;
        if (!doc.document_date || doc.total_amount_minor === 0) continue;
        const absAmount = Math.abs(doc.total_amount_minor);
        const isExpense = doc.total_amount_minor < 0;

        const candidates = bankTxns.filter(t => {
          if (!isAvailable(state, t.transaction_id)) return false;
          if (Math.abs(t.amount_minor) !== absAmount) return false;
          // Sign: expense doc → negative txn, income doc → positive txn
          if (isExpense && t.amount_minor > 0) return false;
          if (!isExpense && t.amount_minor < 0) return false;
          if (!hasStrongVendorAgreement(
            doc,
            `${t.counterparty_name ?? ''} ${t.description_raw ?? ''}`,
          )) return false;
          return daysBetween(t.posting_at, doc.document_date!) <= window;
        });

        if (candidates.length === 1) {
          createMatch(state, this.rule_id, [candidates[0].transaction_id], [doc.document_id], {
            type: 'scan_amount_date',
            window_days: window,
          });
        } else if (candidates.length > 1 && doc.document_date) {
          // Multiple candidates — pick closest by date if it's clearly the best
          const sorted = [...candidates].sort((a, b) =>
            daysBetween(a.posting_at, doc.document_date!) - daysBetween(b.posting_at, doc.document_date!)
          );
          const daysFirst = daysBetween(sorted[0].posting_at, doc.document_date);
          const daysSecond = daysBetween(sorted[1].posting_at, doc.document_date);
          if (daysFirst < daysSecond) {
            createMatch(state, this.rule_id, [sorted[0].transaction_id], [doc.document_id], {
              type: 'scan_amount_date_closest',
              window_days: window,
              days_to_match: daysFirst,
            });
          }
        }
      }
    }
  },
};
