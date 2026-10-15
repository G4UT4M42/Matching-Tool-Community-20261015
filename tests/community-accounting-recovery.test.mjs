import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';

test('accounting UI retains rejected drafts, serializes saves and distinguishes confirmed writes from refresh failures',{timeout:60000},async()=>{
 const evidence=process.env.COMMUNITY_ACCOUNTING_RECOVERY_EVIDENCE;
 if(evidence)mkdirSync(resolve(evidence),{recursive:true});
 const out=mkdtempSync(join(evidence?resolve(evidence):tmpdir(),'community-accounting-recovery-'));
 await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{CommunityAccounting}from'./web/src/pages/CommunityAccounting.tsx';createRoot(document.getElementById('root')).render(React.createElement(CommunityAccounting,{locale:'en'}));`,resolveDir:resolve('.'),sourcefile:'synthetic-recovery.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',outfile:join(out,'harness.js'),alias:{react:resolve('web/node_modules/react'),'react-dom/client':resolve('web/node_modules/react-dom/client')},logLevel:'silent'});
 let mode='stale',revision=0,reads=0,release;
 const requests=[],observations=[],app=express();app.use(express.json());
 const snapshot=()=>({revision,transactions:[{transaction_id:'SYN-T1',amount_minor:-600,currency_code:'EUR'},{transaction_id:'SYN-T2',amount_minor:-400,currency_code:'EUR'}],documents:[{document_id:'SYN-D1',total_amount_minor:1000,currency_code:'EUR'}],allocations:[],match_groups:[],exclusion_rules:[]});
 app.get('/api/accounting',(_req,res)=>{reads++;if(mode==='refresh-failure'&&requests.length){res.status(503).json({code:'WORKSPACE_BUSY',error:'Synthetic refresh failure'});return;}res.json(snapshot());});
 app.get('/api/accounting/reports',(_req,res)=>res.json({rows:[],documents:[],totals_by_currency:{},vat_by_currency:{}}));
 app.post('/api/accounting/allocations',async(req,res)=>{
  requests.push(req.body);
  if(mode==='stale'){revision=7;res.status(409).json({code:'STALE_REVISION',error:'Synthetic stale revision'});return;}
  if(mode==='invalid'){res.status(400).json({code:'INVALID_REQUEST',error:'Synthetic invalid allocation'});return;}
  if(mode==='delay')await new Promise(ok=>{release=ok;});
  revision++;res.json({revision,audit_id:'SYN-AUDIT'});
 });
 app.get('/harness.js',(_req,res)=>res.sendFile(join(out,'harness.js')));
 app.get('/',(_req,res)=>res.type('html').send('<!doctype html><html><body><div id="root"></div><script src="/harness.js"></script></body></html>'));
 const server=app.listen(0,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));let browser;
 try{
  const executablePath=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);assert.ok(executablePath,'An isolated Chromium executable is required');
  browser=await puppeteer.launch({executablePath,headless:true,userDataDir:join(out,'synthetic-browser'),args:['--no-first-run','--disable-background-networking','--disable-extensions']});const page=await browser.newPage();page.setDefaultTimeout(10000);
  const fill=async(selector,value)=>{await page.click(selector);await page.keyboard.down('Control');await page.keyboard.press('A');await page.keyboard.up('Control');await page.type(selector,value);};
  const click=text=>page.evaluate(text=>{const button=[...document.querySelectorAll('button')].find(node=>node.textContent===text);assertButton(button);function assertButton(button){if(!button||button.disabled||button.closest('fieldset')?.disabled)throw Error('Synthetic action unavailable');button.click();}},text);
  const pending=()=>page.evaluate(()=>document.body.innerText.includes('1 pending legs'));
  async function prepare(next){mode=next;requests.length=0;reads=0;revision=0;await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle0'});await page.waitForSelector('#accounting-transactionId option[value="SYN-T1"]');await page.select('#accounting-transactionId','SYN-T1');await page.select('#accounting-documentId','SYN-D1');await fill('#accounting-amount','-600');await fill('#accounting-documentAmount','600');await fill('#accounting-evidence','SYNTHETIC-EVIDENCE');await click('Add leg');await page.waitForFunction(()=>document.body.innerText.includes('1 pending legs'));await page.select('#accounting-transactionId','SYN-T2');await fill('#accounting-amount','-400');await fill('#accounting-documentAmount','400');}
  await prepare('stale');await click('Save Create allocation');await page.waitForSelector('[role="alert"]');await page.waitForFunction(()=>!document.querySelector('fieldset').disabled);assert.equal(await pending(),true);assert.equal(reads,2,'A stale response refreshes the source snapshot');assert.equal(requests[0].revision,0);mode='invalid';await click('Save Create allocation');await page.waitForFunction(()=>document.querySelector('[role="alert"]')?.textContent.includes('invalid allocation'));assert.equal(requests[1].revision,7);assert.equal(await pending(),true);observations.push('stale-and-invalid-retain-draft-and-use-refreshed-revision');
  await prepare('delay');await page.evaluate(()=>{const button=[...document.querySelectorAll('button')].find(n=>n.textContent==='Save Create allocation');button.click();button.click();});await page.waitForFunction(()=>document.querySelector('fieldset').disabled);assert.equal(requests.length,1);assert.equal(await pending(),true);release();await page.waitForFunction(()=>!document.querySelector('fieldset').disabled);assert.equal(requests.length,1);assert.equal(await pending(),false);assert.equal(await page.$eval('#accounting-amount',n=>n.value),'');observations.push('double-submit-serialized-and-confirmed-draft-cleared');
  await prepare('refresh-failure');await click('Save Create allocation');await page.waitForFunction(()=>document.querySelector('[role="alert"]')?.textContent.includes('change was saved'));assert.equal(await pending(),false);assert.equal(requests.length,1);assert.equal(await page.$eval('button',()=>[...document.querySelectorAll('button')].find(n=>n.textContent==='Save Create allocation').disabled),true);mode='invalid';await click('Refresh');await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(n=>n.textContent==='Save Create allocation').disabled);assert.equal(requests.length,1,'Refreshing never replays a mutation');observations.push('confirmed-write-refresh-failure-does-not-retain-or-replay-saved-draft');
  writeFileSync(join(out,'observations.json'),JSON.stringify({result:'PASS',scope:'Actual React component with controlled synthetic HTTP failures; no product persistence acceptance inferred',observations},null,2)+'\n');
 }finally{release?.();if(browser)await browser.close();await new Promise(ok=>server.close(ok));}
});
