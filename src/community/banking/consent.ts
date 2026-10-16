import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Principal} from '../payments/types.js';
import {BankConsentClient,checkedApplication,type BankApplication,type BankEnvironment,type ConsentAccount} from './consent-client.js';
import type {StoredBankApplication} from './application-vault.js';

export interface ConsentBinding {validate():void}
export interface ApplicationStore {get(p:Principal):Promise<StoredBankApplication|undefined>;put(p:Principal,application:BankApplication,guard:()=>void):Promise<StoredBankApplication>;remove?(p:Principal,guard:()=>void):Promise<void>}
export type ConsentStage='awaiting_callback'|'callback_received'|'accounts_ready';
interface Flow {id:string;scope:string;session:string;binding:ConsentBinding;revision:string;application:BankApplication;expires:number;stage:ConsentStage;stateHash?:string;code?:string;denied?:boolean;busy:boolean;authorizedSession?:string;accounts?:ConsentAccount[]}
const digest=(x:string)=>createHash('sha256').update(x).digest('hex');
function fail(code:string):never{throw new Error(code);}
/** Ephemeral capabilities never enter SQL, backups or history. Only the explicit provider authorization URL is returned. */
export class BankConsentCoordinator{
 private readonly flows=new Map<string,Flow>();private readonly states=new Map<string,Flow>();private readonly locks=new Set<string>();
 constructor(private readonly store:ApplicationStore,private readonly client:BankConsentClient,readonly callbackUrl:string,
  private readonly capture:(p:Principal,permission:'integrations:read'|'integrations:configure')=>ConsentBinding,
  private readonly connect:(p:Principal,environment:BankEnvironment,accountRef:string,credential:BankApplication&{sessionId:string},guard:()=>void)=>Promise<void>,
  private readonly now:()=>number=Date.now,private readonly ttlMs=10*60*1000){
  const url=new URL(callbackUrl);if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!=='/api/community-banking/callback'||url.username||url.password||url.search||url.hash)throw new Error('BANK_CALLBACK_CONFIGURATION_INVALID');
 }
 private scope(p:Principal){if(!p.subject||!p.workspace_id||!p.session_id)fail('UNAUTHENTICATED');return digest(JSON.stringify([p.workspace_id,p.subject]));}
 private remove(flow:Flow){if(this.flows.get(flow.scope)===flow)this.flows.delete(flow.scope);if(flow.stateHash)this.states.delete(flow.stateHash);flow.code=undefined;flow.authorizedSession=undefined;flow.accounts=undefined;}
 private alive(flow:Flow){if(this.now()>=flow.expires){this.remove(flow);fail('BANK_CONSENT_EXPIRED');}try{flow.binding.validate();}catch{this.remove(flow);fail('BANK_CONSENT_REVOKED');}if(this.flows.get(flow.scope)!==flow)fail('BANK_CONSENT_REPLACED');}
 private prune(){for(const flow of this.flows.values())try{this.alive(flow);}catch{/* Expired/revoked capabilities are discarded. */}}
 private flow(p:Principal,id:string){const f=this.flows.get(this.scope(p));if(!f||f.id!==id||f.session!==p.session_id)fail('BANK_CONSENT_NOT_FOUND');this.alive(f);return f;}
 private async application(p:Principal,binding:ConsentBinding){const stored=await this.store.get(p);binding.validate();if(!stored)fail('BANK_APPLICATION_REQUIRED');return stored;}
 async status(p:Principal){const b=this.capture(p,'integrations:read');const app=await this.store.get(p);b.validate();this.prune();const f=this.flows.get(this.scope(p));return{applicationConfigured:!!app,applicationEnvironment:app?.application.environment??null,callbackUrl:this.callbackUrl,pendingConsent:f?.session===p.session_id?{flowId:f.id,stage:f.stage,expiresAt:new Date(f.expires).toISOString(),...(f.stage==='accounts_ready'?{accounts:structuredClone(f.accounts)}:{})}:null};}
 async environment(p:Principal):Promise<BankEnvironment>{const b=this.capture(p,'integrations:read'),app=await this.store.get(p);b.validate();return app?.application.environment??'live';}
 async configureApplication(p:Principal,raw:unknown){const scope=this.scope(p);if(this.locks.has(scope))fail('BANK_CONSENT_BUSY');this.locks.add(scope);
  try{const b=this.capture(p,'integrations:configure'),application=checkedApplication(raw);await this.client.verify(application,this.callbackUrl);b.validate();await this.store.put(p,application,()=>b.validate());b.validate();const old=this.flows.get(scope);if(old)this.remove(old);return{applicationConfigured:true,applicationEnvironment:application.environment};}finally{this.locks.delete(scope);}
 }
 async banks(p:Principal,country:string){const b=this.capture(p,'integrations:configure'),app=await this.application(p,b),rows=await this.client.banks(app.application,country);b.validate();return{items:rows,environment:app.application.environment};}
 async start(p:Principal,raw:unknown){const scope=this.scope(p);if(this.locks.has(scope))fail('BANK_CONSENT_BUSY');this.locks.add(scope);let flow:Flow|undefined;
  try{const b=this.capture(p,'integrations:configure');if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('BANK_CONSENT_INVALID');const input=raw as Record<string,any>;
   if(Object.keys(input).some(k=>!['bank','validUntil','psuType'].includes(k))||!input.bank||Object.keys(input.bank).sort().join(',')!=='country,name'||typeof input.bank.name!=='string'||typeof input.bank.country!=='string'||input.psuType!==undefined&&!['personal','business'].includes(input.psuType))fail('BANK_CONSENT_INVALID');
   const app=await this.application(p,b);await this.client.verify(app.application,this.callbackUrl);b.validate();
   const banks=await this.client.banks(app.application,input.bank.country);b.validate();const bank=banks.find(x=>x.name===input.bank.name&&x.country===input.bank.country);if(!bank)fail('BANK_SELECTION_INVALID');
   if(input.validUntil!==undefined&&(typeof input.validUntil!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.validUntil)))fail('BANK_CONSENT_VALIDITY_INVALID');
   const until=input.validUntil===undefined?this.now()+Math.min(30*86400,bank.maximumConsentSeconds)*1000:Date.parse(input.validUntil);
   if(!Number.isFinite(until)||until<=this.now()||until>this.now()+bank.maximumConsentSeconds*1000)fail('BANK_CONSENT_VALIDITY_INVALID');
   this.prune();if(this.flows.size>=128&&!this.flows.has(scope))fail('BANK_CONSENT_CAPACITY');const old=this.flows.get(scope);if(old)this.remove(old);
   const state=randomBytes(32).toString('base64url');flow={id:randomUUID(),scope,session:p.session_id,binding:b,revision:app.revision,application:app.application,expires:this.now()+this.ttlMs,stage:'awaiting_callback',stateHash:digest(state),busy:false};this.flows.set(scope,flow);this.states.set(flow.stateHash!,flow);
   const authorizationUrl=await this.client.start(app.application,{bank,state,callbackUrl:this.callbackUrl,validUntil:new Date(until).toISOString(),psuType:input.psuType??'personal'});this.alive(flow);
   return{flowId:flow.id,authorizationUrl,expiresAt:new Date(flow.expires).toISOString(),environment:app.application.environment};
  }catch(error){if(flow)this.remove(flow);throw error;}finally{this.locks.delete(scope);}
 }
 /** Public receipt only: no cookies, provider request, financial write or reflected text. */
 receive(query:unknown):void{
  if(!query||typeof query!=='object'||Array.isArray(query))return;const x=query as Record<string,unknown>;
  if(Object.keys(x).some(k=>!['state','code','error','error_description'].includes(k))||typeof x.state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(x.state))return;
  const f=this.states.get(digest(x.state));if(!f)return;this.states.delete(digest(x.state));f.stateHash=undefined;
  try{this.alive(f);if(f.stage!=='awaiting_callback')return;
   if(x.error!==undefined){if(typeof x.error!=='string'||x.error.length>200||x.code!==undefined||x.error_description!==undefined&&(typeof x.error_description!=='string'||x.error_description.length>2048))return this.remove(f);f.denied=true;}
   else{if(typeof x.code!=='string'||!/^[A-Za-z0-9._~-]{1,2048}$/.test(x.code))return this.remove(f);f.code=x.code;}
   f.stage='callback_received';
  }catch{this.remove(f);}
 }
 async complete(p:Principal,id:string){const b=this.capture(p,'integrations:configure'),f=this.flow(p,id);if(f.busy)fail('BANK_CONSENT_BUSY');if(f.stage!=='callback_received')fail('BANK_CONSENT_NOT_READY');if(f.denied){this.remove(f);fail('BANK_CONSENT_DENIED');}if(!f.code)fail('BANK_CONSENT_INVALID');f.busy=true;const code=f.code;f.code=undefined;
  try{const app=await this.application(p,b);this.alive(f);if(app.revision!==f.revision)fail('BANK_CONSENT_REPLACED');const session=await this.client.complete(app.application,code);b.validate();this.alive(f);f.authorizedSession=session.sessionId;f.accounts=session.accounts;f.expires=Math.min(f.expires,Date.parse(session.validUntil));f.stage='accounts_ready';return{flowId:f.id,accounts:structuredClone(session.accounts),environment:app.application.environment,expiresAt:new Date(f.expires).toISOString()};
  }catch(error){this.remove(f);throw error;}finally{f.busy=false;}
 }
 async select(p:Principal,id:string,accountRef:string){const b=this.capture(p,'integrations:configure'),f=this.flow(p,id);if(f.busy)fail('BANK_CONSENT_BUSY');if(f.stage!=='accounts_ready'||!f.authorizedSession)fail('BANK_CONSENT_NOT_READY');const account=f.accounts?.find(row=>row.accountRef===accountRef);if(!account)fail('BANK_SELECTION_INVALID');if(account.currency!=='EUR')fail('BANK_CURRENCY_UNSUPPORTED');f.busy=true;
  const guard=()=>{b.validate();this.alive(f);};
  try{const app=await this.application(p,b);guard();if(app.revision!==f.revision)fail('BANK_CONSENT_REPLACED');const session=await this.client.session(app.application,f.authorizedSession);guard();if(!session.accountRefs.includes(accountRef))fail('BANK_SELECTION_INVALID');await this.connect(p,app.application.environment,accountRef,{...app.application,sessionId:f.authorizedSession},guard);guard();this.remove(f);return{configured:true,environment:app.application.environment};}finally{f.busy=false;}
 }
 cancel(p:Principal,id:string){this.capture(p,'integrations:configure').validate();const f=this.flow(p,id);this.remove(f);return{cancelled:true};}
 async disconnect(p:Principal,disconnectConnections:()=>Promise<void>){const scope=this.scope(p);if(this.locks.has(scope))fail('BANK_CONSENT_BUSY');this.locks.add(scope);
  try{const b=this.capture(p,'integrations:configure'),f=this.flows.get(scope);if(f)this.remove(f);await disconnectConnections();b.validate();await this.store.remove?.(p,()=>b.validate());b.validate();}finally{this.locks.delete(scope);}
 }
 async advanced(p:Principal,environment:BankEnvironment,accountRef:string,credential:unknown){const scope=this.scope(p);if(this.locks.has(scope))fail('BANK_CONSENT_BUSY');this.locks.add(scope);
  try{if(!credential||typeof credential!=='object'||Array.isArray(credential))fail('BANK_CONSENT_INVALID');const raw=credential as Record<string,unknown>;if(Object.keys(raw).sort().join(',')!=='applicationId,privateKeyPem,sessionId'||typeof raw.sessionId!=='string')fail('BANK_CONSENT_INVALID');const app=checkedApplication({applicationId:raw.applicationId,privateKeyPem:raw.privateKeyPem,environment});const b=this.capture(p,'integrations:configure');await this.client.verify(app,this.callbackUrl);b.validate();const session=await this.client.session(app,raw.sessionId);b.validate();if(!session.accountRefs.includes(accountRef))fail('BANK_SELECTION_INVALID');await this.store.put(p,app,()=>b.validate());b.validate();const old=this.flows.get(scope);if(old)this.remove(old);await this.connect(p,environment,accountRef,{...app,sessionId:raw.sessionId},()=>b.validate());b.validate();return{configured:true,environment};}finally{this.locks.delete(scope);}
 }
 invalidate(){for(const flow of this.flows.values())this.remove(flow);}
}
