import { createHash } from 'node:crypto';
import type { MatchGroup, MatchingState } from '../types.js';
import { remainingBalances } from '../../community/accounting/ledger.js';
import { documentSettlementMinor, documentSettlementConvention } from '../../community/accounting/document-settlement.js';
import { recordAudit } from '../../observability/audit.js';

/** Exact full-record candidates. A rerun keeps rejected history and never changes accepted decisions. */
export function proposeExactMatches(input: MatchingState): { state: MatchingState; created: MatchGroup[] } {
  const state = structuredClone(input);
  const balances = remainingBalances(state);
  const created: MatchGroup[] = [];
  const transactions = [...state.transactions.values()].filter(t =>
    Number.isSafeInteger(t.amount_minor) && t.amount_minor !== 0 && /^[A-Z]{3}$/.test(t.currency_code) &&
    balances.transaction.get(t.transaction_id) === BigInt(t.amount_minor) && !state.excluded_transaction_ids.has(t.transaction_id) && t.meta?.accounting_status !== 'cancelled');
  const documents = [...state.documents.values()].filter(d =>
    Number.isSafeInteger(d.total_amount_minor) && d.total_amount_minor !== 0 && /^[A-Z]{3}$/.test(d.currency_code) &&
    balances.document.get(d.document_id) === BigInt(d.total_amount_minor) && d.meta?.accounting_status !== 'cancelled');
  const candidates = transactions.flatMap(t => documents.filter(d => t.amount_minor === documentSettlementMinor(d) && t.currency_code === d.currency_code)
    .map(d => ({ t, d })));
  const txCounts = new Map<string, number>(); const docCounts = new Map<string, number>();
  for (const pair of candidates) { txCounts.set(pair.t.transaction_id, (txCounts.get(pair.t.transaction_id) ?? 0) + 1); docCounts.set(pair.d.document_id, (docCounts.get(pair.d.document_id) ?? 0) + 1); }
  candidates.sort((a, b) => a.t.transaction_id.localeCompare(b.t.transaction_id) || a.d.document_id.localeCompare(b.d.document_id));
  for (const { t, d } of candidates) {
    const key = `${t.transaction_id}\u0000${d.document_id}\u0000${t.amount_minor}\u0000${t.currency_code}`;
    const groupId = `CM-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
    if (state.match_groups.has(groupId)) continue;
    const ambiguous = (txCounts.get(t.transaction_id) ?? 0) > 1 || (docCounts.get(d.document_id) ?? 0) > 1;
    const group: MatchGroup = {
      match_group_id: groupId, status: 'proposed', created_at: new Date().toISOString(), created_by: 'system',
      rule_id: 'EXACT_SIGNED_AMOUNT_CURRENCY', transaction_ids: [t.transaction_id], document_ids: [d.document_id],
      amount_total_minor: t.amount_minor, currency_code: t.currency_code,
      reason_codes: ambiguous ? ['exact_amount_currency', 'ambiguous_candidate'] : ['exact_amount_currency'],
      evidence: { transaction_source_row_ref: t.source_row_ref, document_source_ref: d.source_document_ref,
        amount_minor: t.amount_minor, document_amount_minor: d.total_amount_minor, document_settlement_convention: documentSettlementConvention(d), currency_code: t.currency_code, tie_transaction_count: txCounts.get(t.transaction_id), tie_document_count: docCounts.get(d.document_id) },
    };
    state.match_groups.set(groupId, group); created.push(group);
    state.matched_transaction_ids.add(t.transaction_id); state.matched_document_ids.add(d.document_id);
    recordAudit(state, 'MATCH_PROPOSED', 'MatchGroup', groupId, { after: group as unknown as Record<string, unknown>, reason: 'Exact signed minor units and currency' });
  }
  return { state, created };
}
