import { randomUUID } from 'node:crypto';
import type { MatchGroup, MatchingState, AuditAction } from '../types.js';
import { recordAudit } from '../../observability/audit.js';
import { accountingOf } from '../../community/accounting/ledger.js';
import { documentSettlementMinor, documentSettlementConvention } from '../../community/accounting/document-settlement.js';

/** Review errors deliberately contain no filesystem paths or provider details. */
export class MatchDecisionError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'MatchDecisionError';
  }
}
export interface DecisionResult { state: MatchingState; group: MatchGroup }
const committed = new Set(['accepted', 'confirmed', 'manual']);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function fields(body: unknown, allowed: string[]): Record<string, unknown> {
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) {
    throw new MatchDecisionError(400, 'INVALID_MATCH_REQUEST', 'Invalid matching request fields');
  }
  return body;
}
function ids(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000 || value.some(id =>
    typeof id !== 'string' || !id.trim() || id.length > 200 || /[\u0000-\u001f]/.test(id))) {
    throw new MatchDecisionError(400, 'INVALID_MATCH_IDS', `${name} must be an array of valid identifiers`);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) {
    throw new MatchDecisionError(400, 'DUPLICATE_MATCH_IDS', 'A record cannot occur twice in a matching group');
  }
  return result;
}
function reason(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new MatchDecisionError(400, 'INVALID_MATCH_REASON', 'The review reason must be plain text of at most 2000 characters');
  }
  return value.trim() || fallback;
}
function exactTotal(values: number[]): number {
  let result = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new MatchDecisionError(409, 'INVALID_FINANCIAL_RECORD', 'A record has an invalid minor-unit amount');
    result += BigInt(value);
  }
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MatchDecisionError(400, 'MATCH_AMOUNT_OVERFLOW', 'The matching total exceeds the exact integer range');
  }
  return Number(result);
}
// Do not pass a defaulted second numeric parameter through Array.map's index.
function documentSettlementMinorWhole(document: import('../types.js').Document): number { return documentSettlementMinor(document); }
function overlaps(a: MatchGroup, transactionIds: string[], documentIds: string[]): boolean {
  return a.transaction_ids.some(id => transactionIds.includes(id)) || a.document_ids.some(id => documentIds.includes(id));
}
function validateMembers(state: MatchingState, transactionIds: string[], documentIds: string[], currentId?: string) {
  ids(transactionIds, 'transaction_ids');
  ids(documentIds, 'document_ids');
  if (!transactionIds.length) throw new MatchDecisionError(400, 'TRANSACTION_REQUIRED', 'A financial match needs at least one transaction');
  const transactions = transactionIds.map(id => {
    const value = state.transactions.get(id);
    if (!value) throw new MatchDecisionError(404, 'MATCH_RESOURCE_NOT_FOUND', 'A selected transaction no longer exists');
    if (value.meta?.accounting_status === 'cancelled') throw new MatchDecisionError(409, 'CANCELLED_MATCH_RESOURCE', 'A cancelled transaction cannot be matched');
    if (state.excluded_transaction_ids.has(id)) throw new MatchDecisionError(409, 'EXCLUDED_MATCH_RESOURCE', 'An excluded transaction cannot be accepted as a match');
    return value;
  });
  const documents = documentIds.map(id => {
    const value = state.documents.get(id);
    if (!value) throw new MatchDecisionError(404, 'MATCH_RESOURCE_NOT_FOUND', 'A selected document no longer exists');
    if (value.meta?.accounting_status === 'cancelled') throw new MatchDecisionError(409, 'CANCELLED_MATCH_RESOURCE', 'A cancelled document cannot be matched');
    return value;
  });
  const currencies = new Set([...transactions, ...documents].map(value => value.currency_code));
  if (currencies.size !== 1 || [...currencies].some(value => !/^[A-Z]{3}$/.test(value))) {
    throw new MatchDecisionError(400, 'MATCH_CURRENCY_ALLOCATION_REQUIRED', 'Cross-currency matching requires an explicit exchange-rate allocation');
  }
  for (const group of state.match_groups.values()) {
    if (group.match_group_id !== currentId && committed.has(group.status) && overlaps(group, transactionIds, documentIds)) {
      throw new MatchDecisionError(409, 'MATCH_ALLOCATION_CONFLICT', 'A selected record already belongs to an accepted matching decision');
    }
  }
  if (accountingOf(state).allocations.some(a => a.status === 'accepted' &&
      (transactionIds.includes(a.transaction_id) || (a.document_id !== undefined && documentIds.includes(a.document_id))))) {
    throw new MatchDecisionError(409, 'MATCH_ALLOCATION_CONFLICT', 'A selected record already has a partial allocation');
  }
  if (accountingOf(state).classifications.some(c => c.category === 'private' && transactionIds.includes(c.transaction_id))) {
    throw new MatchDecisionError(409, 'PRIVATE_MATCH_RESOURCE', 'A private transaction cannot be accepted as a match');
  }
  const total = exactTotal(transactions.map(value => value.amount_minor));
  const documentTotal = exactTotal(documents.map(documentSettlementMinorWhole));
  return { total, documentTotal, currency: transactions[0].currency_code };
}
function audit(state: MatchingState, action: AuditAction, group: MatchGroup, actor: string, note: string, before?: MatchGroup) {
  recordAudit(state, action, 'MatchGroup', group.match_group_id, {
    actor_type: 'user', actor_id: actor,
    before: before ? structuredClone(before) as unknown as Record<string, unknown> : undefined,
    after: structuredClone(group) as unknown as Record<string, unknown>,
    reason: note, correlation_id: randomUUID(),
  });
}
/** Legacy sets reserve proposals as well as accepted groups; they are not tax evidence. */
function rebuildReservations(state: MatchingState): void {
  state.matched_transaction_ids.clear();
  state.matched_document_ids.clear();
  for (const group of state.match_groups.values()) {
    if (group.status === 'rejected') continue;
    for (const id of group.transaction_ids) state.matched_transaction_ids.add(id);
    for (const id of group.document_ids) state.matched_document_ids.add(id);
  }
  for (const allocation of accountingOf(state).allocations) {
    if (allocation.status !== 'accepted') continue;
    state.matched_transaction_ids.add(allocation.transaction_id);
    if (allocation.document_id) state.matched_document_ids.add(allocation.document_id);
  }
}
function supersedeProposals(state: MatchingState, group: MatchGroup, actor: string) {
  for (const other of state.match_groups.values()) {
    if (other.match_group_id !== group.match_group_id && other.status === 'proposed' && overlaps(other, group.transaction_ids, group.document_ids)) {
      const before = structuredClone(other);
      other.status = 'rejected';
      audit(state, 'MATCH_REJECTED', other, actor, `Superseded by explicit decision ${group.match_group_id}`, before);
    }
  }
}

