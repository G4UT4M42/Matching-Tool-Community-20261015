import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommunityGuard } from '../src/server/community-guard.js';
import type { MatchingState } from '../src/core/types.js';

const token = 'synthetic-statement-upload-token-00000000000';
let root: string;
const previousRoot = process.env.MATCHING_RUNTIME_ROOT, previousMode = process.env.MATCHING_RUNTIME_MODE;
let db: typeof import('../src/storage/db.js');
let store: typeof import('../src/storage/json-store.js');
let state: MatchingState;
let server: Server;
let origin: string;
const statement = (reference = 'SYN-UPLOAD-1', amount = '-12,34') => `Datum;Partnername;Betrag;Waehrung;Referenz;Verwendungszweck\n13.01.2026;Fictional Supplier;${amount};EUR;${reference};Fictional purchase`;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'matching-upload-api-synthetic-'));
  vi.resetModules();
  process.env.MATCHING_RUNTIME_ROOT = root; process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root';
  db = await import('../src/storage/db.js'); db.getDb();
  store = await import('../src/storage/json-store.js');
  state = store.createEmptyState('SYNTHETIC_STATEMENT_UPLOAD'); store.saveState(state);
  const { createStatementImportRouter } = await import('../src/server/routes/statement-import.js');
  const app = express(); app.use('/api', createCommunityGuard(token));
  app.use('/api', createStatementImportRouter(() => state, value => { state = value; }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic API listener missing');
  origin = `http://127.0.0.1:${address.port}`;
});
// Each test owns a fresh dataset; cleanup never disables append-only audit triggers.
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db?.closeDb();
  if (previousRoot === undefined) delete process.env.MATCHING_RUNTIME_ROOT; else process.env.MATCHING_RUNTIME_ROOT = previousRoot;
  if (previousMode === undefined) delete process.env.MATCHING_RUNTIME_MODE; else process.env.MATCHING_RUNTIME_MODE = previousMode;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
function form(content = statement(), filename = 'fictional.csv', fields: Record<string, string | undefined> = { source: 'sparkasse', account_id: 'SYNTHETIC-ACCOUNT' }) {
  const body = new FormData(); body.append('file', new Blob([content]), filename);
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.append(key, value);
  return body;
}
const submit = (body: FormData, headers: Record<string, string> = { 'X-Community-Access-Token': token, Origin: origin }) => fetch(origin + '/api/import/upload', { method: 'POST', headers, body });
const count = () => (db.getDb().prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n;

describe('P06 reviewed HTTP upload boundary', () => {
  it('imports one authorized statement into SQLite, active state and persisted audit', async () => {
    const response = await submit(form()); const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ ok: true, imported: 1, skipped: 0, account_id: 'SYNTHETIC-ACCOUNT', payment_execution: false });
    expect(count()).toBe(1); expect(state.transactions.size).toBe(1); expect(store.loadState()).toEqual(state);
    expect(state.audit_events[0].actor_id).toBe('authenticated-local-owner');
  });
  it('requires authentication before parsing or persisting uploaded financial input', async () => {
    expect((await submit(form(), {})).status).toBe(401);
    expect((await submit(form(), { 'X-Community-Access-Token': 'incorrect' })).status).toBe(401);
    expect(count()).toBe(0);
  });
  it('rejects cross-origin and cross-site uploads even with a valid token', async () => {
    expect((await submit(form(), { 'X-Community-Access-Token': token, Origin: 'https://attacker.invalid' })).status).toBe(403);
    expect((await submit(form(), { 'X-Community-Access-Token': token, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect(count()).toBe(0);
  });
  it('rejects unapproved methods and encoded endpoint aliases', async () => {
    expect((await fetch(origin + '/api/import/upload', { headers: { 'X-Community-Access-Token': token } })).status).toBe(403);
    expect((await fetch(origin + '/api/%69mport/upload', { method: 'POST', headers: { 'X-Community-Access-Token': token }, body: form() })).status).toBe(403);
    expect(count()).toBe(0);
  });
  it.each([
    { source: 'unsupported', account_id: 'SYNTHETIC' },
    { source: 'visa' },
    { source: 'visa', account_id: '../other-owner' },
    { source: 'visa', account_id: 'SYNTHETIC', actor: 'forged-user' },
  ])('rejects invalid source/account or unexpected fields %j', async fields => {
    expect((await submit(form(statement(), 'fictional.csv', fields))).status).toBe(400); expect(count()).toBe(0);
  });
  it('rejects duplicate source fields and unexpected files', async () => {
    const duplicated = form(); duplicated.append('source', 'visa');
    expect((await submit(duplicated)).status).toBe(400);
    const extra = form(); extra.append('file', new Blob([statement()]), 'another.csv');
    expect((await submit(extra)).status).toBe(400); expect(count()).toBe(0);
  });
  it('rejects unsupported, mislabelled and malformed input without reflecting secret-like text', async () => {
    for (const filename of ['fictional.xlsm', 'fictional.xlsx']) expect((await submit(form(statement(), filename))).status).toBe(400);
    const response = await submit(form(statement('SYN-BAD', 'SYNTHETIC_SECRET_DO_NOT_ECHO')));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('SYNTHETIC_SECRET_DO_NOT_ECHO'); expect(count()).toBe(0);
  });
  it('enforces the file size limit before application parsing', async () => {
    const response = await submit(form('x'.repeat(10 * 1024 * 1024 + 1)));
    expect(response.status).toBe(413); expect(count()).toBe(0);
  });
  it('replays the same file and rejects conflicting source content without partial writes', async () => {
    expect((await submit(form())).status).toBe(200);
    const replay = await submit(form()); expect(await replay.json()).toMatchObject({ imported: 0, skipped: 1 });
    const before = store.serializeCommunityState(state);
    const conflicting = await submit(form(statement('SYN-UPLOAD-1', '-99,00')));
    expect(conflicting.status).toBe(409); expect(await conflicting.json()).toMatchObject({ code: 'SOURCE_IDENTITY_CONFLICT' });
    expect(count()).toBe(1); expect(store.serializeCommunityState(state)).toBe(before);
  });
  it('serializes concurrent completed uploads without lost active-state updates', async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, (_, index) => submit(form(statement(`SYN-PARALLEL-${index}`)))));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(count()).toBe(5); expect(state.transactions.size).toBe(5); expect(store.loadState()).toEqual(state);
  });
});
