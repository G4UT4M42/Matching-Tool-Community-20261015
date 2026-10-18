import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {StoredBankApplication} from '../banking/application-vault.js';
import {bankUuid} from '../banking/consent-client.js';
import {EnableBankingPisClient,makePisIntent,type PisIntent,type PisBank} from './enablebanking-pis.js';
import {digest} from './repository.js';
import type {CommunityPaymentService} from './service.js';
import type {PaymentBatch,Principal} from './types.js';

export interface PisBinding{validate():void}
type Flow={id:string;subject:string;workspace:string;session:string;batchId:string;revision:number;intent:PisIntent;binding:PisBinding;expires:number;tokenHash:string;stage:'confirmation_ready'|'awaiting_callback'|'callback_received';stateHash?:string;denied?:boolean;busy:boolean};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function fail(s:string):never{throw new Error(s);}
/** Only ephemeral authority is kept here. Durable events contain economic intent, never tokens, states or URLs. */
export class SandboxPaymentCoordinator{
 private readonly flows=new Map<string,Flow>();private readonly states=new Map<string,Flow>();private readonly locks=new Set<string>();
 constructor(readonly payments:CommunityPaymentService<any>,private readonly applications:{get(p:Principal):Promise<StoredBankApplication|undefined>;generation(p:Principal):number},private readonly client:EnableBankingPisClient,readonly callbackUrl:string,private readonly capture:(p:Principal,recent:boolean)=>PisBinding,private readonly now:()=>Date=()=>new Date()){
  const u=new URL(callbackUrl);if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/api/community-payments/sandbox/callback'||u.search||u.hash||u.username||u.password)fail('PIS_CALLBACK_CONFIGURATION_INVALID');
 }
 invalidate(){this.flows.clear();this.states.clear();}
 private remove(f:Flow){this.flows.delete(f.id);if(f.stateHash)this.states.delete(f.stateHash);}
 private alive(f:Flow){if(this.now().getTime()>=f.expires){this.remove(f);fail('PIS_FLOW_EXPIRED');}try{f.binding.validate();}catch{this.remove(f);fail('PIS_FLOW_REVOKED');}if(this.flows.get(f.id)!==f)fail('PIS_FLOW_REPLACED');}
 private flow(p:Principal,batchId:string,id:unknown){const f=typeof id==='string'?this.flows.get(id):undefined;if(!f||f.subject!==p.subject||f.workspace!==p.workspace_id||f.session!==p.session_id||f.batchId!==batchId)fail('PIS_FLOW_NOT_FOUND');this.alive(f);return f;}
 private batch(p:Principal,id:string,revision?:number){this.payments.require(p,'payments:submit');const b=this.payments.repo.get(id,p.workspace_id);if(!b)fail('BATCH_NOT_FOUND');if(b.provider!=='enablebanking-pis'||b.environment!=='sandbox')fail('PIS_PRODUCTION_DISABLED');if(revision!==undefined&&b.revision!==revision)fail('REVISION_CONFLICT');return b;}
 private assertEpoch(p:Principal,epoch:number){if(this.applications.generation(p)!==epoch)fail('PIS_APPLICATION_CHANGED');}
 private async snapshot(p:Principal,binding:PisBinding){const epoch=this.applications.generation(p),stored=await this.applications.get(p);binding.validate();this.assertEpoch(p,epoch);return{stored,epoch};}
 private async application(p:Principal,binding:PisBinding){const value=await this.snapshot(p,binding);this.assertEpoch(p,value.epoch);const app=value.stored;if(!app)fail('PIS_APPLICATION_REQUIRED');if(app.application.environment!=='sandbox')fail('PIS_PRODUCTION_DISABLED');return{...app,epoch:value.epoch};}
 private key(p:Principal,id:string){return JSON.stringify([p.workspace_id,id]);}
 private async locked<T>(p:Principal,id:string,operation:()=>Promise<T>){const key=this.key(p,id);if(this.locks.has(key))fail('PIS_BUSY');this.locks.add(key);try{return await operation();}finally{this.locks.delete(key);}}
 async status(p:Principal){this.payments.require(p,'finance:read');const binding=this.capture(p,false),snapshot=await this.snapshot(p,binding);binding.validate();this.assertEpoch(p,snapshot.epoch);const app=snapshot.stored,pending: Array<{batchId:string;flowId:string;stage:Flow['stage'];expiresAt:string}>=[];for(const f of this.flows.values())try{this.alive(f);if(f.subject===p.subject&&f.workspace===p.workspace_id){if(!app||app.application.environment!=='sandbox'||app.revision!==f.intent.applicationRevision||app.application.applicationId!==f.intent.applicationId){this.remove(f);continue;}if(f.session===p.session_id)pending.push({batchId:f.batchId,flowId:f.id,stage:f.stage,expiresAt:new Date(f.expires).toISOString()});}}catch{/* discard expired capability */}return{provider:'enablebanking-pis',environment:'sandbox',productionEnabled:false,applicationConfigured:!!app,applicationEnvironment:app?.application.environment??null,callbackUrl:this.callbackUrl,pending};}
 async banks(p:Principal,country:string){const binding=this.capture(p,true),app=await this.application(p,binding);await this.client.verify(app.application,this.callbackUrl);binding.validate();this.assertEpoch(p,app.epoch);const items=await this.client.banks(app.application,country);binding.validate();this.assertEpoch(p,app.epoch);return{items,environment:'sandbox'};}
 async confirm(p:Principal,id:string,raw:unknown){return this.locked(p,id,async()=>{
  const binding=this.capture(p,true);if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('PIS_INTENT_INVALID');const x=raw as Record<string,any>;
  if(Object.keys(x).sort().join(',')!=='bank,psuType,revision'||!Number.isSafeInteger(x.revision)||!x.bank||typeof x.bank!=='object'||Array.isArray(x.bank)||Object.keys(x.bank).sort().join(',')!=='country,name'||typeof x.bank.name!=='string'||x.bank.name.length<1||x.bank.name.length>200||/[\x00-\x1f\x7f]/.test(x.bank.name)||typeof x.bank.country!=='string'||!/^[A-Z]{2}$/.test(x.bank.country)||!['personal','business'].includes(x.psuType)||typeof x.psuType!=='string')fail('PIS_INTENT_INVALID');
  const batch=this.batch(p,id,x.revision),app=await this.application(p,binding),intent=makePisIntent(batch,app.application.applicationId,app.revision,x.bank,x.psuType as 'personal'|'business',this.now());
  await this.client.verify(app.application,this.callbackUrl);binding.validate();await this.client.validateIntent(app.application,intent,this.now());binding.validate();const current=await this.application(p,binding);this.assertEpoch(p,current.epoch);if(current.revision!==app.revision)fail('PIS_APPLICATION_CHANGED');
  for(const f of this.flows.values())try{this.alive(f);}catch{/* prune */}if(this.flows.size>=100)fail('PIS_FLOW_CAPACITY');
  const confirmation=this.payments.issueConfirmation(p,id,x.revision,true);
  for(const old of this.flows.values())if(old.workspace===p.workspace_id&&old.batchId===id)this.remove(old);
  const flow:Flow={id:randomUUID(),subject:p.subject,workspace:p.workspace_id,session:p.session_id,batchId:id,revision:batch.revision,intent,binding,expires:Date.parse(confirmation.expiresAt),tokenHash:hash(confirmation.token),stage:'confirmation_ready',busy:false};this.flows.set(flow.id,flow);
  return{...confirmation,flowId:flow.id,bank:intent.bank,psuType:intent.psuType,intent:{digest:intent.digest,executionDate:intent.executionDate,chargeBearer:intent.chargeBearer,deferSubmission:false,applicationId:intent.applicationId,environment:'sandbox'}};
 });}
 async authorize(p:Principal,id:string,raw:unknown){return this.locked(p,id,async()=>{
  const binding=this.capture(p,true);if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('PIS_CONFIRMATION_INVALID');const x=raw as Record<string,any>;
  if(Object.keys(x).sort().join(',')!=='flowId,revision,token'||typeof x.token!=='string'||!Number.isSafeInteger(x.revision))fail('PIS_CONFIRMATION_INVALID');const f=this.flow(p,id,x.flowId);if(f.stage!=='confirmation_ready'||f.busy||f.revision!==x.revision||hash(x.token)!==f.tokenHash)fail('PIS_CONFIRMATION_INVALID');f.busy=true;let claimed:PaymentBatch|undefined,acceptedPaymentId:string|undefined;
  try{const app=await this.application(p,binding);this.alive(f);if(app.revision!==f.intent.applicationRevision||app.application.applicationId!==f.intent.applicationId)fail('PIS_APPLICATION_CHANGED');await this.client.verify(app.application,this.callbackUrl);binding.validate();this.alive(f);await this.client.validateIntent(app.application,f.intent,this.now());binding.validate();this.alive(f);const current=await this.application(p,binding);this.alive(f);this.assertEpoch(p,current.epoch);if(current.revision!==f.intent.applicationRevision)fail('PIS_APPLICATION_CHANGED');
   const state=randomBytes(32).toString('base64url');
   claimed=this.payments.d.db.transaction(()=>{binding.validate();this.alive(f);const claim=this.payments.claimSubmission(p,id,x.revision,x.token,true).claimed;this.payments.repo.event(claim,p,'sandbox_intent',{intent:f.intent});return claim;})();
   f.stage='awaiting_callback';f.expires=this.now().getTime()+10*60000;f.stateHash=hash(state);this.states.set(f.stateHash,f);
   // No await separates the final guard, durable claim, and the single create attempt.
   const result=await this.client.create(app.application,f.intent,state,this.callbackUrl);acceptedPaymentId=result.paymentId;binding.validate();this.alive(f);
   const currentApplication=await this.snapshot(p,binding);binding.validate();this.alive(f);this.assertEpoch(p,currentApplication.epoch);const activeApplication=currentApplication.stored;
   const latest=this.batch(p,id,claimed.revision);if(latest.claimId!==claimed.claimId||latest.status!=='submission_claimed')fail('REVISION_CONFLICT');
   if(!activeApplication||activeApplication.revision!==f.intent.applicationRevision){
    // A remote payment may already exist. Preserve only its non-authority ID for
    // GET-only recovery; never publish the retired authorization capability.
    this.payments.repo.transition(p,id,latest.revision,['submission_claimed'],'unknown','sandbox_create_retired',{provider_reference:result.paymentId});
    fail('PIS_APPLICATION_CHANGED');
   }
   const batch=this.payments.repo.transition(p,id,latest.revision,['submission_claimed'],'unknown','sandbox_created',{provider_reference:result.paymentId});
   return{batch,flowId:f.id,authorizationUrl:result.authorizationUrl,expiresAt:new Date(f.expires).toISOString(),environment:'sandbox'};
  }catch(error){if(claimed){try{binding.validate();const latest=this.batch(p,id);if(latest.status==='submission_claimed'&&latest.claimId===claimed.claimId)this.payments.repo.transition(p,id,latest.revision,['submission_claimed'],'unknown','sandbox_create_unknown',acceptedPaymentId?{provider_reference:acceptedPaymentId}:{});}catch{/* Retired generation must never publish. Durable claim remains uncertain. */}}this.remove(f);throw error;}finally{f.busy=false;}
 });}
 /** Public receipt consumes only a bound nonce; no transport or financial mutation. */
 receive(raw:unknown){if(!raw||typeof raw!=='object'||Array.isArray(raw))return;const x=raw as Record<string,unknown>;if(Object.keys(x).some(k=>!['state','error','error_description'].includes(k))||typeof x.state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(x.state))return;const f=this.states.get(hash(x.state));if(!f)return;this.states.delete(hash(x.state));f.stateHash=undefined;try{this.alive(f);if(f.stage!=='awaiting_callback')return;if(x.error!==undefined&&(typeof x.error!=='string'||x.error.length>200)||x.error_description!==undefined&&(typeof x.error_description!=='string'||x.error_description.length>2048)){this.remove(f);return;}f.denied=x.error!==undefined;f.stage='callback_received';}catch{this.remove(f);}}
 private storedIntent(b:PaymentBatch):PisIntent{
  const rows=this.payments.d.db.prepare("SELECT detail_json,detail_digest FROM community_payment_events WHERE batch_id=? AND workspace_id=? AND action='sandbox_intent' ORDER BY seq").all(b.id,b.workspaceId) as {detail_json:string;detail_digest:string}[];
  if(rows.length!==1||rows[0].detail_digest!==b.detailDigest||rows[0].detail_json.length>20000)fail('PIS_INTENT_UNAVAILABLE');
  let i:PisIntent;try{i=JSON.parse(rows[0].detail_json).intent;}catch{return fail('PIS_INTENT_UNAVAILABLE');}
  if(!i||typeof i.applicationId!=='string'||!bankUuid.test(i.applicationId)||typeof i.applicationRevision!=='string'||!bankUuid.test(i.applicationRevision)||!i.bank||typeof i.bank.name!=='string'||i.bank.name.length>200||!i.bank.name||/[\x00-\x1f\x7f]/.test(i.bank.name)||typeof i.bank.country!=='string'||!/^[A-Z]{2}$/.test(i.bank.country)||!['personal','business'].includes(i.psuType)||typeof i.executionDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(i.executionDate)||!Number.isFinite(Date.parse(i.executionDate+'T00:00:00Z')))fail('PIS_INTENT_UNAVAILABLE');
  const expected=makePisIntent(b,i.applicationId,i.applicationRevision,i.bank,i.psuType,new Date(i.executionDate+'T00:00:00Z'));
  if(digest(expected)!==digest(i))fail('PIS_INTENT_UNAVAILABLE');return i;
 }
 private async read(p:Principal,id:string,revision:number,binding:PisBinding,flow?:Flow){if(!Number.isSafeInteger(revision)||revision<1)fail('REVISION_CONFLICT');const b=this.batch(p,id,revision);if(!b.claimId||!['unknown','submission_claimed','acknowledged','failed'].includes(b.status)||!b.providerReference)fail('PIS_STATUS_UNAVAILABLE_NO_RESUBMIT');const intent=this.storedIntent(b),app=await this.application(p,binding);if(app.application.applicationId!==intent.applicationId||flow&&app.revision!==flow.intent.applicationRevision)fail('PIS_APPLICATION_CHANGED');await this.client.verify(app.application,this.callbackUrl);binding.validate();const observed=await this.client.read(app.application,b.providerReference,intent);binding.validate();const current=await this.application(p,binding);this.assertEpoch(p,current.epoch);if(current.revision!==app.revision)fail('PIS_APPLICATION_CHANGED');const latest=this.batch(p,id,revision);if(latest.claimId!==b.claimId||latest.providerReference!==b.providerReference)fail('REVISION_CONFLICT');
  const outcome=observed.providerStatus==='ACCC'&&observed.finalStatus?'acknowledged':observed.providerStatus==='RJCT'&&observed.finalStatus?'failed':undefined;
  return this.payments.d.db.transaction(()=>{binding.validate();this.capture(p,true).validate();if(flow)this.alive(flow);let batch=latest;if(outcome&&batch.status!==outcome){if(batch.status==='acknowledged'||batch.status==='failed')fail('PIS_STATUS_CONFLICT');batch=this.payments.repo.transition(p,id,revision,['unknown','submission_claimed'],outcome,'sandbox_status');}this.payments.repo.event(batch,p,'sandbox_status_observed',observed);return{batch,...observed};})();
 }
 async complete(p:Principal,id:string,revision:number,flowId:unknown){return this.locked(p,id,async()=>{const binding=this.capture(p,true),f=this.flow(p,id,flowId);if(f.stage!=='callback_received')fail('PIS_CALLBACK_REQUIRED');if(f.denied){this.remove(f);fail('PIS_AUTHORIZATION_DENIED');}this.alive(f);const result=await this.read(p,id,revision,binding,f);this.remove(f);return result;});}
 async reconcile(p:Principal,id:string,revision:number){return this.locked(p,id,async()=>{const binding=this.capture(p,true);return(await this.read(p,id,revision,binding)).batch;});}
}
