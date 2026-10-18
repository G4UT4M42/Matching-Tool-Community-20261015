import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
async function reserveAvailablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port reservation failed');
  const port = address.port;
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended=new Promise(resolve=>child.once('exit',resolve));
  if(process.platform==='win32') {
    // tsx can spawn a server grandchild; terminate only this test-owned process tree.
    spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{
      windowsHide:true,stdio:'ignore',timeout:6000
    });
  } else {
    try { process.kill(-child.pid,'SIGTERM'); }
    catch { child.kill('SIGTERM'); }
  }
  await Promise.race([ended,sleep(1500)]);
  if(child.exitCode===null)child.kill('SIGKILL');
}
function launch(rootRuntime, port, token) {
  const env = {
    ...process.env,
    MATCHING_RUNTIME_ROOT: rootRuntime,
    MATCHING_RUNTIME_MODE: 'external-runtime-root',
    MATCHING_LOCAL_ACCESS_TOKEN: token, MATCHING_DEMO_MODE: 'true', MATCHING_AUTH_MODE: 'synthetic-preview',
    MATCHING_ENABLE_BANK_AUTOMATION: 'false',
    MATCHING_HTTP_HOST: '127.0.0.1',
    PORT: String(port),
  };
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server/index.ts'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, detached: process.platform!=='win32',
  });
  let output = '';
  child.stdout.on('data', b => { output = (output + b.toString()).slice(-8000); });
  child.stderr.on('data', b => { output = (output + b.toString()).slice(-8000); });
  return {child, getOutput: () => output.replaceAll(token, '[redacted]')};
}
async function ready(base, headers, execution, timeout = 25000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (execution.child.exitCode !== null) {
      throw new Error('Synthetic preview server exited before ready: ' + execution.getOutput());
    }
    try {
      const response = await fetch(base + '/api/community/session', { headers, signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Only the isolated loopback fixture is probed.
    }
    await sleep(250);
  }
  throw new Error('Synthetic preview server did not become ready: ' + execution.getOutput());
}

test('fresh offline demo boot, protected financial API and persisted restart', { timeout: 45000 }, async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'matching-community-smoke-'));
  const token = randomBytes(32).toString('base64url');
  const headers = { 'x-community-access-token': token };
  const port = await reserveAvailablePort();
  const base = `http://127.0.0.1:${port}`;
  let process1; let process2;
  try {
    process1 = launch(runtime, port, token);
    await ready(base, headers, process1);
    assert.equal((await fetch(base + '/api/community/session')).status, 401);
    for (const url of ['/api/transactions', '/api/matches', '/api/report/summary']) {
      const response = await fetch(base + url, { headers });
      assert.equal(response.status, 200, url + ' should function on synthetic data');
      const data = await response.json();
      assert.ok(data && typeof data === 'object');
    }
    for (const url of ['/api/backups', '/api/import/bank/connect', '/api/belege/info']) {
      const response = await fetch(base + url, { headers });
      assert.equal(response.status, 403, url + ' must remain unavailable');
    }
    const stateBytes = readFileSync(join(runtime, 'state', 'state.json'));
    const state = JSON.parse(stateBytes);
    assert.equal(state.schema_version, 2);
    assert.equal(state.format, 'matching-community-state-v2');
    assert.equal(state.accounting.capability, 'exact-accounting-v1');
    assert.equal(Object.keys(state.transactions).length, 17);
    assert.equal(Object.keys(state.documents).length, 13);
    assert.equal(state.transactions['DEMO-TXN-017'].amount_minor, 5000);
    assert.equal(state.transactions['DEMO-TXN-017'].currency_code, 'USD');
    assert.ok(state.transactions['DEMO-TXN-001']);
    const previewResponse = await fetch(base + '/api/community/demo', { headers });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.payments.length, 1);
    assert.equal(preview.payments[0].status, 'draft');
    assert.deepEqual(preview.payments[0].items.map(item => [item.documentId, item.amountMinor]).sort(),
      [['DEMO-DOC-007', 6000], ['DEMO-DOC-009', 3600]]);
    await stop(process1.child);

    // Restart and confirm the same persisted synthetic economic records remain.
    process2 = launch(runtime, port, token);
    await ready(base, headers, process2);
    const resumed = await fetch(base + '/api/transactions', { headers });
    assert.equal(resumed.status, 200);
    const storedState = JSON.parse(readFileSync(join(runtime, 'state', 'state.json'), 'utf8'));
    assert.deepEqual(readFileSync(join(runtime, 'state', 'state.json')), stateBytes);
    assert.deepEqual(storedState, state);
    const resumedPreview = await fetch(base + '/api/community/demo', { headers });
    assert.equal(resumedPreview.status, 200);
    assert.deepEqual(await resumedPreview.json(), preview);
    assert.ok(storedState.transactions['DEMO-TXN-001']);
    assert.equal(storedState.match_groups['DEMO-MATCH-002'].status, 'proposed');
  } finally {
    await stop(process2?.child);
    await stop(process1?.child);
    rmSync(runtime, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
