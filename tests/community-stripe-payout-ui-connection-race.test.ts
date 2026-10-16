import {it,expect} from 'vitest';
import express from 'express';
import {build} from 'esbuild';
import {existsSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {Server} from 'node:http';
import puppeteer from 'puppeteer-core';

it('retires recorded payout authority and late reads on same-path reconnect and disconnect',async()=>{
 const executablePath=['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
 expect(executablePath).toBeTruthy();
 const root=mkdtempSync(join(tmpdir(),'community-payout-connection-race-'));
 let server:Server|undefined,browser:Awaited<ReturnType<typeof puppeteer.launch>>|undefined;
 let configured=true,account='SYNTHETIC-ACCOUNT-A',holdDetail:Promise<void>|undefined,holdMutation:Promise<void>|undefined;
 let releaseDetail=()=>{},releaseMutation=()=>{},detailStarted=false,mutationStarted=false;
 const report=(owner:string)=>({payoutId:'po_SYNTHRACE',account:owner,environment:'test',status:'reconciled',currency:'EUR',amountMinor:970,automatic:true,method:'standard',providerStatus:'paid',reconciliationStatus:'completed',payoutBalanceTransaction:'txn_SYNTHOWN',componentCount:1,totals:{grossMinor:1000,feeMinor:30,netMinor:970},components:[{reference:'txn_SYNTHCHARGE',classification:'payment',providerType:'charge',reportingCategory:'charge',sourceReference:'ch_SYNTHCHARGE',occurredAt:'2026-10-16T00:00:00.000Z',amountMinor:1000,feeMinor:30,netMinor:970}],payoutLeg:{reference:'txn_SYNTHOWN',classification:'payout',providerType:'payout',reportingCategory:'payout',sourceReference:'po_SYNTHRACE',occurredAt:'2026-10-16T00:00:00.000Z',amountMinor:-970,feeMinor:0,netMinor:-970,includedInListing:false},requiredFundingMinor:970,settlementFeeMinor:0,residualMinor:0,observationId:'SYNTHETIC-OBSERVATION',observedAt:'2026-10-16T00:00:00.000Z',replayed:false});
 try{
  mkdirSync(join(root,'web'));
  await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import{CommunityIntegrations}from'../web/src/pages/CommunityIntegrations.tsx';import{LanguageProvider}from'../web/src/i18n/locale.tsx';localStorage.setItem('matching-community-locale','en');createRoot(document.getElementById('root')).render(React.createElement(LanguageProvider,null,React.createElement(CommunityIntegrations)));",resolveDir:resolve('tests'),loader:'tsx'},bundle:true,platform:'browser',format:'iife',outfile:join(root,'web/harness.js'),alias:{react:resolve('web/node_modules/react'),'react-dom/client':resolve('web/node_modules/react-dom/client')},logLevel:'silent'});
  const app=express();app.use(express.json());
  app.get('/favicon.ico',(_req,res)=>res.status(204).end());
  app.get('/',(_req,res)=>res.type('html').send('<!doctype html><link rel="icon" href="data:,"><div id="root"></div><script src="/harness.js"></script>'));
  app.get('/harness.js',(_req,res)=>res.sendFile(join(root,'web/harness.js')));
  app.get('/api/community/integrations/:provider/:environment',(_req,res)=>res.json({configured,lastSuccess:null,lastError:null}));
  app.get('/api/community/integrations/:provider/:environment/history',(_req,res)=>res.json({items:[]}));
  app.get('/api/community/integrations/stripe/test/payouts/po_SYNTHRACE',async(_req,res)=>{const snapshot=report(account);detailStarted=true;await holdDetail;res.json(snapshot);});
  app.put('/api/community/integrations/stripe/test',async(_req,res)=>{mutationStarted=true;await holdMutation;account='SYNTHETIC-ACCOUNT-B';configured=true;res.json({configured:true});});
  app.delete('/api/community/integrations/stripe/test',async(_req,res)=>{mutationStarted=true;await holdMutation;configured=false;res.json({configured:false});});
  server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server!.once('listening',ok));
  const address=server.address();if(!address||typeof address==='string')throw Error('No synthetic listener');const origin='http://127.0.0.1:'+address.port;
  browser=await puppeteer.launch({executablePath,headless:true,userDataDir:join(root,'fresh-browser'),args:['--no-first-run','--disable-background-networking']});
  const page=await browser.newPage(),pageErrors:string[]=[],consoleErrors:string[]=[],badResponses:number[]=[],external:string[]=[];
  page.on('pageerror',error=>pageErrors.push(String(error)));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});page.on('response',response=>{if(response.status()>=400)badResponses.push(response.status());});
  await page.setRequestInterception(true);page.on('request',request=>{const url=new URL(request.url());if(url.origin===origin||['data:','about:','blob:'].includes(url.protocol))void request.continue();else{external.push(url.origin);void request.abort();}});
  const until=async(check:()=>boolean)=>{const deadline=Date.now()+3000;while(!check()){if(Date.now()>=deadline)throw Error('Synthetic request gate not reached');await new Promise(done=>setTimeout(done,5));}};
  const nativeClick=async(label:string)=>{const selector=await page.waitForFunction(text=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent===text&&!node.matches(':disabled')),{},label);const element=selector.asElement();if(!element)throw Error('Missing enabled button');await element.evaluate(node=>{if(!(node instanceof HTMLButtonElement))throw Error('Expected button');node.click();});await selector.dispose();};
  for(const action of ['reconnect','disconnect']){
   configured=true;account='SYNTHETIC-ACCOUNT-A';holdDetail=undefined;holdMutation=undefined;detailStarted=false;mutationStarted=false;
   await page.goto(origin,{waitUntil:'networkidle0'});await page.select('#integration-provider','stripe');await page.waitForSelector('#payout-id');
   await page.type('#payout-id','po_SYNTHRACE');await page.click('#payout-details');await page.waitForSelector('[data-testid=payout-report]');
   expect(await page.$eval('[data-testid=payout-report]',node=>node.textContent)).toContain('SYNTHETIC-ACCOUNT-A');
   await page.waitForFunction(()=>!document.querySelector('#payout-details')?.matches(':disabled'));
   detailStarted=false;holdDetail=new Promise<void>(ok=>releaseDetail=ok);await page.click('#payout-details');await until(()=>detailStarted);
   holdMutation=new Promise<void>(ok=>releaseMutation=ok);
   if(action==='reconnect'){await page.type('#integration-api-key','rk_test_syntheticReconnected');await nativeClick('Reconnect');}else await nativeClick('Disconnect');
   await until(()=>mutationStarted);
   expect(await page.$('[data-testid=payout-report]')).toBeNull();
   expect(await page.$eval('#payout-load',node=>node.matches(':disabled'))).toBe(true);
   releaseMutation();
   if(action==='reconnect')await page.waitForFunction(()=>!document.querySelector('#payout-load')?.matches(':disabled'));
   else await page.waitForFunction(()=>document.querySelector('[data-testid=integration-status]')?.textContent==='Not configured');
   releaseDetail();await page.waitForNetworkIdle();holdDetail=undefined;holdMutation=undefined;
   expect(await page.$('[data-testid=payout-report]')).toBeNull();
   expect(await page.$eval('body',node=>node.textContent)).not.toContain('SYNTHETIC-ACCOUNT-A');
   if(action==='reconnect'){
    expect(await page.$eval('#payout-id',node=>(node as HTMLInputElement).value)).toBe('');
    await page.type('#payout-id','po_SYNTHRACE');await page.click('#payout-details');await page.waitForSelector('[data-testid=payout-report]');
    expect(await page.$eval('[data-testid=payout-report]',node=>node.textContent)).toContain('SYNTHETIC-ACCOUNT-B');
   }else expect(await page.$('#payout-load')).toBeNull();
  }
  expect(pageErrors).toEqual([]);expect(consoleErrors).toEqual([]);expect(badResponses).toEqual([]);expect(external).toEqual([]);
 }finally{
  releaseDetail();releaseMutation();
  try{await browser?.close();}finally{try{if(server)await new Promise<void>(ok=>server!.close(()=>ok()));}finally{rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}
 }
},45000);
