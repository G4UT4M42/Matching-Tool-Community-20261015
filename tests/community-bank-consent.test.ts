import {describe,it,expect} from 'vitest';
import {createCipheriv,createDecipheriv,generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import {upCommunityPayments003} from '../src/migrations/003-community-payments.js';
import {CommunityBankingService,type ReadOnlyBankAdapter} from '../src/community/banking/service.js';
import {BankConsentClient,checkedApplication,boundedBankJson,type BankApplication} from '../src/community/banking/consent-client.js';
import {BankConsentCoordinator,type ApplicationStore,type ConsentBinding} from '../src/community/banking/consent.js';
import {BankApplicationVault} from '../src/community/banking/application-vault.js';
import {bankConsentCallback} from '../src/server/routes/community-banking.js';
import {prepareBankImport} from '../src/community/banking/canonical-import.js';
import {createEmptyState} from '../src/storage/json-store.js';
import type {Principal} from '../src/community/payments/types.js';

const appId='11111111-1111-4111-8111-111111111111',sessionId='22222222-2222-4222-8222-222222222222',accountRef='33333333-3333-4333-8333-333333333333';
const privateKeyPem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
const owner:Principal={subject:'synthetic-owner',workspace_id:'synthetic-workspace',session_id:'synthetic-session',role:'owner',authenticated_at:new Date().toISOString(),permissions:['integrations:read','integrations:configure','integrations:sync']};
const callbackUrl='http://127.0.0.1:34567/api/community-banking/callback';
const application:BankApplication={applicationId:appId,privateKeyPem,environment:'sandbox'};
const bank={name:'Synthetic AIS Bank',country:'AT'};
function fixture(ttlMs=10000){
 let stored:Awaited<ReturnType<ApplicationStore['get']>>,revision=0,allowed=true,epoch=0,clock=Date.now();
 const calls:Array<{method:string;path:string;body?:any}>=[],connected:Array<{environment:string;account:string;session:string}>=[];
 let metadata:Record<string,unknown>={kid:appId,active:true,environment:'SANDBOX',services:['AIS'],redirect_urls:[callbackUrl]};
 let authorizationUrl='https://auth.enablebanking.com/ais/start?sessionid=synthetic';let gate:Promise<void>|undefined,connectGate:Promise<void>|undefined,connectStarted=false;
 const http=async(input:unknown,init?:RequestInit)=>{
  expect(init?.redirect).toBe('error');const u=new URL(String(input)),method=init?.method??'GET',body=typeof init?.body==='string'?JSON.parse(init.body):undefined;
  expect(u.origin).toBe('https://api.enablebanking.com');calls.push({method,path:u.pathname,body});
  let value:unknown;
  if(u.pathname==='/application')value=metadata;
  else if(u.pathname==='/aspsps')value={aspsps:[{...bank,maximum_consent_validity:86400*30}]};
  else if(u.pathname==='/auth'){await gate;value={url:authorizationUrl};}
  else if(u.pathname==='/sessions'&&method==='POST'){await gate;value={session_id:sessionId,accounts:[{uid:accountRef,name:'Synthetic EUR account',currency:'EUR',identification_hash:'synthetic-stable'}]};}
  else if(u.pathname==='/sessions/'+sessionId)value={status:'AUTHORIZED',accounts:[accountRef],accounts_data:[{uid:accountRef,identification_hash:'synthetic-stable'}],access:{valid_until:new Date(Date.now()+86400000).toISOString()}};
  else throw new Error('Unexpected synthetic endpoint');
  return new Response(JSON.stringify(value),{status:200});
 };
 const store:ApplicationStore={get:async()=>stored,put:async(_p,value,guard)=>{guard();stored={revision:String(++revision),application:value};return stored;},remove:async(_p,guard)=>{guard();stored=undefined;}};
 let recentUntil=clock+5*60*1000;
 const capture=(p:Principal,permission:'integrations:read'|'integrations:configure'):ConsentBinding=>{const expectedEpoch=epoch;if(!allowed||!p.permissions.includes(permission))throw new Error('FORBIDDEN');if(permission==='integrations:configure'&&clock>=recentUntil)throw new Error('RECENT_AUTH_REQUIRED');return{validate(){if(!allowed||epoch!==expectedEpoch)throw new Error('RETIRED_CONTEXT');}};};
 const coordinator=new BankConsentCoordinator(store,new BankConsentClient(http as typeof fetch),callbackUrl,capture,async(_p,environment,account,credential,guard)=>{connectStarted=true;await connectGate;guard();connected.push({environment,account,session:credential.sessionId});},()=>clock,ttlMs);
 return{coordinator,client:new BankConsentClient(http as typeof fetch),calls,connected,get state(){return [...calls].reverse().find(x=>x.path==='/auth')?.body?.state as string;},get connectStarted(){return connectStarted;},reauthenticate(){recentUntil=clock+5*60*1000;},setConnectGate(x:Promise<void>){connectGate=x;},setMetadata(x:Record<string,unknown>){metadata=x;},metadata:()=>metadata,setAuthorizationUrl(x:string){authorizationUrl=x;},setGate(x:Promise<void>|undefined){gate=x;},revoke(){allowed=false;},restore(){epoch++;},advance(ms:number){clock+=ms;}};
}
async function until(check:()=>boolean){const deadline=Date.now()+2000;while(!check()){if(Date.now()>=deadline)throw new Error('Synthetic gate not reached');await new Promise(r=>setTimeout(r,1));}}
const configure=async(f:ReturnType<typeof fixture>)=>f.coordinator.configureApplication(owner,application);
async function started(f:ReturnType<typeof fixture>){await configure(f);return f.coordinator.start(owner,{bank});}

describe('AIS consent authority and callback lifecycle',()=>{
 it('rejects provider UUID/date coercions and ambiguous duplicate account identities before activation',async()=>{
  const details={uid:accountRef,name:'Synthetic EUR account',currency:'EUR',identification_hash:'synthetic-stable'};
  for(const response of [{session_id:[sessionId],accounts:[details]},{session_id:sessionId,accounts:[{...details,uid:[accountRef]}]}]){
   let calls=0;const client=new BankConsentClient((async()=>{calls++;return new Response(JSON.stringify(response));}) as typeof fetch);
   await expect(client.complete(application,'synthetic')).rejects.toThrow('BANK_RESPONSE_INVALID');expect(calls).toBe(1);
  }
  for(const [change,code] of [[{access:{valid_until:[new Date(Date.now()+86400000).toISOString()]}},'BANK_CONSENT_REQUIRED'],[{accounts_data:[details,details]},'BANK_ACCOUNT_IDENTITY_REQUIRED']] as const){
   const response=Object.assign({status:'AUTHORIZED',accounts:[accountRef],accounts_data:[details],access:{valid_until:new Date(Date.now()+86400000).toISOString()}},change);
   const client=new BankConsentClient((async()=>new Response(JSON.stringify(response))) as typeof fetch);await expect(client.session(application,sessionId)).rejects.toThrow(code);
  }
 });
 it('retains a valid callback across recent-auth expiry and resumes only after authenticated reauthentication',async()=>{
  const f=fixture(10*60*1000);await configure(f);f.advance(4*60*1000);const flow=await f.coordinator.start(owner,{bank});f.advance(60*1000+1);f.coordinator.receive({state:f.state,code:'synthetic'});expect((await f.coordinator.status(owner)).pendingConsent?.stage).toBe('callback_received');await expect(f.coordinator.complete(owner,flow.flowId)).rejects.toThrow('RECENT_AUTH_REQUIRED');expect(f.calls.some(x=>x.path==='/sessions')).toBe(false);expect((await f.coordinator.status(owner)).pendingConsent?.stage).toBe('callback_received');f.reauthenticate();await f.coordinator.complete(owner,flow.flowId);expect((await f.coordinator.status(owner)).pendingConsent?.stage).toBe('accounts_ready');
 });
 it('verifies the app, uses one-time state, safely recovers account selection and connects sandbox only',async()=>{
  const f=fixture(),start=await started(f);expect(f.state).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(start.authorizationUrl).toMatch(/^https:\/\/auth.enablebanking.com\//);
  expect((await f.coordinator.status(owner)).pendingConsent?.stage).toBe('awaiting_callback');
  f.coordinator.receive({state:'x'.repeat(43),code:'synthetic-code'});expect((await f.coordinator.status(owner)).pendingConsent?.stage).toBe('awaiting_callback');
  f.coordinator.receive({state:f.state,code:'synthetic-code'});expect((await f.coordinator.status(owner)).pendingConsent?.stage).toBe('callback_received');
  const complete=await f.coordinator.complete(owner,start.flowId);expect(complete.accounts).toEqual([{accountRef,name:'Synthetic EUR account',currency:'EUR'}]);
  const status=await f.coordinator.status(owner);expect(status.pendingConsent?.accounts).toEqual(complete.accounts);expect(JSON.stringify(status)).not.toContain('synthetic-code');expect(JSON.stringify(status)).not.toContain(privateKeyPem);expect(JSON.stringify(complete)).not.toContain(sessionId);
  f.coordinator.receive({state:f.state,code:'replacement-code'});await expect(f.coordinator.complete(owner,start.flowId)).rejects.toThrow('BANK_CONSENT_NOT_READY');
  await expect(f.coordinator.select({...owner,session_id:'foreign-session'},start.flowId,accountRef)).rejects.toThrow('BANK_CONSENT_NOT_FOUND');
  await expect(f.coordinator.select(owner,start.flowId,'44444444-4444-4444-8444-444444444444')).rejects.toThrow('BANK_SELECTION_INVALID');
  await f.coordinator.select(owner,start.flowId,accountRef);expect(f.connected).toEqual([{environment:'sandbox',account:accountRef,session:sessionId}]);expect((await f.coordinator.status(owner)).pendingConsent).toBeNull();
  expect(f.calls.filter(x=>x.path==='/sessions'&&x.method==='POST')).toHaveLength(1);expect(f.calls.every(x=>!x.path.includes('payment'))).toBe(true);
 });
 it('rejects inactive, mismatched, foreign or unregistered application metadata and unsafe authorization URLs',async()=>{
  for(const change of [{active:false},{environment:'PRODUCTION'},{kid:sessionId},{services:['PIS']},{redirect_urls:['https://other.invalid/callback']}]){const f=fixture();f.setMetadata({...f.metadata(),...change});await expect(configure(f)).rejects.toThrow();expect(f.calls.some(x=>x.path==='/auth')).toBe(false);}
  const f=fixture();await configure(f);f.setAuthorizationUrl('https://auth.enablebanking.com.evil.invalid/ais/start');await expect(f.coordinator.start(owner,{bank})).rejects.toThrow('BANK_AUTHORIZATION_URL_INVALID');expect((await f.coordinator.status(owner)).pendingConsent).toBeNull();
  expect(()=>checkedApplication({...application,environment:'mock'})).toThrow();
  expect(()=>checkedApplication({...application,applicationId:[appId]})).toThrow('BANK_APPLICATION_INVALID');
 });
 it('never exchanges denied, cancelled, expired, replaced or cross-owner authorization capabilities',async()=>{
  const denied=fixture(),a=await started(denied);denied.coordinator.receive({state:denied.state,error:'access_denied',error_description:'SYNTHETIC_PRIVATE_PROVIDER_TEXT'});await expect(denied.coordinator.complete(owner,a.flowId)).rejects.toThrow('BANK_CONSENT_DENIED');expect(denied.calls.some(x=>x.path==='/sessions')).toBe(false);
  const cancelled=fixture(),b=await started(cancelled);cancelled.coordinator.cancel(owner,b.flowId);cancelled.coordinator.receive({state:cancelled.state,code:'synthetic'});await expect(cancelled.coordinator.complete(owner,b.flowId)).rejects.toThrow('BANK_CONSENT_NOT_FOUND');
  const expired=fixture(),c=await started(expired);expired.advance(10001);expired.coordinator.receive({state:expired.state,code:'synthetic'});expect((await expired.coordinator.status(owner)).pendingConsent).toBeNull();await expect(expired.coordinator.complete(owner,c.flowId)).rejects.toThrow('BANK_CONSENT_NOT_FOUND');
  const replaced=fixture(),d=await started(replaced),oldState=replaced.state;await replaced.coordinator.start(owner,{bank});replaced.coordinator.receive({state:oldState,code:'synthetic'});await expect(replaced.coordinator.complete(owner,d.flowId)).rejects.toThrow('BANK_CONSENT_NOT_FOUND');expect((await replaced.coordinator.status({...owner,workspace_id:'foreign-workspace'})).pendingConsent).toBeNull();
 });
 it('fails closed on concurrent start, cancellation during provider wait, revocation and dataset retirement',async()=>{
  const f=fixture();await configure(f);let release!:()=>void;f.setGate(new Promise<void>(r=>{release=r;}));const pending=f.coordinator.start(owner,{bank});
  await until(()=>!!f.state);await expect(f.coordinator.start(owner,{bank})).rejects.toThrow('BANK_CONSENT_BUSY');const id=(await f.coordinator.status(owner)).pendingConsent!.flowId;f.coordinator.cancel(owner,id);release();await expect(pending).rejects.toThrow('BANK_CONSENT_REPLACED');
  for(const retire of ['revoke','restore'] as const){const x=fixture(),flow=await started(x);x.coordinator.receive({state:x.state,code:'synthetic'});x.setGate(new Promise<void>(r=>{release=r;}));const completing=x.coordinator.complete(owner,flow.flowId);await until(()=>x.calls.some(row=>row.path==='/sessions'));x[retire]();release();await expect(completing).rejects.toThrow();expect(x.connected).toHaveLength(0);}
 });
 it('disconnect locks the scope, invalidates pending flow and removes application authority after all connections',async()=>{
  const f=fixture(),flow=await started(f);let release!:()=>void;const held=new Promise<void>(r=>{release=r;});const disconnect=f.coordinator.disconnect(owner,async()=>held);
  await expect(f.coordinator.start(owner,{bank})).rejects.toThrow('BANK_CONSENT_BUSY');release();await disconnect;expect((await f.coordinator.status(owner)).applicationConfigured).toBe(false);await expect(f.coordinator.complete(owner,flow.flowId)).rejects.toThrow('BANK_CONSENT_NOT_FOUND');
 });
 it('serializes advanced configuration through final connection publication and blocks revoked selection',async()=>{
  const f=fixture();let release!:()=>void;f.setConnectGate(new Promise<void>(r=>{release=r;}));const connecting=f.coordinator.advanced(owner,'sandbox',accountRef,{applicationId:appId,privateKeyPem,sessionId});await until(()=>f.connectStarted);
  await expect(f.coordinator.disconnect(owner,async()=>{})).rejects.toThrow('BANK_CONSENT_BUSY');await expect(configure(f)).rejects.toThrow('BANK_CONSENT_BUSY');release();await connecting;expect(f.connected).toHaveLength(1);await f.coordinator.disconnect(owner,async()=>{f.connected.length=0;});expect(f.connected).toHaveLength(0);expect((await f.coordinator.status(owner)).applicationConfigured).toBe(false);
  const selected=fixture(),flow=await started(selected);selected.coordinator.receive({state:selected.state,code:'synthetic'});await selected.coordinator.complete(owner,flow.flowId);selected.setConnectGate(new Promise<void>(r=>{release=r;}));const selecting=selected.coordinator.select(owner,flow.flowId,accountRef);await until(()=>selected.connectStarted);selected.coordinator.cancel(owner,flow.flowId);release();await expect(selecting).rejects.toThrow('BANK_CONSENT_REPLACED');expect(selected.connected).toHaveLength(0);
 });
 it('receives an external callback without cookies and returns only a constant no-store redirect',async()=>{
  const f=fixture(),flow=await started(f),app=express();app.get('/api/community-banking/callback',bankConsentCallback(f.coordinator));const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  try{const port=(server.address() as {port:number}).port;const response=await fetch(`http://127.0.0.1:${port}/api/community-banking/callback?state=${f.state}&code=SYNTHETIC_PRIVATE_CODE`,{headers:{'Sec-Fetch-Site':'cross-site'},redirect:'manual'});expect(response.status).toBe(303);expect(response.headers.get('location')).toBe('/banking');expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.text()).toBe('');expect(JSON.stringify(Object.fromEntries(['location','cache-control','referrer-policy'].map(k=>[k,response.headers.get(k)])))).not.toContain('SYNTHETIC_PRIVATE');expect((await f.coordinator.status(owner)).pendingConsent?.stage).toBe('callback_received');await f.coordinator.complete(owner,flow.flowId);}finally{await new Promise<void>((r,j)=>server.close(error=>error?j(error):r()));}
 });
});

class SyntheticProtector{
 private readonly key=Buffer.alloc(32,17);
 protect(input:Buffer,context:Buffer){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(context);return Buffer.concat([nonce,cipher.update(input),cipher.final(),cipher.getAuthTag()]);}
 unprotect(input:Buffer,context:Buffer){const cipher=createDecipheriv('aes-256-gcm',this.key,input.subarray(0,12));cipher.setAAD(context);cipher.setAuthTag(input.subarray(-16));return Buffer.concat([cipher.update(input.subarray(12,-16)),cipher.final()]);}
}
describe('AIS protected application and source separation',()=>{
 it.skipIf(process.platform!=='win32')('uses the existing strict Windows vault layout for empty, staged and persisted application authority',async()=>{
  const root=await mkdtemp(join(tmpdir(),'community-consent-dpapi-'));try{const directory=join(root,'bank-vault'),vault=new BankApplicationVault(directory);expect(await vault.get(owner)).toBeUndefined();await vault.put(owner,application,()=>{});expect((await vault.get(owner))?.application).toEqual(application);expect((await readdir(directory)).every(name=>/^[a-f0-9]{64}\.credential$/.test(name))).toBe(true);await vault.remove(owner,()=>{});expect(await vault.get(owner)).toBeUndefined();}finally{await rm(root,{recursive:true,force:true});}
 },30000);
 it('persists encrypted app configuration and rejects tampering or a revoked final publication guard',async()=>{
  const root=await mkdtemp(join(tmpdir(),'community-consent-vault-'));try{const vault=new BankApplicationVault(root,new SyntheticProtector());await vault.put(owner,application,()=>{});const got=await vault.get(owner);expect(got?.application.environment).toBe('sandbox');expect(got?.application.privateKeyPem).toBe(privateKeyPem);expect(await vault.get({...owner,subject:'other'})).toBeUndefined();const file=(await readdir(root)).find(x=>x.endsWith('.credential'))!;const bytes=await readFile(join(root,file));expect(bytes.toString()).not.toContain('PRIVATE KEY');await expect(vault.put(owner,{...application,environment:'live'},()=>{throw new Error('REVOKED');})).rejects.toThrow('REVOKED');expect((await vault.get(owner))?.revision).toBe(got?.revision);await writeFile(join(root,file),bytes.toString().replace('sandbox','live'));await expect(vault.get(owner)).rejects.toThrow('BANK_APPLICATION_UNAVAILABLE');}finally{await rm(root,{recursive:true,force:true});}
 });
 it('keeps existing live IDs exact and separates identical sandbox account/reference identities',()=>{
  const row={providerId:'synthetic-reference',accountRef,accountIdentity:'synthetic-stable',bookedAt:'2026-10-15',amountMinor:-1234,currency:'EUR',description:'Synthetic purchase'};
  const first=prepareBankImport(createEmptyState('synthetic'),[row],owner.subject),live=[...first.state.transactions.values()][0];const both=prepareBankImport(first.state,[{...row,providerEnvironment:'sandbox'}],owner.subject);expect(both.imported).toBe(1);expect(both.state.transactions.size).toBe(2);expect([...both.state.transactions.values()].find(x=>x.meta.provider_environment==='live')?.transaction_id).toBe(live.transaction_id);expect(new Set([...both.state.transactions.values()].map(x=>x.source_account_id)).size).toBe(2);expect(prepareBankImport(both.state,[{...row,providerEnvironment:'sandbox'}],owner.subject).skipped).toBe(1);
 });
 it('bounds streamed provider bytes before JSON materialization',async()=>{
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(1_000_001));controller.enqueue(new Uint8Array(1_000_001));controller.close();}});await expect(boundedBankJson(new Response(body))).rejects.toThrow('BANK_RESPONSE_INVALID');
 });
 it('rejects retired connection responses after disconnect or reconfigure and rechecks at import publication',async()=>{
  for(const mode of ['disconnect','reconfigure','late-publication'] as const){const db=new Database(':memory:');upCommunityPayments003(db);let ref=0,imports=0,release!:()=>void,providerStarted=false;const gate=new Promise<void>(r=>{release=r;});
   const adapter:ReadOnlyBankAdapter={provider:'enablebanking-ais',environment:'sandbox',capabilities:['accounts','transactions'],accounts:async()=>[],transactions:async()=>{providerStarted=true;await gate;return[{providerId:'synthetic',accountRef,bookedAt:'2026-10-15',amountMinor:100,currency:'EUR',description:'Synthetic'}];}};
   let service!:CommunityBankingService;service=new CommunityBankingService(db,()=>true,{resolve:async()=>({synthetic:true})},adapter,{storeCredential:async()=>`synthetic-${++ref}`,importTransactions:async({guard})=>{if(mode==='late-publication')await service.disconnect(owner);guard?.();imports++;return{imported:1,skipped:0};}});
   try{await service.configure(owner,accountRef,{});const pending=service.sync(owner,'2026-10-01','2026-10-15');await until(()=>providerStarted);if(mode==='disconnect')await service.disconnect(owner);if(mode==='reconfigure')await service.configure(owner,accountRef,{});release();await expect(pending).rejects.toThrow('BANK_CONNECTION_CHANGED');expect(imports).toBe(0);}finally{db.close();}
  }
 });
 it('does not return account metadata after session revocation or connection retirement',async()=>{
  for(const mode of ['revoke','disconnect','vault-revoke'] as const){const db=new Database(':memory:');upCommunityPayments003(db);let allowed=true,release!:()=>void,started=false;const gate=new Promise<void>(r=>{release=r;});const adapter:ReadOnlyBankAdapter={provider:'enablebanking-ais',environment:'sandbox',capabilities:['accounts','transactions'],accounts:async()=>{started=true;await gate;return[{accountRef,currency:'EUR',name:'Synthetic private metadata'}];},transactions:async()=>[]};
   const service=new CommunityBankingService(db,()=>allowed,{resolve:async()=>{if(mode==='vault-revoke'){started=true;await gate;}return{};}},adapter,{storeCredential:async()=> 'synthetic-pointer',importTransactions:async()=>({imported:0,skipped:0})});
   try{await service.configure(owner,accountRef,{});const pending=service.accounts(owner);await until(()=>started);if(mode==='disconnect')await service.disconnect(owner);else allowed=false;release();await expect(pending).rejects.toThrow(mode==='disconnect'?'BANK_CONNECTION_CHANGED':'FORBIDDEN');}finally{db.close();}
  }
 });
});