/** Pure candidate construction: the caller must persist successfully before activation. */
export function createManualDecision(input: MatchingState, body: unknown, actor: string): DecisionResult {
  const request = fields(body, ['transaction_ids', 'document_ids', 'reason']);
  const transactionIds = ids(request.transaction_ids, 'transaction_ids');
  const documentIds = ids(request.document_ids, 'document_ids');
  const totals = validateMembers(input, transactionIds, documentIds);
  if (documentIds.length && (totals.total !== totals.documentTotal)) {
    throw new MatchDecisionError(400, 'MATCH_PARTIAL_ALLOCATION_REQUIRED', 'Unequal transaction and invoice totals require explicit partial-payment or fee allocation');
  }
  if (!documentIds.length && (transactionIds.length < 2 || totals.total !== 0)) {
    throw new MatchDecisionError(400, 'MATCH_EVIDENCE_REQUIRED', 'Without invoices, only a balanced transfer between two or more transactions can be confirmed');
  }
  const note = reason(request.reason, 'Explicit manual reconciliation');
  const state = structuredClone(input);
  const group: MatchGroup = {
    match_group_id: `MG-${randomUUID()}`, status: 'confirmed', created_at: new Date().toISOString(),
    created_by: actor, rule_id: 'MANUAL', transaction_ids: transactionIds, document_ids: documentIds,
    amount_total_minor: totals.total, currency_code: totals.currency,
    evidence: { type: 'manual', reason: note, allocation: 'full-records', document_settlement_conventions: Object.fromEntries(documentIds.map(id => [id, documentSettlementConvention(state.documents.get(id)!)])) }, reason_codes: ['manual_match'],
  };
  state.match_groups.set(group.match_group_id, group);
  audit(state, 'MATCH_CREATED_MANUAL', group, actor, note);
  supersedeProposals(state, group, actor);
  rebuildReservations(state);
  return { state, group };
}

