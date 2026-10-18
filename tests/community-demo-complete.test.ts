import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { createCommunityDemoState } from '../src/server/community-demo-state.js';
import { communityDemoProjection, DEMO_WORKSPACE, ensureCommunityDemoDraft } from '../src/server/community-demo-preview.js';
import { accountingReport } from '../src/community/accounting/reports.js';
import { validateAccountingState } from '../src/community/accounting/ledger.js';
import { createEmptyState, serializeCommunityState } from '../src/storage/json-store.js';

const owned: string[] = [], closers: Array<() => Promise<void>> = [];
const originalEnvironment = { ...process.env };
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  process.env = { ...originalEnvironment }; vi.resetModules();
  for (const directory of owned.splice(0)) {
    const target = resolve(directory), parent = resolve(tmpdir());
    if (dirname(target) !== parent || !target.startsWith(join(parent, 'community-demo-complete-synthetic-'))) throw new Error('UNOWNED_TEST_DIRECTORY');
    rmSync(target, { recursive: true, force: true });
  }
});

it('creates deterministic provider, fee, refund, FX and partial evidence while retaining the original records', () => {
  const first = createCommunityDemoState(), second = createCommunityDemoState();
  expect(serializeCommunityState(first)).toBe(serializeCommunityState(second));
  expect(first.transactions.size).toBe(17); expect(first.documents.size).toBe(13);
  expect([...new Set([...first.transactions.values()].map(t => t.source_system))].sort()).toEqual(['enablebanking', 'paypal', 'sparkasse', 'stripe', 'visa']);
  const originals = [
    ['DEMO-TXN-001', -12900, '2026-01-14', 'Cedar Example Labs', 'Fictional office supplies'],
    ['DEMO-TXN-002', -5050, '2026-01-15', 'Harbor Demonstration Supplies', 'Fictional subscription'],
    ['DEMO-TXN-003', 5050, '2026-01-17', 'Harbor Demonstration Supplies', 'Fictional refund'],
    ['DEMO-TXN-004', 39200, '2026-01-21', 'Sunrise Example Services', 'Fictional revenue'],
  ] as const;
  for (const [id, amount, date, counterparty, note] of originals) expect(first.transactions.get(id)).toEqual({
    transaction_id: id, source_system: 'sparkasse', source_account_id: 'NON-ROUTABLE-DEMO', source_row_ref: id,
    posting_at: date + 'T12:00:00Z', amount_minor: amount, currency_code: 'EUR', description_raw: note,
    counterparty_name: counterparty, tags: ['synthetic-demo'], meta: { source: 'TEST_SYNTHETIC', network_enabled: false },
  });
  for (const [id, date, supplier, amount] of [['DEMO-DOC-001', '2026-01-13', 'Cedar Example Labs', -12900], ['DEMO-DOC-002', '2026-01-14', 'Harbor Demonstration Supplies', -5050]] as const) {
    expect(first.documents.get(id)).toEqual({ document_id: id, source_system: 'amazon', source_document_ref: id,
      captured_at: date + 'T13:00:00Z', document_date: date, total_amount_minor: amount, currency_code: 'EUR', supplier_name: supplier,
      vat_rate: 0.2, meta: { source: 'TEST_SYNTHETIC', invoice_country: 'AT', sample_only: true } });
  }
  expect(first.match_groups.get('DEMO-MATCH-001')?.status).toBe('accepted');
  expect(first.match_groups.get('DEMO-MATCH-002')?.status).toBe('proposed');
  expect(() => validateAccountingState(first)).not.toThrow();
  for (const doc of first.documents.values()) if (doc.meta.source_fixture) expect(doc.file_hash).toBe(createHash('sha256').update(String(doc.meta.source_fixture)).digest('hex'));
});

