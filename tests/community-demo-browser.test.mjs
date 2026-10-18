import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer-core';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function port(){const socket=createServer();await new Promise((ok,fail)=>socket.once('error',fail).listen(0,'127.0.0.1',ok));const value=socket.address().port;await new Promise(ok=>socket.close(ok));return value;}
async function boot(runtime,token){
 const value=await port(),env={...process.env,PORT:String(value),MATCHING_RUNTIME_MODE:'external-runtime-root',MATCHING_RUNTIME_ROOT:runtime,MATCHING_AUTH_MODE:'synthetic-preview',MATCHING_DEMO_MODE:'true',MATCHING_LOCAL_ACCESS_TOKEN:token,MATCHING_HTTP_HOST:'127.0.0.1',MATCHING_ENABLE_BANK_AUTOMATION:'false'};
 const child=spawn(process.execPath,['--import','tsx','src/server/index.ts'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log=(log+chunk).slice(-8192);});
 const result={child,origin:`http://127.0.0.1:${value}`};
 for(let i=0;i<120;i++){if(child.exitCode!==null)throw Error('Owned demo server exited: '+log.replaceAll(token,'[REDACTED]'));try{const r=await fetch(result.origin+'/api/community/session',{signal:AbortSignal.timeout(500)});if(r.status===401)return result;}catch{}await pause(100);}
 await stop(result);throw Error('Owned demo server was not ready');
}
async function stop(server){if(!server||server.child.exitCode!==null||server.child.signalCode!==null)return;const ended=new Promise(ok=>server.child.once('exit',ok));if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(server.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});else server.child.kill('SIGTERM');await Promise.race([ended,pause(10000)]);assert.ok(server.child.exitCode!==null||server.child.signalCode!==null,'Owned demo server closed');}
function ledger(runtime){const db=new Database(join(runtime,'database','matching.db'),{readonly:true,fileMustExist:true});try{return Object.fromEntries(['transactions','documents','community_canonical_state','community_payment_batches','community_payment_items','community_payment_events','community_payment_confirmations','community_payment_callbacks','community_bank_connections'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));}finally{db.close();}}
const routes=[['/','Accounts','Konten'],['/rechnungen','Invoices','Rechnungen'],['/einkuenfte','Income','Einkünfte'],['/belegerkennung','Document recognition','Belegerkennung'],['/integrations','Provider samples','Anbieterbeispiele'],['/invoice-bot','Provider samples','Anbieterbeispiele'],['/reports','Canonical reports','Kanonische Berichte'],['/vat-report','VAT report','Umsatzsteuerbericht'],['/einkommensteuer','Income and expense classifications','Einnahmen- und Ausgabenklassifikation'],['/payments','Local payment draft','Lokaler Zahlungsentwurf'],['/settings','Local preferences','Lokale Einstellungen'],['/import','Account samples','Kontobeispiele'],['/manual-match','Manual match','Manuelle Zuordnung'],['/exclusions','Exclusion rules','Ausschlussregeln'],['/audit','Audit trail','Audit-Verlauf'],['/review','Review queue','Prüfliste'],['/matches','Matching decisions','Zuordnungsentscheidungen'],['/matching','Matching centre','Matching-Zentrale']];

