import {it,expect} from 'vitest';
import express from 'express';
import {build} from 'esbuild';
import {mkdtempSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import puppeteer from 'puppeteer-core';
import type {Server} from 'node:http';
import {bankAccounts,bankingStatus,consentAuthorization,availableBanks} from '../web/src/banking-contract';

it('rejects external callback targets, unsafe authorization links, mixed environments and ambiguous accounts',()=>{
 const origin='http://127.0.0.1:3000',status={configured:false,provider:'enablebanking-ais',accountRef:null,capabilities:[],applicationConfigured:false,applicationEnvironment:null,callbackUrl:origin+'/api/community-banking/callback',pendingConsent:null};
 expect(bankingStatus(status,origin).configured).toBe(false);
 for(const callbackUrl of ['https://other.invalid/api/community-banking/callback',origin+'/api/community-banking/callback?code=secret',origin+'/api/community-banking/callback#state',origin+'/api/other'])expect(()=>bankingStatus({...status,callbackUrl},origin)).toThrow();
 const flow={flowId:'synthetic-flow',environment:'sandbox',expiresAt:'2026-10-20T00:00:00Z',authorizationUrl:'https://auth.enablebanking.com/ais/start?sessionid=synthetic'};
 expect(consentAuthorization(flow,'sandbox').flowId).toBe('synthetic-flow');
 const userinfo=new URL(flow.authorizationUrl);userinfo.username='synthetic-user';
 for(const authorizationUrl of ['javascript:alert(1)','http://auth.enablebanking.com/ais/start','https://auth.enablebanking.com.evil.invalid/ais/start',userinfo.href,'https://auth.enablebanking.com:444/ais/start','https://auth.enablebanking.com/ais/start#secret'])expect(()=>consentAuthorization({...flow,authorizationUrl},'sandbox')).toThrow();
 expect(()=>consentAuthorization(flow,'live')).toThrow();
 const account={accountRef:'synthetic-account',name:'Synthetic EUR account',currency:'EUR'};
 for(const rows of [[account,account],[null],[{...account,name:{markup:'invalid'}}],[{...account,currency:'eur'}]])expect(()=>bankAccounts(rows)).toThrow();
 expect(()=>availableBanks({environment:'live',items:[]},'sandbox','AT')).toThrow();
 expect(()=>availableBanks({environment:'sandbox',items:[{name:'Synthetic',country:'DE',maximumConsentSeconds:3600}]},'sandbox','AT')).toThrow();
});

it('runs the localized consent UI without following provider links and clears submitted secrets',async()=>{
 const root=mkdtempSync(join(tmpdir(),'community-bank-ui-'));let server:Server|undefined,browser:Awaited<ReturnType<typeof puppeteer.launch>>|undefined;
 const submissions:Array<{path:string;body:any}>=[];let configured=false,application=false,stage:string|null=null,origin='';
 const account={accountRef:'11111111-1111-4111-8111-111111111111',name:'Synthetic EUR account',currency:'EUR'};
 try{
  mkdirSync(join(root,'web'));await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import{CommunityBanking}from'../web/src/pages/CommunityBanking.tsx';import{LanguageProvider}from'../web/src/i18n/locale.tsx';localStorage.setItem('matching-community-locale',new URLSearchParams(location.search).get('language')??'en');createRoot(document.getElementById('root')).render(React.createElement(LanguageProvider,null,React.createElement(CommunityBanking)));",resolveDir:resolve('tests'),loader:'tsx'},bundle:true,platform:'browser',format:'iife',outfile:join(root,'web','harness.js'),alias:{react:resolve('web/node_modules/react'),'react-dom/client':resolve('web/node_modules/react-dom/client')},logLevel:'silent'});
  const app=express();app.use(express.json());app.get('/favicon.ico',(_req,res)=>res.status(204).end());app.get('/',(_req,res)=>res.type('html').send('<!doctype html><div id="root"></div><script src="/harness.js"></script>'));app.get('/harness.js',(_req,res)=>res.sendFile(join(root,'web','harness.js')));
  app.get('/api/community-banking/status',(_req,res)=>res.json({configured,provider:'enablebanking-ais',accountRef:configured?account.accountRef:null,capabilities:[{paymentInitiation:false,qualification:'LIVE_AUTHORIZATION_REQUIRED'}],applicationConfigured:application,applicationEnvironment:application?'sandbox':null,callbackUrl:origin+'/api/community-banking/callback',pendingConsent:stage?{flowId:'synthetic-flow',stage,expiresAt:'2099-01-01T00:00:00Z',...(stage==='accounts_ready'?{accounts:[account]}:{})}:null}));
  app.get('/api/community-banking/banks',(req,res)=>res.json({environment:'sandbox',items:[{name:'Synthetic bank',country:req.query.country,maximumConsentSeconds:3600}]}));
  app.post('/api/community-banking/*',(req,res)=>{submissions.push({path:req.path,body:req.body});switch(req.path){case '/api/community-banking/application':application=true;break;case '/api/community-banking/consents':stage='awaiting_callback';return res.json({flowId:'synthetic-flow',environment:'sandbox',expiresAt:'2099-01-01T00:00:00Z',authorizationUrl:'https://auth.enablebanking.com/ais/start?sessionid=synthetic'});case '/api/community-banking/consents/synthetic-flow/complete':stage='accounts_ready';break;case '/api/community-banking/consents/synthetic-flow/select':if(req.body.accountRef!==account.accountRef)return res.sendStatus(400);configured=true;stage=null;break;case '/api/community-banking/disconnect':configured=false;break;case '/api/community-banking/consents/synthetic-flow/cancel':stage=null;break;default:return res.sendStatus(404);}res.status(204).end();});
  server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server!.once('listening',ok));const address=server.address();if(!address||typeof address==='string')throw Error('No synthetic listener');origin='http://127.0.0.1:'+address.port;
  const executablePath=['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);expect(executablePath).toBeTruthy();browser=await puppeteer.launch({executablePath,headless:true,userDataDir:join(root,'fresh-browser'),args:['--no-first-run','--disable-background-networking']});
  const page=await browser.newPage(),errors:string[]=[],external:string[]=[];page.on('pageerror',error=>errors.push(String(error)));await page.setRequestInterception(true);page.on('request',request=>{const url=new URL(request.url());if(url.origin===origin||['about:','data:','blob:'].includes(url.protocol))void request.continue();else{external.push(url.origin);void request.abort();}});
  const click=async(selector:string)=>{await page.waitForFunction(s=>{const node=document.querySelector(s);return node&&!node.matches(':disabled');},{},selector);await page.click(selector);};
  for(const language of ['en','de']){
   configured=false;application=false;stage=null;await page.goto(origin+'/?language='+language,{waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelector('#bank-save-application')&&!document.querySelector('#bank-save-application')!.matches(':disabled'));
   await page.type('#bank-application-id','33333333-3333-4333-8333-333333333333');await page.type('#bank-private-key','SYNTHETIC-PRIVATE-KEY');await click('#bank-save-application');await page.waitForFunction(()=>document.querySelector('#bank-load-banks')&&!document.querySelector('#bank-load-banks')!.matches(':disabled'));
   expect(await page.$eval('#bank-private-key',node=>(node as HTMLTextAreaElement).value)).toBe('');await click('#bank-load-banks');await page.waitForSelector('#bank-choice');await page.select('#bank-choice','Synthetic bank');await click('#bank-start-consent');await page.waitForSelector('#bank-authorize');
   expect(await page.$eval('#bank-authorize',node=>({target:node.getAttribute('target'),rel:node.getAttribute('rel'),href:node.getAttribute('href')}))).toEqual({target:'_blank',rel:'noopener noreferrer',href:'https://auth.enablebanking.com/ais/start?sessionid=synthetic'});
   expect(await page.$eval('#bank-complete-consent',node=>(node as HTMLButtonElement).disabled)).toBe(true);stage='callback_received';await click('#bank-refresh-consent');await click('#bank-complete-consent');await page.waitForSelector('#bank-consent-account');
   await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('#bank-consent-account');await page.select('#bank-consent-account',account.accountRef);await click('#bank-select-account');await page.waitForFunction(()=>!document.querySelector('[data-testid=bank-consent]'));
   expect(await page.$eval('[data-testid=bank-status]',node=>node.textContent)).toContain(language==='de'?'Eingerichtet':'Configured');
   expect(await page.$eval('body',node=>node.textContent)).not.toContain('SYNTHETIC-PRIVATE-KEY');
  }
  expect(submissions.filter(item=>item.path.endsWith('/application')).every(item=>item.body.environment==='sandbox'&&item.body.privateKeyPem==='SYNTHETIC-PRIVATE-KEY')).toBe(true);expect(external).toEqual([]);expect(errors).toEqual([]);
 }finally{await browser?.close();if(server)await new Promise<void>(ok=>server!.close(()=>ok()));const absolute=resolve(root);if(!absolute.startsWith(resolve(tmpdir())+'\\'))throw Error('Unexpected synthetic root');rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
},45000);