it('reports the actual exact ledger: partial balance, balanced payout, signed fees/refunds, currencies and recognized VAT', () => {
  const state = createCommunityDemoState(), report = accountingReport(state, { start: '2026-01-01', end: '2026-12-31' });
  expect(report.totals_by_currency).toEqual({ EUR: { expense: -30950, refund: -2950, income: 75200, fee: -2940, private: -2000, transfer: 0 }, USD: { income: 5000 } });
  expect(report.vat_by_currency).toEqual({ EUR: { output_minor: 11200, eligible_input_minor: -2150, unclassified_documents: 0 }, USD: { output_minor: 0, eligible_input_minor: 0, unclassified_documents: 0 } });
  expect(report.documents.find(d => d.document_id === 'DEMO-DOC-007')).toMatchObject({ total_amount_minor: 10000, remaining_minor: 6000, reconciliation: 'partially_matched', input_tax_eligible: false });
  expect(report.documents.find(d => d.document_id === 'DEMO-DOC-008')).toMatchObject({ currency_code: 'USD', remaining_minor: 0, reconciliation: 'fully_matched' });
  expect(report.documents.find(d => d.document_id === 'DEMO-DOC-002')?.reconciliation).toBe('unmatched');
  expect(state.accounting!.allocations.filter(a => a.kind === 'transfer').reduce((total, a) => total + a.transaction_amount_minor, 0)).toBe(0);
  expect(report.rows.find(t => t.transaction_id === 'DEMO-TXN-015')?.category).toBe('transfer');
});

async function application() {
  const runtime = mkdtempSync(join(tmpdir(), 'community-demo-complete-synthetic-')); owned.push(runtime);
  Object.assign(process.env, { MATCHING_RUNTIME_MODE: 'external-runtime-root', MATCHING_RUNTIME_ROOT: runtime,
    MATCHING_DEMO_MODE: 'true', MATCHING_AUTH_MODE: 'synthetic-preview', MATCHING_LOCAL_ACCESS_TOKEN: randomBytes(32).toString('base64url'),
    MATCHING_HTTP_HOST: '127.0.0.1', MATCHING_ENABLE_BANK_AUTOMATION: 'false', PORT: '31701' });
  vi.resetModules();
  const { createCommunityApplication } = await import('../src/server/application.js');
  const { getDb } = await import('../src/storage/db.js');
  let app = createCommunityApplication();
  let server: Server | undefined;
  const stop = async () => { if (server) { const current = server; server = undefined; await new Promise<void>((ok, fail) => current.close(e => e ? fail(e) : ok())); } await app.close(); };
  closers.push(stop);
  const listen = async () => { server = await new Promise<Server>(ok => { const listener = app.app.listen(0, '127.0.0.1', () => ok(listener)); }); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };
  return { runtime, token: process.env.MATCHING_LOCAL_ACCESS_TOKEN!, db: () => getDb(), listen, restart: async () => { await stop(); app = createCommunityApplication(); return listen(); } };
}

