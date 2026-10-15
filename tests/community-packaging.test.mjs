import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeClosure, buildPackage } from '../scripts/package-community.mjs';
import { verifyPackage, sha256 } from '../scripts/verify-community-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = process.env.MATCHING_PACKAGING_EVIDENCE;
function command(file, args, options = {}) {
  const run = spawnSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000, ...options });
  assert.equal(run.status, 0, (run.stderr || run.stdout || String(run.error)).slice(-4000));
  return run.stdout;
}
function ps(script, args) { return command('powershell.exe', ['-NoProfile', '-File', join(root, 'scripts', script), ...args]); }
async function port() { const server = createServer(); await new Promise(ok => server.listen(0, '127.0.0.1', ok)); const value = server.address().port; await new Promise(ok => server.close(ok)); return value; }
function launch(install, data, number) {
  // No NodeExe override: the installed runtime must work independently of PATH.
  const child = spawn('powershell.exe', ['-NoProfile', '-File', join(install, 'scripts/Start-Community.ps1'), '-DataDirectory', data, '-Port', String(number)], { cwd: tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const server = { child, output: '', origin: 'http://127.0.0.1:' + number };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { server.output = (server.output + bytes).slice(-65536); });
  return server;
}
async function ready(server) {
  for (let count = 0; count < 200; count++) {
    if (server.child.exitCode !== null) throw new Error('Packaged launcher exited before readiness: ' + server.output.slice(-2000));
    try { const reply = await fetch(server.origin + '/health', { signal: AbortSignal.timeout(1000) }); if (reply.ok) return reply.json(); } catch {}
    await new Promise(ok => setTimeout(ok, 100));
  }
  throw new Error('Packaged server failed to become ready');
}
async function stop(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  const done = new Promise((ok, fail) => { const timer = setTimeout(() => fail(new Error('Owned packaged process did not stop')), 15000); server.child.once('exit', () => { clearTimeout(timer); ok(); }); });
  command('taskkill.exe', ['/PID', String(server.child.pid), '/T', '/F'], { timeout: 15000 }); await done;
}
function request(server, action, payload) { return fetch(server.origin + '/api/auth/' + action, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }

test('runtime closure includes runtime tsx and required peers, excludes unused development roots', () => {
  const entry = (name, extra = {}) => ({ ref: name, workspace: 'root', path: 'node_modules/' + name, installed: true, ...extra });
  const report = { installations: [entry('server'), entry('tsx'), entry('peer'), entry('unused'), entry('other-platform', { installed: false, optional: true })], unresolvedDependencyEdges: [] };
  const bom = { dependencies: [{ ref: 'server', dependsOn: ['peer', 'other-platform'] }, { ref: 'tsx', dependsOn: [] }] };
  assert.deepEqual(runtimeClosure(report, bom, { dependencies: { server: '1' } }).map(e => e.ref), ['peer', 'server', 'tsx']);
  report.installations.find(e => e.ref === 'peer').installed = false;
  assert.throws(() => runtimeClosure(report, bom, { dependencies: { server: '1' } }), /not installed/);
});

test('installation and uninstall refuse junctions while retaining independent synthetic files', () => {
  const base = mkdtempSync(join(tmpdir(), 'community-package-links-'));
  try {
    const pack = join(base, 'package'), install = join(base, 'install'), data = join(base, 'data'), retained = join(base, 'retained');
    for (const path of ['src/server/index.ts', 'web/dist/index.html', 'node_modules/tsx/dist/cli.mjs', 'scripts/Start-Community.ps1', 'LICENSE', 'package.json']) {
      const target = join(pack, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, path.endsWith('json') ? '{}' : 'Synthetic fixture');
    }
    mkdirSync(retained); writeFileSync(join(retained, 'keep.txt'), 'SYNTHETIC RETAIN');
    symlinkSync(retained, join(pack, 'junction'), 'junction');
    const refused = spawnSync('powershell.exe', ['-NoProfile', '-File', join(root, 'scripts/Install-Community.ps1'), '-PackageDirectory', pack, '-InstallDirectory', install, '-DataDirectory', data], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.notEqual(refused.status, 0); assert.equal(existsSync(install), false);
    rmSync(join(pack, 'junction'));
    ps('Install-Community.ps1', ['-PackageDirectory', pack, '-InstallDirectory', install, '-DataDirectory', data]);
    symlinkSync(retained, join(install, 'junction'), 'junction');
    const uninstalled = spawnSync('powershell.exe', ['-NoProfile', '-File', join(root, 'scripts/Uninstall-Community.ps1'), '-InstallDirectory', install, '-DataDirectory', data, '-ConfirmStopped'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.notEqual(uninstalled.status, 0); assert.equal(existsSync(install), true);
    assert.equal(readFileSync(join(retained, 'keep.txt'), 'utf8'), 'SYNTHETIC RETAIN');
  } finally { assert.ok(resolve(base).startsWith(resolve(tmpdir()) + '\\')); rmSync(base, { recursive: true, force: true }); }
});

test('external development package installs, runs with bundled runtime, upgrades and uninstalls retaining synthetic data', { timeout: 360000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'community-package-synthetic-'));
  const compliance = join(base, 'compliance'), pack = join(base, 'package'), install = join(base, 'Application Übung'), data = join(base, 'Daten Übung');
  const results = { syntheticOnly: true, releaseAccepted: false }; let server;
  try {
    command(process.execPath, [join(root, 'scripts/create-compliance-inventory.mjs'), '--out', compliance]);
    assert.throws(() => buildPackage({ out: join(base, 'refused-release'), compliance, mode: 'distributable' }), /blocked/);
    assert.equal(existsSync(join(base, 'refused-release')), false);
    results.package = buildPackage({ out: pack, compliance });
    assert.equal(results.package.distributable, false);
    assert.equal(existsSync(join(pack, 'node_modules/vitest')), false);
    assert.equal(existsSync(join(pack, 'node_modules/typescript')), false);
    assert.equal(existsSync(join(pack, 'node_modules/canvas')), false);
    assert.equal(existsSync(join(pack, 'node_modules/tsx/dist/cli.mjs')), true);
    for (const language of ['eng', 'deu']) assert.equal(existsSync(join(pack, 'node_modules/@tesseract.js-data', language, '4.0.0_best_int', language + '.traineddata.gz')), true);
    const notice = readFileSync(join(pack, 'NOTICE'));
    writeFileSync(join(pack, 'NOTICE'), 'synthetic tamper');
    assert.throws(() => verifyPackage(pack), /integrity/);
    const refused = spawnSync('powershell.exe', ['-NoProfile', '-File', join(root, 'scripts/Install-Community.ps1'), '-PackageDirectory', pack, '-InstallDirectory', install, '-DataDirectory', data], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.notEqual(refused.status, 0); assert.equal(existsSync(install), false);
    writeFileSync(join(pack, 'NOTICE'), notice); verifyPackage(pack);
    ps('Install-Community.ps1', ['-PackageDirectory', pack, '-InstallDirectory', install, '-DataDirectory', data]);
    assert.equal(verifyPackage(install).ok, true);
    assert.equal(readFileSync(join(install, 'NOTICE'), 'utf8'), notice.toString());
    assert.equal(existsSync(join(install, 'compliance/license-texts')), true);
    command(join(install, 'runtime/node.exe'), ['-e', "const canvas=require('@napi-rs/canvas');if(canvas.createCanvas(2,2).toBuffer('image/png').length<10)process.exit(1)"], { cwd: install });
    command(join(install, 'runtime/node.exe'), ['--import', 'tsx', '--input-type=module', '-e', "import {packagedOcrDirectory} from './src/community/documents/ocr-assets.ts';import{existsSync}from'node:fs';import{join}from'node:path';const dir=packagedOcrDirectory();for(const lang of ['eng','deu'])if(!existsSync(join(dir,lang+'.traineddata')))process.exit(1)"], { cwd: install });
    const number = await port(); server = launch(install, data, number);
    assert.deepEqual(await ready(server), { ok: true, auth_mode: 'accounts', release_ready: false });
    const setup = /Local setup code: ([A-Za-z0-9_-]{43})/.exec(server.output)?.[1]; assert.ok(setup);
    const credentials = { username: 'synthetic-package-owner', password: 'Synthetic packaged owner passphrase 2026' };
    assert.equal((await request(server, 'setup', { ...credentials, setup_code: setup })).status, 201);
    await stop(server); server = undefined;
    const stateBefore = sha256(readFileSync(join(data, 'state/state.json')));
    const dbBefore = sha256(readFileSync(join(data, 'database/matching.db')));
    ps('Upgrade-Community.ps1', ['-PackageDirectory', pack, '-InstallDirectory', install, '-DataDirectory', data, '-ConfirmStopped']);
    assert.equal(sha256(readFileSync(join(data, 'state/state.json'))), stateBefore);
    assert.equal(sha256(readFileSync(join(data, 'database/matching.db'))), dbBefore);
    server = launch(install, data, number); await ready(server);
    assert.equal((await (await fetch(server.origin + '/api/auth/session')).json()).setup_required, false);
    assert.equal((await request(server, 'login', credentials)).status, 200);
    await stop(server); server = undefined;
    const retainedState = sha256(readFileSync(join(data, 'state/state.json'))), retainedDb = sha256(readFileSync(join(data, 'database/matching.db')));
    ps('Uninstall-Community.ps1', ['-InstallDirectory', install, '-DataDirectory', data, '-ConfirmStopped']);
    assert.equal(existsSync(install), false);
    assert.equal(sha256(readFileSync(join(data, 'state/state.json'))), retainedState);
    assert.equal(sha256(readFileSync(join(data, 'database/matching.db'))), retainedDb);
    results.freshInstall = results.bundledRuntime = results.offlineOcrAssets = results.upgradePreservedData = results.restartLogin = results.uninstallPreservedData = true;
    results.tamperedNoticeRejected = results.distributableModeBlocked = true;
    if (evidenceRoot) { const evidence = resolve(evidenceRoot), rel = relative(root, evidence); if (!(isAbsolute(rel) || rel === '..' || rel.startsWith('..\\'))) throw new Error('Evidence must stay external'); const runId=process.env.MATCHING_TEST_RUN_ID??String(Date.now());assert.match(runId,/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'packaging-tested-manifest-'+runId+'.json'),readFileSync(join(pack,'community-package.json')),{flag:'wx'});writeFileSync(join(evidence, 'packaging-test-result-'+runId+'.json'), JSON.stringify(results, null, 2) + '\n',{flag:'wx'}); }
  } finally { await stop(server); const resolvedBase = resolve(base); assert.ok(resolvedBase.startsWith(resolve(tmpdir()) + '\\')); rmSync(resolvedBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});
