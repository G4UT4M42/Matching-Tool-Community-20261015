import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import express from 'express';
import puppeteer from 'puppeteer-core';
import { createServer as createVite } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = process.env.MATCHING_E2E_EVIDENCE_DIR;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const validNode = process.versions.node.startsWith('22.');
if (!validNode) throw new Error('P06 browser requires the qualified isolated Node 22 runtime');

test('P06 real browser reviews a synthetic statement, confirms it, replays idempotently and switches locale', { timeout:120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'community-statement-browser-synthetic-'));
  const runtime = join(temp, 'runtime'), input = join(temp, 'fictional.csv');
  mkdirSync(runtime);
  writeFileSync(input,'Datum;Partnername;Betrag;Waehrung;Referenz;Verwendungszweck\n13.01.2026;Synthetic Supplier;-12,34;EUR;SYN-E2E-100;Fictional test data');
  process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root';
  process.env.MATCHING_RUNTIME_ROOT = runtime;
  let database, vite, server, browser, page;
  const captures = [], start = new Date().toISOString();
  try {
    const db = await import('../src/storage/db.ts');
    const json = await import('../src/storage/json-store.ts');
    const preview = await import('../src/server/routes/statement-preview.ts');
    database=db.getDb();
    let state=json.createEmptyState('SYNTHETIC_STANDALONE_BROWSER');
    json.saveState(state);
    const app=express();
    app.use('/api',express.json({limit:'8kb'}));
    app.use('/api',(_req,res,next)=>{
      // Isolated test harness ONLY: real application requires authenticated account and CSRF.
      res.locals.communityPrincipal={subject:'USR-SYNTHETIC',workspace_id:'WS-SYNTHETIC',session_id:'SES-SYNTHETIC'};
      next();
    });
    app.use('/api',preview.createStatementPreviewRouter(()=>state,value=>{state=value;}));
    vite=await createVite({root:join(root,'web'),configFile:false,server:{middlewareMode:true},appType:'custom',logLevel:'silent'});
    const html=`<!doctype html><html><head><meta charset="UTF-8"/><title>Synthetic Statement Review</title></head>
<body><div id="root"></div><script type="module">
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CommunityStatementReview} from '/src/pages/CommunityStatementReview.tsx';
function View(){const [locale,setLocale]=useState('en');return React.createElement(React.Fragment,null,
React.createElement('label',null,'Language',React.createElement('select',{id:'language',value:locale,onChange:e=>setLocale(e.target.value)},React.createElement('option',{value:'en'},'English'),React.createElement('option',{value:'de'},'Deutsch'))),
React.createElement(CommunityStatementReview,{locale,request:(url,init)=>fetch(url,init)}))}
createRoot(document.getElementById('root')).render(React.createElement(View));
</script></body></html>`;
    app.use(vite.middlewares);
    app.get('*',async(req,res,next)=>{try{res.type('html').send(await vite.transformIndexHtml('/',html));}catch(e){next(e);}});
    server=app.listen(0,'127.0.0.1');
    await new Promise(ok=>server.once('listening',ok));
    const address=server.address();
    assert.ok(address&&typeof address!=='string');
    const origin=`http://127.0.0.1:${address.port}`;
    const browsers=[process.env.MATCHING_TEST_BROWSER,'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
    const executablePath=browsers.find(x=>existsSync(x));
    assert.ok(executablePath,'An installed Chromium-based browser is needed for this acceptance test');
    browser=await puppeteer.launch({executablePath,headless:true,userDataDir:join(temp,'fresh-browser-profile'),defaultViewport:{width:1280,height:860},
      timeout:15000,args:['--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check']});
    page=await browser.newPage();
    page.setDefaultTimeout(15000);
    const failedRequests=[];
    await page.setRequestInterception(true);
    page.on('request',request=>{const url=new URL(request.url());if(url.origin===origin||['data:','blob:','about:'].includes(url.protocol))request.continue();else {failedRequests.push(url.origin);request.abort();}});
    const screenshotsDir=evidenceRoot?resolve(evidenceRoot):join(temp,'evidence');
    mkdirSync(screenshotsDir,{recursive:true});
    const screenshot=async name=>{const path=join(screenshotsDir,name+'.png');await page.screenshot({path,fullPage:true});captures.push({name,sha256:sha(readFileSync(path))})};
    const clicks=async label=>{await page.evaluate(label=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===label);if(!button)throw Error('Missing button: '+label);button.click();},label);};
    await page.goto(origin,{waitUntil:'networkidle2'});
    await page.waitForSelector('input[type=file]');
    await page.type('input[aria-label="Local account identifier"]','SYN-ACCOUNT');
    const fileInput=await page.$('input[type=file]');
    await fileInput.uploadFile(input);
    await screenshot('01-file-selected');
    await clicks('Preview statement');
    await page.waitForFunction(()=>document.body.textContent?.includes('SYN-E2E-100'));
    assert.equal((database.prepare('SELECT count(*) AS n FROM transactions').get()).n,0);
    await screenshot('02-reviewed-no-write');
    await page.select('#language','de');
    await page.waitForFunction(()=>document.body.textContent?.includes('Import bestätigen'));
    await screenshot('03-review-german');
    await clicks('Import bestätigen');
    await page.waitForFunction(()=>document.body.textContent?.includes('Neue Buchungen: 1'));
    assert.equal((database.prepare('SELECT count(*) AS n FROM transactions').get()).n,1);
    assert.equal(state.transactions.size,1);
    assert.equal(json.loadState().transactions.size,1);
    await screenshot('04-committed-with-audit');
    await page.reload({waitUntil:'networkidle2'});
    await page.waitForSelector('input[type=file]');
    await page.type('input[aria-label="Local account identifier"]','SYN-ACCOUNT');
    await (await page.$('input[type=file]')).uploadFile(input);
    await clicks('Preview statement');
    await page.waitForFunction(()=>document.body.textContent?.includes('SYN-E2E-100'));
    await clicks('Confirm import');
    await page.waitForFunction(()=>document.body.textContent?.includes('Already present: 1'));
    assert.equal((database.prepare('SELECT count(*) AS n FROM transactions').get()).n,1);
    assert.equal((database.prepare('SELECT count(*) AS n FROM audit_events').get()).n,2);
    assert.deepEqual(failedRequests,[]);
    await screenshot('05-repeat-idempotent');
    await page.reload({waitUntil:'networkidle2'});
    await page.waitForSelector('input[type=file]');
    await page.type('input[aria-label="Local account identifier"]','SYN-ACCOUNT');
    await (await page.$('input[type=file]')).uploadFile(input);
    await clicks('Preview statement');
    await page.waitForFunction(()=>document.body.textContent?.includes('SYN-E2E-100'));
    await clicks('Discard preview');
    await page.waitForFunction(()=>![...document.querySelectorAll('button')].some(button=>button.textContent?.includes('Discard preview')));
    assert.equal((database.prepare('SELECT count(*) AS n FROM transactions').get()).n,1);
    await screenshot('06-discarded-without-write');
    if(evidenceRoot) writeFileSync(join(screenshotsDir,'statement-browser-result.json'),JSON.stringify({result:'PASS',mode:'standalone-synthetic-mock-auth',
      first_import:1,replay_import:0,existing:1,external_requests:failedRequests, screenshots:captures,
      started:start,finished:new Date().toISOString(),full_app_wired:false},null,2));
  } finally {
    if(browser) await browser.close();
    if(server) await new Promise(ok=>server.close(ok));
    if(vite) await vite.close();
    if(database) (await import('../src/storage/db.ts')).closeDb();
    delete process.env.MATCHING_RUNTIME_MODE;delete process.env.MATCHING_RUNTIME_ROOT;
    rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
