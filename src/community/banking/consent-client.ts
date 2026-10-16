import {createPrivateKey,createSign} from 'node:crypto';

export type BankEnvironment='sandbox'|'live';
export interface BankApplication {applicationId:string;privateKeyPem:string;environment:BankEnvironment}
export interface ConsentBank {name:string;country:string;maximumConsentSeconds:number}
export interface ConsentAccount {accountRef:string;name:string;currency:string}
export interface AuthorizedBankSession {sessionId:string;accounts:ConsentAccount[];validUntil:string}
export const bankUuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const object=(x:unknown):Record<string,any>=>{if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('BANK_RESPONSE_INVALID');return x as Record<string,any>};
const text=(x:unknown,max=200):x is string=>typeof x==='string'&&x.length>0&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
export async function boundedBankJson(response:Response):Promise<Record<string,any>>{
 const limit=2_000_000,header=response.headers.get('content-length');if(header!==null&&(!/^\d+$/.test(header)||Number(header)>limit))throw new Error('BANK_RESPONSE_INVALID');
 if(!response.body)throw new Error('BANK_RESPONSE_INVALID');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit){await reader.cancel();throw new Error('BANK_RESPONSE_INVALID');}chunks.push(next.value);}return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{throw new Error('BANK_RESPONSE_INVALID');}finally{reader.releaseLock();}
}
export function checkedApplication(raw:unknown):BankApplication{
 const x=object(raw);
 if(Object.keys(x).sort().join(',')!=='applicationId,environment,privateKeyPem'||typeof x.applicationId!=='string'||!bankUuid.test(x.applicationId)||!['sandbox','live'].includes(x.environment)||typeof x.privateKeyPem!=='string'||x.privateKeyPem.length>16384)throw new Error('BANK_APPLICATION_INVALID');
 try{const key=createPrivateKey(x.privateKeyPem);if(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength??0)<2048)throw new Error();}catch{throw new Error('BANK_APPLICATION_INVALID');}
 return{applicationId:x.applicationId,privateKeyPem:x.privateKeyPem,environment:x.environment};
}
/** Official AIS endpoints only. No payment endpoint or caller-supplied provider URL. */
export class BankConsentClient{
 constructor(private readonly http:typeof fetch=fetch){}
 private async request(application:BankApplication,path:string,body?:unknown):Promise<Record<string,any>>{
  const now=Math.floor(Date.now()/1000),b64=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const data=b64({typ:'JWT',alg:'RS256',kid:application.applicationId})+'.'+b64({iss:'enablebanking.com',aud:'api.enablebanking.com',iat:now,exp:now+300});
  const sign=createSign('RSA-SHA256');sign.update(data);const token=data+'.'+sign.sign(application.privateKeyPem,'base64url');
  let response:Response;try{response=await this.http('https://api.enablebanking.com'+path,{method:body===undefined?'GET':'POST',headers:{Accept:'application/json',Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(5000)});}catch{throw new Error('BANK_PROVIDER_UNAVAILABLE');}
  if(!response.ok)throw new Error(response.status===401||response.status===403?'BANK_PROVIDER_PERMISSION_DENIED':'BANK_PROVIDER_UNAVAILABLE');
  return boundedBankJson(response);
 }
 async verify(application:BankApplication,callbackUrl:string):Promise<void>{
  const x=await this.request(application,'/application');
  if(x.kid!==application.applicationId||x.active!==true||!Array.isArray(x.services)||!x.services.includes('AIS')||!Array.isArray(x.redirect_urls)||!x.redirect_urls.includes(callbackUrl))throw new Error('BANK_APPLICATION_NOT_AUTHORIZED');
  if(x.environment!==(application.environment==='sandbox'?'SANDBOX':'PRODUCTION'))throw new Error('BANK_ENVIRONMENT_MISMATCH');
 }
 async banks(application:BankApplication,country:string):Promise<ConsentBank[]>{
  if(!/^[A-Z]{2}$/.test(country))throw new Error('BANK_COUNTRY_INVALID');
  const x=await this.request(application,'/aspsps?'+new URLSearchParams({country}));
  if(!Array.isArray(x.aspsps)||x.aspsps.length>1000)throw new Error('BANK_RESPONSE_INVALID');
  const result:ConsentBank[]=[],seen=new Set<string>();
  for(const raw of x.aspsps){const row=object(raw);if(!text(row.name)||row.country!==country||!Number.isSafeInteger(row.maximum_consent_validity)||row.maximum_consent_validity<60)throw new Error('BANK_RESPONSE_INVALID');const key=row.country+'\0'+row.name;if(seen.has(key))throw new Error('BANK_RESPONSE_INVALID');seen.add(key);result.push({name:row.name,country:row.country,maximumConsentSeconds:Math.min(row.maximum_consent_validity,90*86400)});}
  return result;
 }
 async start(application:BankApplication,input:{bank:ConsentBank;state:string;callbackUrl:string;validUntil:string;psuType:'personal'|'business'}):Promise<string>{
  const x=await this.request(application,'/auth',{access:{valid_until:input.validUntil},aspsp:{name:input.bank.name,country:input.bank.country},state:input.state,redirect_url:input.callbackUrl,psu_type:input.psuType});
  if(!text(x.url,4096))throw new Error('BANK_RESPONSE_INVALID');
  let url:URL;try{url=new URL(x.url);}catch{throw new Error('BANK_RESPONSE_INVALID');}
  if(url.protocol!=='https:'||url.hostname!=='auth.enablebanking.com'||url.port||url.username||url.password||url.hash)throw new Error('BANK_AUTHORIZATION_URL_INVALID');
  return url.href;
 }
 async complete(application:BankApplication,code:string):Promise<AuthorizedBankSession>{
  const x=await this.request(application,'/sessions',{code});
  if(typeof x.session_id!=='string'||!bankUuid.test(x.session_id)||!Array.isArray(x.accounts)||x.accounts.length<1||x.accounts.length>100)throw new Error('BANK_RESPONSE_INVALID');
  const accounts:ConsentAccount[]=[],seen=new Set<string>();
  for(const raw of x.accounts){const row=object(raw);if(typeof row.uid!=='string'||!bankUuid.test(row.uid)||seen.has(row.uid)||!text(row.identification_hash,1024)||!text(row.currency,3)||!/^[A-Z]{3}$/.test(row.currency))throw new Error('BANK_RESPONSE_INVALID');seen.add(row.uid);accounts.push({accountRef:row.uid,name:text(row.name)?row.name:'Bank account',currency:row.currency});}
  // AuthorizeSessionResponse may omit access; the authoritative GET is always checked.
  const session=await this.session(application,x.session_id);
  if(accounts.some(row=>!session.accountRefs.includes(row.accountRef)))throw new Error('BANK_RESPONSE_INVALID');
  return{sessionId:x.session_id,accounts,validUntil:session.validUntil};
 }
 async session(application:BankApplication,sessionId:string):Promise<{accountRefs:string[];validUntil:string}>{
  if(typeof sessionId!=='string'||!bankUuid.test(sessionId))throw new Error('BANK_CONSENT_INVALID');
  const x=await this.request(application,'/sessions/'+sessionId),until=Date.parse(x.access?.valid_until);
  if(x.status!=='AUTHORIZED'||!text(x.access?.valid_until,64)||!Number.isFinite(until)||until<=Date.now()||!Array.isArray(x.accounts)||!x.accounts.length||x.accounts.length>100||x.accounts.some((id:unknown)=>typeof id!=='string'||!bankUuid.test(id))||new Set(x.accounts).size!==x.accounts.length||!Array.isArray(x.accounts_data))throw new Error('BANK_CONSENT_REQUIRED');
  for(const id of x.accounts){const matching=x.accounts_data.filter((row:any)=>row?.uid===id);if(matching.length!==1||!text(matching[0].identification_hash,1024))throw new Error('BANK_ACCOUNT_IDENTITY_REQUIRED');}
  return{accountRefs:x.accounts,validUntil:new Date(until).toISOString()};
 }
}
