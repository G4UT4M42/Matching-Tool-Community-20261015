import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const password = 'Fictional real-server passphrase 2026';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
async function freePort() {
  const socket = createServer(); await new Promise((resolveListen, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolveListen); });
  const port = socket.address().port; await new Promise(resolveClose => socket.close(resolveClose)); return port;
}
function launch(runtime, port, setupCode, extra = {}) {
  mkdirSync(join(runtime, 'temp'), { recursive: true });
  const environment = { ...process.env, MATCHING_RUNTIME_MODE: 'external-runtime-root', MATCHING_RUNTIME_ROOT: runtime,
    MATCHING_AUTH_MODE: 'accounts', MATCHING_DEMO_MODE: 'false', MATCHING_SETUP_TOKEN: setupCode,
    MATCHING_HTTP_HOST: '127.0.0.1', MATCHING_ENABLE_BANK_AUTOMATION: 'false', PORT: String(port),
    NODE_ENV: 'production', TEMP: join(runtime, 'temp'), TMP: join(runtime, 'temp'), ...extra };
  delete environment.MATCHING_LOCAL_ACCESS_TOKEN;
  if (Object.hasOwn(extra, 'MATCHING_LOCAL_ACCESS_TOKEN')) environment.MATCHING_LOCAL_ACCESS_TOKEN = extra.MATCHING_LOCAL_ACCESS_TOKEN;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const output = { text: '' };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { output.text = (output.text + value.toString()).slice(-131072); });
  return { child, output, origin: `http://127.0.0.1:${port}` };
}
async function stop(process_) {
  if (!process_ || process_.child.exitCode !== null || process_.child.signalCode !== null) return;
  const exited = new Promise(resolveExit => process_.child.once('exit', resolveExit));
  // This is the test-owned main server PID, never a user service or another agent.
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(process_.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  else process_.child.kill('SIGTERM');
  await Promise.race([exited, sleep(10000)]);
  assert.ok(process_.child.exitCode !== null || process_.child.signalCode !== null, 'The test-owned server must stop before its runtime is removed');
}
async function ready(process_) {
  for (let index = 0; index < 150; index++) {
    if (process_.child.exitCode !== null) throw new Error(`Isolated server exited before readiness: ${process_.output.text}`);
    try {
      const response = await fetch(process_.origin + '/health', { signal: AbortSignal.timeout(1500) });
      if (response.ok) return await response.json();
    } catch { /* Retry only the read-only readiness request. */ }
    await sleep(200);
  }
  throw new Error(`Isolated server readiness deadline exceeded: ${process_.output.text}`);
}
function send(process_, path, method = 'GET', session, body, additionalHeaders = {}) {
  const headers = { Origin: process_.origin, ...additionalHeaders };
  if (session) { headers.Cookie ??= session.cookie; headers['X-CSRF-Token'] ??= session.csrf; }
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] ??= 'application/json';
  return fetch(process_.origin + '/api' + path, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
}
async function sessionFrom(response, expectedStatus) {
  assert.equal(response.status, expectedStatus, await response.clone().text());
  const data = await response.json(), header = response.headers.get('set-cookie');
  assert.ok(header?.includes('HttpOnly')); assert.ok(header.includes('SameSite=Strict'));
  const cookie = header.split(';')[0], rawToken = cookie.slice(cookie.indexOf('=') + 1);
  assert.ok(!JSON.stringify(data).includes(rawToken), 'The session token must not be returned as JSON');
  assert.ok(!JSON.stringify(data).includes(password));
  assert.match(data.csrf_token, /^[a-f0-9]{64}$/);
  return { cookie, csrf: data.csrf_token, principal: data.principal };
}
function statement(reference = 'SYN-MAIN-001', amount = '-12,34') {
  const body = new FormData();
  body.append('source', 'sparkasse'); body.append('account_id', 'SYNTHETIC-MAIN-ACCOUNT');
  body.append('file', new Blob([`Datum;Partnername;Betrag;Waehrung;Referenz;Verwendungszweck\n13.01.2026;Fictional Main Supplier;${amount};EUR;${reference};Fictional main-server purchase`]), 'synthetic-main.csv');
  return body;
}
function persisted(runtime) {
  const state = JSON.parse(readFileSync(join(runtime, 'state', 'state.json'), 'utf8'));
  const inspect = new Database(join(runtime, 'database', 'matching.db'), { readonly: true, fileMustExist: true });
  try {
    return { state, transactions: inspect.prepare('SELECT transaction_id, amount_minor, currency_code, source_account_id, source_row_ref FROM transactions ORDER BY transaction_id').all(), audit: inspect.prepare('SELECT audit_id, actor_id, action FROM audit_events ORDER BY timestamp, audit_id').all() };
  } finally { inspect.close(); }
}

test('P02 real account-mode server: owner setup, roles, authenticated import, durable audit and restart', { timeout: 150000 }, async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'community-main-accounts-synthetic-'));
  const setupCode = randomBytes(32).toString('base64url');
  const evidence = process.env.MATCHING_ACCOUNT_EVIDENCE_DIR ? resolve(process.env.MATCHING_ACCOUNT_EVIDENCE_DIR) : undefined;
  let server;
  const milestones = [];
  try {
    server = launch(runtime, await freePort(), setupCode);
    assert.deepEqual(await ready(server), { ok: true, auth_mode: 'accounts', release_ready: false });
    const anonymous = await send(server, '/auth/session');
    assert.deepEqual(await anonymous.json(), { mode: 'accounts', authenticated: false, setup_required: true, setup_available: true });
    assert.equal((await send(server, '/summary')).status, 401);
    assert.equal((await send(server, '/summary', 'GET', undefined, undefined, { 'X-Community-Access-Token': randomBytes(32).toString('base64url') })).status, 401);
    const owner = await sessionFrom(await send(server, '/auth/setup', 'POST', undefined, { username: 'synthetic-owner', password, setup_code: setupCode }), 201);
    assert.equal(owner.principal.role, 'owner');
    const info = await send(server, '/community/session', 'GET', owner);
    assert.equal(info.status, 200);
    assert.deepEqual(await info.json(), { ok: true, mode: 'accounts', demo: false, banking_enabled: false, release_ready: false, workspace_id: owner.principal.workspace_id, role: 'owner' });
    const empty = await send(server, '/transactions', 'GET', owner); assert.equal(empty.status, 200); assert.equal((await empty.json()).total, 0);
    milestones.push('Fresh owner setup with a temporary local authorization code; no synthetic demo seeded in normal mode');

    const newUser = await send(server, '/auth/users', 'POST', owner, { username: 'synthetic-viewer', password, role: 'viewer' });
    assert.equal(newUser.status, 201, await newUser.clone().text());
    const viewer = await sessionFrom(await send(server, '/auth/login', 'POST', undefined, { username: 'synthetic-viewer', password }), 200);
    assert.equal((await send(server, '/summary', 'GET', viewer)).status, 200);
    assert.equal((await send(server, '/import/upload', 'POST', viewer, statement())).status, 403);
    assert.equal((await send(server, '/auth/users', 'GET', viewer)).status, 403);
    assert.equal(persisted(runtime).transactions.length, 0);
    assert.equal((await send(server, '/import/upload', 'POST', owner, statement(), { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await send(server, '/import/upload', 'POST', owner, statement(), { Origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await send(server, '/payments/batches', 'POST', owner, {})).status, 403);
    assert.equal((await send(server, '/run', 'POST', owner, {})).status, 403);
    milestones.push('Viewer read-only, forged preview token denied, origin/CSRF and unreviewed financial routes denied');

    const imported = await send(server, '/import/upload', 'POST', owner, statement());
    assert.equal(imported.status, 200, await imported.clone().text());
    const importResult = await imported.json(); assert.equal(importResult.imported, 1); assert.equal(importResult.payment_execution, false);
    let state = persisted(runtime);
    assert.equal(state.transactions.length, 1); assert.equal(Object.keys(state.state.transactions).length, 1);
    assert.equal(state.transactions[0].amount_minor, -1234); assert.equal(state.transactions[0].currency_code, 'EUR');
    assert.equal(state.transactions[0].source_account_id, 'SYNTHETIC-MAIN-ACCOUNT');
    assert.equal(state.audit.length, 1); assert.equal(state.audit[0].actor_id, owner.principal.subject);
    const audit = await send(server, '/audit', 'GET', viewer); assert.equal(audit.status, 200);
    assert.equal((await audit.json()).items[0].actor_id, owner.principal.subject);
    const replay = await send(server, '/import/upload', 'POST', owner, statement()); assert.equal(replay.status, 200);
    assert.equal((await replay.json()).skipped, 1);
    const beforeConflict = sha256(readFileSync(join(runtime, 'state', 'state.json')));
    const conflict = await send(server, '/import/upload', 'POST', owner, statement('SYN-MAIN-001', '-99,00'));
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'SOURCE_IDENTITY_CONFLICT');
    assert.equal(sha256(readFileSync(join(runtime, 'state', 'state.json'))), beforeConflict);
    milestones.push('Real multipart bank import with exact values, authenticated audit, idempotent replay and atomic conflicting-reference rejection');

    const oversizedAuth = await send(server, '/auth/login', 'POST', undefined, { username: 'synthetic-owner', password, padding: 'SYNTHETIC-NO-ECHO'.repeat(2000) });
    assert.equal(oversizedAuth.status, 413); assert.ok(!(await oversizedAuth.text()).includes(password));
    // Unauthorized financial input is rejected before parsing its deliberately oversized JSON.
    const unauthorizedLarge = await send(server, '/matches', 'POST', undefined, { padding: 'synthetic'.repeat(160000) });
    assert.equal(unauthorizedLarge.status, 401);
    milestones.push('Main-server authentication JSON limit and authorization-before-financial-body parsing');

    await stop(server);
    assert.ok(!server.output.text.includes(password)); assert.ok(!server.output.text.includes(setupCode));
    server = launch(runtime, await freePort(), setupCode); await ready(server);
    const restored = await send(server, '/auth/session', 'GET', owner); assert.equal(restored.status, 200);
    const restoredData = await restored.json(); assert.equal(restoredData.authenticated, true); assert.equal(restoredData.principal.subject, owner.principal.subject);
    assert.equal((await (await send(server, '/transactions', 'GET', viewer)).json()).total, 1);
    state = persisted(runtime); assert.equal(state.transactions.length, 1); assert.equal(state.audit.length, 2);
    assert.equal((await send(server, '/auth/setup', 'POST', undefined, { username: 'second-owner', password, setup_code: setupCode })).status, 403);
    assert.equal((await send(server, '/auth/logout', 'POST', owner, {})).status, 204);
    assert.equal((await send(server, '/summary', 'GET', owner)).status, 401);
    assert.equal((await send(server, '/summary', 'GET', viewer)).status, 200);
    milestones.push('Main process restart preserves the account namespace, valid sessions, transaction identities and audit; logout revokes one session');

    await stop(server);
    const identityHash = sha256(readFileSync(join(runtime, 'identity', 'auth.sqlite')));
    const snapshotHash = sha256(readFileSync(join(runtime, 'state', 'state.json')));
    server = launch(runtime, await freePort(), setupCode, { MATCHING_AUTH_MODE: 'synthetic-preview', MATCHING_DEMO_MODE: 'true', MATCHING_LOCAL_ACCESS_TOKEN: randomBytes(32).toString('base64url') });
    await Promise.race([new Promise(resolveExit => server.child.once('exit', resolveExit)), sleep(15000)]);
    assert.notEqual(server.child.exitCode, null, 'An account-owned installation must not enter token-preview mode');
    assert.notEqual(server.child.exitCode, 0);
    assert.equal(sha256(readFileSync(join(runtime, 'identity', 'auth.sqlite'))), identityHash);
    assert.equal(sha256(readFileSync(join(runtime, 'state', 'state.json'))), snapshotHash);
    milestones.push('Account-owned runtime rejects a downgrade to synthetic token access without changing identity or financial snapshots');
    if (evidence) {
      assert.ok(!evidence.startsWith(repository + '\\') && !evidence.startsWith(repository + '/'), 'Evidence belongs outside source');
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, 'account-server-result.json'), JSON.stringify({ test: 'P02 real main server account/API qualification', result: 'PASS', runtime: process.versions.node, abi: process.versions.modules, milestones, transactions: 1, signed_totals_minor: { EUR: -1234 }, audit_events: 2, browser_account_ui_qualified: false, release_accepted: false }, null, 2));
    }
  } finally { await stop(server); rmSync(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('P02 main server rejects invalid launch boundaries before initializing financial or identity stores', { timeout: 60000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'community-invalid-launch-synthetic-'));
  const setupCode = randomBytes(32).toString('base64url');
  try {
    const cases = [
      { name: 'explicit-preview-without-demo', extra: { MATCHING_AUTH_MODE: 'synthetic-preview', MATCHING_DEMO_MODE: 'false', MATCHING_LOCAL_ACCESS_TOKEN: randomBytes(32).toString('base64url') } },
      { name: 'external-host', extra: { MATCHING_HTTP_HOST: '0.0.0.0' } },
      { name: 'bank-automation-without-qualified-provider', extra: { MATCHING_ENABLE_BANK_AUTOMATION: 'true' } },
      { name: 'invalid-port', extra: { PORT: '3000trailing' } },
    ];
    for (const { name, extra } of cases) {
      const runtime = join(work, name), server = launch(runtime, await freePort(), setupCode, extra);
      try {
        await Promise.race([new Promise(resolveExit => server.child.once('exit', resolveExit)), sleep(10000)]);
        assert.notEqual(server.child.exitCode, null, name); assert.notEqual(server.child.exitCode, 0, name);
        assert.equal(existsSync(join(runtime, 'database', 'matching.db')), false, name);
        assert.equal(existsSync(join(runtime, 'identity', 'auth.sqlite')), false, name);
        assert.ok(!server.output.text.includes(setupCode));
      } finally { await stop(server); }
    }
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
