import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommunityGuard } from '../src/server/community-guard.js';

// Tests only an isolated loopback server with fictional authentication material.
const token = 'synthetic-origin-regression-token-000000000000';
let server: Server | undefined;
async function setup() {
  const app = express();
  app.use('/api', createCommunityGuard(token));
  app.post('/api/matches', (_req, res) => res.json({ synthetic: true }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
});
async function status(base: string, origin?: string, additional: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'X-Community-Access-Token': token, ...additional };
  if (origin !== undefined) headers.Origin = origin;
  return (await fetch(base + '/api/matches', { method: 'POST', headers })).status;
}
describe('P02 exact local origin boundary', () => {
  it('accepts a same-origin request and authenticated non-browser clients', async () => {
    const base = await setup();
    expect(await status(base, base)).toBe(200);
    expect(await status(base)).toBe(200);
  });
  it('rejects a different loopback port', async () => {
    const base = await setup();
    const other = new URL(base);
    other.port = other.port === '9999' ? '9998' : '9999';
    expect(await status(base, other.origin)).toBe(403);
  });
  it('rejects a different scheme even on the same hostname and port', async () => {
    const base = await setup();
    expect(await status(base, base.replace('http:', 'https:'))).toBe(403);
  });
  it('rejects malformed origins with userinfo, paths or opaque origin', async () => {
    const base = await setup();
    for (const origin of [base.replace('http://', 'http://user@'), base + '/unexpected', 'null']) {
      expect(await status(base, origin)).toBe(403);
    }
  });
  it('does not trust proxy headers to change the origin boundary', async () => {
    const base = await setup();
    expect(await status(base, base.replace('http:', 'https:'), { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'localhost' })).toBe(403);
  });
  it('rejects browser cross-site metadata independently of the token', async () => {
    const base = await setup();
    expect(await status(base, undefined, { 'Sec-Fetch-Site': 'cross-site' })).toBe(403);
  });
});
