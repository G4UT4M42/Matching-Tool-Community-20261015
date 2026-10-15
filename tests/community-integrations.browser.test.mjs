import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash,randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'web', 'src');
const importPath = file => file.replaceAll('\\', '/');
test('real browser integration management with simulated provider responses', { timeout: 90000 }, async () => {
  const executablePath = process.env.MATCHING_TEST_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const work = await mkdtemp(path.join(tmpdir(), 'community-integration-browser-synthetic-'));
  const evidence = process.env.MATCHING_E2E_EVIDENCE_DIR || path.join(work, 'evidence');
  await mkdir(evidence, {recursive:true});
  let browser, server;
  const state = {configured:false, lastSuccess:null, lastError:null};
  const actions = [];
  const history=[],pageErrors=[];let tests=0;
  const fixtureSubject='USR-'+randomUUID(),fixtureWorkspace='WS-'+randomUUID();
  try {
    const entry = path.join(work, 'entry.tsx'), bundle = path.join(work, 'bundle.js');
    await writeFile(entry, `import React from 'react';
import { createRoot } from 'react-dom/client';
import { CommunityIntegrations } from '${importPath(path.join(source,'pages','CommunityIntegrations.tsx'))}';
import { LanguageProvider, useLanguage } from '${importPath(path.join(source,'i18n','locale.tsx'))}';
function Controls() { const {setLanguage} = useLanguage(); return <><button id="de" onClick={() => setLanguage('de')}>Deutsch</button><CommunityIntegrations /></>; }
createRoot(document.getElementById('root')!).render(<LanguageProvider><Controls /></LanguageProvider>);`);
    await build({entryPoints:[entry], bundle:true, outfile:bundle, platform:'browser', format:'iife', jsx:'automatic', nodePaths:[path.join(root,'web','node_modules')], logLevel:'silent'});
    console.log('browser stage: bundled');
    server = createServer(async (req,res) => {
      if (req.url === '/') { res.writeHead(200,{'Content-Type':'text/html'}); res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      if (req.url === '/bundle.js') { res.writeHead(200,{'Content-Type':'application/javascript'}); res.end(await readFile(bundle)); return; }
      if (req.url?.startsWith('/api/community/integrations/')) {
        const body = [];
        for await (const chunk of req) body.push(chunk);
        const parts=req.url.split('/'),provider=parts[4],environment=parts[5];let operation,failed=false;
        if (req.method === 'PUT') { const input = JSON.parse(Buffer.concat(body).toString()); assert.equal(typeof input.credentials.clientSecret, 'string'); state.configured = true;operation='configure'; }
        if (req.method === 'POST' && req.url.endsWith('/test')) {operation='test';failed=++tests===1;state.lastError=failed?'INTEGRATION_FAILED':null;}
        if (req.method === 'POST' && req.url.endsWith('/sync')) { state.lastSuccess = '2026-10-14T00:00:00Z';state.lastError=null;operation='sync'; }
        if (req.method === 'DELETE') { state.configured = false; state.lastSuccess = null;operation='disconnect'; }
        if(operation){actions.push(operation);const operation_id=randomUUID(),scope={subject:fixtureSubject,workspace_id:fixtureWorkspace,provider,environment,operation_id,operation};history.push({...scope,id:randomUUID(),occurred_at:new Date().toISOString(),phase:'started',outcome:'started'},{...scope,id:randomUUID(),occurred_at:new Date().toISOString(),phase:'completed',outcome:failed?'failed':'succeeded',...(failed?{code:'INTEGRATION_FAILED'}:{}),...(operation==='sync'?{imported:2}:{})});}
        res.writeHead(failed?502:200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify(req.method === 'GET' ? req.url.endsWith('/history')?{items:history.filter(row=>row.provider===provider&&row.environment===environment).slice().reverse()}:{...state,provider,environment} : failed?{code:'INTEGRATION_FAILED'}:{ok:true})); return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    console.log('browser stage: server listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({executablePath, headless:true, userDataDir:path.join(work,'profile'), defaultViewport:{width:1200,height:900}, timeout:10000, args:['--no-first-run','--no-default-browser-check','--disable-gpu','--in-process-gpu','--disable-gpu-sandbox','--disable-software-rasterizer']});
    console.log('browser stage: launched');
    const page = await browser.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => {pageErrors.push(error.message);console.log('browser page error:',error.message);});
    await page.goto(`http://127.0.0.1:${address.port}/`);
    console.log('browser stage: navigated');
    await page.waitForSelector('#integration-client-secret');
    await page.type('#integration-client-id','synthetic-client');
    await page.type('#integration-client-secret','synthetic-secret');
    await page.click('button[type=submit]');
    await page.waitForFunction(() => document.querySelector('[data-testid=integration-status]')?.textContent?.includes('Configured'));
    assert.equal(await page.$eval('#integration-client-secret', element => element.value), '');
    await page.screenshot({path:path.join(evidence,'integration-configured.png'),fullPage:true});
    const click = async label => { await page.evaluate(text => { const button = [...document.querySelectorAll('button')].find(x => x.textContent === text); if (!button) throw new Error('Missing button '+text); button.click(); }, label); };
    await click('Test connection');await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent?.includes('INTEGRATION_FAILED'));
    await page.waitForSelector('[data-testid=integration-history] [data-outcome=failed]');
    await click('Test connection'); await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('Operation completed'));
    await page.waitForSelector('[data-testid=integration-history] [data-outcome=failed]');
    await click('Synchronize'); await page.waitForFunction(() => document.body.textContent.includes('2026-10-14T00:00:00Z'));
    await page.click('#de'); await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Integrationen');
    await page.waitForFunction(()=>document.querySelector('[data-testid=integration-history]')?.textContent?.includes('Fehlgeschlagen'));
    await page.screenshot({path:path.join(evidence,'integration-german.png'),fullPage:true});
    await click('Trennen'); await page.waitForFunction(() => document.querySelector('[data-testid=integration-status]')?.textContent?.includes('Nicht konfiguriert'));
    await page.waitForSelector('[data-testid=integration-history] [data-operation=disconnect][data-outcome=succeeded]');
    assert.deepEqual(actions,['configure','test','test','sync','disconnect']);assert.deepEqual(pageErrors,[]);
    assert.equal(await page.$$eval('[data-testid=integration-history] tr',rows=>rows.length),10);
    assert.equal(await page.$$eval('[data-testid=integration-history] [data-outcome=failed]',rows=>rows.length),1);
    assert.equal(await page.$eval('[data-testid=integration-history] [data-operation=sync][data-outcome=succeeded] td:last-child',node=>node.textContent),'2');
    const files = ['integration-configured.png','integration-german.png'];
    for (const filename of files) assert.equal((await readFile(path.join(evidence,filename))).includes(Buffer.from('synthetic-secret')), false);
    const manifest = await Promise.all(files.map(async filename => ({filename,sha256:createHash('sha256').update(await readFile(path.join(evidence,filename))).digest('hex')})));
    await writeFile(path.join(evidence,'integration-browser-manifest.json'),JSON.stringify({simulatedProvider:true,actions,historyEntries:history.length,failedOutcomes:1,imported:2,pageErrors,files:manifest},null,2));
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(work,{recursive:true,force:true});
  }
});
