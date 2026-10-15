import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { MatchingState } from '../src/core/types.js';

let root: string, state: MatchingState, server: Server, base: string;
let storage: typeof import('../src/storage/db.js');
let json: typeof import('../src/storage/json-store.js');
const text = (ref = 'SYN-PREVIEW-01', amount = '-12,34') =>
  'Datum;Partnername;Betrag;Waehrung;Referenz;Verwendungszweck\n' +
  `13.01.2026;Fictional Vendor;${amount};EUR;${ref};Fictional item`;
const headers = (subject = 'USR-owner', session = 'SES-one') =>
  ({ 'x-synthetic-principal': subject, 'x-synthetic-session': session });
function form(content = text(), fields = { source: 'sparkasse', account_id: 'SYN-ACCOUNT' }) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  data.append('file', new Blob([content]), 'synthetic.csv');
  return data;
}
function send(path: string, init: RequestInit = {}) {
  return fetch(base + path, { method: 'POST', ...init });
}
async function preview(body = form(), principal?: Record<string,string>) {
  return send('/api/import/preview', { body, headers: principal ?? headers() });
}
async function commit(token: string, principal?: Record<string,string>) {
  return send('/api/import/commit', { body: JSON.stringify({ token }), headers: { 'Content-Type': 'application/json', ...(principal ?? headers()) } });
}
function count() {
  return (storage.getDb().prepare('SELECT count(*) AS n FROM transactions').get() as {n: number}).n;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'matching-preview-only-synthetic-'));
  process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root';
  process.env.MATCHING_RUNTIME_ROOT = root;
  vi.resetModules();
  storage = await import('../src/storage/db.js'); storage.getDb();
  json = await import('../src/storage/json-store.js');
  state = json.createEmptyState('SYNTHETIC_REVIEW_RUN'); json.saveState(state);
  const { createStatementPreviewRouter } = await import('../src/server/routes/statement-preview.js');
  const app = express();
  app.use('/api', express.json({limit:'8kb'}));
  app.use('/api', (request, response, next) => {
    const subject = request.get('x-synthetic-principal');
    const session_id = request.get('x-synthetic-session');
    if (subject && session_id) response.locals.communityPrincipal =
      { subject, session_id, workspace_id: 'WS-SYNTHETIC' };
    next();
  });
  app.use('/api', createStatementPreviewRouter(() => state, value => {state=value;}));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local test port');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  storage.closeDb();
  delete process.env.MATCHING_RUNTIME_MODE;
  delete process.env.MATCHING_RUNTIME_ROOT;
  rmSync(root, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
});

describe('P06 explicit statement preview before durable commit', () => {
  it('shows exact signed integer amounts without mutating either store', async () => {
    const response = await preview();
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data).toMatchObject({source:'sparkasse',account_id:'SYN-ACCOUNT', fetched:1,
      totals_minor_by_currency:{EUR:-1234},remaining_rows:0,payment_execution:false});
    expect(data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(data.file_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(data.preview[0]).toMatchObject({amount_minor:-1234,currency:'EUR',reference:'SYN-PREVIEW-01'});
    expect(data).not.toHaveProperty('transaction_id');
    expect(count()).toBe(0);
    expect(state.transactions.size).toBe(0);
    expect(json.loadState()?.transactions.size).toBe(0);
  });
  it('commits only after explicit confirmation, then rejects replay', async () => {
    const reviewed = await (await preview()).json() as any;
    const outcome = await commit(reviewed.token);
    expect(outcome.status).toBe(200);
    expect(await outcome.json()).toMatchObject({imported:1,skipped:0,payment_execution:false});
    expect(count()).toBe(1);
    expect(state.transactions.size).toBe(1);
    expect(json.loadState()).toEqual(state);
    expect(state.audit_events).toHaveLength(1);
    expect((await commit(reviewed.token)).status).toBe(400);
    expect(count()).toBe(1);
  });
  it('binds confirmation to the same authenticated session', async () => {
    const reviewed = await (await preview()).json() as any;
    expect((await commit(reviewed.token, headers('USR-owner', 'SES-other'))).status).toBe(400);
    expect((await commit(reviewed.token, headers('USR-other', 'SES-one'))).status).toBe(400);
    expect(count()).toBe(0);
    expect((await commit(reviewed.token)).status).toBe(200);
    expect(count()).toBe(1);
  });
  it('invalidates a discarded preview without writing financial records', async () => {
    const reviewed = await (await preview()).json() as any;
    const wrongSession = await send('/api/import/discard', { body: JSON.stringify({token:reviewed.token}),
      headers: { 'Content-Type':'application/json', ...headers('USR-owner','SES-foreign') } });
    expect(wrongSession.status).toBe(400);
    const discarded = await send('/api/import/discard', { body: JSON.stringify({token:reviewed.token}),
      headers: { 'Content-Type':'application/json', ...headers() } });
    expect(discarded.status).toBe(200);
    expect(await discarded.json()).toMatchObject({discarded:true,financial_records_changed:false});
    expect((await commit(reviewed.token)).status).toBe(400);
    expect(count()).toBe(0);
    expect(state.audit_events).toHaveLength(0);
  });
  it('requires the accounting principal before handling upload or confirmation', async () => {
    expect((await preview(form(), {})).status).toBe(401);
    expect((await commit('a'.repeat(43), {})).status).toBe(401);
    expect(count()).toBe(0);
  });
  it('refuses a stale financial snapshot without discarding the expected history', async () => {
    const reviewed = await (await preview()).json() as any;
    const newState = json.createEmptyState('SYNTHETIC_UPDATED_RUN');
    json.saveState(newState); state = newState;
    const response = await commit(reviewed.token);
    expect(response.status).toBe(409);
    expect((await response.json() as any).code).toBe('STALE_ACCOUNTING_STATE');
    expect(count()).toBe(0);
    expect(json.loadState()).toEqual(state);
  });
  it('rejects malformed data, conflicting columns and missing account before a preview token exists', async () => {
    const invalid = await preview(form(text('SYN-BAD', 'invalid')));
    expect(invalid.status).toBe(400); expect(count()).toBe(0);
    const missing = await preview(form(text(), {source:'sparkasse', account_id:'../other'}));
    expect(missing.status).toBe(400); expect(count()).toBe(0);
    const extra = form(); extra.append('source', 'visa');
    expect((await preview(extra)).status).toBe(400); expect(count()).toBe(0);
  });
  it('previews repeated identical rows as separate economic events', async () => {
    const lines = text('', '-4,00').split('\n');
    const response = await preview(form([lines[0],lines[1],lines[1]].join('\n')));
    expect(response.status).toBe(200);
    const reviewed = await response.json() as any;
    expect(reviewed.fetched).toBe(2);
    expect(reviewed.totals_minor_by_currency).toEqual({EUR:-800});
    expect((await commit(reviewed.token)).status).toBe(200);
    expect(count()).toBe(2);
  });
  it('uses an exact file-size limit before creating a review', async () => {
    const response = await preview(form('X'.repeat(10 * 1024 * 1024 + 1)));
    expect(response.status).toBe(413);
    expect(count()).toBe(0);
  },30000);
});
