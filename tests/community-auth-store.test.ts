import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { CommunityAuthStore, type AuthSession } from '../src/server/community-auth-store.js';
import { COMMUNITY_PERMISSIONS, hasCommunityPermission, permissionsForRole } from '../src/server/community-permissions.js';

// Generated credentials belong exclusively to synthetic test installations.
const password = 'Fictional-only passphrase for tests 2026';
let root: string, setupCode: string, time: number, store: CommunityAuthStore;
const otherStores: CommunityAuthStore[] = [];
const otherRoots: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'community-identity-synthetic-'));
  setupCode = randomBytes(32).toString('base64url'); time = Date.now();
  store = new CommunityAuthStore({ runtimeRoot: root, setupToken: setupCode, clock: () => time });
});
afterEach(() => {
  store?.close(); for (const other of otherStores.splice(0)) other.close();
  for (const path of [root, ...otherRoots.splice(0)]) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const setup = (name = 'synthetic-owner') => store.setup({ username: name, password, setupToken: setupCode });
const newAccount = (owner: AuthSession, username: string, role: 'viewer' | 'bookkeeper' | 'owner' | 'payment_approver') => store.createUser(owner.token, { username, password, role });

describe('P02 application-owned identity and session store', () => {
  it('requires an explicit current setup code and consumes it after creating the owner', async () => {
    expect(store.needsSetup()).toBe(true); expect(store.setupAvailable()).toBe(true);
    await expect(store.setup({ username: 'synthetic-owner', password, setupToken: 'incorrect' })).rejects.toMatchObject({ status: 403 });
    const owner = await setup();
    expect(owner.principal).toMatchObject({ username: 'synthetic-owner', role: 'owner', workspace_id: store.workspaceId });
    expect(owner.principal.permissions).toEqual([...COMMUNITY_PERMISSIONS]);
    expect(store.needsSetup()).toBe(false); expect(store.setupAvailable()).toBe(false);
    await expect(setup('second-owner')).rejects.toMatchObject({ status: 403 });
    expect(store.listUsers(owner.token)).toHaveLength(1);
  });
  it('expires bootstrap authorization without creating a user', async () => {
    time += 30 * 60 * 1000;
    expect(store.setupAvailable()).toBe(false);
    await expect(setup()).rejects.toMatchObject({ code: 'SETUP_AUTHORIZATION_REQUIRED' });
    expect(store.needsSetup()).toBe(true);
  });
  it('atomically resolves concurrent first-owner requests to exactly one account', async () => {
    const results = await Promise.allSettled([setup('synthetic-first'), setup('synthetic-second')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const succeeded = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<AuthSession>;
    expect(store.listUsers(succeeded.value.token)).toHaveLength(1);
  });
  it.each(['short', 'passwordpassword', 'xxxxxxxxxxxxxxxx'])('rejects weak setup password %s without committing identity', async value => {
    await expect(store.setup({ username: 'synthetic-owner', password: value, setupToken: setupCode })).rejects.toMatchObject({ status: 400 });
    expect(store.needsSetup()).toBe(true);
  });
  it('normalizes Unicode passwords consistently without trimming significant spaces', async () => {
    const accented = ' Fictional cafe\u0301 passphrase for tests ';
    await store.setup({ username: 'Synthetic-Owner', password: accented, setupToken: setupCode });
    expect((await store.login({ username: 'synthetic-owner', password: accented.normalize('NFC') })).principal.username).toBe('synthetic-owner');
    await expect(store.login({ username: 'synthetic-owner', password: accented.trim() })).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
  });
  it('stores salted password hashes and token digests, never the synthetic plaintext secrets', async () => {
    const owner = await setup(); await newAccount(owner, 'synthetic-viewer', 'viewer');
    const inspect = new Database(join(root, 'identity', 'auth.sqlite'), { readonly: true });
    try {
      const users = inspect.prepare('SELECT password_hash FROM auth_users').all() as Array<{ password_hash: string }>;
      expect(users).toHaveLength(2);
      expect(users[0].password_hash).toMatch(/^scrypt-v1\$131072\$8\$1\$/);
      expect(users[0].password_hash).not.toBe(users[1].password_hash);
      const dump = JSON.stringify({ users, config: inspect.prepare('SELECT * FROM auth_config').all(), sessions: inspect.prepare('SELECT * FROM auth_sessions').all(), audit: inspect.prepare('SELECT * FROM auth_security_events').all() });
      for (const secret of [password, setupCode, owner.token]) expect(dump).not.toContain(secret);
    } finally { inspect.close(); }
  });
  it('uses generic failed-login responses and durable per-user rate limits', async () => {
    await setup();
    await expect(store.login({ username: 'not-existing', password })).rejects.toMatchObject({ status: 401, code: 'LOGIN_FAILED' });
    for (let index = 0; index < 5; index++) await expect(store.login({ username: 'synthetic-owner', password: 'incorrect-password' })).rejects.toMatchObject({ status: 401 });
    store.close(); store = new CommunityAuthStore({ runtimeRoot: root, clock: () => time });
    await expect(store.login({ username: 'synthetic-owner', password })).rejects.toMatchObject({ status: 429 });
    time += 60001;
    expect((await store.login({ username: 'synthetic-owner', password })).principal.role).toBe('owner');
  }, 20000);
  it('binds session and CSRF identity to one installation and session', async () => {
    const owner = await setup(); const other = await store.login({ username: 'synthetic-owner', password });
    expect(other.token).not.toBe(owner.token); expect(other.csrfToken).not.toBe(owner.csrfToken);
    expect(store.validateCsrf(owner, owner.csrfToken)).toBe(true);
    expect(store.validateCsrf(owner, other.csrfToken)).toBe(false);
    const elsewhere = mkdtempSync(join(tmpdir(), 'community-identity-other-synthetic-')); otherRoots.push(elsewhere);
    const otherStore = new CommunityAuthStore({ runtimeRoot: elsewhere }); otherStores.push(otherStore);
    expect(otherStore.cookieName).not.toBe(store.cookieName);
    expect(otherStore.authenticate(owner.token)).toBeNull();
    expect(hasCommunityPermission(owner.principal, otherStore.workspaceId, 'finance:read')).toBe(false);
    expect(store.authenticate('invalid')).toBeNull();
  });
  it('expires idle and absolute sessions even when the process remains running', async () => {
    const idle = await setup(); time += 30 * 60 * 1000;
    expect(store.authenticate(idle.token)).toBeNull();
    const active = await store.login({ username: 'synthetic-owner', password });
    for (let index = 0; index < 35; index++) { time += 20 * 60 * 1000; expect(store.authenticate(active.token)).not.toBeNull(); }
    time += 20 * 60 * 1000;
    expect(store.authenticate(active.token)).toBeNull();
  });
  it('persists valid sessions across restart and revokes a logged-out session', async () => {
    const owner = await setup(); store.close();
    store = new CommunityAuthStore({ runtimeRoot: root, clock: () => time });
    expect(store.authenticate(owner.token)?.principal).toEqual(owner.principal);
    store.logout(owner.token); expect(store.authenticate(owner.token)).toBeNull();
    expect(() => store.logout(owner.token)).not.toThrow(); store.verifyAudit();
  });
  it('requires recent password confirmation for account administration', async () => {
    const owner = await setup(); time += 5 * 60 * 1000;
    expect(() => store.listUsers(owner.token)).toThrow(/Confirm your password/);
    await expect(store.reauthenticate(owner.token, 'wrong-password')).rejects.toMatchObject({ status: 401 });
    const refreshed = await store.reauthenticate(owner.token, password);
    expect(refreshed.principal.reauthenticated_at).toBe(time);
    expect(store.listUsers(owner.token)).toHaveLength(1);
  });
  it('separates role capabilities and rejects forged role lists or foreign workspaces', async () => {
    const owner = await setup();
    const expected: Record<string, string[]> = {
      viewer: ['finance:read'], bookkeeper: ['finance:import', 'finance:match', 'payments:prepare'],
      payment_approver: ['payments:approve', 'payments:submit'],
    };
    for (const role of ['viewer', 'bookkeeper', 'payment_approver'] as const) {
      await newAccount(owner, 'synthetic-' + role, role);
      const session = await store.login({ username: 'synthetic-' + role, password });
      for (const permission of expected[role]) expect(session.principal.permissions).toContain(permission);
      expect(hasCommunityPermission(session.principal, store.workspaceId, 'accounts:manage')).toBe(false);
      expect(() => store.listUsers(session.token)).toThrow(/owner/);
      expect(hasCommunityPermission({ ...session.principal, permissions: [...COMMUNITY_PERMISSIONS] }, store.workspaceId, 'accounts:manage')).toBe(false);
    }
    expect(permissionsForRole('__proto__')).toEqual([]);
    expect(permissionsForRole('constructor')).toEqual([]);
    expect(hasCommunityPermission(owner.principal, 'WS-' + randomUUID(), 'finance:read')).toBe(false);
  }, 20000);
  it('revokes role-changed and disabled accounts immediately and preserves the last owner', async () => {
    const owner = await setup(); const user = await newAccount(owner, 'synthetic-member', 'bookkeeper');
    const before = await store.login({ username: user.username, password });
    store.updateUser(owner.token, user.user_id, { role: 'viewer' });
    expect(store.authenticate(before.token)).toBeNull();
    const viewer = await store.login({ username: user.username, password });
    store.updateUser(owner.token, user.user_id, { disabled: true });
    expect(store.authenticate(viewer.token)).toBeNull();
    await expect(store.login({ username: user.username, password })).rejects.toMatchObject({ status: 401 });
    expect(() => store.updateUser(owner.token, owner.principal.subject, { disabled: true })).toThrow(/one enabled/);
    expect(() => store.updateUser(owner.token, owner.principal.subject, { role: 'viewer' })).toThrow(/one enabled/);
    expect(store.authenticate(owner.token)).not.toBeNull();
  }, 20000);
  it('changes the password only after verification and invalidates all older sessions', async () => {
    const first = await setup(); const second = await store.login({ username: 'synthetic-owner', password });
    const nextPassword = 'Another fictional-only passphrase for testing';
    await expect(store.changePassword(first.token, 'wrong-password', nextPassword)).rejects.toMatchObject({ status: 401 });
    expect(store.authenticate(second.token)).not.toBeNull();
    const updated = await store.changePassword(first.token, password, nextPassword);
    expect(store.authenticate(first.token)).toBeNull(); expect(store.authenticate(second.token)).toBeNull();
    expect(store.authenticate(updated.token)).not.toBeNull();
    await expect(store.login({ username: 'synthetic-owner', password })).rejects.toMatchObject({ status: 401 });
    expect((await store.login({ username: 'synthetic-owner', password: nextPassword })).principal.subject).toBe(first.principal.subject);
  }, 20000);
  it('rejects future schema versions without changing the existing database bytes', async () => {
    await setup(); store.close();
    const path = join(root, 'identity', 'auth.sqlite'); const temporary = new Database(path);
    temporary.pragma('journal_mode = DELETE'); temporary.pragma('user_version = 99'); temporary.close();
    const before = readFileSync(path);
    expect(() => new CommunityAuthStore({ runtimeRoot: root })).toThrow(/Unsupported/);
    expect(readFileSync(path)).toEqual(before);
  });
  it('protects append-only security events and detects tampered audit history on reopen', async () => {
    await setup(); store.verifyAudit(); store.close();
    const path = join(root, 'identity', 'auth.sqlite'); const temporary = new Database(path);
    expect(() => temporary.prepare('UPDATE auth_security_events SET subject = ?').run('forged')).toThrow(/append only/);
    temporary.exec('DROP TRIGGER auth_event_no_update'); temporary.prepare('UPDATE auth_security_events SET subject = ?').run('forged'); temporary.close();
    expect(() => new CommunityAuthStore({ runtimeRoot: root })).toThrow(/integrity/);
  });
});
