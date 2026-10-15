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
  const app=express();app.get('/',(_req,res)=>res.type('html').send('<!doctype html><div id="root"></div><script src="/harness.js"></script>'));app.get('/harness.js',(_req,res)=>res.sendFile(join(root,'web','harness.js')));
  app.get('/api/community/integrations/:provider/:environment',async(req,res)=>{if(req.params.provider==='paypal'){requested();await hold;res.json({configured:true,lastSuccess:'OLD-PAYPAL-SCOPE',lastError:null});replied();}else res.json({configured:false,lastSuccess:null,lastError:null});});
  app.get('/api/community/integrations/:provider/:environment/history',(req,res)=>res.json({items:req.params.provider==='paypal'?[{id:'SYNTHETIC-OLD-HISTORY',occurred_at:'OLD-PAYPAL-HISTORY',operation:'test',phase:'completed',outcome:'succeeded'}]:[]}));
  server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server!.once('listening',ok));const address=server.address();if(!address||typeof address==='string')throw Error('No synthetic listener');
  const executablePath=['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);expect(executablePath).toBeTruthy();browser=await puppeteer.launch({executablePath,headless:true,userDataDir:join(root,'fresh-browser'),args:['--no-first-run']});const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));await page.goto('http://127.0.0.1:'+address.port,{waitUntil:'domcontentloaded'});await began;await page.select('#integration-provider','stripe');await page.waitForFunction(()=>document.querySelector('[data-testid=integration-status]')?.textContent==='Not configured');release();await completed;await page.waitForNetworkIdle();
  expect(await page.$eval('#integration-provider',node=>(node as HTMLSelectElement).value)).toBe('stripe');expect(await page.$eval('[data-testid=integration-status]',node=>node.textContent)).toBe('Not configured');const text=await page.$eval('body',node=>node.textContent);expect(text).not.toContain('OLD-PAYPAL');expect(text).toContain('Save configuration');expect(errors).toEqual([]);
 }finally{release?.();await browser?.close();if(server)await new Promise<void>(ok=>server!.close(()=>ok()));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
},30000);
