import {it,expect} from 'vitest';
import express from 'express';
import {build} from 'esbuild';
import {mkdtempSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import puppeteer from 'puppeteer-core';
import type {Server} from 'node:http';
it('ignores a delayed prior-provider status and history after switching provider',async()=>{
 const root=mkdtempSync(join(tmpdir(),'community-provider-ui-race-'));let server:Server|undefined,browser:Awaited<ReturnType<typeof puppeteer.launch>>|undefined;
 let requested!:()=>void,replied!:()=>void,release!:()=>void;const began=new Promise<void>(ok=>requested=ok),completed=new Promise<void>(ok=>replied=ok),hold=new Promise<void>(ok=>release=ok);
 try{
  mkdirSync(join(root,'web'));await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import{CommunityIntegrations}from'../web/src/pages/CommunityIntegrations.tsx';import{LanguageProvider}from'../web/src/i18n/locale.tsx';createRoot(document.getElementById('root')).render(React.createElement(LanguageProvider,null,React.createElement(CommunityIntegrations)));",resolveDir:resolve('tests'),loader:'tsx'},bundle:true,platform:'browser',format:'iife',outfile:join(root,'web','harness.js'),alias:{react:resolve('web/node_modules/react'),'react-dom/client':resolve('web/node_modules/react-dom/client')},logLevel:'silent'});
  const app=express();app.get('/favicon.ico',(_req,res)=>res.status(204).end());app.get('/',(_req,res)=>res.type('html').send('<!doctype html><div id="root"></div><script src="/harness.js"></script>'));app.get('/harness.js',(_req,res)=>res.sendFile(join(root,'web','harness.js')));
  app.get('/api/community/integrations/:provider/:environment',async(req,res)=>{if(req.params.provider==='paypal'){requested();await hold;res.json({configured:true,lastSuccess:'OLD-PAYPAL-SCOPE',lastError:null});replied();}else res.json({configured:false,lastSuccess:null,lastError:null});});
  app.get('/api/community/integrations/:provider/:environment/history',(req,res)=>res.json({items:req.params.provider==='paypal'?[{id:'SYNTHETIC-OLD-HISTORY',occurred_at:'OLD-PAYPAL-HISTORY',operation:'test',phase:'completed',outcome:'succeeded'}]:[]}));
  server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server!.once('listening',ok));const address=server.address();if(!address||typeof address==='string')throw Error('No synthetic listener');
  const executablePath=['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);expect(executablePath).toBeTruthy();browser=await puppeteer.launch({executablePath,headless:true,userDataDir:join(root,'fresh-browser'),args:['--no-first-run']});const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));await page.goto('http://127.0.0.1:'+address.port,{waitUntil:'domcontentloaded'});await began;await page.select('#integration-provider','stripe');await page.waitForFunction(()=>document.querySelector('[data-testid=integration-status]')?.textContent==='Not configured');release();await completed;await page.waitForNetworkIdle();
  expect(await page.$eval('#integration-provider',node=>(node as HTMLSelectElement).value)).toBe('stripe');expect(await page.$eval('[data-testid=integration-status]',node=>node.textContent)).toBe('Not configured');const text=await page.$eval('body',node=>node.textContent);expect(text).not.toContain('OLD-PAYPAL');expect(text).toContain('Save configuration');expect(errors).toEqual([]);
 }finally{release?.();await browser?.close();if(server)await new Promise<void>(ok=>server!.close(()=>ok()));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
},30000);

it('shows localized actionable failures for malformed status/history instead of crashing or retaining stale rows',async()=>{
 const root=mkdtempSync(join(tmpdir(),'community-provider-ui-shape-'));let server:Server|undefined,browser:Awaited<ReturnType<typeof puppeteer.launch>>|undefined;
 const validStatus={configured:true,lastSuccess:'2026-10-14T00:00:00Z',lastError:null},entry={id:'SYNTHETIC-VALID-HISTORY',occurred_at:'2026-10-14T00:00:00Z',operation:'test',phase:'completed',outcome:'succeeded'};
 const cases:Array<{status?:unknown;history?:unknown;rawHistory?:string}>=[{history:validStatus},{history:{items:{}}},{history:{items:[null]}},{history:{items:[{...entry,outcome:{unexpected:true}}]}},{history:{items:[entry,entry]}},{status:{...validStatus,configured:'true'}},{status:{...validStatus,lastSuccess:{unexpected:true}}},{status:{...validStatus,lastError:{unexpected:true}}},{status:{...validStatus,provider:'stripe',environment:'test'}},{rawHistory:'{"items":'}];
 let fixture:typeof cases[number]={};
 try{
  mkdirSync(join(root,'web'));await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import{CommunityIntegrations}from'../web/src/pages/CommunityIntegrations.tsx';import{LanguageProvider}from'../web/src/i18n/locale.tsx';localStorage.setItem('matching-community-locale',new URLSearchParams(location.search).get('language')??'en');createRoot(document.getElementById('root')).render(React.createElement(LanguageProvider,null,React.createElement(CommunityIntegrations)));",resolveDir:resolve('tests'),loader:'tsx'},bundle:true,platform:'browser',format:'iife',outfile:join(root,'web','harness.js'),alias:{react:resolve('web/node_modules/react'),'react-dom/client':resolve('web/node_modules/react-dom/client')},logLevel:'silent'});
  const app=express();app.get('/favicon.ico',(_req,res)=>res.status(204).end());app.get('/',(_req,res)=>res.type('html').send('<!doctype html><div id="root"></div><script src="/harness.js"></script>'));app.get('/harness.js',(_req,res)=>res.sendFile(join(root,'web','harness.js')));
  app.get('/api/community/integrations/:provider/:environment',(_req,res)=>res.json(fixture.status??validStatus));app.get('/api/community/integrations/:provider/:environment/history',(_req,res)=>fixture.rawHistory!==undefined?res.type('json').send(fixture.rawHistory):res.json(fixture.history??{items:[entry]}));app.post('/api/community/integrations/:provider/:environment/test',(_req,res)=>res.json({connected:true}));
  server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server!.once('listening',ok));const address=server.address();if(!address||typeof address==='string')throw Error('No synthetic listener');
  const executablePath=['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);expect(executablePath).toBeTruthy();browser=await puppeteer.launch({executablePath,headless:true,userDataDir:join(root,'fresh-browser'),args:['--no-first-run','--disable-background-networking']});const page=await browser.newPage(),errors:string[]=[],consoleErrors:string[]=[],badResponses:string[]=[];page.on('pageerror',error=>errors.push(String(error)));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});page.on('response',response=>{if(response.status()>=400)badResponses.push(response.status()+' '+response.url());});
  const base='http://127.0.0.1:'+address.port;
  for(const language of ['en','de'])for(const malformed of cases){
   fixture={};await page.goto(base+'/?language='+language,{waitUntil:'networkidle0'});await page.waitForSelector('[data-testid=integration-history] tr');fixture=malformed;
   await page.evaluate(label=>{const button=Array.from(document.querySelectorAll('button')).find(node=>node.textContent===label);if(!button)throw Error('Missing test control');button.click();},language==='de'?'Verbindung testen':'Test connection');
   await page.waitForFunction(fragment=>Array.from(document.querySelectorAll('[role=status]')).some(node=>node.textContent?.includes(fragment)),{},language==='de'?'Seite neu laden':'Reload the page');
   expect(await page.$$('[data-testid=integration-history] tr')).toHaveLength(0);expect(await page.$eval('[data-testid=integration-status]',node=>node.textContent)).toBe(language==='de'?'Status nicht verfügbar':'Status unavailable');
   expect(await page.$$eval('button',nodes=>nodes.filter(node=>['Test connection','Synchronize','Disconnect','Verbindung testen','Synchronisieren','Trennen'].includes(node.textContent??'')).every(node=>node.disabled))).toBe(true);
   const text=await page.$eval('body',node=>node.textContent);expect(text).not.toContain('Objects are not valid');expect(text).not.toContain('SyntaxError');expect(await page.$('#integration-client-secret')).not.toBeNull();
  }
  expect(errors).toEqual([]);expect(badResponses).toEqual([]);expect(consoleErrors).toEqual([]);
 }finally{await browser?.close();if(server)await new Promise<void>(ok=>server!.close(()=>ok()));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
},45000);
