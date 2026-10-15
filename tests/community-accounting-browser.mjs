import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const evidence = process.env.COMMUNITY_FINANCIAL_EVIDENCE || join(tmpdir(), 'community-accounting-browser-evidence');
const browserPath = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(existsSync);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clickButton = (page, label) => page.evaluate(text => {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  button.click();
}, label);
const fill = async (page, selector, value) => { await page.click(selector); await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); await page.keyboard.type(value); };

test('real browser buttons reconcile a partial and completed synthetic payment', async () => {
  assert.ok(browserPath, 'An isolated Chromium executable is required');
  const runtime = join(evidence, 'browser-runtime'); mkdirSync(runtime, { recursive: true });
  const entry = `import React from 'react'; import { createRoot } from 'react-dom/client'; import { CommunityAccounting } from '../web/src/pages/CommunityAccounting.tsx'; createRoot(document.getElementById('root')).render(React.createElement(CommunityAccounting, {apiBase:'/api', locale:'en'}));`;
  await build({ stdin: { contents: entry, resolveDir: resolve('tests'), sourcefile: 'community-accounting-harness.tsx', loader: 'tsx' },
    bundle: true, platform: 'browser', format: 'iife', outfile: join(runtime, 'harness.js'), logLevel: 'silent',
    alias: { react: resolve('web/node_modules/react'), 'react-dom/client': resolve('web/node_modules/react-dom/client') } });
  await build({ stdin: { contents: `export { createEmptyState } from '../src/storage/json-store.ts'; export { createCommunityAccountingRouter } from '../src/server/routes/community-accounting.ts';`,
    resolveDir: resolve('tests'), sourcefile: 'community-accounting-backend.ts', loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: join(runtime, 'backend.cjs'), logLevel: 'silent' });
  const { createEmptyState, createCommunityAccountingRouter } = createRequire(import.meta.url)(join(runtime, 'backend.cjs'));
  let state = createEmptyState('BROWSER_SYNTHETIC');
  for (const [key, amount] of [['T1', -600], ['T2', -400]]) state.transactions.set(key, {
    transaction_id: key, source_system: 'sparkasse', source_account_id: 'FICTIONAL', source_row_ref: key,
    posting_at: '2026-01-12T12:00:00Z', amount_minor: amount, currency_code: 'EUR', description_raw: `Fictional ${key}`, tags: [], meta: {},
  });
  state.documents.set('D1', { document_id: 'D1', source_system: 'manual', source_document_ref: 'D1', captured_at: '2026-01-12T12:00:00Z',
    document_date: '2026-01-12', total_amount_minor: -1000, currency_code: 'EUR', meta: { synthetic: true } });
  const app = express(); app.use(express.json());
  app.get('/synthetic-login', (_req, res) => { res.cookie('synthetic_session', 'owner', { sameSite: 'strict', httpOnly: true }); res.redirect('/'); });
  app.use('/api', (_req, res, next) => { if (_req.headers.cookie?.includes('synthetic_session=owner')) res.locals.communityPrincipal = { subject: 'browser-fictional-owner', workspace_id: 'browser-workspace', role: 'owner' }; next(); });
  app.use('/api', createCommunityAccountingRouter({ workspaceId: 'browser-workspace', getState: () => state,
    can: (principal, _permission) => principal.role === 'owner',
    persistAndActivate: (expected, next) => { assert.equal(expected, state); state = next; },
  }));
  app.get('/harness.js', (_req, res) => res.sendFile(join(runtime, 'harness.js')));
  app.get('/', (_req, res) => res.type('html').send('<!doctype html><html><body><div id="root"></div><script src="/harness.js"></script></body></html>'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const address = server.address(); const url = `http://127.0.0.1:${address.port}`;
  let browser;
  let page;
  let stage = 'launch';
  try {
    browser = await puppeteer.launch({ executablePath: browserPath, headless: true, timeout: 12000, userDataDir: join(runtime, 'isolated-edge-profile'), args: ['--no-first-run', '--disable-background-networking', '--disable-extensions'] });
    page = await browser.newPage();
    page.on('pageerror', error => console.log('BROWSER_PAGE_ERROR', error.message));
    stage = 'navigate';
    await page.goto(`${url}/synthetic-login`, { waitUntil: 'networkidle0' });
    stage = 'load form';
    await page.waitForSelector('select');
    stage = 'first allocation';
    await page.select('select', 'T1');
    const selects = await page.$$('select'); await selects[1].select('D1');
    await fill(page, 'input[aria-label="Transaction minor units"]', '-600');
    await fill(page, 'input[aria-label="Document minor units"]', '-600');
    await fill(page, 'input[aria-label="Evidence reference"]', 'BROWSER_SYNTHETIC_EVIDENCE');
    await clickButton(page, 'Save Create allocation');
    stage = 'first allocation reflected';
    await page.waitForFunction(() => document.body.innerText.includes('payment: T1'));
    await clickButton(page, 'Load report');
    stage = 'partial report';
    await page.waitForFunction(() => document.body.innerText.includes('partially_matched'));
    await page.screenshot({ path: join(evidence, 'accounting-partial.png'), fullPage: true });
    await page.select('select', 'T2');
    await fill(page, 'input[aria-label="Transaction minor units"]', '-400');
    await fill(page, 'input[aria-label="Document minor units"]', '-400');
    await clickButton(page, 'Save Create allocation');
    stage = 'second allocation reflected';
    await page.waitForFunction(() => document.body.innerText.includes('payment: T2'));
    await page.waitForFunction(() => document.body.innerText.includes('fully_matched'));
    await page.screenshot({ path: join(evidence, 'accounting-complete.png'), fullPage: true });
    await clickButton(page, 'Export CSV');
    await pause(500);
    assert.equal(state.accounting?.allocations.filter(a => a.status === 'accepted').length, 2);
    assert.equal(state.audit_events.filter(e => e.action === 'ACCOUNTING_ALLOCATED').length, 2);
    const screenshots = ['accounting-partial.png', 'accounting-complete.png'].map(name => ({ name, sha256: createHash('sha256').update(readFileSync(join(evidence, name))).digest('hex') }));
    assert.equal(screenshots.length, 2);
    console.log(JSON.stringify({ screenshots, allocations: 2, browser: browserPath, runtime_files: readdirSync(runtime).length }));
  } catch (error) {
    console.log('BROWSER_FAILED_STAGE', stage);
    if (page) { console.log('BROWSER_BODY', (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 1500)); await page.screenshot({ path: join(evidence, 'accounting-failure.png'), fullPage: true }).catch(() => {}); }
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
