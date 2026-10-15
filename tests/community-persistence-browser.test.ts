import express from 'express';
import Database from 'better-sqlite3';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCommunityPersistenceRouter } from '../src/server/routes/community-persistence.js';
import type { Browser } from 'puppeteer-core';
import type { Server } from 'node:http';

let root: string, server: Server | undefined, browser: Browser | undefined, vite: Awaited<ReturnType<typeof createServer>> | undefined;
let closeDb: (() => void) | undefined, openDb: (() => Database.Database) | undefined;
async function harness() {
  root = mkdtempSync(join(tmpdir(), 'community-browser-'));
  process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root'; process.env.MATCHING_RUNTIME_ROOT = root;
  vi.resetModules(); const store = await import('../src/storage/db.js'); closeDb = store.closeDb; openDb = store.getDb; store.getDb();
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state', 'state.json'), JSON.stringify({ schema_version: 1, format: 'matching-community-state-v1', run_id: 'BROWSER-SYNTHETIC', transactions: {}, documents: {}, match_groups: {}, exclusion_rules: [], audit_events: [], matched_transaction_ids: [], matched_document_ids: [], excluded_transaction_ids: [] }));
  const app = express(); app.use(express.json());
  app.use('/api/community/persistence', (request, response, next) => { response.locals.communityPrincipal = { subject: 'browser-owner' }; next(); }, createCommunityPersistenceRouter({
    activeRuntimeRoot: () => root, withExclusiveAccess: run => run(), may: principal => principal.subject === 'browser-owner', inspectCurrent: () => ({}), invalidateCheckpoint: () => {},
    safeActivate: async (change, rollback) => { closeDb?.(); try { change(); openDb?.(); } catch (error) { rollback(); openDb?.(); throw error; } },
  }));
  const web = resolve(import.meta.dirname, '..', 'web');
  vite = await createServer({ configFile: false, root: web, cacheDir: join(root, 'vite-cache'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  app.get('/persistence-test', async (request, response) => {
    const html = `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {LanguageProvider} from '/src/i18n/locale.tsx';
      import {CommunityDataManagement} from '/src/pages/CommunityDataManagement.tsx';
      createRoot(document.getElementById('root')).render(React.createElement(LanguageProvider,null,React.createElement(CommunityDataManagement)));
    </script></body></html>`;
    response.type('html').send(await vite!.transformIndexHtml(request.url, html));
  });
  app.use(vite.middlewares);
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server!.once('listening', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Browser harness failed');
  return `http://127.0.0.1:${address.port}/persistence-test`;
}
afterEach(async () => {
  await browser?.close(); browser = undefined;
  if (server) await new Promise<void>(done => server!.close(() => done())); server = undefined;
  await vite?.close(); vite = undefined;
  closeDb?.(); closeDb = undefined; openDb = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  delete process.env.MATCHING_RUNTIME_MODE; delete process.env.MATCHING_RUNTIME_ROOT; vi.resetModules();
});
describe('real browser data management', () => {
  it('creates, downloads, stages and activates a generated backup', async () => {
    const url = await harness();
    browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, userDataDir: join(root, 'browser-profile'), args: ['--no-first-run','--disable-background-networking'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    const browserErrors: string[] = [];
    page.on('pageerror', error => browserErrors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try { await page.waitForSelector('h1', { timeout: 8000 }); }
    catch { throw new Error(`React did not mount: ${browserErrors.join(' | ')}; HTML: ${(await page.content()).slice(0, 1000)}`); }
    expect(await page.$eval('h1', element => element.textContent)).toBe('Data management');
    console.log('browser: mounted');
    await page.$$eval('button', buttons => buttons.find(button => button.textContent === 'Create backup')?.click());
    await page.waitForSelector('li');
    console.log('browser: backup created');
    const backups = await import('../src/community/persistence/backup.js');
    const list = backups.listCommunityBackups(root); expect(list.length).toBe(1);
    const id = list[0]!.id;
    const download = await page.waitForSelector('button');
    expect(download).not.toBeNull();
    const input = await page.$('input[type=file]'); if (!input) throw new Error('Restore upload missing');
    await input.uploadFile(join(root, 'backups', id + '.zip'));
    await page.$$eval('button', buttons => buttons.find(button => button.textContent === 'Stage and verify')?.click());
    await page.waitForSelector('[aria-label="Backup verified. Review the financial summary before activation."]');
    console.log('browser: restore staged');
    await page.$$eval('button', buttons => buttons.find(button => button.textContent === 'Activate verified backup')?.click());
    await page.waitForSelector('[role=status]');
    console.log('browser: restore activated');
    const evidence = '<external-audit-root>/Matching-Community-E2E-20261014-045708\\worker-persistence';
    if (existsSync(evidence)) await page.screenshot({ path: join(evidence, 'community-persistence-browser.png'), fullPage: true });
    expect(readFileSync(join(root, 'state', 'state.json'), 'utf8')).toContain('BROWSER-SYNTHETIC');
  }, 60000);
});
