import type { MatchingState, MatchGroup, Transaction, Document } from '../types.js';
import { matchGroupId } from '../ids.js';
import { isAvailable, isDocAvailable, txnsBySource } from '../pipeline.js';
import { recordAudit } from '../../observability/audit.js';

export interface MatchRule {
  rule_id: string;
  description: string;
  apply(state: MatchingState): void;
}

/** Create a match group and register it in state */
export function createMatch(
  state: MatchingState,
  rule_id: string,
  txnIds: string[],
  docIds: string[],
  evidence?: Record<string, unknown>,
): MatchGroup {
  const mg: MatchGroup = {
    match_group_id: matchGroupId(txnIds, docIds, rule_id),
    status: 'proposed',
    created_at: new Date().toISOString(),
    created_by: 'system',
    rule_id,
    transaction_ids: txnIds,
    document_ids: docIds,
    amount_total_minor: 0,
    currency_code: 'EUR',
    evidence,
    reason_codes: [],
  };

  // Compute total amount from transactions
  for (const id of txnIds) {
    const txn = state.transactions.get(id);
    if (txn) mg.amount_total_minor += txn.amount_minor;
  }

  state.match_groups.set(mg.match_group_id, mg);

  // Mark transactions and documents as matched
  for (const id of txnIds) state.matched_transaction_ids.add(id);
  for (const id of docIds) state.matched_document_ids.add(id);

  return mg;
}

/** Run all matching rules in waterfall order */
export function runMatchingEngine(state: MatchingState, rules: MatchRule[]): void {
  recordAudit(state, 'RUN_STARTED', 'Run', state.run_id);

  for (const rule of rules) {
    rule.apply(state);
  }

  recordAudit(state, 'RUN_FINISHED', 'Run', state.run_id, {
    after: {
      total_matches: state.match_groups.size,
      matched_transactions: state.matched_transaction_ids.size,
      matched_documents: state.matched_document_ids.size,
    },
  });
}

// --- Utility functions for rules ---

/** Find unmatched Sparkasse transactions matching a predicate */
export function findSparkasse(state: MatchingState, pred: (t: Transaction) => boolean): Transaction[] {
  return txnsBySource(state, 'sparkasse').filter((t) => isAvailable(state, t.transaction_id) && pred(t));
}

/** Find unmatched transactions of a given source */
export function findUnmatched(state: MatchingState, source: string, pred?: (t: Transaction) => boolean): Transaction[] {
  return txnsBySource(state, source).filter((t) =>
    isAvailable(state, t.transaction_id) && (pred ? pred(t) : true)
  );
}

/** Find unmatched documents */
export function findUnmatchedDocs(state: MatchingState, source?: string): Document[] {
  return [...state.documents.values()].filter((d) =>
    isDocAvailable(state, d.document_id) && (source ? d.source_system === source : true)
  );
}
