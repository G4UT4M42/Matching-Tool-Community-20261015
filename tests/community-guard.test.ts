import express from 'express';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommunityGuard } from '../src/server/community-guard.js';

const ownerToken = 'synthetic-only-fixed-owner-access-token-123456';
const auth = { 'X-Community-Access-Token': ownerToken };

describe('Community preview: explicit-method allowlist and synthetic-only API', () => {
  let server: Server | undefined;
  async function setup() {
    const app = express();
    app.use('/api', createCommunityGuard(ownerToken));
    app.get('/api/community/session', (_req, res) => res.json({ ok: true }));
    app.get('/api/transactions', (_req, res) => res.json({ synthetic: true }));
    app.get('/api/report/summary', (_req, res) => res.json({ synthetic: true }));
    app.post('/api/matches', (_req, res) => res.json({ ok: true }));
    app.patch('/api/matches/:id/status', (_req, res) => res.json({ ok: true }));
    for (const url of [
      '/api/import/bank/connect', '/api/payments/batches',
      '/api/belege/open', '/api/run', '/api/invoicerec/upload',
      '/api/invoicerec/scans/scan1/rescan', '/api/documents/eigenbeleg',
      '/api/documents/eigenbeleg/upload', '/api/match', '/api/backups',
    ]) app.post(url, (_req, res) => res.json({ should_never_execute: true }));
    for (const url of [
      '/api/invoicerec/import-folder', '/api/files/open/private.txt',
      '/api/belege/info', '/api/vendor-email', '/api/invoicerec/scans/scan1/page/1',
      '/api/report/vat/pdf', '/api/settings/test', '/api/backups',
    ]) app.get(url, (_req, res) => res.json({ should_never_execute: true }));
    app.put('/api/settings/test', (_req, res) => res.json({ should_never_execute: true }));
    app.delete('/api/trash', (_req, res) => res.json({ should_never_execute: true }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind synthetic server');
    return 'http://127.0.0.1:' + addr.port + '/api';
  }
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) =>
      server!.close(err => err ? reject(err) : resolve()));
    server = undefined;
  });
  it('fails closed for missing and insufficiently long configured tokens', () => {
    expect(() => createCommunityGuard('')).toThrow();
    expect(() => createCommunityGuard('weak')).toThrow();
  });
  it('requires the local token even for read-only synthetic data', async () => {
    const base = await setup();
    expect((await fetch(base + '/community/session')).status).toBe(401);
    expect((await fetch(base + '/community/session', { headers: { 'X-Community-Access-Token': 'wrong-token' } })).status).toBe(401);
    expect((await fetch(base + '/community/session', { headers: auth })).status).toBe(200);
  });
  it('allows only explicitly reviewed read and manual-match operations', async () => {
    const base = await setup();
    for (const path of ['/transactions', '/report/summary']) {
      expect((await fetch(base + path, { headers: auth })).status, path).toBe(200);
    }
    expect((await fetch(base + '/matches', { method: 'POST', headers: auth })).status).toBe(200);
    expect((await fetch(base + '/matches/example/status', { method: 'PATCH', headers: auth })).status).toBe(200);
    expect((await fetch(base + '/matches/example/status', { method: 'POST', headers: auth })).status).toBe(403);
  });
  it('blocks known external banking and payment actions even with a valid token', async () => {
    const base = await setup();
    for (const path of ['/import/bank/connect', '/payments/batches']) {
      const response = await fetch(base + path, { method: 'POST', headers: auth });
      expect(response.status, path).toBe(403);
      expect((await response.json() as { code: string }).code).toBe('COMMUNITY_EXTERNAL_ACTION_DISABLED');
    }
  });
  it('blocks unreviewed local file operations, preview parsers and settings mutation', async () => {
    const base = await setup();
    const attempts: Array<[string, string]> = [
      ['GET', '/invoicerec/import-folder'], ['GET', '/files/open/private.txt'],
      ['POST', '/belege/open'], ['POST', '/run'], ['POST', '/invoicerec/upload'],
      ['POST', '/invoicerec/scans/scan1/rescan'],
      ['POST', '/documents/eigenbeleg'], ['POST', '/documents/eigenbeleg/upload'],
      ['GET', '/belege/info'], ['GET', '/vendor-email'], ['GET', '/invoicerec/scans/scan1/page/1'],
      ['GET', '/report/vat/pdf'], ['POST', '/match'], ['PUT', '/settings/test'],
      ['DELETE', '/trash'], ['POST', '/backups'], ['GET', '/backups'],
    ];
    for (const [method, path] of attempts) {
      const response = await fetch(base + path, { method, headers: auth });
      expect(response.status, method + ' ' + path).toBe(403);
      expect((await response.json() as { code: string }).code, path).toBe('COMMUNITY_EXTERNAL_ACTION_DISABLED');
    }
  });
  it('rejects hostile origins while allowing a same-origin reviewed operation', async () => {
    const base = await setup();
    expect((await fetch(base + '/matches', {
      method: 'POST', headers: { ...auth, Origin: 'https://attacker.invalid' },
    })).status).toBe(403);
    expect((await fetch(base + '/matches', {
      method: 'POST', headers: { ...auth, Origin: base.replace(/\/api$/, '') },
    })).status).toBe(200);
  });
  it('rejects unapproved methods, encoded endpoint aliases and hostile Host values', async () => {
    const base = await setup();
    expect((await fetch(base + '/transactions', { method: 'POST', headers: auth })).status).toBe(403);
    expect((await fetch(base + '/%62ackups', { headers: auth })).status).toBe(403);
    // Fetch implementations may override Host; use a raw HTTP request here.
    const hostileHostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(base + '/transactions', {
        headers: { ...auth, Host: 'hostile.example.invalid' },
      }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    expect(hostileHostStatus).toBe(403);
  });
});
