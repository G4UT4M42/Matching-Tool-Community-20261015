import { join } from 'path';
import { existsSync } from 'fs';
import type { MatchingState } from './types.js';
import { generateRunId } from './ids.js';
import { createEmptyState } from '../storage/json-store.js';

// Ingestion
import { parseSparkasse } from './ingestion/sparkasse.js';
import { parseVisa } from './ingestion/visa.js';
import { parsePaypal } from './ingestion/paypal.js';
import { parseStripe } from './ingestion/stripe.js';
import { parseIncome } from './ingestion/income.js';
import { parseInvoices } from './ingestion/invoices.js';
import { parseExtractedInvoices } from './ingestion/extracted-invoices.js';

// Normalization
import { normalizeSparkasse, normalizeVisa, normalizePaypal, normalizeStripe } from './normalization/normalize-transaction.js';
import { normalizeIncomeDocument, normalizeInvoiceDocument, normalizeExtractedInvoice } from './normalization/normalize-document.js';

export interface PipelineInput {
  dataDir: string;
  matchedFile?: string; // for extracted_invoice sheet
}

/**
 * Run the ingestion + normalization pipeline.
 * Returns a MatchingState with all transactions and documents loaded.
 */
export function ingestAndNormalize(input: PipelineInput): MatchingState {
  const state = createEmptyState(generateRunId());

  // --- Ingest Sparkasse ---
  const spkFile = join(input.dataDir, 'Sparkasse.xlsx');
  if (existsSync(spkFile)) {
    const rows = parseSparkasse(spkFile);
    for (const row of rows) {
      const txn = normalizeSparkasse(row);
      state.transactions.set(txn.transaction_id, txn);
    }
  }

  // --- Ingest Visa ---
  const visaFile = join(input.dataDir, 'Visa.xlsx');
  if (existsSync(visaFile)) {
    const rows = parseVisa(visaFile);
    for (const row of rows) {
      const txn = normalizeVisa(row);
      state.transactions.set(txn.transaction_id, txn);
    }
  }

  // --- Ingest PayPal ---
  const ppFile = join(input.dataDir, 'Paypal.xlsx');
  if (existsSync(ppFile)) {
    const rows = parsePaypal(ppFile);
    for (const row of rows) {
      const txn = normalizePaypal(row);
      state.transactions.set(txn.transaction_id, txn);
    }
  }

  // --- Ingest Stripe ---
  const stripeFile = join(input.dataDir, 'Stripe.xlsx');
  if (existsSync(stripeFile)) {
    const rows = parseStripe(stripeFile);
    for (const row of rows) {
      const txn = normalizeStripe(row);
      state.transactions.set(txn.transaction_id, txn);
    }
  }

  // --- Ingest Income (as documents) ---
  const incomeFile = join(input.dataDir, 'Income.xlsx');
  if (existsSync(incomeFile)) {
    const rows = parseIncome(incomeFile);
    for (const row of rows) {
      const doc = normalizeIncomeDocument(row);
      state.documents.set(doc.document_id, doc);
    }
  }

  // --- Ingest Invoices (as documents) ---
  const invFile = join(input.dataDir, 'invoices.xlsx');
  if (existsSync(invFile)) {
    const rows = parseInvoices(invFile);
    for (const row of rows) {
      const doc = normalizeInvoiceDocument(row);
      state.documents.set(doc.document_id, doc);
    }
  }

  // --- Ingest Extracted Invoices from matched.xlsm ---
  const matchedFile = input.matchedFile ?? join(input.dataDir, 'matched.xlsm');
  if (existsSync(matchedFile)) {
    try {
      const rows = parseExtractedInvoices(matchedFile);
      for (const row of rows) {
        const doc = normalizeExtractedInvoice(row);
        state.documents.set(doc.document_id, doc);
      }
    } catch {
      // extracted_invoice sheet may not exist in all files
    }
  }

  return state;
}

/** Get transactions by source system */
export function txnsBySource(state: MatchingState, source: string): import('./types.js').Transaction[] {
  return [...state.transactions.values()].filter((t) => t.source_system === source);
}

/** Get documents by source system */
export function docsBySource(state: MatchingState, source: string): import('./types.js').Document[] {
  return [...state.documents.values()].filter((d) => d.source_system === source);
}

/** Check if a transaction is already matched or excluded */
export function isAvailable(state: MatchingState, txnId: string): boolean {
  return !state.matched_transaction_ids.has(txnId) && !state.excluded_transaction_ids.has(txnId);
}

/** Check if a document is already matched */
export function isDocAvailable(state: MatchingState, docId: string): boolean {
  return !state.matched_document_ids.has(docId);
}
