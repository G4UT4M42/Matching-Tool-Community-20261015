import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {MatchingState} from '../../core/types.js';
import {recordAudit} from '../../observability/audit.js';
import {isProviderAccountIdentity} from './provider-account.js';
import {validPayoutId,stripePayoutClassification} from './stripe-payout.js';
import {currencyCode,type StripePayoutComponent,type StripePayoutEvidence,type StripePayoutReport} from './types.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)).digest('hex');
const transaction=(value:unknown)=>typeof value==='string'&&/^txn_[A-Za-z0-9]{1,128}$/.test(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value);
const fail=():never=>{throw new Error('PAYOUT_EVIDENCE_UNAVAILABLE');};
function checkedComponent(value:unknown,leg=false):StripePayoutComponent{
 if(!value||typeof value!=='object'||Array.isArray(value))return fail();const x=value as Record<string,any>;
 if(Object.keys(x).sort().join(',')!==['reference','providerType','reportingCategory','classification','sourceReference','occurredAt','amountMinor','feeMinor','netMinor',...(leg?['includedInListing']:[])].sort().join(',')||!transaction(x.reference)||typeof x.providerType!=='string'||!/^[a-z_]{1,80}$/.test(x.providerType)||typeof x.reportingCategory!=='string'||!/^[a-z_]{1,80}$/.test(x.reportingCategory)||x.classification!==stripePayoutClassification(x.providerType,x.reportingCategory)||x.sourceReference!==null&&(typeof x.sourceReference!=='string'||!/^[A-Za-z0-9_]{1,160}$/.test(x.sourceReference))||typeof x.occurredAt!=='string'||!Number.isFinite(Date.parse(x.occurredAt))||new Date(x.occurredAt).toISOString()!==x.occurredAt||![x.amountMinor,x.feeMinor,x.netMinor].every(integer)||!integer(x.amountMinor-x.feeMinor)||x.amountMinor-x.feeMinor!==x.netMinor||leg&&(typeof x.includedInListing!=='boolean'||x.providerType!=='payout'))return fail();return structuredClone(x) as StripePayoutComponent;
}
/** Strict persisted projection: no arbitrary provider descriptions, metadata or authority. */
export function checkedPayoutEvidence(value:unknown):StripePayoutEvidence{
 if(!value||typeof value!=='object'||Array.isArray(value))return fail();const x=value as Record<string,any>;
 const fields=['payoutId','account','environment','status','currency','amountMinor','automatic','method','providerStatus','reconciliationStatus','payoutBalanceTransaction','componentCount','totals','components','payoutLeg','requiredFundingMinor','settlementFeeMinor','residualMinor',...(x.reason===undefined?[]:['reason'])];
 if(Object.keys(x).sort().join(',')!==fields.sort().join(',')||!validPayoutId(x.payoutId)||!['test','live'].includes(x.environment)||!isProviderAccountIdentity(x.account,'stripe',x.environment)||!['pending','reconciled','unsupported','unreconciled'].includes(x.status)||typeof x.currency!=='string'||currencyCode(x.currency)!==x.currency||!integer(x.amountMinor)||x.amountMinor<=0||typeof x.automatic!=='boolean'||!['standard','instant'].includes(x.method)||!['paid','pending','in_transit','canceled','failed'].includes(x.providerStatus)||!['completed','in_progress','not_applicable'].includes(x.reconciliationStatus)||x.payoutBalanceTransaction!==null&&!transaction(x.payoutBalanceTransaction)||!Array.isArray(x.components)||x.components.length>10000||x.componentCount!==x.components.length||!x.totals||Object.keys(x.totals).sort().join(',')!=='feeMinor,grossMinor,netMinor'||![x.totals.grossMinor,x.totals.feeMinor,x.totals.netMinor].every(integer))return fail();
 const components=x.components.map((row:unknown)=>checkedComponent(row));if(new Set(components.map((row:StripePayoutComponent)=>row.reference)).size!==components.length)return fail();
 let gross=0,fee=0,net=0;for(const row of components){gross+=row.amountMinor;fee+=row.feeMinor;net+=row.netMinor;if(![gross,fee,net].every(integer))return fail();}if(gross!==x.totals.grossMinor||fee!==x.totals.feeMinor||net!==x.totals.netMinor||!integer(gross-fee)||gross-fee!==net)return fail();
 if(x.status==='reconciled'||x.status==='unreconciled'){
  if(!x.automatic||x.method!=='standard'||x.providerStatus!=='paid'||x.reconciliationStatus!=='completed'||!x.payoutLeg)return fail();const leg=checkedComponent(x.payoutLeg,true);
  if(leg.reference!==x.payoutBalanceTransaction||leg.classification!=='payout'||leg.sourceReference!==x.payoutId||leg.amountMinor!==-x.amountMinor||components.some((row:StripePayoutComponent)=>row.reference===leg.reference)||x.requiredFundingMinor!==-leg.netMinor||x.settlementFeeMinor!==leg.feeMinor||!integer(net+leg.netMinor)||x.residualMinor!==net+leg.netMinor||x.status==='reconciled'&&(x.residualMinor!==0||x.reason!==undefined)||x.status==='unreconciled'&&(x.residualMinor===0||x.reason!=='PAYOUT_TOTAL_MISMATCH'))return fail();
 }else{
  if(components.length||x.payoutLeg!==null||x.requiredFundingMinor!==null||x.settlementFeeMinor!==null||x.residualMinor!==null||gross!==0||fee!==0||net!==0)return fail();
  const reason=!x.automatic?'PAYOUT_MANUAL_UNSUPPORTED':x.method==='instant'?'PAYOUT_INSTANT_UNSUPPORTED':x.reconciliationStatus==='not_applicable'?'PAYOUT_MEMBERSHIP_UNAVAILABLE':['failed','canceled'].includes(x.providerStatus)?'PAYOUT_NOT_PAID':'PAYOUT_RECONCILIATION_PENDING';
  if(x.reason!==reason||x.status!==(reason==='PAYOUT_RECONCILIATION_PENDING'?'pending':'unsupported')||reason==='PAYOUT_RECONCILIATION_PENDING'&&x.providerStatus==='paid'&&x.reconciliationStatus==='completed')return fail();
 }
 return {...structuredClone(x),components:components.sort((a:StripePayoutComponent,b:StripePayoutComponent)=>a.reference.localeCompare(b.reference))} as StripePayoutEvidence;
}
export function storedPayoutReports(state:MatchingState,subject:string|null,environment:'test'|'live',account:string):StripePayoutReport[]{
 const result:StripePayoutReport[]=[];for(const event of state.audit_events){const raw=event.after?.stripe_payout_reconciliation;if(!raw||subject!==null&&event.actor_id!==subject)continue;const value=raw as unknown as Record<string,unknown>;if(value.environment!==environment||value.account!==account)continue;
  if(event.after?.stripe_payout_reconciliation_version!==1)return fail();const {observationId,observedAt,...evidence}=value;const checked=checkedPayoutEvidence(evidence);if(event.actor_type!=='user'||typeof event.actor_id!=='string'||!event.actor_id||event.actor_id.length>256||event.action!=='STATE_COMMITTED'||event.entity_type!=='Run'||event.entity_id!==observationId||typeof event.timestamp!=='string'||!Number.isFinite(Date.parse(event.timestamp))||new Date(event.timestamp).toISOString()!==event.timestamp||typeof event.audit_id!=='string'||!event.audit_id||typeof observationId!=='string'||observationId!=='STRIPE-PAYOUT-'+hash([event.actor_id,checked])||typeof observedAt!=='string'||!Number.isFinite(Date.parse(observedAt))||new Date(observedAt).toISOString()!==observedAt)return fail();result.push({...checked,observationId,observedAt});
 }return result;
}
export function preparePayoutObservation(input:MatchingState,subject:string,raw:StripePayoutEvidence,observedAt:string){
 const evidence=checkedPayoutEvidence(raw),known=storedPayoutReports(input,null,evidence.environment,evidence.account),observationId='STRIPE-PAYOUT-'+hash([subject,evidence]),same=known.find(x=>x.observationId===observationId);
 if(typeof observedAt!=='string'||!Number.isFinite(Date.parse(observedAt))||new Date(observedAt).toISOString()!==observedAt)return fail();
 for(const previous of known.filter(x=>x.payoutId===evidence.payoutId)){
  if(previous.currency!==evidence.currency||previous.amountMinor!==evidence.amountMinor||previous.automatic!==evidence.automatic||previous.method!==evidence.method||previous.payoutBalanceTransaction!==null&&previous.payoutBalanceTransaction!==evidence.payoutBalanceTransaction)throw new Error('PAYOUT_SOURCE_CONFLICT');
  if(previous.payoutLeg&&evidence.payoutLeg){const economic=(value:StripePayoutEvidence)=>({components:value.components,totals:value.totals,payoutLeg:value.payoutLeg?{...value.payoutLeg,includedInListing:false}:null});if(!isDeepStrictEqual(economic(previous),economic(evidence)))throw new Error('PAYOUT_SOURCE_CONFLICT');}
 }
 if(same)return{state:input,report:same,replayed:true};
 const state=structuredClone(input),report:StripePayoutReport={...evidence,observationId,observedAt};recordAudit(state,'STATE_COMMITTED','Run',observationId,{actor_type:'user',actor_id:subject,reason:'Read-only Stripe payout membership observation; cash rows remain unchanged',after:{stripe_payout_reconciliation_version:1,stripe_payout_reconciliation:report}});return{state,report,replayed:false};
}
