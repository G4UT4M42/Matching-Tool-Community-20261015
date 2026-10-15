import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MatchingState } from '../src/core/types.js';

let root: string;
let db: typeof import('../src/storage/db.js');
let json: typeof import('../src/storage/json-store.js');
let canonical: typeof import('../src/storage/canonical-transaction.js');
let state: MatchingState;
const originalRoot = process.env.MATCHING_RUNTIME_ROOT;
const originalMode = process.env.MATCHING_RUNTIME_MODE;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'matching-audit-snapshot-synthetic-'));
  process.env.MATCHING_RUNTIME_ROOT = root;
  process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root';
  vi.resetModules();
  db = await import('../src/storage/db.js'); db.getDb();
  json = await import('../src/storage/json-store.js');
  canonical = await import('../src/storage/canonical-transaction.js');
  state = json.createEmptyState('SYNTHETIC_AUDIT_SNAPSHOT');
  json.saveState(state); canonical.initializeCanonicalState(state);
});
afterEach(() => {
  db?.closeDb();
  if (originalRoot === undefined) delete process.env.MATCHING_RUNTIME_ROOT; else process.env.MATCHING_RUNTIME_ROOT = originalRoot;
  if (originalMode === undefined) delete process.env.MATCHING_RUNTIME_MODE; else process.env.MATCHING_RUNTIME_MODE = originalMode;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vi.resetModules();
});
async function propose() {
  const first = structuredClone(state);
  first.transactions.set('SYN-TX', { transaction_id: 'SYN-TX', source_system: 'sparkasse', source_account_id: 'SYN-ACCOUNT', source_row_ref: 'SYN-TX', posting_at: '2026-01-12', amount_minor: -1250, currency_code: 'EUR', description_raw: 'Fictional invoice settlement', tags: [], meta: { synthetic: true } });
  first.documents.set('SYN-DOC', { document_id: 'SYN-DOC', source_system: 'upload', source_document_ref: 'SYN-INVOICE', captured_at: '2026-01-12T00:00:00Z', document_date: '2026-01-12', total_amount_minor: 1250, currency_code: 'EUR', supplier_name: 'Fictional supplier', meta: { synthetic: true, settlement_convention: 'payable-face-v1' } });
  state = canonical.commitCanonicalState(state, first, 'synthetic-owner');
  const { proposeExactMatches } = await import('../src/core/matching/community-proposals.js');
  const { accountingOf } = await import('../src/community/accounting/ledger.js');
  const result = proposeExactMatches(state);
  expect(result.created).toHaveLength(1);
  result.state.accounting = { ...accountingOf(result.state), revision: 1 };
  state = canonical.commitCanonicalState(state, result.state, 'synthetic-owner');
  return result.created[0].match_group_id;
}

describe('immutable audit snapshots across live canonical matching decisions', () => {
  it('copies nested before and after evidence instead of retaining caller references', async () => {
    const { recordAudit } = await import('../src/observability/audit.js');
    const before = { status: 'proposed', nested: { ids: ['SYN-TX'] } };
    const after = { status: 'accepted', nested: { amount_minor: -1250 } };
    const expectedBefore = structuredClone(before), expectedAfter = structuredClone(after);
    const event = recordAudit(state, 'MATCH_ACCEPTED', 'MatchGroup', 'SYN-GROUP', { before, after });
    before.status = 'rejected'; before.nested.ids.push('UNRELATED');
    after.nested.amount_minor = -999;
    expect(event.before).toEqual(expectedBefore);
    expect(event.after).toEqual(expectedAfter);
    expect(event.before).not.toBe(before); expect(event.after).not.toBe(after);
  });

  it('keeps separate audit entries independent when the caller reuses an evidence object', async () => {
    const { recordAudit } = await import('../src/observability/audit.js');
    const evidence = { status: 'proposed', members: ['SYN-TX'] };
    const first = recordAudit(state, 'MATCH_PROPOSED', 'MatchGroup', 'SYN-A', { after: evidence });
    evidence.status = 'accepted';
    const second = recordAudit(state, 'MATCH_ACCEPTED', 'MatchGroup', 'SYN-A', { after: evidence });
    evidence.members.push('UNRELATED');
    expect(first.after).toEqual({ status: 'proposed', members: ['SYN-TX'] });
    expect(second.after).toEqual({ status: 'accepted', members: ['SYN-TX'] });
  });

  it('accepts a live exact proposal without rewriting its prior audit event, then restarts exactly', async () => {
    const id = await propose();
    const history = structuredClone(state.audit_events);
    const input = state;
    const { reviewDecision } = await import('../src/core/matching/decisions.js');
    const next = reviewDecision(state, id, { status: 'accepted', reason: 'SYNTHETIC_REVIEW' }, 'synthetic-owner').state;
    next.accounting!.revision++;
    expect(() => { state = canonical.commitCanonicalState(state, next, 'synthetic-owner'); }).not.toThrow();
    expect(state.match_groups.get(id)?.status).toBe('accepted');
    expect(input.match_groups.get(id)?.status).toBe('proposed');
    expect(state.audit_events.slice(0, history.length)).toEqual(history);
    expect(state.audit_events.find(event => event.action === 'MATCH_PROPOSED')?.after?.status).toBe('proposed');
    expect(db.getDb().prepare('SELECT status FROM match_groups WHERE match_group_id=?').pluck().get(id)).toBe('accepted');
    const disk = JSON.parse(readFileSync(join(root, 'state', 'state.json'), 'utf8'));
    expect(JSON.parse(db.getDb().prepare('SELECT state_json FROM community_canonical_state').pluck().get() as string)).toEqual(disk);
    db.closeDb(); db.getDb();
    expect(() => canonical.initializeCanonicalState(json.loadState()!)).not.toThrow();
    expect(json.loadState()).toEqual(state);
  });

  it('retains complete proposal/reject/reopen/accept/undo history through the real durable coordinator', async () => {
    const id = await propose();
    const { reviewDecision, unmatchDecision } = await import('../src/core/matching/decisions.js');
    for (const status of ['rejected', 'proposed', 'accepted'] as const) {
      const history = structuredClone(state.audit_events);
      const next = reviewDecision(state, id, { status, reason: 'SYNTHETIC_' + status }, 'synthetic-owner').state;
      next.accounting!.revision++;
      expect(() => { state = canonical.commitCanonicalState(state, next, 'synthetic-owner'); }).not.toThrow();
      expect(state.match_groups.get(id)?.status).toBe(status);
      expect(state.audit_events.slice(0, history.length)).toEqual(history);
    }
    const history = structuredClone(state.audit_events);
    const next = unmatchDecision(state, id, { reason: 'SYNTHETIC_UNDO' }, 'synthetic-owner').state;
    next.accounting!.revision++;
    state = canonical.commitCanonicalState(state, next, 'synthetic-owner');
    expect(state.match_groups.get(id)?.status).toBe('rejected');
    expect(state.audit_events.slice(0, history.length)).toEqual(history);
    expect(state.audit_events.map(event => event.action)).toEqual(['STATE_COMMITTED', 'MATCH_PROPOSED', 'MATCH_REJECTED', 'MATCH_REOPENED', 'MATCH_ACCEPTED', 'MATCH_DELETED']);
    expect(json.loadState()).toEqual(state);
  });
});
