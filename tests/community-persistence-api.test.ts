import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommunityPersistenceRouter } from '../src/server/routes/community-persistence.js';
import type { Server } from 'node:http';

let server: Server | undefined, root: string, closeDb: (() => void) | undefined;
async function fixture() {
  root = mkdtempSync(join(tmpdir(), 'community-api-'));
  process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root'; process.env.MATCHING_RUNTIME_ROOT = root;
  vi.resetModules();
  const store = await import('../src/storage/db.js'); closeDb = store.closeDb; store.getDb();
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state', 'state.json'), JSON.stringify({
    schema_version: 1, format: 'matching-community-state-v1', run_id: 'SYNTHETIC',
    transactions: {}, documents: {}, match_groups: {}, exclusion_rules: [], audit_events: [],
    matched_transaction_ids: [], matched_document_ids: [], excluded_transaction_ids: [],
  }));
  const app = express(); app.use(express.json());
  app.use((request, response, next) => { if (request.headers['x-test-subject'] === 'owner') response.locals.communityPrincipal = { subject: 'synthetic-owner' }; next(); });
  app.use('/api/community/persistence', createCommunityPersistenceRouter({
    activeRuntimeRoot: () => root,
    withExclusiveAccess: run => run(),
    safeActivate: async (change, rollback) => { closeDb?.(); try { change(); } catch (error) { rollback(); throw error; } },
    may: principal => principal.subject === 'synthetic-owner',
    invalidateCheckpoint: () => {}, inspectCurrent: () => ({ synthetic: true }),
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server unavailable');
  return `http://127.0.0.1:${address.port}/api/community/persistence`;
}
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
  closeDb?.(); closeDb = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  delete process.env.MATCHING_RUNTIME_MODE; delete process.env.MATCHING_RUNTIME_ROOT; vi.resetModules();
});
describe('authenticated persistence router', () => {
  it('requires a trusted principal and serves a generated ZIP through bounded IDs', async () => {
    const base = await fixture();
    expect((await fetch(base + '/backups')).status).toBe(401);
    expect((await fetch(base + '/backups', { headers: { 'x-test-subject': 'other' } })).status).toBe(401);
    const headers = { 'x-test-subject': 'owner' };
    expect((await fetch(base + '/backups', { headers })).status).toBe(200);
    const created = await fetch(base + '/backups', { method: 'POST', headers });
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string };
    const download = await fetch(`${base}/backups/${body.id}/download`, { headers });
    expect(download.status).toBe(200); expect(download.headers.get('content-type')).toContain('application/zip');
    expect((await fetch(base + '/backups/invalid/download', { headers })).status).toBe(422);
    expect((await fetch(base + '/backups', { method: 'DELETE', headers })).status).toBe(404);
    const stage = await fetch(base + '/restore/stage', { method: 'POST', headers: { ...headers, 'content-type': 'application/zip' }, body: await download.arrayBuffer() });
    expect(stage.status).toBe(201);
    const staged = await stage.json() as { id: string; fingerprint: string };
    const activated = await fetch(`${base}/restore/${staged.id}/activate`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ fingerprint: staged.fingerprint, owner: 'forged' }) });
    expect(activated.status).toBe(200);
  });
});
