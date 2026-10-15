import express from 'express';
import type { Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createEmptyState } from '../src/storage/json-store.js';
import { createCommunityAccountingRouter } from '../src/server/routes/community-accounting.js';
import type { MatchingState } from '../src/core/types.js';

let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });
it('authenticates workspace, enforces roles, persists only through coordinator, and exports exact data', async () => {
  let state: MatchingState = createEmptyState('SYNTHETIC_ROUTE');
  state.transactions.set('T1', { transaction_id: 'T1', source_system: 'sparkasse', source_account_id: 'FAKE', source_row_ref: 'T1',
    posting_at: '2026-01-01T00:00:00Z', amount_minor: -100, currency_code: 'EUR', description_raw: '=DANGEROUS()', tags: [], meta: {} });
  state.documents.set('D1', { document_id: 'D1', source_system: 'manual', source_document_ref: 'D1', captured_at: '2026-01-01T00:00:00Z',
    document_date: '2026-01-01', total_amount_minor: -100, currency_code: 'EUR', meta: {} });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.headers['x-synthetic-role']) res.locals.communityPrincipal = {
    subject: 'trusted-fictional-owner', workspace_id: String(req.headers['x-synthetic-workspace'] ?? 'workspace-A'),
    role: req.headers['x-synthetic-role'],
  }; next(); });
  const persisted: Array<{ expected: MatchingState; next: MatchingState; actor: string }> = [];
  app.use('/api', createCommunityAccountingRouter({ workspaceId: 'workspace-A', getState: () => state,
    can: (p, permission) => p.role === 'owner' || (p.role === 'viewer' && ['finance:read', 'reports:read'].includes(permission)),
    persistAndActivate: (expected, next, actor) => { if (expected !== state) throw new Error('STALE'); persisted.push({ expected, next, actor }); state = next; },
  }));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve));
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('No listener');
  const base = `http://127.0.0.1:${addr.port}/api`;
  const body = JSON.stringify({ revision: 0, evidence_ref: 'SYNTHETIC', actor: 'spoofed', allocations: [{ kind: 'payment', transaction_id: 'T1', document_id: 'D1', transaction_amount_minor: -100, document_amount_minor: -100 }] });
  const post = (headers: Record<string, string>, value = body) => fetch(`${base}/accounting/allocations`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: value });
  expect((await post({})).status).toBe(401);
  expect((await post({ 'x-synthetic-role': 'viewer' })).status).toBe(403);
  expect((await post({ 'x-synthetic-role': 'owner', 'x-synthetic-workspace': 'other' })).status).toBe(403);
  const owner = { 'x-synthetic-role': 'owner' };
  expect((await post(owner)).status).toBe(400);
  const good = body.replace(',"actor":"spoofed"', '');
  expect((await post(owner, good)).status).toBe(200);
  expect(persisted).toHaveLength(1);
  expect(persisted[0].actor).toBe('trusted-fictional-owner');
  expect(persisted[0].expected.accounting).toBeUndefined();
  expect((await post(owner, good)).status).toBe(409);
  const report = await fetch(`${base}/accounting/reports?start=2026-01-01&end=2026-01-01`, { headers: { 'x-synthetic-role': 'viewer' } });
  expect(report.status).toBe(200);
  expect(((await report.json()) as { documents: Array<{ reconciliation: string }> }).documents[0].reconciliation).toBe('fully_matched');
  const csv = await fetch(`${base}/accounting/reports/export.csv?start=2026-01-01&end=2026-01-01`, { headers: { 'x-synthetic-role': 'viewer' } });
  expect(csv.status).toBe(200);
  expect(await csv.text()).toContain("'=DANGEROUS()");
  expect((await fetch(`${base}/accounting/audit`, { headers: { 'x-synthetic-role': 'viewer' } })).status).toBe(403);
});

it('reviews an exact proposal through the coordinator without trusting body identity', async () => {
  let state = createEmptyState('SYNTHETIC_PROPOSAL_ROUTE');
  state.transactions.set('T', { transaction_id: 'T', source_system: 'sparkasse', source_account_id: 'FAKE', source_row_ref: 'T',
    posting_at: '2026-01-01T00:00:00Z', amount_minor: -125, currency_code: 'EUR', description_raw: 'Fictional', tags: [], meta: {} });
  state.documents.set('D', { document_id: 'D', source_system: 'manual', source_document_ref: 'D', captured_at: '2026-01-01T00:00:00Z',
    document_date: '2026-01-01', total_amount_minor: -125, currency_code: 'EUR', meta: {} });
  const app = express(); app.use(express.json()); app.use((_req, res, next) => { res.locals.communityPrincipal = { subject: 'trusted-owner', workspace_id: 'W', role: 'owner' }; next(); });
  app.use('/api', createCommunityAccountingRouter({ workspaceId: 'W', getState: () => state, can: () => true,
    persistAndActivate: (expected, next) => { expect(expected).toBe(state); state = next; } }));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve));
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('No listener');
  const base = `http://127.0.0.1:${addr.port}/api`;
  const proposed = await fetch(`${base}/accounting/proposals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(proposed.status).toBe(200);
  const created = (await proposed.json()) as { created: Array<{ match_group_id: string }> };
  expect(created.created).toHaveLength(1);
  expect(state.match_groups.get(created.created[0].match_group_id)?.status).toBe('proposed');
  expect((await fetch(`${base}/accounting/proposals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  expect(state.match_groups.size).toBe(1);
  const accepted = await fetch(`${base}/accounting/matches/${created.created[0].match_group_id}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, status: 'accepted', reason: 'Reviewed fictional invoice', actor: 'spoof' }),
  });
  expect(accepted.status).toBe(200);
  expect(state.match_groups.get(created.created[0].match_group_id)?.status).toBe('accepted');
  expect(state.audit_events.at(-1)?.actor_id).toBe('trusted-owner');
  expect((await fetch(`${base}/accounting/matches/${created.created[0].match_group_id}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, status: 'rejected' }),
  })).status).toBe(409);
});