export function reviewDecision(input: MatchingState, id: string, body: unknown, actor: string): DecisionResult {
  const request = fields(body, ['status', 'reason']);
  if (request.status !== 'accepted' && request.status !== 'rejected' && request.status !== 'proposed') {
    throw new MatchDecisionError(400, 'INVALID_MATCH_STATUS', 'Choose accepted, rejected or proposed');
  }
  const existing = input.match_groups.get(id);
  if (!existing) throw new MatchDecisionError(404, 'MATCH_NOT_FOUND', 'Matching group not found');
  if (existing.status === request.status) throw new MatchDecisionError(409, 'MATCH_ALREADY_REVIEWED', 'The matching group is already in this state');
  if (request.status === 'accepted') {
    if (existing.status !== 'proposed') throw new MatchDecisionError(409, 'MATCH_REVIEW_CONFLICT', 'Only a proposed group can be accepted; reopen the decision first');
    const totals = validateMembers(input, existing.transaction_ids, existing.document_ids, id);
    if ((existing.document_ids.length && totals.total !== totals.documentTotal) || (!existing.document_ids.length && (existing.transaction_ids.length < 2 || totals.total !== 0))) {
      throw new MatchDecisionError(409, 'MATCH_EXPLICIT_ALLOCATION_REQUIRED', 'The proposal requires an explicit partial-payment, fee or transfer allocation before acceptance');
    }
    if (existing.amount_total_minor !== totals.total || existing.currency_code !== totals.currency) {
      throw new MatchDecisionError(409, 'STALE_MATCH_FINANCIALS', 'The proposal totals no longer agree with its source records');
    }
  }
  const note = reason(request.reason, request.status === 'proposed' ? 'Decision reopened for review' : `Matching proposal ${request.status}`);
  const state = structuredClone(input);
  const group = state.match_groups.get(id)!;
  group.status = request.status;
  // Reopening is a correction, not a new accepted accounting decision.
  const action: AuditAction = request.status === 'accepted' ? 'MATCH_ACCEPTED' : request.status === 'proposed' ? 'MATCH_REOPENED' : 'MATCH_REJECTED';
  audit(state, action, group, actor, note, existing);
  if (request.status === 'accepted') supersedeProposals(state, group, actor);
  rebuildReservations(state);
  return { state, group };
}

/** Preserve rejected groups and their source links; deletion is an auditable unmatch. */
export function unmatchDecision(input: MatchingState, id: string, body: unknown, actor: string): DecisionResult {
  const request = fields(body ?? {}, ['reason']);
  const existing = input.match_groups.get(id);
  if (!existing) throw new MatchDecisionError(404, 'MATCH_NOT_FOUND', 'Matching group not found');
  if (existing.status === 'rejected') throw new MatchDecisionError(409, 'MATCH_ALREADY_REVIEWED', 'This matching decision is already inactive');
  const state = structuredClone(input);
  const group = state.match_groups.get(id)!;
  group.status = 'rejected';
  audit(state, 'MATCH_DELETED', group, actor, reason(request.reason, 'Matching decision undone; history retained'), existing);
  rebuildReservations(state);
  return { state, group };
}