it('seeds an actual unsubmitted simulator draft and retains identical source, item economics and history after restart', async () => {
  const app = await application(), url = await app.listen(), headers = { 'x-community-access-token': app.token };
  const response = await fetch(url + '/api/community/demo', { headers }); expect(response.status).toBe(200);
  const before = await response.json();
  expect(before.mode).toBe('synthetic-preview'); expect(before.network_enabled).toBe(false);
  expect(before.transactions).toHaveLength(17); expect(before.documents).toHaveLength(13); expect(before.accounts).toHaveLength(6);
  expect(before.payments).toHaveLength(1);
  expect(before.payments[0]).toMatchObject({ provider: 'community-simulated-bank', environment: 'mock', status: 'draft', revision: 1 });
  expect(before.payments[0].items.map((i: { documentId: string; amountMinor: number }) => [i.documentId, i.amountMinor]).sort()).toEqual([['DEMO-DOC-007', 6000], ['DEMO-DOC-009', 3600]]);
  expect(before.payments[0]).not.toHaveProperty('claimId'); expect(before.payments[0]).not.toHaveProperty('approver'); expect(before.payments[0]).not.toHaveProperty('approvalDigest');
  expect(app.db().prepare('SELECT action FROM community_payment_events').all()).toEqual([{ action: 'created' }]);
  for (const table of ['community_payment_confirmations', 'community_payment_callbacks', 'community_bank_connections']) expect(app.db().prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  const jsonBefore = readFileSync(join(app.runtime, 'state', 'state.json'));
  const restarted = await app.restart(), after = await (await fetch(restarted + '/api/community/demo', { headers })).json();
  expect(after).toEqual(before); expect(readFileSync(join(app.runtime, 'state', 'state.json'))).toEqual(jsonBefore);
  expect(app.db().prepare('SELECT count(*) AS n FROM community_payment_batches').get()).toEqual({ n: 1 });
  expect(app.db().prepare('SELECT count(*) AS n FROM community_payment_events').get()).toEqual({ n: 1 });
  const snapshot = app.db().prepare('SELECT state_json FROM community_canonical_state WHERE singleton=1').get() as { state_json: string };
  expect(JSON.parse(snapshot.state_json)).toEqual(JSON.parse(jsonBefore.toString()));
}, 15000); // Cold import of the real composition root plus two SQLite boots; no external transport.

it('keeps projection authenticated/read-only and every provider, bank and payment mutation denied', async () => {
  const app = await application(), url = await app.listen(), headers = { 'x-community-access-token': app.token, 'content-type': 'application/json' };
  expect((await fetch(url + '/api/community/demo')).status).toBe(401);
  expect((await fetch(url + '/api/community/demo', { headers: { ...headers, origin: 'https://example.com' } })).status).toBe(403);
  expect((await fetch(url + '/api/community/demo', { headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  for (const [method, path] of [['POST', '/api/community/demo'], ['PUT', '/api/community/demo'], ['GET', '/api/community-payments/batches'],
    ['POST', '/api/community-payments/batches'], ['POST', '/api/community-banking/application'], ['POST', '/api/community/integrations/stripe/test/configure'],
    ['POST', '/api/invoice-bot/browser/start']]) {
    expect((await fetch(url + path, { method, headers, ...(method === 'GET' ? {} : { body: '{}' }) })).status).toBe(403);
  }
  const projection = await (await fetch(url + '/api/community/demo', { headers })).json();
  const forbiddenKeys = /^(?:token|session_id|authorizationUrl|privateKeyPem|credential|csrf|approvalDigest|claimId|providerReference)$/i;
  const walk = (value: unknown) => { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { expect(forbiddenKeys.test(key), key).toBe(false); walk(child); } };
  walk(projection);
  expect(projection.capabilities).toEqual({ read_only_projection: true, provider_network: false, payment_submission: false, synthetic_data: true });
});

it('cannot initialize or project an ordinary accounting workspace', async () => {
  const app = await application(), ordinary = createEmptyState('ORDINARY_SYNTHETIC_TEST_ONLY');
  expect(() => ensureCommunityDemoDraft(app.db() as Database.Database, ordinary)).toThrow('DEMO_SEED_SCOPE_INVALID');
  expect(() => communityDemoProjection(app.db() as Database.Database, ordinary)).toThrow('DEMO_SEED_SCOPE_INVALID');
  expect(accountingOfDemo(app.db())).toBe(1);
});

it('projects financial records without reusable or historical payment authority and fails closed above the bounded fixture size', async () => {
  const app = await application(), state = createCommunityDemoState();
  // Synthetic history can contain these fields; none belongs to the read-only preview DTO.
  app.db().prepare('UPDATE community_payment_batches SET reviewer=?,approver=?,approval_revision=1,approval_digest=?,claim_id=?,provider_reference=?')
    .run('synthetic-reviewer', 'synthetic-approver', 'a'.repeat(64), 'synthetic-retired-claim', 'synthetic-retired-provider-reference');
  const projection = communityDemoProjection(app.db(), state), text = JSON.stringify(projection);
  for (const key of ['reviewer', 'approver', 'approvalRevision', 'approvalDigest', 'claimId', 'providerReference']) expect(projection.payments[0]).not.toHaveProperty(key);
  expect(text).not.toContain('synthetic-retired-claim'); expect(text).not.toContain('synthetic-retired-provider-reference');
  const tx = state.transactions.get('DEMO-TXN-001')!;
  for (let n = state.transactions.size; n <= 1000; n++) state.transactions.set(`SYNTHETIC-LIMIT-${n}`, { ...tx, transaction_id: `SYNTHETIC-LIMIT-${n}` });
  expect(() => communityDemoProjection(app.db(), state)).toThrow('DEMO_PROJECTION_LIMIT');
});

function accountingOfDemo(db: Database.Database): number {
  return (db.prepare('SELECT count(*) AS n FROM community_payment_batches WHERE workspace_id=?').get(DEMO_WORKSPACE) as { n: number }).n;
}
