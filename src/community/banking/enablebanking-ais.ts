import { createSign } from 'node:crypto';
import type { ReadOnlyBankAdapter, BankAccountRow, BankTransactionRow } from './service.js';

const BASE='https://api.enablebanking.com';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type VaultCredential={applicationId:string;privateKeyPem:string;sessionId:string};
function credential(raw:unknown):VaultCredential {
  const x=raw as Partial<VaultCredential>|null;
  if(!x || typeof x.applicationId!=='string' || !uuid.test(x.applicationId) || typeof x.privateKeyPem!=='string' || !x.privateKeyPem.includes('PRIVATE KEY') || typeof x.sessionId!=='string' || !uuid.test(x.sessionId))throw new Error('BANK_CREDENTIAL_UNAVAILABLE');
  return x as VaultCredential;
}
function jwt(c:VaultCredential):string {
  const now=Math.floor(Date.now()/1000),b64=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const data=`${b64({typ:'JWT',alg:'RS256',kid:c.applicationId})}.${b64({iss:'enablebanking.com',aud:'api.enablebanking.com',iat:now,exp:now+300})}`;
  const sign=createSign('RSA-SHA256');sign.update(data);return `${data}.${sign.sign(c.privateKeyPem,'base64url')}`;
}
function exactEuroMinor(value:unknown):number {
  if(typeof value!=='string'||!/^[-+]?\d{1,12}(?:\.\d{1,2})?$/.test(value))throw new Error('BANK_AMOUNT_UNSUPPORTED');
  const negative=value.startsWith('-'),clean=value.replace(/^[-+]/,''),[whole,fraction='']=clean.split('.');
  const minor=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(minor))throw new Error('BANK_AMOUNT_UNSUPPORTED');return negative?-minor:minor;
}
export class EnableBankingAisAdapter implements ReadOnlyBankAdapter {
  readonly provider='enablebanking-ais' as const;readonly environment='live' as const;readonly capabilities=['accounts','transactions'] as const;
  constructor(readonly http:typeof fetch=fetch) {}
  private async get(path:string,c:VaultCredential):Promise<any>{
    let response:Response;
    try{response=await this.http(BASE+path,{method:'GET',headers:{Accept:'application/json',Authorization:`Bearer ${jwt(c)}`},signal:AbortSignal.timeout(5000),redirect:'error'})}
    catch{throw new Error('BANK_READ_UNAVAILABLE')}
    if(!response.ok)throw new Error('BANK_READ_UNAVAILABLE');
    try{const body=await response.text();if(body.length>2_000_000)throw new Error('BANK_RESPONSE_TOO_LARGE');return JSON.parse(body)}
    catch{throw new Error('BANK_RESPONSE_INVALID')}
  }
  private async authorized(raw:unknown,accountRef:string):Promise<VaultCredential>{
    const c=credential(raw);if(!uuid.test(accountRef))throw new Error('BANK_ACCOUNT_REF_INVALID');
    const session=await this.get(`/sessions/${c.sessionId}`,c);
    if(session.status!=='AUTHORIZED'||!Array.isArray(session.accounts)||!session.accounts.includes(accountRef)||Date.parse(session.access?.valid_until??'')<=Date.now())throw new Error('BANK_CONSENT_REQUIRED');
    return c;
  }
  async accounts(raw:unknown,accountRef:string):Promise<BankAccountRow[]>{
    const c=await this.authorized(raw,accountRef),data=await this.get(`/accounts/${accountRef}/details`,c);
    if(data.uid!==accountRef||typeof data.currency!=='string')throw new Error('BANK_RESPONSE_INVALID');
    return [{accountRef,name:String(data.name??accountRef),iban:typeof data.account_id?.iban==='string'?data.account_id.iban:undefined,currency:data.currency}];
  }
  async transactions(raw:unknown,accountRef:string,from:string,to:string):Promise<BankTransactionRow[]>{
    const c=await this.authorized(raw,accountRef);const items:BankTransactionRow[]=[],seen=new Set<string>();let continuation:string|undefined;
    for(let page=0;page<20;page++){
      const q=new URLSearchParams({date_from:from,date_to:to,transaction_status:'BOOK'});if(continuation)q.set('continuation_key',continuation);
      const data=await this.get(`/accounts/${accountRef}/transactions?${q}`,c);
      if(!Array.isArray(data.transactions))throw new Error('BANK_RESPONSE_INVALID');
      for(const row of data.transactions){
        if(row.transaction_amount?.currency!=='EUR')throw new Error('BANK_CURRENCY_UNSUPPORTED');
        const providerId=row.transaction_id??row.entry_reference;
        if(typeof providerId!=='string'||!providerId||!/^\d{4}-\d{2}-\d{2}$/.test(row.booking_date))throw new Error('BANK_RESPONSE_INVALID');
        const amountMinor=exactEuroMinor(row.transaction_amount.amount);
        items.push({providerId,accountRef,bookedAt:row.booking_date,amountMinor,currency:'EUR',description:Array.isArray(row.remittance_information)?row.remittance_information.join(' ').slice(0,500):''});
      }
      if(!data.continuation_key)return items;
      if(typeof data.continuation_key!=='string'||seen.has(data.continuation_key))throw new Error('BANK_PAGINATION_INVALID');
      seen.add(data.continuation_key);continuation=data.continuation_key;
    }
    throw new Error('BANK_PAGINATION_LIMIT');
  }
}
