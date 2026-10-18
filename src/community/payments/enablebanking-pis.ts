import {createSign} from 'node:crypto';
import {boundedBankJson,bankUuid,type BankApplication} from '../banking/consent-client.js';
import {digest} from './repository.js';
import type {PaymentBatch} from './types.js';

export interface PisBank {name:string;country:string}
export interface PisIntent {version:1;environment:'sandbox';applicationId:string;applicationRevision:string;batchDigest:string;bank:PisBank;psuType:'personal'|'business';executionDate:string;chargeBearer:'SLEV';deferSubmission:false;request:Record<string,any>;digest:string}
export interface PisStatus {providerStatus:string;finalStatus:boolean;verifiedDetails:true;transactionStatus?:string}
const obj=(x:unknown):Record<string,any>=>{if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('PIS_RESPONSE_INVALID');return x as Record<string,any>};
const text=(x:unknown,max=200):x is string=>typeof x==='string'&&x.length>0&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
const statuses=new Set(['ACCC','ACCP','ACCR','ACPT','ACSC','ACSP','ACTC','ACWC','ACWP','CNCL','NULL','PACR','PART','PDCR','PDNG','RCVD','RJCR','RJCT']);
const cents=(n:number)=>{if(!Number.isSafeInteger(n)||n<=0)throw new Error('PIS_AMOUNT_INVALID');const value=BigInt(n);return `${value/100n}.${String(value%100n).padStart(2,'0')}`;};
function sameAmount(actual:unknown,expected:string):boolean {if(typeof actual!=='string'||!/^\d{1,16}(?:\.\d{1,2})?$/.test(actual))return false;const [a,b='']=actual.split('.'),[c,d]=expected.split('.');return BigInt(a)*100n+BigInt(b.padEnd(2,'0'))===BigInt(c)*100n+BigInt(d);}
export function makePisIntent(batch:PaymentBatch,applicationId:string,applicationRevision:string,bank:PisBank,psuType:'personal'|'business',now:Date):PisIntent{
 if(batch.provider!=='enablebanking-pis'||batch.environment!=='sandbox')throw new Error('PIS_PRODUCTION_DISABLED');
 if(batch.items.length!==1)throw new Error('PIS_SINGLE_ITEM_REQUIRED');
 const item=batch.items[0];if(item.currency!=='EUR')throw new Error('PIS_CURRENCY_UNSUPPORTED');
 const executionDate=[now.toISOString().slice(0,10),item.dueDate].sort().at(-1)!;
 const request={debtor:{name:batch.debtorName},debtor_account:{identification:batch.debtorIban,scheme_name:'IBAN'},debtor_currency:'EUR',charge_bearer:'SLEV',credit_transfer_transaction:[{beneficiary:{creditor:{name:item.creditorName},creditor_account:{identification:item.creditorIban,scheme_name:'IBAN'}},instructed_amount:{amount:cents(item.amountMinor),currency:'EUR'},payment_id:{instruction_id:item.id.slice(0,35),end_to_end_id:item.id.slice(0,35)},requested_execution_date:executionDate,remittance_information:[item.reference]}]};
 const value={version:1 as const,environment:'sandbox' as const,applicationId,applicationRevision,batchDigest:batch.detailDigest,bank:{name:bank.name,country:bank.country},psuType,executionDate,chargeBearer:'SLEV' as const,deferSubmission:false as const,request};return{...value,digest:digest(value)};
}
/** Fixed official sandbox PIS endpoints. Creation is deliberately a single attempt. */
export class EnableBankingPisClient{
 constructor(private readonly http:typeof fetch=fetch){}
 private async request(app:BankApplication,path:string,body?:unknown):Promise<Record<string,any>>{
  if(app.environment!=='sandbox')throw new Error('PIS_PRODUCTION_DISABLED');
  const now=Math.floor(Date.now()/1000),b64=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url'),data=b64({typ:'JWT',alg:'RS256',kid:app.applicationId})+'.'+b64({iss:'enablebanking.com',aud:'api.enablebanking.com',iat:now,exp:now+300});const signer=createSign('RSA-SHA256');signer.update(data);const token=data+'.'+signer.sign(app.privateKeyPem,'base64url');
  let response:Response;try{response=await this.http('https://api.enablebanking.com'+path,{method:body===undefined?'GET':'POST',headers:{Accept:'application/json',Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(5000)});}catch{throw new Error('PIS_PROVIDER_UNAVAILABLE');}
  if(!response.ok)throw new Error('PIS_PROVIDER_UNAVAILABLE');return boundedBankJson(response);
 }
 async verify(app:BankApplication,callbackUrl:string){const x=await this.request(app,'/application');if(x.environment!=='SANDBOX')throw new Error('PIS_PRODUCTION_DISABLED');if(x.kid!==app.applicationId||x.active!==true||!Array.isArray(x.services)||!x.services.includes('PIS')||!Array.isArray(x.redirect_urls)||!x.redirect_urls.includes(callbackUrl))throw new Error('PIS_APPLICATION_NOT_AUTHORIZED');}
 private async metadata(app:BankApplication,country:string){if(typeof country!=='string'||!/^[A-Z]{2}$/.test(country))throw new Error('PIS_BANK_INVALID');const x=await this.request(app,'/aspsps?'+new URLSearchParams({country,service:'PIS',payment_type:'SEPA'}));if(!Array.isArray(x.aspsps)||x.aspsps.length>1000)throw new Error('PIS_RESPONSE_INVALID');return x.aspsps.map(obj);}
 async banks(app:BankApplication,country:string):Promise<PisBank[]>{const rows=await this.metadata(app,country),seen=new Set<string>();return rows.map(row=>{if(!text(row.name)||row.country!==country||seen.has(row.name))throw new Error('PIS_RESPONSE_INVALID');seen.add(row.name);return{name:row.name,country};});}
 async validateIntent(app:BankApplication,intent:PisIntent,now:Date):Promise<void>{
  const banks=await this.metadata(app,intent.bank.country),bank=banks.find(x=>x.name===intent.bank.name&&x.country===intent.bank.country);if(!bank||!Array.isArray(bank.payments))throw new Error('PIS_BANK_INVALID');
  if(bank.required_psu_headers!==undefined&&(!Array.isArray(bank.required_psu_headers)||bank.required_psu_headers.length))throw new Error('PIS_BANK_REQUIREMENTS_UNSUPPORTED');
  const matches=bank.payments.map(obj).filter(x=>x.payment_type==='SEPA'&&x.psu_type===intent.psuType);if(matches.length!==1)throw new Error('PIS_BANK_REQUIREMENTS_UNSUPPORTED');const m=matches[0];
  if(!Array.isArray(m.currencies)||!m.currencies.includes('EUR')||!Array.isArray(m.debtor_account_schemas)||!m.debtor_account_schemas.includes('IBAN')||!Array.isArray(m.creditor_account_schemas)||!m.creditor_account_schemas.includes('IBAN')||!Array.isArray(m.charge_bearer_values)||!m.charge_bearer_values.includes('SLEV')||m.max_transactions!==undefined&&(!Number.isSafeInteger(m.max_transactions)||m.max_transactions<1))throw new Error('PIS_BANK_REQUIREMENTS_UNSUPPORTED');
  const supportedRequired=new Set(['debtor_account_required','creditor_name_required','remittance_information_required','debtor_currency_required']);for(const [key,value]of Object.entries(m))if(key.endsWith('_required')&&(typeof value!=='boolean'||value&&!supportedRequired.has(key)))throw new Error('PIS_BANK_REQUIREMENTS_UNSUPPORTED');
  const days=(Date.parse(intent.executionDate+'T00:00:00Z')-Date.parse(now.toISOString().slice(0,10)+'T00:00:00Z'))/86400000;
  if(!Number.isInteger(days)||days<0||m.requested_execution_date_supported!==true||!Number.isSafeInteger(m.requested_execution_date_max_period)||days>m.requested_execution_date_max_period)throw new Error('PIS_EXECUTION_DATE_UNSUPPORTED');
  if(m.remittance_information_lines!==undefined){if(!Array.isArray(m.remittance_information_lines)||m.remittance_information_lines.length!==1)throw new Error('PIS_REMITTANCE_UNSUPPORTED');const line=obj(m.remittance_information_lines[0]),ref=intent.request.credit_transfer_transaction[0].remittance_information[0];if(line.min_length!==undefined&&(!Number.isSafeInteger(line.min_length)||ref.length<line.min_length)||line.max_length!==undefined&&(!Number.isSafeInteger(line.max_length)||ref.length>line.max_length)||line.pattern!==undefined&&line.pattern!=='^.{1,140}$')throw new Error('PIS_REMITTANCE_UNSUPPORTED');}
 }
 async create(app:BankApplication,intent:PisIntent,state:string,callbackUrl:string):Promise<{paymentId:string;authorizationUrl:string}>{
  const x=await this.request(app,'/payments',{aspsp:intent.bank,payment_request:intent.request,payment_type:'SEPA',psu_type:intent.psuType,redirect_url:callbackUrl,state,defer_submission:false});
  if(typeof x.payment_id!=='string'||!bankUuid.test(x.payment_id)||x.status!=='RCVD'||!text(x.url,4096))throw new Error('PIS_RESPONSE_INVALID');let url:URL;try{url=new URL(x.url);}catch{throw new Error('PIS_RESPONSE_INVALID');}if(url.protocol!=='https:'||url.hostname!=='auth.enablebanking.com'||url.port||url.username||url.password||url.hash)throw new Error('PIS_AUTHORIZATION_URL_INVALID');return{paymentId:x.payment_id,authorizationUrl:url.href};
 }
 async read(app:BankApplication,id:string,intent:PisIntent):Promise<PisStatus>{
  if(typeof id!=='string'||!bankUuid.test(id))throw new Error('PIS_PAYMENT_ID_REQUIRED');const x=await this.request(app,'/payments/'+id);if(x.payment_id!==id||x.payment_type!=='SEPA'||x.aspsp?.name!==intent.bank.name||x.aspsp?.country!==intent.bank.country||typeof x.status!=='string'||!statuses.has(x.status)||typeof x.final_status!=='boolean')throw new Error('PIS_RESPONSE_INVALID');
  const actual=obj(x.payment_details),expected=intent.request;
  // Verify every approved economic field; unknown provider descriptions never enter history.
  if(actual.debtor?.name!==expected.debtor.name||actual.debtor_account?.scheme_name!=='IBAN'||actual.debtor_account?.identification!==expected.debtor_account.identification||actual.debtor_currency!==expected.debtor_currency||actual.charge_bearer!==expected.charge_bearer||!Array.isArray(actual.credit_transfer_transaction)||actual.credit_transfer_transaction.length!==1)throw new Error('PIS_DETAILS_CHANGED');
  const a=obj(actual.credit_transfer_transaction[0]),e=expected.credit_transfer_transaction[0];
  if(a.beneficiary?.creditor?.name!==e.beneficiary.creditor.name||a.beneficiary?.creditor_account?.scheme_name!=='IBAN'||a.beneficiary?.creditor_account?.identification!==e.beneficiary.creditor_account.identification||a.instructed_amount?.currency!=='EUR'||!sameAmount(a.instructed_amount?.amount,e.instructed_amount.amount)||a.requested_execution_date!==e.requested_execution_date||a.payment_id?.instruction_id!==e.payment_id.instruction_id||a.payment_id?.end_to_end_id!==e.payment_id.end_to_end_id||JSON.stringify(a.remittance_information)!==JSON.stringify(e.remittance_information))throw new Error('PIS_DETAILS_CHANGED');
  if(a.transaction_status!==undefined&&(typeof a.transaction_status!=='string'||!statuses.has(a.transaction_status)))throw new Error('PIS_RESPONSE_INVALID');
  if(a.transaction_status!==undefined&&((x.status==='ACCC'&&a.transaction_status!=='ACCC')||(x.status==='RJCT'&&a.transaction_status!=='RJCT')))throw new Error('PIS_STATUS_CONFLICT');
  return{providerStatus:x.status,finalStatus:x.final_status,verifiedDetails:true,...(a.transaction_status===undefined?{}:{transactionStatus:a.transaction_status})};
 }
}
