import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync,readFileSync,existsSync,writeFileSync,readdirSync } from 'node:fs';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer-core';
import { createServer as createVite } from 'vite';
import { setTimeout as sleep } from 'node:timers/promises';
import { upCommunityPayments003 } from '../src/migrations/003-community-payments.ts';
import { CommunityPaymentService } from '../src/community/payments/service.ts';
import { createCommunityPaymentsRouter } from '../src/server/routes/community-payments.ts';
import { localFakeAdapters,LOCAL_FAKE_BANK_MARKER } from '../src/community/banking/mock.ts';
import { paymentText } from '../web/src/i18n/community-payments.ts';

const root=process.cwd();
const evidenceRoot=process.env.MATCHING_E2E_EVIDENCE_DIR||join(root,'..','worker-payments-browser-evidence');
const evidence=join(evidenceRoot,'run-'+Date.now());
const iban=bban=>{let rem=0;for(const digit of bban+'131400')rem=(rem*10+Number(digit))%97;return `DE${String(98-rem).padStart(2,'0')}${bban}`};
const principal={subject:'fictional-owner',workspace_id:'fictional-workspace',role:'owner',session_id:'fresh-synthetic-session',authenticated_at:'2026-10-14T06:00:00Z',reauthenticated_at:'2026-10-14T06:00:00Z',permissions:['finance:read','payments:prepare','payments:approve','payments:submit']};
const fixture={documentId:'fictional-document-1',invoiceId:'fictional-invoice-1',sourceHash:createHash('sha256').update('fictional-source-1').digest('hex'),confirmed:true,archived:false,rejected:false,totalMinor:12345,allocatedMinor:345,currency:'EUR',creditorName:'Fictional Supplier & Co',creditorIban:iban('000000001234567890'),reference:'FIC-2026-01',dueDate:'2026-11-01',matchIds:['partial-match-1']};
const html=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="community-csrf" content="trusted-csrf"><title>Isolated fictional payments</title></head><body><div id="root"></div><script type="module">
import React from 'react';import{createRoot}from'react-dom/client';import{LanguageProvider,useLanguage}from'/src/i18n/locale.tsx';import{CommunityPayments}from'/src/pages/CommunityPayments.tsx';
function View(){const{language,setLanguage}=useLanguage();return React.createElement(React.Fragment,null,React.createElement('label',null,'Language',React.createElement('select',{id:'language',value:language,onChange:e=>setLanguage(e.target.value)},React.createElement('option',{value:'en'},'English'),React.createElement('option',{value:'de'},'Deutsch'))),React.createElement(CommunityPayments))}createRoot(document.getElementById('root')).render(React.createElement(LanguageProvider,null,React.createElement(View)));
</script></body></html>`;
async function start(dbPath,fake){
  const db=new Database(dbPath);if(!db.prepare("SELECT name FROM sqlite_master WHERE name='community_payment_batches'").get())upCommunityPayments003(db);
  db.prepare('INSERT OR IGNORE INTO community_bank_connections(workspace_id,subject,provider,environment,account_ref,vault_ref,configured_at) VALUES (?,?,?,?,?,?,?)').run(principal.workspace_id,principal.subject,'local-fake-bank','mock','fictional-account','vault:fictional','2026-10-14T06:00:00Z');
  const service=new CommunityPaymentService({db,now:()=>new Date(),adapter:fake.payment,authorize:(p,permission)=>p.permissions.includes(permission),recentAuth:()=>true,csrf:(_p,token)=>token==='trusted-csrf',credentialResolver:{resolve:async()=>({fictional:true})},accounting:{loadState:()=>({}),persistAndActivate:()=>{},invoiceEvidence:()=>[fixture],confirmedReconciliation:(_s,_w,_b,id)=>id==='confirmed-fixture-match'}});
  const vite=await createVite({root:join(root,'web'),configFile:false,server:{middlewareMode:true},appType:'custom',logLevel:'silent'});
  const app=express();app.use(express.json());app.use((_req,res,next)=>{res.locals.communityPrincipal=principal;next()});app.use('/api/community-payments',createCommunityPaymentsRouter(service));app.use(vite.middlewares);
  app.get('/',async(_req,res)=>res.type('html').send(await vite.transformIndexHtml('/',html)));
  const server=app.listen(0,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));const address=server.address();
  return {db,service,vite,server,base:`http://127.0.0.1:${address.port}`,async stop(){
    // Close the test-owned HMR websocket before waiting for HTTP shutdown.
    // server.close() alone can otherwise wait for Vite's upgraded connection.
    await vite.close();
    const stopped=new Promise((ok,fail)=>server.close(err=>err?fail(err):ok()));
    server.closeAllConnections();
    await stopped;db.close();
  }};
}
async function click(page,label){const buttons=await page.$$('button');for(const button of buttons){if((await button.evaluate(el=>el.textContent||'')).trim()===label){await button.click();return}}throw new Error(`Button missing: ${label}`)}
async function waitStatus(page,status){await page.waitForFunction(s=>[...document.querySelectorAll('article p')].some(el=>el.textContent?.includes(`Status: ${s}`)||el.textContent?.includes(`Status: ${s}`)),{},status)}
test('real isolated browser creates payment XML, confirms fake submission and survives service restart',{timeout:120000},async()=>{
  mkdirSync(evidence,{recursive:true});const dbPath=join(evidence,'browser-payments.sqlite');
  const fake=localFakeAdapters(LOCAL_FAKE_BANK_MARKER);let running=await start(dbPath,fake),browser,page;
  const screenshots=[];let xmlResponse=null;const screenshot=async name=>{const path=join(evidence,name+'.png');await page.screenshot({path,fullPage:true});screenshots.push({name,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})};
  try{
    console.log('browser: launch');
    browser=await puppeteer.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true,userDataDir:join(evidence,'fresh-browser-profile-2'),defaultViewport:{width:1300,height:900},timeout:12000,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
    console.log('browser: launched');
    page=await browser.newPage();page.setDefaultTimeout(20000);
    const client=await page.target().createCDPSession();await client.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:evidence});
    await page.setRequestInterception(true);page.on('request',request=>{const u=new URL(request.url());if(u.origin===running.base||['blob:','data:','about:'].includes(u.protocol))request.continue();else request.abort()});
    console.log('browser: navigate',running.base);
    await page.goto(running.base,{waitUntil:'networkidle0'});console.log('browser: navigated');await page.waitForSelector('input[type=checkbox]');await screenshot('01-candidate');
    await page.click('input[type=checkbox]');await page.type('input[aria-label="Debtor name"]','Fictional Debtor');await page.type('input[aria-label="Debtor IBAN"]',iban('000000001234567891'));
    await click(page,'Create draft');await waitStatus(page,'draft');console.log('browser: draft');await click(page,'Validate');await waitStatus(page,'validated');await click(page,'Review');await waitStatus(page,'reviewed');await click(page,'Approve');await waitStatus(page,'approved');console.log('browser: approved');
    await click(page,'Download SEPA XML');let downloaded;for(let attempt=0;attempt<100;attempt++){downloaded=readdirSync(evidence).find(x=>x.startsWith('payment-')&&x.endsWith('.xml'));if(downloaded)break;await sleep(100)}assert.ok(downloaded,'actual browser XML download');const xml=readFileSync(join(evidence,downloaded),'utf8');const id=(await running.service.repo.list(principal.workspace_id))[0].id;const response=await fetch(`${running.base}/api/community-payments/batches/${id}/sepa`);xmlResponse={xml,hash:response.headers.get('x-content-sha256')};assert.ok(xml.includes('pain.001.001.09'));assert.equal(createHash('sha256').update(xml).digest('hex'),xmlResponse.hash);console.log('browser: xml downloaded');
    await screenshot('02-approved-xml');await click(page,'Confirm this exact payment');await page.waitForFunction(label=>[...document.querySelectorAll('button')].some(x=>x.textContent?.trim()===label),{},paymentText.en.submit);await click(page,paymentText.en.submit);await waitStatus(page,'acknowledged');assert.equal(fake.calls.submit,1);await screenshot('03-fake-bank-acknowledged');
    const before=running.service.repo.list(principal.workspace_id);assert.equal(before.length,1);await page.close();await running.stop();running=await start(dbPath,fake);page=await browser.newPage();page.setDefaultTimeout(20000);await page.setRequestInterception(true);page.on('request',request=>{const u=new URL(request.url());if(u.hostname==='127.0.0.1'||['blob:','data:','about:'].includes(u.protocol))request.continue();else request.abort()});await page.goto(running.base,{waitUntil:'domcontentloaded'});await page.waitForSelector('button');await click(page,before[0].id+' · acknowledged · 1');await waitStatus(page,'acknowledged');assert.equal(fake.calls.submit,1);await screenshot('04-persisted-restart');
    await page.select('#language','de');await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='Zahlungen');await screenshot('05-german');
    writeFileSync(join(evidence,'browser-results.json'),JSON.stringify({qualification:'MOCK_SOFTWARE_QUALIFIED',adapterSubmitCalls:fake.calls.submit,xmlSha256:xmlResponse.hash,dbPath,screenshots},null,2));
  }finally{if(browser)await browser.close();await running.stop()}
});
