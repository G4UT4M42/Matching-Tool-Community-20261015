import {isDeepStrictEqual} from 'node:util';
import {requestJson} from './http.js';
import {asObject,currencyCode,safeInteger,type Environment,type StripePayoutComponent,type StripePayoutEvidence,type Transport} from './types.js';

export const validPayoutId=(value:unknown):value is string=>typeof value==='string'&&/^po_[A-Za-z0-9]{1,128}$/.test(value);
const transactionId=(value:unknown):value is string=>typeof value==='string'&&/^txn_[A-Za-z0-9]{1,128}$/.test(value);
export function stripePayoutClassification(type:string,category:string):StripePayoutComponent['classification']{const label=type+' '+category;return type==='payout'||type.startsWith('payout_')?'payout':label.includes('refund')||type==='payment_reversal'?'refund':label.includes('dispute')?'dispute':label.includes('fee')?'fee':['charge','payment'].includes(type)?'payment':'other';}
function component(raw:unknown):StripePayoutComponent{
 const row=asObject(raw);if(row.object!=='balance_transaction'||!transactionId(row.id)||typeof row.type!=='string'||!/^[a-z_]{1,80}$/.test(row.type)||typeof row.reporting_category!=='string'||!/^[a-z_]{1,80}$/.test(row.reporting_category))throw new Error('INVALID_PROVIDER_RESPONSE');
 const amountMinor=safeInteger(row.amount),feeMinor=safeInteger(row.fee),netMinor=safeInteger(row.net);if(!Number.isSafeInteger(amountMinor-feeMinor)||amountMinor-feeMinor!==netMinor)throw new Error('INVALID_PROVIDER_AMOUNT');
 if(row.source!==null&&row.source!==undefined&&(typeof row.source!=='string'||!/^[A-Za-z0-9_]{1,160}$/.test(row.source)))throw new Error('INVALID_PROVIDER_RESPONSE');
 const created=safeInteger(row.created);if(created<0||created>8640000000000)throw new Error('INVALID_PROVIDER_RESPONSE');const occurredAt=new Date(created*1000).toISOString(),classification=stripePayoutClassification(row.type,row.reporting_category);
 return{reference:row.id,providerType:row.type,reportingCategory:row.reporting_category,classification,sourceReference:typeof row.source==='string'?row.source:null,occurredAt,amountMinor,feeMinor,netMinor};
}
/** Read-only membership evidence. This function never imports or changes a cash row. */
export async function readStripePayout(key:string,environment:Environment,account:string,payoutId:string,transport:Transport,guard:()=>void=()=>{}):Promise<StripePayoutEvidence>{
 if(!validPayoutId(payoutId))throw new Error('INVALID_PAYOUT_ID');if(environment!=='test'&&environment!=='live')throw new Error('INVALID_ENVIRONMENT');
 const get=async(path:string)=>{guard();const result=await requestJson(transport,{method:'GET',url:'https://api.stripe.com/v1/'+path,headers:{Authorization:'Bearer '+key,Accept:'application/json'}});guard();return result;};
 const row=asObject(await get('payouts/'+payoutId));
 if(row.object!=='payout'||row.id!==payoutId||typeof row.automatic!=='boolean'||row.livemode!==(environment==='live')||typeof row.method!=='string'||!['standard','instant'].includes(row.method)||typeof row.reconciliation_status!=='string'||!['completed','in_progress','not_applicable'].includes(row.reconciliation_status)||typeof row.status!=='string'||!['paid','pending','in_transit','canceled','failed'].includes(row.status)||row.balance_transaction!==null&&!transactionId(row.balance_transaction))throw new Error('INVALID_PROVIDER_RESPONSE');
 const amountMinor=safeInteger(row.amount);if(amountMinor<=0)throw new Error('INVALID_PROVIDER_AMOUNT');const currency=currencyCode(row.currency);
 const result:StripePayoutEvidence={payoutId,account,environment,status:'pending',currency,amountMinor,automatic:row.automatic,method:row.method as StripePayoutEvidence['method'],providerStatus:row.status as StripePayoutEvidence['providerStatus'],reconciliationStatus:row.reconciliation_status as StripePayoutEvidence['reconciliationStatus'],payoutBalanceTransaction:row.balance_transaction as string|null,componentCount:0,totals:{grossMinor:0,feeMinor:0,netMinor:0},components:[],payoutLeg:null,requiredFundingMinor:null,settlementFeeMinor:null,residualMinor:null};
 if(!row.automatic)return{...result,status:'unsupported',reason:'PAYOUT_MANUAL_UNSUPPORTED'};
 if(row.method==='instant')return{...result,status:'unsupported',reason:'PAYOUT_INSTANT_UNSUPPORTED'};
 if(row.reconciliation_status==='not_applicable')return{...result,status:'unsupported',reason:'PAYOUT_MEMBERSHIP_UNAVAILABLE'};
 if(row.status==='failed'||row.status==='canceled')return{...result,status:'unsupported',reason:'PAYOUT_NOT_PAID'};
 if(row.status!=='paid'||row.reconciliation_status!=='completed')return{...result,reason:'PAYOUT_RECONCILIATION_PENDING'};
 if(!transactionId(row.balance_transaction))throw new Error('INVALID_PROVIDER_RESPONSE');
 const ownRaw=asObject(await get('balance_transactions/'+row.balance_transaction)),own=component(ownRaw);
 if(own.reference!==row.balance_transaction||ownRaw.type!=='payout'||own.sourceReference!==payoutId||currencyCode(ownRaw.currency)!==currency||own.amountMinor!==-amountMinor)throw new Error('PAYOUT_SOURCE_CONFLICT');
 result.payoutLeg={...own,includedInListing:false};result.requiredFundingMinor=-own.netMinor;result.settlementFeeMinor=own.feeMinor;const seen=new Map<string,StripePayoutComponent>(),currencies=new Map<string,string>(),pages=new Set<string>();let after:string|undefined;
 for(let page=0;page<100;page++){
  const query=new URLSearchParams({payout:payoutId,limit:'100'});if(after)query.set('starting_after',after);const response=asObject(await get('balance_transactions?'+query));
  if(response.object!=='list'||response.url!=='/v1/balance_transactions'||!Array.isArray(response.data)||response.data.length>100||typeof response.has_more!=='boolean')throw new Error('INVALID_PROVIDER_RESPONSE');
  for(const raw of response.data){const value=asObject(raw),entry=component(value),unit=currencyCode(value.currency);if(unit!==currency)throw new Error('PAYOUT_CURRENCY_MISMATCH');const old=seen.get(entry.reference);if(old&&(!isDeepStrictEqual(old,entry)||currencies.get(entry.reference)!==unit))throw new Error('PAYOUT_SOURCE_CONFLICT');seen.set(entry.reference,entry);currencies.set(entry.reference,unit);
   if(entry.reference===own.reference){if(!isDeepStrictEqual(entry,own)||value.type!=='payout')throw new Error('PAYOUT_SOURCE_CONFLICT');result.payoutLeg.includedInListing=true;}
  }
  if(seen.size>10000)throw new Error('PROVIDER_PAGINATION_LIMIT');
  if(!response.has_more){result.components=[...seen.values()].filter(x=>x.reference!==own.reference).sort((a,b)=>a.reference.localeCompare(b.reference));result.componentCount=result.components.length;
   for(const entry of result.components)for(const [total,field]of [['grossMinor','amountMinor'],['feeMinor','feeMinor'],['netMinor','netMinor']] as const){const sum=result.totals[total]+entry[field];if(!Number.isSafeInteger(sum))throw new Error('INVALID_PROVIDER_AMOUNT');result.totals[total]=sum;}
   if(!Number.isSafeInteger(result.totals.grossMinor-result.totals.feeMinor)||result.totals.grossMinor-result.totals.feeMinor!==result.totals.netMinor)throw new Error('INVALID_PROVIDER_AMOUNT');
   result.residualMinor=result.totals.netMinor+own.netMinor;if(!Number.isSafeInteger(result.residualMinor))throw new Error('INVALID_PROVIDER_AMOUNT');return result.residualMinor===0?{...result,status:'reconciled'}:{...result,status:'unreconciled',reason:'PAYOUT_TOTAL_MISMATCH'};
  }
  const last=response.data.at(-1);if(!last||!transactionId(last.id)||pages.has(last.id))throw new Error('PROVIDER_PAGINATION_LOOP');pages.add(last.id);after=last.id;
 }
 throw new Error('PROVIDER_PAGINATION_LIMIT');
}
