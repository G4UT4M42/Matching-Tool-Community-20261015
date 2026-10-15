import Database from 'better-sqlite3';
import { preparePrivateIdentityDirectory } from './community-identity-files.js';
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { hasCommunityPermission, permissionsForRole, type CommunityPrincipal, type CommunityRole } from './community-permissions.js';

const AUTH_VERSION = 1;
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const REAUTH_MS = 5 * 60 * 1000;
const HASH_PARAMETERS = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const commonPasswords = new Set(['123456789012345', '1234567890123456', 'passwordpassword', 'password123456789', 'qwertyuiopasdfgh', 'iloveyouiloveyou', 'letmeinletmein123', 'changemechangeme']);
let activeHashes = 0;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const secretEqual = (left: string, right: string) => timingSafeEqual(Buffer.from(sha256(left), 'hex'), Buffer.from(sha256(right), 'hex'));

export class CommunityAuthError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = 'CommunityAuthError'; }
}
interface UserRow { user_id: string; username: string; password_hash: string; role: CommunityRole; disabled: number; created_at: number }
interface SessionRow {
  session_id: string; token_hash: string; csrf_nonce: string; user_id: string;
  created_at: number; last_seen_at: number; absolute_expires_at: number; reauthenticated_at: number;
}
export interface AuthSession { token: string; csrfToken: string; principal: CommunityPrincipal; absoluteExpiresAt: number }
export interface CommunityAuthOptions { runtimeRoot: string; setupToken?: string; clock?: () => number }

function usernameValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value)) throw new CommunityAuthError(400, 'USERNAME_INVALID', 'Use a username of 3 to 64 letters, digits, dots, underscores or hyphens');
  return value.toLowerCase();
}
function passwordValue(value: unknown, enforcePolicy: boolean): string {
  if (typeof value !== 'string') throw new CommunityAuthError(400, 'PASSWORD_INVALID', 'A password is required');
  const normalized = value.normalize('NFC');
  const length = Array.from(normalized).length;
  if (length < (enforcePolicy ? 15 : 1) || length > 128 || Buffer.byteLength(normalized) > 1024 || /[\u0000\r\n]/.test(normalized)) {
    throw new CommunityAuthError(400, 'PASSWORD_LENGTH', 'Use a password containing 15 to 128 characters');
  }
  if (enforcePolicy && (commonPasswords.has(normalized.toLowerCase()) || /^(.)\1+$/u.test(normalized))) throw new CommunityAuthError(400, 'PASSWORD_COMMON', 'Choose a less predictable password');
  return normalized;
}
async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  if (activeHashes >= 2) throw new CommunityAuthError(429, 'AUTHENTICATION_BUSY', 'Authentication is busy; try again shortly');
  activeHashes++;
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, HASH_PARAMETERS, (error, key) => error ? reject(error) : resolve(key)));
  } finally { activeHashes--; }
}
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32);
  const derived = await derivePassword(password, salt);
  try { return `scrypt-v1$131072$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`; }
  finally { derived.fill(0); salt.fill(0); }
}
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt-v1' || parts[1] !== '131072' || parts[2] !== '8' || parts[3] !== '1' || !/^[A-Za-z0-9_-]{43}$/.test(parts[4]) || !/^[A-Za-z0-9_-]{86}$/.test(parts[5])) throw new CommunityAuthError(503, 'AUTHENTICATION_STORE_INVALID', 'The authentication store requires recovery');
  const expected = Buffer.from(parts[5], 'base64url');
  const actual = await derivePassword(password, Buffer.from(parts[4], 'base64url'));
  try { return timingSafeEqual(actual, expected); }
  finally { actual.fill(0); expected.fill(0); }
}
function assertRegular(path: string): void {
  if (!existsSync(path)) return;
  const information = lstatSync(path);
  if (!information.isFile() || information.isSymbolicLink()) throw new Error('Authentication files must be regular local files');
}

/** Identity data is a separate store and must never be included in financial backups. */
export class CommunityAuthStore {
  readonly workspaceId: string;
  readonly cookieName: string;
  private readonly db: Database.Database;
  private readonly clock: () => number;
  private readonly dummyHash: string;
  private closed = false;

