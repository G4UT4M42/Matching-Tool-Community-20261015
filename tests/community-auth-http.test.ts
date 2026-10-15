import express from 'express';
import { request as rawRequest, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommunityAuthStore, type AuthSession } from '../src/server/community-auth-store.js';
import { createCommunityAccountGuard, createCommunityAuthRouter, createCommunityTransportGuard } from '../src/server/community-auth-http.js';

const password = 'Fictional HTTP account passphrase 2026';
const root = mkdtempSync(join(tmpdir(), 'community-auth-http-synthetic-'));
const setupCode = randomBytes(32).toString('base64url');
const store = new CommunityAuthStore({ runtimeRoot: root, setupToken: setupCode });
let server: Server, origin: string, owner: AuthSession, viewer: AuthSession, bookkeeper: AuthSession;
let mutations = 0;
const cookie = (session: AuthSession) => `${store.cookieName}=${session.token}`;
beforeAll(async () => {
  owner = await store.setup({ username: 'synthetic-owner', password, setupToken: setupCode });
  for (const role of ['viewer', 'bookkeeper'] as const) await store.createUser(owner.token, { username: 'synthetic-' + role, password, role });
  viewer = await store.login({ username: 'synthetic-viewer', password });
  bookkeeper = await store.login({ username: 'synthetic-bookkeeper', password });
  const app = express(); app.disable('x-powered-by');
  app.use('/api', createCommunityTransportGuard());
  app.use('/api', createCommunityAuthRouter(store));
  app.use('/api', createCommunityAccountGuard(store));
  app.get('/api/summary', (_request, response) => response.json({ workspace: response.locals.communityPrincipal.workspace_id, actor: response.locals.communityPrincipal.subject }));
  app.post('/api/import/upload', (_request, response) => { mutations++; response.json({ actor: response.locals.communityPrincipal.subject, mutations }); });
  app.post('/api/payments/batches', (_request, response) => { mutations++; response.json({ unsafe: true }); });
  app.get('/api/settings/private', (_request, response) => response.json({ unsafe: true }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Synthetic listener unavailable');
  origin = `http://127.0.0.1:${address.port}`;
}, 20000);
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
function call(path: string, method = 'GET', session?: AuthSession, body?: unknown, overrides: Record<string, string> = {}) {
  const headers: Record<string, string> = { Origin: origin, ...overrides };
  if (session) { headers.Cookie ??= cookie(session); headers['X-CSRF-Token'] ??= session.csrfToken; }
  if (body !== undefined) headers['Content-Type'] ??= 'application/json';
  return fetch(origin + '/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
}

describe('P02 authenticated HTTP boundary and role enforcement', () => {
  it('provides no financial data to unauthenticated callers or forged preview tokens', async () => {
    expect((await call('/summary')).status).toBe(401);
    expect((await call('/summary', 'GET', undefined, undefined, { 'X-Community-Access-Token': 'synthetic-preview-token-cannot-authorize-accounts' })).status).toBe(401);
    const status = await call('/auth/session');
    expect(await status.json()).toMatchObject({ mode: 'accounts', authenticated: false, setup_required: false });
  });
  it('allows financial reads for a viewer but not financial mutations or account administration', async () => {
    const read = await call('/summary', 'GET', viewer); expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ workspace: store.workspaceId, actor: viewer.principal.subject });
    const before = mutations;
    expect((await call('/import/upload', 'POST', viewer, {})).status).toBe(403);
    expect((await call('/auth/users', 'GET', viewer)).status).toBe(403);
    expect((await call('/auth/users', 'POST', viewer, { username: 'forged-owner', password, role: 'owner' })).status).toBe(403);
    expect(mutations).toBe(before);
  });
  it('allows a reviewed bookkeeper action with the real principal, never a body actor', async () => {
    const response = await call('/import/upload', 'POST', bookkeeper, { actor: 'forged-owner', role: 'owner', workspace_id: 'forged-workspace' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ actor: bookkeeper.principal.subject });
  });
  it('requires a session-specific CSRF token even with a valid authentication cookie', async () => {
    const before = mutations;
    for (const supplied of ['', 'wrong', viewer.csrfToken]) {
      const response = await call('/import/upload', 'POST', owner, {}, { 'X-CSRF-Token': supplied });
      expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: 'CSRF_TOKEN_REQUIRED' });
    }
    expect(mutations).toBe(before);
  });
  it('rejects hostile, missing and null origins before authentication mutation', async () => {
    const before = mutations;
    for (const supplied of ['https://attacker.invalid', 'null', origin + '/forged', origin.replace('http:', 'https:')]) {
      expect((await call('/import/upload', 'POST', owner, {}, { Origin: supplied })).status).toBe(403);
    }
    const response = await fetch(origin + '/api/import/upload', { method: 'POST', headers: { Cookie: cookie(owner), 'X-CSRF-Token': owner.csrfToken } });
    expect(response.status).toBe(403);
    expect((await call('/summary', 'GET', owner, undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect(mutations).toBe(before);
  });
  it('does not trust forwarded headers to turn a hostile request into same origin', async () => {
    expect((await call('/import/upload', 'POST', owner, {}, { Origin: 'https://attacker.invalid', 'X-Forwarded-Host': 'attacker.invalid', 'X-Forwarded-Proto': 'https', Forwarded: 'proto=https;host=attacker.invalid' })).status).toBe(403);
  });
  it('rejects hostile Host values and invalid ports using the raw transport', async () => {
    for (const host of ['attacker.invalid', '127.0.0.1:99999', '127.0.0.1/path', '127.0.0.1:0']) {
      const status = await new Promise<number>((resolve, reject) => {
        const request = rawRequest(origin + '/api/summary', { headers: { Host: host, Cookie: cookie(owner) } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); });
        request.on('error', reject); request.end();
      });
      expect(status, host).toBe(403);
    }
  });
  it('rejects duplicate cookies, different installation cookies and malformed bearer values', async () => {
    for (const value of [cookie(owner) + '; ' + cookie(owner), 'other_installation_session=' + owner.token, `${store.cookieName}=invalid`]) {
      expect((await call('/summary', 'GET', undefined, undefined, { Cookie: value })).status).toBe(401);
    }
  });
  it('keeps unreviewed payment, secret-reading and method aliases denied even to the owner', async () => {
    const before = mutations;
    expect((await call('/payments/batches', 'POST', owner, {})).status).toBe(403);
    expect((await call('/settings/private', 'GET', owner)).status).toBe(403);
    expect((await call('/summary', 'POST', owner, {})).status).toBe(403);
    expect((await call('/%73ummary', 'GET', owner)).status).toBe(400);
    expect((await call('/auth/login', 'GET', owner)).status).toBe(405);
    expect(mutations).toBe(before);
  });
  it('rejects unknown setup/login fields and oversized/malformed JSON without secret reflection', async () => {
    const forged = await call('/auth/login', 'POST', undefined, { username: 'synthetic-owner', password, actor: 'attacker' });
    expect(forged.status).toBe(400);
    for (const value of ['{"password":"SYNTHETIC_DO_NOT_ECHO"', JSON.stringify({ padding: 'SYNTHETIC_DO_NOT_ECHO'.repeat(1000) })]) {
      const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: value });
      expect([400, 413]).toContain(response.status); expect(await response.text()).not.toContain('SYNTHETIC_DO_NOT_ECHO');
    }
  });
  it('uses HttpOnly same-site cookies and does not return the raw session token in JSON', async () => {
    const response = await call('/auth/login', 'POST', undefined, { username: 'synthetic-owner', password });
    expect(response.status).toBe(200);
    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toContain('HttpOnly'); expect(header).toContain('SameSite=Strict'); expect(header).toContain('Path=/');
    const rawToken = header.split(';')[0].split('=')[1];
    const body = await response.json() as { authenticated: boolean; csrf_token: string }; expect(body.authenticated).toBe(true); expect(body.csrf_token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain(rawToken); expect(JSON.stringify(body)).not.toContain(password);
    const logout = await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { Origin: origin, Cookie: header.split(';')[0], 'X-CSRF-Token': body.csrf_token, 'Content-Type': 'application/json' }, body: '{}' });
    expect(logout.status).toBe(204); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(store.authenticate(rawToken)).toBeNull();
  });
  it('returns masked user management data and refuses owner deletion or forged account fields', async () => {
    const users = await call('/auth/users', 'GET', owner); expect(users.status).toBe(200);
    const data = await users.json() as { users: unknown[] }; expect(data.users).toHaveLength(3);
    expect(JSON.stringify(data)).not.toMatch(/password|scrypt|token_hash/);
    expect((await call('/auth/users/' + owner.principal.subject, 'PATCH', owner, { disabled: true })).status).toBe(409);
    expect((await call('/auth/users/' + viewer.principal.subject, 'PATCH', owner, { role: 'owner', actor: 'forged' })).status).toBe(400);
  });
  it('sets private-response security headers', async () => {
    const response = await call('/summary', 'GET', viewer);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });
  it('serves bounded verified account history with safe before/after fields and no authentication material',async()=>{
    expect((await call('/auth/audit')).status).toBe(401);
    const created=await store.createUser(owner.token,{username:'synthetic-audit-target',password,role:'viewer'});
    expect((await call('/auth/users/'+created.user_id,'PATCH',owner,{role:'bookkeeper'})).status).toBe(200);
    const response=await call('/auth/audit','GET',viewer);expect(response.status).toBe(200);
    const data=await response.json() as {events:Array<{action:string;actor_id:string;entity_id:string;before:unknown;after:unknown}>};
    expect(data.events.length).toBeLessThanOrEqual(100);expect(data.events.find(event=>event.action==='ACCOUNT_UPDATED'&&event.entity_id===created.user_id)).toMatchObject({actor_id:owner.principal.subject,before:{role:'viewer',disabled:false},after:{role:'bookkeeper',disabled:false}});
    const text=JSON.stringify(data);for(const value of[password,owner.token,viewer.token,owner.csrfToken,setupCode])expect(text).not.toContain(value);expect(text).not.toMatch(/account_fingerprint|password_hash|csrf_nonce|previous_hash|token_hash/);
    for(const query of['?before=0','?before=invalid','?before=1&forged=1'])expect((await call('/auth/audit'+query,'GET',owner)).status).toBe(400);
    expect((await call('/auth/audit','POST',owner,{})).status).toBe(405);
  });
});