test('real protected demo renders actual records in English and German at desktop/mobile widths without provider authority or financial mutation',{timeout:240000},async()=>{
 const temporary=mkdtempSync(join(tmpdir(),'matching-demo-browser-synthetic-')),runtime=join(temporary,'runtime');mkdirSync(runtime);
 const evidence=process.env.MATCHING_DEMO_BROWSER_EVIDENCE_DIR?resolve(process.env.MATCHING_DEMO_BROWSER_EVIDENCE_DIR):process.env.MATCHING_MAIN_BROWSER_EVIDENCE_DIR?join(resolve(process.env.MATCHING_MAIN_BROWSER_EVIDENCE_DIR),'demo-normal-app'):join(temporary,'evidence');mkdirSync(evidence,{recursive:true});
 const token=randomBytes(32).toString('base64url'),headers={'x-community-access-token':token};let server,browser,page;const screenshots=[],pageErrors=[],consoleErrors=[],httpErrors=[],external=[],requests=[];
 try{
  server=await boot(runtime,token);const get=async()=>{const r=await fetch(server.origin+'/api/community/demo',{headers});assert.equal(r.status,200);return r.json();};
  const before=await get(),jsonBefore=readFileSync(join(runtime,'state','state.json')),sqlBefore=ledger(runtime);
  assert.equal(before.transactions.length,17);assert.equal(before.documents.length,13);assert.equal(before.accounts.length,6);assert.equal(before.payments.length,1);assert.equal(before.payments[0].status,'draft');
  assert.deepEqual(before.reports.accounting.totals_by_currency,{EUR:{expense:-30950,refund:-2950,income:75200,fee:-2940,private:-2000,transfer:0},USD:{income:5000}});
  assert.deepEqual(before.payments[0].items.map(i=>[i.documentId,i.amountMinor]).sort(),[['DEMO-DOC-007',6000],['DEMO-DOC-009',3600]]);
  const executablePath=[process.env.MATCHING_TEST_BROWSER,'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);assert.ok(executablePath,'Installed browser required');
  browser=await puppeteer.launch({executablePath,headless:true,userDataDir:join(temporary,'fresh-browser'),defaultViewport:{width:1400,height:950},args:['--no-first-run','--no-default-browser-check','--disable-gpu']});
  page=await browser.newPage();page.setDefaultTimeout(15000);await page.setRequestInterception(true);
  page.on('request',r=>{const u=new URL(r.url());if(u.origin===server.origin||['data:','blob:','about:'].includes(u.protocol)){if(u.pathname.startsWith('/api/'))requests.push({method:r.method(),path:u.pathname});void r.continue();}else{external.push(u.origin+u.pathname);void r.abort();}});
  page.on('pageerror',e=>pageErrors.push(e.message));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});page.on('response',r=>{if(r.status()>=400)httpErrors.push({status:r.status(),path:new URL(r.url()).pathname});});
  await page.goto(server.origin,{waitUntil:'domcontentloaded'});await page.waitForSelector('#local-access-token');assert.equal(await page.$eval('#access-language',e=>e.value),'en');await page.type('#local-access-token',token);await page.click('button[type="submit"]');await page.waitForSelector('#community-language');
  // The unauthenticated access check occurs before the owner enters the token.
  httpErrors.length=0;consoleErrors.length=0;requests.length=0;
  for(const width of [1400,390]){await page.setViewport({width,height:950});for(const language of ['en','de']){await page.select('#community-language',language);await page.waitForFunction(value=>document.documentElement.lang===value,{},language);for(const [route,en,de]of routes){
   await page.goto(server.origin+route,{waitUntil:'networkidle0'});await page.waitForSelector('main h1');const expected=language==='en'?en:de;await page.waitForFunction(title=>document.querySelector('main h1')?.textContent?.trim()===title,{},expected);
   if(route==='/matching'){const label=language==='en'?'Run matching rules':'Matching-Regeln ausführen';assert.equal(await page.$$eval('main button',(buttons,label)=>buttons.find(b=>b.textContent?.trim()===label)?.disabled,label),true,'Unreviewed demo automation is visibly disabled');}
   if(route==='/'||route==='/exclusions'){const unnamed=await page.$$eval('main select',els=>els.filter(e=>!e.getAttribute('aria-label')?.trim()&&!e.getAttribute('aria-labelledby')&&!e.labels?.length).map(e=>e.outerHTML));assert.deepEqual(unnamed,[],'Select controls have accessible names');}
   const alert=await page.$$eval('main [role="alert"]',els=>els.map(e=>e.textContent));assert.deepEqual(alert,[],`${route} has no failed demo API view`);
   if(['/integrations','/invoice-bot','/import'].includes(route)){assert.equal(await page.$$eval('[data-testid="demo-provider-samples"] tbody tr',x=>x.length),17);assert.equal(await page.$$eval('[data-testid="demo-accounts"] tbody tr',x=>x.length),6);}
   if(route==='/payments'){assert.equal(await page.$$eval('[data-testid="demo-payment-draft"]',x=>x.length),1);const values=await page.$$eval('[data-testid="demo-payment-draft"] tbody tr',rows=>rows.map(row=>[...row.querySelectorAll('td')].map(e=>e.textContent)));assert.deepEqual(values.map(row=>[row[0],row[3].replace(/[,.]/g,'')]).sort(),[['DEMO-DOC-007','6000'],['DEMO-DOC-009','3600']]);assert.equal(await page.$$eval('[data-demo-view="payments"] input, [data-demo-view="payments"] button:not([disabled])',els=>els.filter(e=>e.tagName==='INPUT'||!['Refresh demo records','Demodatensätze aktualisieren','Tips','Tipps'].includes(e.textContent?.trim()??'')).length),0);}
   if(route==='/vat-report'){const values=await page.$$eval('[data-testid="demo-vat"] tbody tr',rows=>rows.map(row=>[...row.querySelectorAll('td')].map(e=>e.textContent)));assert.deepEqual(values.map(row=>row.map(x=>x.replace(/[,.]/g,''))),[['EUR','11200','-2150','0'],['USD','0','0','0']]);}
   const name=`demo-${width}-${language}-${route==='/'?'transactions':route.slice(1)}.png`,path=join(evidence,name);await page.screenshot({path,fullPage:true});screenshots.push({route,width,language,title:expected,file:name,sha256:sha(readFileSync(path))});
  }}}
  await page.select('#community-language','en');await page.goto(server.origin+'/manual-match',{waitUntil:'networkidle0'});
  await page.type('input[aria-label="Search transactions..."]','Fictional');await page.type('input[aria-label="Search documents..."]','Unpaid');
  const searchButtons=await page.$$('main button');const searches=[];for(const b of searchButtons)if((await b.evaluate(e=>e.textContent?.trim()))==='Search')searches.push(b);assert.equal(searches.length,2);await searches[0].click();await searches[1].click();
  for(const kind of ['transaction','document']){const selector=`[data-demo-selection="${kind}"]`;await page.waitForSelector(selector);await page.focus(selector);await page.keyboard.press('Space');await page.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-pressed')==='true',{},selector);await page.keyboard.press('Enter');await page.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-pressed')==='false',{},selector);}
  assert.equal(await page.$$eval('main a[href^="/api/files/"]',els=>els.length),0,'Synthetic references are inert, not failed file links');
  assert.deepEqual(pageErrors,[]);assert.deepEqual(consoleErrors,[]);assert.deepEqual(httpErrors,[]);assert.deepEqual(external,[]);assert.ok(requests.length>0);assert.ok(requests.every(r=>r.method==='GET'),'Browsing does not write or submit');
  for(const [method,path]of [['POST','/api/community-payments/batches'],['POST','/api/community-banking/application'],['POST','/api/invoice-bot/browser/start'],['GET','/api/settings']]){const r=await fetch(server.origin+path,{method,headers:{...headers,'content-type':'application/json'},...(method==='GET'?{}:{body:'{}'})});assert.equal(r.status,403);}
  assert.deepEqual(await get(),before);assert.deepEqual(ledger(runtime),sqlBefore);assert.deepEqual(readFileSync(join(runtime,'state','state.json')),jsonBefore);
  await browser.close();browser=undefined;await stop(server);server=await boot(runtime,token);assert.deepEqual(await get(),before);assert.deepEqual(ledger(runtime),sqlBefore);assert.deepEqual(readFileSync(join(runtime,'state','state.json')),jsonBefore);
  writeFileSync(join(evidence,'demo-browser-results.json'),JSON.stringify({result:'PASS',mode:'synthetic-preview',network_enabled:false,routes:routes.length,viewports:[1400,390],languages:['en','de'],screenshots,transactions:17,documents:13,payment_drafts:1,payment_events:sqlBefore.community_payment_events.length,authority_denials:4,read_only_requests:requests.length,pageErrors,consoleErrors,httpErrors,external,canonical_json_sha256:sha(jsonBefore),restart_exact:true,keyboard_record_selection:true,named_selects:true},null,2));
 }catch(error){if(page&&!page.isClosed())await page.screenshot({path:join(evidence,'failure.png'),fullPage:true}).catch(()=>{});writeFileSync(join(evidence,'failure.json'),JSON.stringify({message:String(error),pageErrors,consoleErrors,httpErrors,external,screenshots},null,2));throw error;}
 finally{if(browser)await browser.close();await stop(server);const resolved=resolve(temporary);assert.equal(dirname(resolved),resolve(tmpdir()));assert.ok(resolved.startsWith(join(resolve(tmpdir()),'matching-demo-browser-synthetic-')));rmSync(resolved,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