  constructor(options: CommunityAuthOptions) {
    if (!isAbsolute(options.runtimeRoot)) throw new Error('Authentication requires an explicit absolute runtime directory');
    this.clock = options.clock ?? Date.now;
    const directory = preparePrivateIdentityDirectory(options.runtimeRoot);
    const file = join(directory, 'auth.sqlite');
    for (const suffix of ['', '-wal', '-shm']) assertRegular(file + suffix);
    const existing = existsSync(file);
    if (existing) {
      const inspect = new Database(file, { readonly: true, fileMustExist: true });
      try {
        if (inspect.pragma('user_version', { simple: true }) !== AUTH_VERSION || inspect.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Unsupported or damaged authentication schema');
      } finally { inspect.close(); }
    }
    this.db = new Database(file);
    try {
      this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
      if (!existing) this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE auth_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE auth_users (
            user_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('owner','bookkeeper','viewer','payment_approver')),
            disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)), created_at INTEGER NOT NULL
          );
          CREATE TABLE auth_sessions (
            session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_nonce TEXT NOT NULL,
            user_id TEXT NOT NULL REFERENCES auth_users(user_id), created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL, reauthenticated_at INTEGER NOT NULL
          );
          CREATE TABLE auth_rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL);
          CREATE TABLE auth_security_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, occurred_at INTEGER NOT NULL,
            event_type TEXT NOT NULL, subject TEXT, metadata TEXT NOT NULL, previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL
          );
          CREATE TRIGGER auth_event_no_update BEFORE UPDATE ON auth_security_events BEGIN SELECT RAISE(ABORT, 'Security audit is append only'); END;
          CREATE TRIGGER auth_event_no_delete BEFORE DELETE ON auth_security_events BEGIN SELECT RAISE(ABORT, 'Security audit is append only'); END;
          PRAGMA user_version = 1;
        `);
        this.db.prepare('INSERT INTO auth_config (key, value) VALUES (?, ?)').run('workspace_id', 'WS-' + randomUUID());
        this.db.prepare('INSERT INTO auth_config (key, value) VALUES (?, ?)').run('cookie_namespace', randomBytes(12).toString('hex'));
      })();
      this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
      if (process.platform !== 'win32') chmodSync(file, 0o600);
      this.workspaceId = this.config('workspace_id') ?? '';
      const namespace = this.config('cookie_namespace') ?? '';
      if (!/^WS-[a-f0-9-]{36}$/.test(this.workspaceId) || !/^[a-f0-9]{24}$/.test(namespace)) throw new Error('Invalid authentication installation identity');
      this.cookieName = 'mt_' + namespace + '_session';
      this.verifyAudit();
      const dummySalt = randomBytes(32).toString('base64url');
      this.dummyHash = `scrypt-v1$131072$8$1$${dummySalt}$${randomBytes(64).toString('base64url')}`;
      if (this.needsSetup() && options.setupToken !== undefined) {
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(options.setupToken)) throw new Error('First-run setup requires a random local setup code');
        this.db.transaction(() => {
          this.setConfig('setup_hash', sha256(options.setupToken!));
          this.setConfig('setup_expires_at', String(this.now() + 30 * 60 * 1000));
        }).immediate();
      }
    } catch (error) { this.db.close(); throw error; }
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid authentication clock');
    return value;
  }
  private config(key: string): string | undefined { return (this.db.prepare('SELECT value FROM auth_config WHERE key = ?').get(key) as { value: string } | undefined)?.value; }
  private setConfig(key: string, value: string): void { this.db.prepare('INSERT INTO auth_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }
  needsSetup(): boolean { return (this.db.prepare('SELECT count(*) AS n FROM auth_users').get() as { n: number }).n === 0; }
  setupAvailable(): boolean { return this.needsSetup() && Number(this.config('setup_expires_at') ?? 0) > this.now(); }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }

  private event(type: string, subject: string | null, metadata: Record<string, unknown> = {}): void {
    this.db.transaction(() => {
      const previous = (this.db.prepare('SELECT event_hash FROM auth_security_events ORDER BY sequence DESC LIMIT 1').get() as { event_hash: string } | undefined)?.event_hash ?? '0'.repeat(64);
      const id = 'SEC-' + randomUUID(), time = this.now(), encoded = JSON.stringify(metadata);
      const hash = sha256(JSON.stringify([id, time, type, subject, encoded, previous]));
      this.db.prepare('INSERT INTO auth_security_events (event_id, occurred_at, event_type, subject, metadata, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, time, type, subject, encoded, previous, hash);
    }).immediate();
  }
  verifyAudit(): void {
    let previous = '0'.repeat(64);
    const rows = this.db.prepare('SELECT * FROM auth_security_events ORDER BY sequence').iterate() as Iterable<{ event_id: string; occurred_at: number; event_type: string; subject: string | null; metadata: string; previous_hash: string; event_hash: string }>;
    for (const row of rows) {
      if (row.previous_hash !== previous || row.event_hash !== sha256(JSON.stringify([row.event_id, row.occurred_at, row.event_type, row.subject, row.metadata, row.previous_hash]))) throw new Error('Authentication audit integrity verification failed');
      previous = row.event_hash;
    }
  }
  recordDataOperation(token:unknown,entry:{id:string;operation:string;phase:string;before:{sha256:string;transactions:number;documents:number;audits:number};after:{sha256:string;transactions:number;documents:number;audits:number}}):void{
    const session=this.requireSession(token),permission=entry.operation==='backup'?'data:backup':entry.operation.startsWith('legacy-')?'data:migrate':'data:restore';
    if(!hasCommunityPermission(session.principal,this.workspaceId,permission))throw new CommunityAuthError(403,'PERMISSION_REQUIRED','Data operation permission is required');
    if(!/^[a-f0-9-]{36}$/.test(entry.id)||!['backup','restore-stage','restore-activate','legacy-inspect','legacy-stage'].includes(entry.operation)||!['started','succeeded','failed'].includes(entry.phase))throw new Error('Invalid data audit event');
    const snapshot=(value:typeof entry.before)=>{if(!value||!/^[a-f0-9]{64}$/.test(value.sha256)||![value.transactions,value.documents,value.audits].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('Invalid data audit snapshot');return{sha256:value.sha256,transactions:value.transactions,documents:value.documents,audits:value.audits};};
    this.verifyAudit();this.event('DATA_OPERATION_'+entry.phase.toUpperCase(),session.principal.subject,{target:entry.id,operation:entry.operation,phase:entry.phase,before:snapshot(entry.before),after:snapshot(entry.after)});
  }
  securityEvents(token:unknown,before?:number){
    const session=this.requireSession(token);
    if(!hasCommunityPermission(session.principal,this.workspaceId,'audit:read'))throw new CommunityAuthError(403,'PERMISSION_REQUIRED','Audit permission is required');
    if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw new CommunityAuthError(400,'AUDIT_CURSOR_INVALID','Use a valid audit cursor');
    this.verifyAudit();
    const rows=this.db.prepare('SELECT sequence,event_id,occurred_at,event_type,subject,metadata FROM auth_security_events WHERE sequence<? ORDER BY sequence DESC LIMIT 100').all(before??Number.MAX_SAFE_INTEGER) as Array<{sequence:number;event_id:string;occurred_at:number;event_type:string;subject:string|null;metadata:string}>;
    const fields=(value:unknown)=>{const result:Record<string,unknown>={};if(value&&typeof value==='object'&&!Array.isArray(value)){const item=value as Record<string,unknown>;if(typeof item.role==='string'&&['owner','bookkeeper','viewer','payment_approver'].includes(item.role))result.role=item.role;if(typeof item.disabled==='boolean')result.disabled=item.disabled;if(typeof item.sha256==='string'&&/^[a-f0-9]{64}$/.test(item.sha256))result.sha256=item.sha256;for(const key of ['transactions','documents','audits'])if(Number.isSafeInteger(item[key])&&Number(item[key])>=0)result[key]=item[key];}return result;};
    return{events:rows.map(row=>{const metadata=JSON.parse(row.metadata) as Record<string,unknown>;return{sequence:row.sequence,audit_id:row.event_id,timestamp:new Date(row.occurred_at).toISOString(),actor_id:row.subject,action:row.event_type,
      ...(typeof metadata.operation==='string'&&['backup','restore-stage','restore-activate','legacy-inspect','legacy-stage'].includes(metadata.operation)?{operation:metadata.operation,phase:metadata.phase}:{}),entity_id:typeof metadata.target==='string'?metadata.target:row.subject,before:fields(metadata.before),after:fields(metadata.after??metadata)};}),next_cursor:rows.length===100?rows.at(-1)!.sequence:null};
  }
  private consumeAttempt(key: string, maximum: number, windowMs = 60000): void {
    this.db.transaction(() => {
      const now = this.now();
      this.db.prepare('DELETE FROM auth_rate_limits WHERE window_start < ?').run(now - 60 * 60 * 1000);
      const stored = this.db.prepare('SELECT window_start, attempts FROM auth_rate_limits WHERE key = ?').get(key) as { window_start: number; attempts: number } | undefined;
      if (stored && stored.window_start + windowMs > now && stored.attempts >= maximum) throw new CommunityAuthError(429, 'AUTHENTICATION_RATE_LIMITED', 'Too many authentication attempts; wait before retrying');
      if (!stored || stored.window_start + windowMs <= now) this.db.prepare('INSERT INTO auth_rate_limits (key, window_start, attempts) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, attempts = 1').run(key, now);
      else this.db.prepare('UPDATE auth_rate_limits SET attempts = attempts + 1 WHERE key = ?').run(key);
    }).immediate();
  }
  private principal(user: UserRow, session: SessionRow): CommunityPrincipal {
    return { subject: user.user_id, workspace_id: this.workspaceId, username: user.username, role: user.role, session_id: session.session_id, authenticated_at: session.created_at, reauthenticated_at: session.reauthenticated_at, permissions: [...permissionsForRole(user.role)] };
  }
  private csrf(token: string, session: SessionRow): string { return createHmac('sha256', token).update(`csrf:${this.workspaceId}:${session.session_id}:${session.csrf_nonce}`).digest('hex'); }
  private newSession(user: UserRow): AuthSession {
    const now = this.now(), token = randomBytes(32).toString('base64url');
    const session: SessionRow = { session_id: 'SES-' + randomUUID(), token_hash: sha256(token), csrf_nonce: randomBytes(32).toString('hex'), user_id: user.user_id, created_at: now, last_seen_at: now, absolute_expires_at: now + ABSOLUTE_MS, reauthenticated_at: now };
    this.db.prepare('DELETE FROM auth_sessions WHERE absolute_expires_at <= ? OR last_seen_at <= ?').run(now, now - IDLE_MS);
    this.db.prepare('INSERT INTO auth_sessions (session_id, token_hash, csrf_nonce, user_id, created_at, last_seen_at, absolute_expires_at, reauthenticated_at) VALUES (@session_id, @token_hash, @csrf_nonce, @user_id, @created_at, @last_seen_at, @absolute_expires_at, @reauthenticated_at)').run(session);
    return { token, csrfToken: this.csrf(token, session), principal: this.principal(user, session), absoluteExpiresAt: session.absolute_expires_at };
  }
  private validSetupToken(value: unknown): boolean {
    const expected = this.config('setup_hash');
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value) && Boolean(expected) && Number(this.config('setup_expires_at') ?? 0) > this.now() && secretEqual(sha256(value), expected!);
  }

  async setup(input: { username: unknown; password: unknown; setupToken: unknown }): Promise<AuthSession> {
    this.consumeAttempt('setup', 10);
    if (!this.needsSetup() || !this.validSetupToken(input.setupToken)) throw new CommunityAuthError(403, 'SETUP_AUTHORIZATION_REQUIRED', 'First-run setup requires the current local setup code');
    const username = usernameValue(input.username), password = passwordValue(input.password, true);
    const hash = await hashPassword(password);
    return this.db.transaction(() => {
      if (!this.needsSetup() || !this.validSetupToken(input.setupToken)) throw new CommunityAuthError(409, 'SETUP_ALREADY_COMPLETED', 'First-run setup changed; reload the application');
      const user: UserRow = { user_id: 'USR-' + randomUUID(), username, password_hash: hash, role: 'owner', disabled: 0, created_at: this.now() };
      this.db.prepare('INSERT INTO auth_users (user_id, username, password_hash, role, disabled, created_at) VALUES (@user_id, @username, @password_hash, @role, @disabled, @created_at)').run(user);
      this.db.prepare("DELETE FROM auth_config WHERE key IN ('setup_hash','setup_expires_at')").run();
      const session = this.newSession(user); this.event('OWNER_CREATED', user.user_id, { role: 'owner' });
      return session;
    }).immediate();
  }

  async login(input: { username: unknown; password: unknown }): Promise<AuthSession> {
    this.consumeAttempt('login-global', 30);
    let username = '', password = '';
    try { username = usernameValue(input.username); password = passwordValue(input.password, false); }
    catch { this.event('LOGIN_FAILED', null, { reason: 'INVALID_CREDENTIALS' }); throw new CommunityAuthError(401, 'LOGIN_FAILED', 'The username or password is incorrect'); }
    this.consumeAttempt('login-user:' + sha256(username), 5);
    const user = this.db.prepare('SELECT * FROM auth_users WHERE username = ?').get(username) as UserRow | undefined;
    const valid = await verifyPassword(password, user?.password_hash ?? this.dummyHash);
    if (!user || !valid || user.disabled) {
      this.event('LOGIN_FAILED', null, { account_fingerprint: sha256(username), reason: 'INVALID_CREDENTIALS' });
      throw new CommunityAuthError(401, 'LOGIN_FAILED', 'The username or password is incorrect');
    }
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT * FROM auth_users WHERE user_id = ?').get(user.user_id) as UserRow | undefined;
      if (!current || current.disabled || current.password_hash !== user.password_hash) throw new CommunityAuthError(401, 'LOGIN_FAILED', 'The username or password is incorrect');
      const session = this.newSession(current); this.event('LOGIN_SUCCEEDED', current.user_id);
      this.db.prepare('DELETE FROM auth_rate_limits WHERE key = ?').run('login-user:' + sha256(username));
      return session;
    }).immediate();
  }

  authenticate(token: unknown): AuthSession | null {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = this.db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get(sha256(token)) as SessionRow | undefined;
    if (!session) return null;
    const now = this.now();
    const user = this.db.prepare('SELECT * FROM auth_users WHERE user_id = ?').get(session.user_id) as UserRow | undefined;
    if (!user || user.disabled || !permissionsForRole(user.role).length || session.absolute_expires_at <= now || session.last_seen_at + IDLE_MS <= now || session.created_at > now || session.reauthenticated_at > now) {
      this.db.prepare('DELETE FROM auth_sessions WHERE session_id = ?').run(session.session_id); return null;
    }
    this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE session_id = ?').run(now, session.session_id);
    return { token, csrfToken: this.csrf(token, session), principal: this.principal(user, session), absoluteExpiresAt: session.absolute_expires_at };
  }
  validateCsrf(session: AuthSession, value: unknown): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && secretEqual(value, session.csrfToken); }
  private requireSession(token: unknown): AuthSession {
    const session = this.authenticate(token);
    if (!session) throw new CommunityAuthError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
    return session;
  }
  requireRecentAuthentication(session: AuthSession): void {
    if (session.principal.reauthenticated_at + REAUTH_MS <= this.now()) throw new CommunityAuthError(403, 'REAUTHENTICATION_REQUIRED', 'Confirm your password before this sensitive operation');
  }
  logout(token: unknown): void {
    const session = this.authenticate(token);
    if (!session) return;
    this.db.transaction(() => { this.db.prepare('DELETE FROM auth_sessions WHERE session_id = ?').run(session.principal.session_id); this.event('LOGOUT', session.principal.subject); }).immediate();
  }
  async reauthenticate(token: unknown, passwordInput: unknown): Promise<AuthSession> {
    const before = this.requireSession(token);
    this.consumeAttempt('reauth:' + before.principal.subject, 5);
    const password = passwordValue(passwordInput, false);
    const user = this.db.prepare('SELECT * FROM auth_users WHERE user_id = ?').get(before.principal.subject) as UserRow;
    if (!await verifyPassword(password, user.password_hash)) { this.event('REAUTHENTICATION_FAILED', user.user_id); throw new CommunityAuthError(401, 'REAUTHENTICATION_FAILED', 'The password is incorrect'); }
    return this.db.transaction(() => {
      const current = this.requireSession(token);
      const currentUser = this.db.prepare('SELECT * FROM auth_users WHERE user_id = ?').get(user.user_id) as UserRow;
      if (currentUser.password_hash !== user.password_hash) throw new CommunityAuthError(401, 'REAUTHENTICATION_FAILED', 'The authentication state changed');
      this.db.prepare('UPDATE auth_sessions SET reauthenticated_at = ? WHERE session_id = ?').run(this.now(), current.principal.session_id);
      this.event('REAUTHENTICATED', current.principal.subject);
      return this.requireSession(token);
    }).immediate();
  }
  private requireOwner(token: unknown): AuthSession {
    const session = this.requireSession(token);
    if (!hasCommunityPermission(session.principal, this.workspaceId, 'accounts:manage')) throw new CommunityAuthError(403, 'PERMISSION_REQUIRED', 'Account administration requires the local owner');
    this.requireRecentAuthentication(session); return session;
  }
  listUsers(token: unknown): Array<{ user_id: string; username: string; role: CommunityRole; disabled: boolean; created_at: number }> {
    this.requireOwner(token);
    return (this.db.prepare('SELECT user_id, username, role, disabled, created_at FROM auth_users ORDER BY created_at, user_id').all() as UserRow[]).map(user => ({ user_id: user.user_id, username: user.username, role: user.role, disabled: Boolean(user.disabled), created_at: user.created_at }));
  }
  async createUser(token: unknown, input: { username: unknown; password: unknown; role: unknown }): Promise<{ user_id: string; username: string; role: CommunityRole }> {
    this.requireOwner(token);
    const username = usernameValue(input.username), password = passwordValue(input.password, true);
    if (typeof input.role !== 'string' || !permissionsForRole(input.role).length) throw new CommunityAuthError(400, 'ROLE_INVALID', 'Select a supported account role');
    const hash = await hashPassword(password);
    return this.db.transaction(() => {
      const owner = this.requireOwner(token);
      if (this.db.prepare('SELECT 1 FROM auth_users WHERE username = ?').get(username)) throw new CommunityAuthError(409, 'USERNAME_UNAVAILABLE', 'This username is already configured');
      const user: UserRow = { user_id: 'USR-' + randomUUID(), username, password_hash: hash, role: input.role as CommunityRole, disabled: 0, created_at: this.now() };
      this.db.prepare('INSERT INTO auth_users (user_id, username, password_hash, role, disabled, created_at) VALUES (@user_id, @username, @password_hash, @role, @disabled, @created_at)').run(user);
      this.event('ACCOUNT_CREATED', owner.principal.subject, { target: user.user_id, role: user.role });
      return { user_id: user.user_id, username, role: user.role };
    }).immediate();
  }
  updateUser(token: unknown, userId: string, changes: { role?: unknown; disabled?: unknown }): void {
    this.db.transaction(() => {
      const owner = this.requireOwner(token);
      const user = this.db.prepare('SELECT * FROM auth_users WHERE user_id = ?').get(userId) as UserRow | undefined;
      if (!user) throw new CommunityAuthError(404, 'ACCOUNT_NOT_FOUND', 'The account does not exist in this workspace');
      const role = changes.role ?? user.role, disabled = changes.disabled ?? Boolean(user.disabled);
      if (!permissionsForRole(role).length || typeof disabled !== 'boolean') throw new CommunityAuthError(400, 'ACCOUNT_CHANGE_INVALID', 'Invalid account role or enabled state');
      if (user.role === 'owner' && !user.disabled && (role !== 'owner' || disabled)) {
        const owners = (this.db.prepare("SELECT count(*) AS n FROM auth_users WHERE role = 'owner' AND disabled = 0").get() as { n: number }).n;
        if (owners < 2) throw new CommunityAuthError(409, 'LAST_OWNER_REQUIRED', 'At least one enabled local owner must remain');
      }
      this.db.prepare('UPDATE auth_users SET role = ?, disabled = ? WHERE user_id = ?').run(role, disabled ? 1 : 0, userId);
      this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
      this.event('ACCOUNT_UPDATED', owner.principal.subject, { target: userId, role, disabled,before:{role:user.role,disabled:Boolean(user.disabled)},after:{role,disabled:Boolean(disabled)} });
    }).immediate();
  }
  async changePassword(token: unknown, currentPassword: unknown, newPassword: unknown): Promise<AuthSession> {
    const password = passwordValue(newPassword, true);
    const session = await this.reauthenticate(token, currentPassword);
    const hash = await hashPassword(password);
    return this.db.transaction(() => {
      const current = this.requireSession(token);
      if (current.principal.subject !== session.principal.subject) throw new CommunityAuthError(401, 'AUTHENTICATION_REQUIRED', 'Authentication changed');
      this.requireRecentAuthentication(current);
      this.db.prepare('UPDATE auth_users SET password_hash = ? WHERE user_id = ?').run(hash, current.principal.subject);
      this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(current.principal.subject);
      this.event('PASSWORD_CHANGED', current.principal.subject);
      const user = this.db.prepare('SELECT * FROM auth_users WHERE user_id = ?').get(current.principal.subject) as UserRow;
      return this.newSession(user);
    }).immediate();
  }
}
