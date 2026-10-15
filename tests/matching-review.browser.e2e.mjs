import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((ok, fail) => { server.once('listening', ok); server.once('error', fail); });
  const value = server.address().port;
  await new Promise(ok => server.close(ok));
  return value;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise(ok => child.once('exit', ok));
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 6000 });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
  await Promise.race([ended, sleep(1500)]);
}
async function boot(runtime, listenPort, token) {
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server/index.ts'], {
    cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MATCHING_RUNTIME_MODE: 'external-runtime-root', MATCHING_RUNTIME_ROOT: runtime,
      MATCHING_LOCAL_ACCESS_TOKEN: token, MATCHING_DEMO_MODE: 'true', MATCHING_AUTH_MODE: 'synthetic-preview', MATCHING_HTTP_HOST: '127.0.0.1', MATCHING_ENABLE_BANK_AUTOMATION: 'false',
      NODE_ENV: 'production', PORT: String(listenPort), TEMP: join(runtime, 'temp'), TMP: join(runtime, 'temp') },
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { output = (output + String(value)).slice(-4000); });
  const base = `http://127.0.0.1:${listenPort}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error('Isolated server failed: ' + output.replaceAll(token, '[redacted]'));
    try {
      const response = await fetch(base + '/api/community/session', { signal: AbortSignal.timeout(500) });
      if (response.status === 401) return { child, base };
    } catch {}
    await sleep(150);
  }
  await stop(child);
  throw new Error('Isolated service startup timeout: ' + output.replaceAll(token, '[redacted]'));
}
async function clickButton(page, prefix) {
  for (const button of await page.$$('button')) {
    const text = await button.evaluate(node => node.textContent?.trim() ?? '');
    if (text.startsWith(prefix)) { await button.click(); return; }
  }
  throw new Error('UI button not found: ' + prefix);
}
async function stateText(page, id, expected) {
  await page.waitForFunction((key, text) => document.querySelector(`[data-testid="match-${key}"] [data-testid="decision-state"]`)?.textContent?.includes(text), {}, id, expected);
}

test('P08 real browser review, localized controls, manual matching, audit and restart', { timeout: 120000 }, async () => {
  const executablePath = process.env.MATCHING_TEST_BROWSER || [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome',
  ].find(existsSync);
  assert.ok(executablePath, 'A supported test browser is required; this is not a mock browser test');
  assert.ok(existsSync(join(root, 'web', 'dist', 'index.html')), 'Build the actual frontend before browser qualification');
  const work = mkdtempSync(join(tmpdir(), 'matching-browser-synthetic-'));
  const runtime = join(work, 'runtime'); mkdirSync(join(runtime, 'temp'), { recursive: true });
  const evidence = process.env.MATCHING_E2E_EVIDENCE_DIR ? resolve(process.env.MATCHING_E2E_EVIDENCE_DIR) : join(work, 'evidence');
  mkdirSync(evidence, { recursive: true });
  const token = randomBytes(32).toString('base64url');
  const listenPort = await port();
  let execution; let browser; let page;
  const milestones = []; const pageErrors = []; const externalRequests = [];
  const screenshot = async name => {
    const filename = join(evidence, name + '.png');
    await page.screenshot({ path: filename, fullPage: true });
    milestones.push({ milestone: name, sha256: createHash('sha256').update(readFileSync(filename)).digest('hex') });
  };
  try {
    execution = await boot(runtime, listenPort, token);
    browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: join(work, 'browser-profile'), defaultViewport: { width: 1440, height: 1000 } });
    page = await browser.newPage(); page.setDefaultTimeout(15000);
    page.on('dialog', dialog => dialog.accept());
    page.on('pageerror', error => pageErrors.push(String(error.message).replaceAll(token, '[redacted]')));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === execution.base || ['data:', 'blob:', 'about:'].includes(url.protocol)) request.continue();
      else { externalRequests.push(url.origin); request.abort(); }
    });
    await page.goto(execution.base, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#local-access-token'); await screenshot('01-authentication-required');
    await page.type('#local-access-token', token); await clickButton(page, 'Unlock demo');
    await page.waitForSelector('nav');
    await page.click('nav a[href="/matches"]');
    await stateText(page, 'DEMO-MATCH-002', 'Proposed');
    const second = '[data-testid="match-DEMO-MATCH-002"]';
    await page.click(second + ' [data-action="reject"]'); await stateText(page, 'DEMO-MATCH-002', 'Rejected');
    await screenshot('02-proposal-rejected-history-retained');
    await page.click(second + ' [data-action="reopen"]'); await stateText(page, 'DEMO-MATCH-002', 'Proposed');
    await page.click(second + ' [data-action="accept"]'); await stateText(page, 'DEMO-MATCH-002', 'Accepted');
    await screenshot('03-proposal-accepted');
    await page.reload({ waitUntil: 'networkidle0' }); await stateText(page, 'DEMO-MATCH-002', 'Accepted');
    await page.select('#community-language', 'de');
    await stateText(page, 'DEMO-MATCH-002', 'Angenommen');
    assert.equal(await page.$eval('#matching-review-title', node => node.textContent), 'Zuordnungsentscheidungen');
    await screenshot('04-german-review-controls');
    await page.select('#community-language', 'en'); await stateText(page, 'DEMO-MATCH-002', 'Accepted');
    await page.click(second + ' [data-action="undo"]'); await stateText(page, 'DEMO-MATCH-002', 'Rejected');
    await page.click('a[href="/manual-match"]');
    await page.waitForSelector('input[placeholder="Search transactions..."]');
    await page.type('input[placeholder="Search transactions..."]', 'Fictional subscription');
    await clickButton(page, 'Search');
    await page.waitForFunction(() => [...document.querySelectorAll('div')].some(node => node.style.cursor === 'pointer' && node.textContent.includes('Fictional subscription')));
    for (const node of await page.$$('div[style*="cursor: pointer"]')) {
      if ((await node.evaluate(element => element.textContent)).includes('Fictional subscription')) { await node.click(); break; }
    }
    await page.type('input[placeholder="Search documents..."]', 'DEMO-DOC-002');
    const searches = [];
    for (const button of await page.$$('button')) if (await button.evaluate(node => node.textContent?.trim() === 'Search')) searches.push(button);
    assert.equal(searches.length, 2); await searches[1].click();
    await page.waitForFunction(() => [...document.querySelectorAll('div')].some(node => node.style.cursor === 'pointer' && node.textContent.includes('DEMO-DOC-002')));
    for (const node of await page.$$('div[style*="cursor: pointer"]')) {
      if ((await node.evaluate(element => element.textContent)).includes('DEMO-DOC-002')) { await node.click(); break; }
    }
    await clickButton(page, 'Create Match');
    await page.waitForFunction(() => document.body.innerText.includes('Match created:'));
    await screenshot('05-manual-match-created');
    const before = JSON.parse(readFileSync(join(runtime, 'state', 'state.json'), 'utf8'));
    assert.equal(Object.keys(before.transactions).length, 4);
    assert.equal(Object.values(before.transactions).reduce((sum, item) => sum + item.amount_minor, 0), 26300);
    assert.equal(before.match_groups['DEMO-MATCH-002'].status, 'rejected');
    assert.ok(Object.values(before.match_groups).some(group => group.status === 'confirmed' && group.transaction_ids.includes('DEMO-TXN-002')));
    for (const action of ['MATCH_REJECTED', 'MATCH_REOPENED', 'MATCH_ACCEPTED', 'MATCH_DELETED', 'MATCH_CREATED_MANUAL']) assert.ok(before.audit_events.some(event => event.action === action), action);
    await stop(execution.child); execution = undefined;
    execution = await boot(runtime, listenPort, token);
    await page.goto(execution.base + '/matches', { waitUntil: 'networkidle0' });
    await stateText(page, 'DEMO-MATCH-002', 'Rejected');
    await screenshot('06-persisted-restart');
    const after = JSON.parse(readFileSync(join(runtime, 'state', 'state.json'), 'utf8'));
    assert.deepEqual(after.match_groups, before.match_groups);
    assert.deepEqual(after.audit_events, before.audit_events);
    assert.deepEqual(after.transactions, before.transactions);
    assert.equal((await fetch(execution.base + '/api/transactions')).status, 401);
    assert.equal(externalRequests.length, 0, 'No provider/external request is allowed in synthetic browser qualification');
    assert.deepEqual(pageErrors, []);
    writeFileSync(join(evidence, 'matching-review-result.json'), JSON.stringify({ result: 'PASS', browser: await browser.version(), milestones, accounting: { transactions: 4, currency: 'EUR', signed_total_minor: 26300 }, audit_actions: before.audit_events.map(event => event.action), external_requests: externalRequests, page_errors: pageErrors }, null, 2));
  } catch (error) {
    if (page && !page.isClosed()) { try { await screenshot('failure'); } catch {} }
    writeFileSync(join(evidence, 'matching-review-result.json'), JSON.stringify({ result: 'FAIL', error: String(error.message).replaceAll(token, '[redacted]'), milestones, external_requests: externalRequests, page_errors: pageErrors }, null, 2));
    throw error;
  } finally {
    if (browser) await browser.close();
    await stop(execution?.child);
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
