/**
 * R-FX-USD_INV-001: Match USD invoices (from invoice_scan) against
 * Visa/PayPal FX transactions by USD amount + date proximity.
 *
 * Two strategies:
 *  A) Exact USD match: transaction has fx.original_amount_minor (USD) — match within 5¢
 *  B) EUR↔USD approximate: no FX info on transaction — convert EUR to USD using
 *     approximate historical rate and match within 2% tolerance + date proximity.
 *
 * When matched, copies the EUR amount from the bank transaction
 * into the document's total_amount_minor and meta.eur_from_match.
 */
import type { MatchRule } from '../engine.js';
import type { MatchingState, Transaction, Document } from '../../types.js';
import { createMatch, findUnmatchedDocs, findUnmatched } from '../engine.js';
import { daysBetween } from '../../normalization/dates.js';
import { getDb } from '../../../storage/db.js';

/** Tolerance for percentage-based FX matching (2%) */
const FX_TOLERANCE_PERCENT = 0.02;

/** Max date proximity for FX matches (days) */
const MAX_DATE_DIFF_DAYS = 60;
const MAX_APPROX_DATE_DIFF_DAYS = 7;

const GENERIC_VENDOR_TOKENS = new Set([
  'company', 'corp', 'corporation', 'europe', 'gmbh', 'inc', 'invoice',
  'limited', 'llc', 'payment', 'paypal', 'receipt', 'subscription',
]);

function vendorTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(token =>
        token.length >= 4
        && /[a-z]/.test(token)
        && !GENERIC_VENDOR_TOKENS.has(token)
      ),
  );
}

/** Reject an explicit supplier/merchant contradiction while allowing missing labels. */
function hasVendorConflict(doc: Document, txn: Transaction): boolean {
  const compactDoc = `${doc.supplier_name ?? ''}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '');
  const compactTxn = `${txn.counterparty_name ?? ''} ${txn.description_raw ?? ''}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '');
  if (
    compactDoc.length >= 5
    && compactTxn.length >= 5
    && (compactTxn.includes(compactDoc) || compactDoc.includes(compactTxn))
  ) return false;
  const docTokens = vendorTokens(`${doc.supplier_name ?? ''} ${doc.filename ?? ''}`);
  const txnTokens = vendorTokens(`${txn.counterparty_name ?? ''} ${txn.description_raw ?? ''}`);
  if (docTokens.size === 0 || txnTokens.size === 0) return false;
  return ![...docTokens].some(token => txnTokens.has(token));
}

/**
 * Approximate historical USD/EUR rates by quarter.
 * Used when the bank transaction has no FX info (no rate on the statement).
 * Source: ECB reference rates, rounded. Updated periodically.
 */
const APPROX_USD_EUR_RATES: Array<{ from: string; to: string; rate: number }> = [
  // rate = how many USD per 1 EUR (e.g. 1.08 means 1 EUR = 1.08 USD)
  { from: '2023-01-01', to: '2023-06-30', rate: 1.08 },
  { from: '2023-07-01', to: '2023-12-31', rate: 1.09 },
  { from: '2024-01-01', to: '2024-06-30', rate: 1.08 },
  { from: '2024-07-01', to: '2024-12-31', rate: 1.10 },
  { from: '2025-01-01', to: '2025-06-30', rate: 1.05 },
  { from: '2025-07-01', to: '2025-12-31', rate: 1.08 },
  { from: '2026-01-01', to: '2026-12-31', rate: 1.10 },
];

/** Default fallback rate if date is outside known range */
const DEFAULT_USD_EUR_RATE = 1.08;

/** Get approximate USD/EUR rate for a given date */
function getApproxRate(dateStr: string): number {
  for (const entry of APPROX_USD_EUR_RATES) {
    if (dateStr >= entry.from && dateStr <= entry.to) return entry.rate;
  }
  return DEFAULT_USD_EUR_RATE;
}

/**
 * Check if a USD amount approximately matches an EUR amount given an approximate rate.
 * Returns true if they match within the tolerance percentage.
 */
function fxPercentMatch(
  eurMinor: number, usdMinor: number, rate: number, tolerance = FX_TOLERANCE_PERCENT,
): boolean {
  // expectedEur = usd / rate
  const expectedEurMinor = Math.round(Math.abs(usdMinor) / rate);
  const actualEurMinor = Math.abs(eurMinor);
  if (expectedEurMinor === 0) return false;
  const diff = Math.abs(expectedEurMinor - actualEurMinor);
  return diff / expectedEurMinor <= tolerance;
}

/** Get USD amount from a document */
function getDocUsdAmount(doc: Document): number {
  const meta = (doc.meta ?? {}) as Record<string, any>;
  if (meta.original_amount_minor != null) return Math.abs(meta.original_amount_minor as number);
  if (doc.currency_code === 'USD' && doc.total_amount_minor !== 0) return Math.abs(doc.total_amount_minor);
  return 0;
}

/** Check if a document is a USD document */
function isUsdDoc(doc: Document): boolean {
  const meta = (doc.meta ?? {}) as Record<string, any>;
  return doc.currency_code === 'USD' || meta.original_currency === 'USD' || meta.is_usd === true;
}

/** Get USD amount from a transaction's FX info */
function getTxnUsdAmount(txn: Transaction): number {
  if (txn.fx?.original_amount_minor) return Math.abs(txn.fx.original_amount_minor);
  const meta = (txn.meta ?? {}) as Record<string, any>;
  if (meta.original_amount_minor) return Math.abs(meta.original_amount_minor);
  return 0;
}

