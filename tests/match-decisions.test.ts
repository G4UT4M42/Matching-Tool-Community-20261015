import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyState } from '../src/storage/json-store.js';
import type { MatchingState, Transaction, Document, MatchGroup } from '../src/core/types.js';
import { createManualDecision, reviewDecision, unmatchDecision } from '../src/core/matching/decisions.js';
import { createMatchDecisionRouter } from '../src/server/routes/match-decisions.js';
import { createCommunityGuard } from '../src/server/community-guard.js';

function fixture(): MatchingState {
  const state = createEmptyState('TEST_SYNTHETIC_MATCH_DECISIONS');
  for (const [id, amount] of [['T1', -12000], ['T2', -5000], ['T3', 5000], ['T4', -7000]] as const) {
    const transaction: Transaction = {
      transaction_id: id, source_system: 'sparkasse', source_account_id: 'SYNTHETIC_ACCOUNT',
      source_row_ref: id, posting_at: '2026-01-15T12:00:00Z', amount_minor: amount, currency_code: 'EUR',
      description_raw: 'Fictional supplies', tags: ['synthetic'], meta: {},
    };
    state.transactions.set(id, transaction);
  }
  for (const [id, amount] of [['D1', -12000], ['D2', -5000], ['D3', 5000], ['D4', -7000]] as const) {
    const document: Document = {
      document_id: id, source_system: 'manual', source_document_ref: id, captured_at: '2026-01-15T12:00:00Z',
      document_date: '2026-01-15', total_amount_minor: amount, currency_code: 'EUR', meta: { synthetic: true },
    };
    state.documents.set(id, document);
  }
  return state;
}
function proposal(state: MatchingState): MatchGroup {
  const group: MatchGroup = {
    match_group_id: 'M1', status: 'proposed', created_at: '2026-01-16T12:00:00Z', created_by: 'system',
    rule_id: 'SYNTHETIC_EXACT', transaction_ids: ['T1'], document_ids: ['D1'], amount_total_minor: -12000,
    currency_code: 'EUR', reason_codes: [],
  };
  state.match_groups.set(group.match_group_id, group);
  state.matched_transaction_ids.add('T1'); state.matched_document_ids.add('D1');
  return group;
}
const actor = 'fictional-reviewer';
const request = { transaction_ids: ['T1'], document_ids: ['D1'], reason: 'Fictional manual review' };
describe('P08 matching decision invariants', () => {
  it('creates a full manual decision without mutating the previous state', () => {
    const before = fixture();
    const result = createManualDecision(before, request, actor);
    expect(before.match_groups.size).toBe(0);
    expect(before.audit_events).toHaveLength(0);
    expect(result.group).toMatchObject({ status: 'confirmed', amount_total_minor: -12000, currency_code: 'EUR', created_by: actor });
    expect(result.state.audit_events[0]).toMatchObject({ action: 'MATCH_CREATED_MANUAL', actor_type: 'user', actor_id: actor });
  });
  it('rejects duplicated identifiers rather than counting a transaction twice', () => {
    expect(() => createManualDecision(fixture(), { ...request, transaction_ids: ['T1', 'T1'] }, actor)).toThrow(/twice/);
  });
  it('rejects string arrays, missing IDs and unknown request fields', () => {
    for (const body of [{ ...request, transaction_ids: 'T1' }, { ...request, document_ids: ['missing'] }, { ...request, owner: 'another-user' }]) {
      expect(() => createManualDecision(fixture(), body, actor)).toThrow();
    }
  });
  it('prevents double allocation of an accepted record', () => {
    const first = createManualDecision(fixture(), request, actor);
    expect(() => createManualDecision(first.state, request, actor)).toThrow(/already belongs/);
  });
  it('does not overwrite rejected history when an equivalent new decision is created', () => {
    const first = createManualDecision(fixture(), request, actor);
    const undone = unmatchDecision(first.state, first.group.match_group_id, {}, actor);
    const next = createManualDecision(undone.state, request, actor);
    expect(next.state.match_groups.size).toBe(2);
    expect(next.state.match_groups.get(first.group.match_group_id)?.status).toBe('rejected');
    expect(new Set(next.state.audit_events.map(event => event.audit_id)).size).toBe(3);
  });
  it('accepts, rejects and reopens a proposal without losing its original evidence', () => {
    const original = fixture(); proposal(original);
    const accepted = reviewDecision(original, 'M1', { status: 'accepted' }, actor);
    expect(original.match_groups.get('M1')?.status).toBe('proposed');
    const rejected = reviewDecision(accepted.state, 'M1', { status: 'rejected' }, actor);
    expect(rejected.state.matched_transaction_ids.has('T1')).toBe(false);
    const reopened = reviewDecision(rejected.state, 'M1', { status: 'proposed', reason: 'Correct review' }, actor);
    expect(reopened.state.match_groups.get('M1')?.status).toBe('proposed');
    expect(reopened.state.audit_events).toHaveLength(3);
    expect(reopened.state.audit_events[0].after?.status).toBe('accepted');
  });
  it('requires a proposal before approval and rejects stale totals', () => {
    const state = fixture(); const group = proposal(state);
    group.amount_total_minor = 100;
    expect(() => reviewDecision(state, 'M1', { status: 'accepted' }, actor)).toThrow(/totals/);
    group.amount_total_minor = -12000; group.status = 'rejected';
    expect(() => reviewDecision(state, 'M1', { status: 'accepted' }, actor)).toThrow(/proposed/);
  });
  it('retains superseded proposals as rejected audited history', () => {
    const state = fixture(); proposal(state);
    const result = createManualDecision(state, request, actor);
    expect(result.state.match_groups.get('M1')?.status).toBe('rejected');
    expect(result.state.audit_events.map(event => event.action)).toEqual(['MATCH_CREATED_MANUAL', 'MATCH_REJECTED']);
  });
  it('rejects cross-currency implicit addition and excluded transactions', () => {
    const state = fixture(); state.documents.get('D1')!.currency_code = 'USD';
    expect(() => createManualDecision(state, request, actor)).toThrow(/currency/);
    state.documents.get('D1')!.currency_code = 'EUR'; state.excluded_transaction_ids.add('T1');
    expect(() => createManualDecision(state, request, actor)).toThrow(/excluded/);
  });
  it('preserves same-currency non-EUR records without relabeling them EUR', () => {
    const state = fixture(); state.transactions.get('T1')!.currency_code = 'USD'; state.documents.get('D1')!.currency_code = 'USD';
    expect(createManualDecision(state, request, actor).group.currency_code).toBe('USD');
  });
  it('supports a complete one-to-many invoice allocation', () => {
    const result = createManualDecision(fixture(), { transaction_ids: ['T1'], document_ids: ['D2', 'D4'] }, actor);
    expect(result.group.amount_total_minor).toBe(-12000);
  });
  it('supports a complete many-to-one invoice allocation', () => {
    const result = createManualDecision(fixture(), { transaction_ids: ['T2', 'T4'], document_ids: ['D1'] }, actor);
    expect(result.group.amount_total_minor).toBe(-12000);
  });
  it('requires explicit allocation for unequal totals rather than inventing a full payment', () => {
    expect(() => createManualDecision(fixture(), { transaction_ids: ['T2'], document_ids: ['D1'] }, actor)).toThrow(/allocation/);
  });
  it('supports a balanced refund/transfer pair without counting another invoice', () => {
    expect(createManualDecision(fixture(), { transaction_ids: ['T2', 'T3'], document_ids: [] }, actor).group.amount_total_minor).toBe(0);
    expect(() => createManualDecision(fixture(), { transaction_ids: ['T1'], document_ids: [] }, actor)).toThrow(/balanced/);
  });
  it('refuses invalid exact amounts and unsafe aggregate totals', () => {
    const state = fixture(); state.transactions.get('T1')!.amount_minor = Number.NaN;
    expect(() => createManualDecision(state, request, actor)).toThrow(/minor-unit/);
    state.transactions.get('T1')!.amount_minor = Number.MAX_SAFE_INTEGER;
    state.transactions.get('T2')!.amount_minor = 100;
    expect(() => createManualDecision(state, { transaction_ids: ['T1', 'T2'], document_ids: ['D1'] }, actor)).toThrow(/integer range/);
  });
});

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
});
it('P08 real HTTP authorization and persistence failure cannot mutate the active decision', async () => {
  let state = fixture(); proposal(state);
  const initial = structuredClone(state);
  const token = 'synthetic-matching-api-token-000000000000000';
  const app = express();
  app.use('/api', createCommunityGuard(token)); app.use(express.json());
  app.use('/api', createMatchDecisionRouter(() => state, candidate => { state = candidate; }, () => { throw new Error('Private internal storage path'); }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
  const base = `http://127.0.0.1:${address.port}/api`;
  expect((await fetch(base + '/matches/M1/status', { method: 'PATCH' })).status).toBe(401);
  const response = await fetch(base + '/matches/M1/status', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Community-Access-Token': token }, body: JSON.stringify({ status: 'accepted' }) });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('Private internal');
  expect(state).toEqual(initial);
});