/** Apply EUR amount from bank transaction to matched USD document */
function applyEurAmount(doc: Document, txn: Transaction, usdAmount: number): void {
  const eurAmount = -Math.abs(txn.amount_minor); // expense = negative
  doc.total_amount_minor = eurAmount;
  doc.currency_code = 'EUR';
  const meta = doc.meta as Record<string, any>;
  meta.eur_from_match = Math.abs(txn.amount_minor);
  meta.eur_matched_txn = txn.transaction_id;
  meta.original_currency = 'USD';
  if (meta.original_amount_minor == null) {
    meta.original_amount_minor = usdAmount;
  }

  // Persist to DB
  try {
    const db = getDb();
    db.prepare('UPDATE documents SET total_amount_minor = ?, currency_code = ?, meta = ? WHERE document_id = ?')
      .run(eurAmount, 'EUR', JSON.stringify(doc.meta), doc.document_id);
  } catch {}
}

export const fxUsdInvoiceRule: MatchRule = {
  rule_id: 'R-FX-USD_INV-001',
  description: 'Match USD invoice scans to Visa/PayPal FX transactions by USD amount + date',
  apply(state: MatchingState) {
    // Find unmatched USD documents (from invoice_scan or invoice_file)
    const usdDocs = findUnmatchedDocs(state).filter(isUsdDoc);
    if (usdDocs.length === 0) return;

    // === Strategy A: Exact USD match (transaction has FX info with USD amount) ===

    // Visa FX transactions
    const visaFx = findUnmatched(state, 'visa', t =>
      t.fx != null && t.fx.original_amount_minor !== 0
    );
    // PayPal FX transactions
    const paypalFx = findUnmatched(state, 'paypal', t => {
      const meta = (t.meta ?? {}) as Record<string, any>;
      return meta.original_currency === 'USD' || (t.fx != null && t.fx.original_amount_minor !== 0);
    });
    const fxTxns = [...visaFx, ...paypalFx];

    for (const doc of usdDocs) {
      if (state.matched_document_ids.has(doc.document_id)) continue;
      const usdAmount = getDocUsdAmount(doc);
      if (usdAmount === 0) continue;

      let bestMatch: { txn: Transaction; diff: number } | null = null;

      for (const txn of fxTxns) {
        if (state.matched_transaction_ids.has(txn.transaction_id)) continue;
        const txnUsd = getTxnUsdAmount(txn);
        if (txnUsd === 0) continue;

        // Amount must match within 5 cents (FX rounding)
        if (Math.abs(txnUsd - usdAmount) > 5) continue;

        // Date proximity
        const days = doc.document_date ? daysBetween(doc.document_date, txn.posting_at) : 0;
        if (days > MAX_DATE_DIFF_DAYS) continue;
        if (hasVendorConflict(doc, txn)) continue;

        if (bestMatch) {
          // More than one plausible candidate is ambiguous: fail closed.
          bestMatch = null;
          break;
        }
        bestMatch = { txn, diff: days };
      }

      if (bestMatch) {
        const txn = bestMatch.txn;
        createMatch(state, this.rule_id, [txn.transaction_id], [doc.document_id], {
          type: 'fx_usd_invoice',
          strategy: 'exact_usd',
          usd_amount: usdAmount,
          eur_amount: Math.abs(txn.amount_minor),
          date_diff_days: bestMatch.diff,
        });
        applyEurAmount(doc, txn, usdAmount);
      }
    }

    // === Strategy B: Approximate EUR↔USD match (2% tolerance) ===
    // For USD docs still unmatched after Strategy A, try matching against
    // ANY unmatched EUR expense transaction using approximate FX rate.

    const remainingUsdDocs = usdDocs.filter(d => !state.matched_document_ids.has(d.document_id));
    if (remainingUsdDocs.length === 0) return;

    // All unmatched expense transactions across all sources
    const eurTxns = [
      ...findUnmatched(state, 'visa'),
      ...findUnmatched(state, 'sparkasse'),
      ...findUnmatched(state, 'paypal'),
    ].filter(t => t.amount_minor < 0); // expenses only

    for (const doc of remainingUsdDocs) {
      if (state.matched_document_ids.has(doc.document_id)) continue;
      const usdAmount = getDocUsdAmount(doc);
      if (usdAmount === 0) continue;

      // Get approximate rate for the document date
      const docDate = doc.document_date ?? '';
      const rate = getApproxRate(docDate);

      const candidates: Array<{ txn: Transaction; diff: number; rate: number }> = [];

      for (const txn of eurTxns) {
        if (state.matched_transaction_ids.has(txn.transaction_id)) continue;

        // Use the transaction's own FX rate if available, otherwise approximate
        let effectiveRate = rate;
        if (txn.fx?.rate && txn.fx.rate > 0) {
          effectiveRate = txn.fx.rate;
        }

        // Check EUR↔USD within 2% tolerance
        if (!fxPercentMatch(txn.amount_minor, usdAmount, effectiveRate)) continue;

        // Date proximity
        const days = docDate ? daysBetween(docDate, txn.posting_at) : 999;
        if (days > MAX_APPROX_DATE_DIFF_DAYS) continue;
        if (hasVendorConflict(doc, txn)) continue;

        candidates.push({ txn, diff: days, rate: effectiveRate });
      }

      const bestMatch = candidates.length === 1 ? candidates[0] : null;
      if (bestMatch) {
        const txn = bestMatch.txn;
        createMatch(state, this.rule_id, [txn.transaction_id], [doc.document_id], {
          type: 'fx_usd_invoice',
          strategy: 'eur_approx_2pct',
          usd_amount: usdAmount,
          eur_amount: Math.abs(txn.amount_minor),
          fx_rate_used: bestMatch.rate,
          tolerance_pct: FX_TOLERANCE_PERCENT,
          date_diff_days: bestMatch.diff,
        });
        applyEurAmount(doc, txn, usdAmount);
      }
    }
  },
};
