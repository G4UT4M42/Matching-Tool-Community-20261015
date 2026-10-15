import {describe,expect,it} from 'vitest';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareProviderImport} from '../src/community/integrations/canonical-import.js';
import {createEmptyState} from '../src/storage/json-store.js';
import {IntegrationService} from '../src/community/integrations/service.js';
import {CredentialVault,type KeyProtector} from '../src/community/integrations/vault.js';
import {normalizePayPal} from '../src/community/integrations/paypal.js';
import {PayPalClient} from '../src/community/integrations/paypal.js';
import {StripeClient} from '../src/community/integrations/stripe.js';
import type {CanonicalTransaction,CommitBatch} from '../src/community/integrations/types.js';
import {providerAccountIdentity} from '../src/community/integrations/provider-account.js';

const subject='USR-synthetic-identity';
const account=providerAccountIdentity('stripe','test','acct_SYNTHETIC');
const event=(overrides:Partial<CanonicalTransaction>={}):CanonicalTransaction=>({provider:'stripe',environment:'test',account,reference:'txn_identity',occurredAt:'2026-10-14T00:00:00.000Z',currency:'EUR',amountMinor:1000,feeMinor:-30,netMinor:970,classification:'payment',revenue:true,...overrides});
const batch=(transactions:CanonicalTransaction[]):Parameters<CommitBatch>[0]=>({principal:{subject},provider:transactions[0]?.provider??'stripe',environment:transactions[0]?.environment??'test',transactions,checkpoint:{cursor:'2026-10-15T00:00:00.000Z',seen:[]}});
class TestProtector implements KeyProtector{
 private readonly key=randomBytes(32);
 protect(value:Buffer,context:Buffer){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(context);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]);}
 unprotect(value:Buffer,context:Buffer){const cipher=createDecipheriv('aes-256-gcm',this.key,value.subarray(0,12));cipher.setAAD(context);cipher.setAuthTag(value.subarray(-16));return Buffer.concat([cipher.update(value.subarray(12,-16)),cipher.final()]);}
}
describe('provider economic identity independently of mutable row classification',()=>{
 it.each([{classification:'refund' as const},{currency:'USD'}])('rejects changed economic evidence across replay and within a batch: %j',change=>{
  const empty=createEmptyState('SYNTHETIC_IDENTITY');const first=prepareProviderImport(empty,batch([event()]));
  expect(()=>prepareProviderImport(first.state,batch([event(change)]))).toThrow('PROVIDER_SOURCE_CONFLICT');
  expect(()=>prepareProviderImport(empty,batch([event(),event(change)]))).toThrow('PROVIDER_SOURCE_CONFLICT');
  expect(empty.transactions.size).toBe(0);expect(first.state.transactions.size).toBe(2);
  expect([...first.state.transactions.values()].reduce((sum,row)=>sum+row.amount_minor,0)).toBe(970);
 });
 it('preserves the source/fee ID formula, independent referenced fee events, and account/environment scope',()=>{
  const original=event();const first=prepareProviderImport(createEmptyState('SYNTHETIC_HISTORY_IDS'),batch([original]));
  const expectedId=(kind:string)=>'PROV-'+createHash('sha256').update(JSON.stringify(['stripe','test',account,'txn_identity','payment','EUR',kind])).digest('hex').slice(0,40);
  expect([...first.state.transactions.keys()]).toEqual([expectedId('source'),expectedId('fee')]);
  expect(prepareProviderImport(first.state,batch([original]))).toMatchObject({added:0,duplicates:2,importedEvents:0});
  const otherScope=event({account:providerAccountIdentity('stripe','live','acct_OTHER'),environment:'live'});
  expect(prepareProviderImport(first.state,batch([otherScope])).state.transactions.size).toBe(4);
  const paypal=normalizePayPal({transaction_info:{transaction_id:'SYN_PAYPAL',transaction_amount:{value:'10.00',currency_code:'EUR'},fee_amount:{value:'-0.30',currency_code:'USD'},transaction_event_code:'T0006',transaction_initiation_date:'2026-10-14T00:00:00Z'}},'sandbox',providerAccountIdentity('paypal','sandbox','SYNTHETICMERCHANT'));
  const split=prepareProviderImport(first.state,batch(paypal));
  expect(paypal.map(row=>row.reference)).toEqual(['SYN_PAYPAL','SYN_PAYPAL:fee:USD']);
  expect(split.importedEvents).toBe(2);expect(prepareProviderImport(split.state,batch(paypal))).toMatchObject({added:0,duplicates:2});
 });
 it('leaves historical actor-scoped IDs untouched and rejects ambiguous replay even under another actor',()=>{
  const legacy=prepareProviderImport(createEmptyState('SYNTHETIC_LEGACY_IDENTITY'),batch([event()]));
  for(const [id,row]of [...legacy.state.transactions]){legacy.state.transactions.delete(id);const fee=row.tags?.includes('provider-fee');row.transaction_id='PROV-'+createHash('sha256').update(JSON.stringify(['stripe','test',subject,'txn_identity','payment','EUR',fee?'fee':'source'])).digest('hex').slice(0,40);row.source_account_id=subject+':test';delete row.meta.provider_account_identity_scheme;legacy.state.transactions.set(row.transaction_id,row);}
  const unchanged=structuredClone(legacy.state);
  expect(()=>prepareProviderImport(legacy.state,{...batch([event()]),principal:{subject:'USR-another-synthetic-actor'}})).toThrow('PROVIDER_ACCOUNT_BINDING_REQUIRED');
  expect(legacy.state).toEqual(unchanged);
 });
 it('also rejects ambiguous raw legacy source references and Stripe charge aliases without rewriting imported history',()=>{
  const legacy=prepareProviderImport(createEmptyState('SYNTHETIC_LEGACY_FILE'),batch([event()]));
  for(const row of legacy.state.transactions.values()){row.source_account_id='main';row.source_row_ref='ch_synthetic_legacy';row.booking_reference=undefined;row.tags=['charge'];row.meta={stripe_source:'ch_synthetic_legacy'};}
  const unchanged=structuredClone(legacy.state);
  // Different legacy fee/source rows may share the same old charge reference.
  // Source-collision validation still fails closed before any financial write.
  expect(()=>prepareProviderImport(legacy.state,batch([event({reference:'txn_new_balance',relatedReference:'ch_synthetic_legacy'})]))).toThrow();
  expect(legacy.state).toEqual(unchanged);
  const one=createEmptyState('SYNTHETIC_SINGLE_LEGACY_FILE');const row=structuredClone([...legacy.state.transactions.values()][0]);one.transactions.set(row.transaction_id,row);
  expect(()=>prepareProviderImport(one,batch([event({reference:'txn_new_balance',relatedReference:'ch_synthetic_legacy'})]))).toThrow('PROVIDER_ACCOUNT_BINDING_REQUIRED');
  expect(one.transactions.size).toBe(1);
 });
 it('revalidates checkpoint-known rows, retains the cursor on changed evidence, and restores missing accounting rows',async()=>{
  const root=await mkdtemp(join(tmpdir(),'provider-identity-'));const principal={subject};const vault=new CredentialVault(root,new TestProtector());
  let state=createEmptyState('SYNTHETIC_CHECKPOINT_IDENTITY'),now=new Date('2026-10-15T00:00:00.000Z');
  let rows=[{id:'txn_identity',type:'charge',amount:1000,fee:30,net:970,currency:'eur',created:Date.parse('2026-10-14T00:00:00Z')/1000}];
  const observed:number[]=[];
  const service=new IntegrationService(vault,async input=>{observed.push(input.transactions.length);const result=prepareProviderImport(state,input);state=result.state;return result.importedEvents;},async request=>request.url==='https://api.stripe.com/v1/account'?{status:200,json:{id:'acct_SYNTHETIC',object:'account'}}:({status:200,json:{data:rows,has_more:false}}),()=>now);
  const cursor=async()=>{const file=(await readdir(root)).find(name=>name.endsWith('.checkpoint'))!;const envelope=JSON.parse(await readFile(join(root,file),'utf8'));const plain=vault.openMetadata(principal,'stripe','test',Buffer.from(envelope.ciphertext,'base64'));try{return JSON.parse(plain.toString()).checkpoint.cursor;}finally{plain.fill(0);}};
  try{
   await service.configure(principal,'stripe','test',{apiKey:'rk_test_synthetic1234'});
   expect((await service.synchronize(principal,'stripe','test')).imported).toBe(1);
   const ids=[...state.transactions.keys()];expect(await cursor()).toBe('2026-10-15T00:00:00.000Z');
   rows=[{...rows[0],type:'refund'}];now=new Date('2026-10-16T00:00:00.000Z');
   await expect(service.synchronize(principal,'stripe','test')).rejects.toThrow('INTEGRATION_FAILED');
   expect(await cursor()).toBe('2026-10-15T00:00:00.000Z');expect([...state.transactions.keys()]).toEqual(ids);
   rows=[{...rows[0],type:'charge'}];expect((await service.synchronize(principal,'stripe','test')).imported).toBe(0);
   expect(state.audit_events).toHaveLength(1);expect([...state.transactions.keys()]).toEqual(ids);
   state=createEmptyState('SYNTHETIC_ACCOUNTING_RESTORE');
   expect((await service.synchronize(principal,'stripe','test')).imported).toBe(1);
   expect([...state.transactions.keys()]).toEqual(ids);expect(observed).toEqual([1,1,1,1]);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 });
 it('rejects different normalized rows sharing a page key instead of silently discarding one',async()=>{
  const root=await mkdtemp(join(tmpdir(),'provider-page-conflict-'));let commits=0;
  const row={id:'txn_page_conflict',type:'charge',amount:1000,fee:0,net:1000,currency:'eur',created:Date.parse('2026-10-14T00:00:00Z')/1000};
  const service=new IntegrationService(new CredentialVault(root,new TestProtector()),async()=>{commits++;},async request=>request.url==='https://api.stripe.com/v1/account'?{status:200,json:{id:'acct_SYNTHETIC',object:'account'}}:({status:200,json:{data:[row,{...row,type:'refund'}],has_more:false}}),()=>new Date('2026-10-15T00:00:00Z'));
  try{await service.configure({subject},'stripe','test',{apiKey:'rk_test_synthetic1234'});await expect(service.synchronize({subject},'stripe','test')).rejects.toThrow('INVALID_PROVIDER_RESPONSE');expect(commits).toBe(0);expect((await service.status({subject},'stripe','test')).lastSuccess).toBeNull();}
  finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 });
 it.each(['stripe','paypal'] as const)('the same verified %s account cannot become two economic events under different local users',async provider=>{
  const root=await mkdtemp(join(tmpdir(),'provider-real-account-'));let state=createEmptyState('SYNTHETIC_PROVIDER_ACCOUNT');
  const environment=provider==='stripe'?'test':'sandbox';const seenAccounts:string[]=[];
  const transport=async(request:{url:string;method:string})=>{
   if(request.url.endsWith('/v1/account'))return{status:200,json:{id:'acct_SYNTHETIC',object:'account'}};
   if(request.method==='POST')return{status:200,json:{access_token:'synthetic-token',expires_in:3600}};
   if(provider==='stripe')return{status:200,json:{data:[{id:'txn_shared_account',type:'charge',amount:1000,fee:30,net:970,currency:'eur',created:Date.parse('2026-10-14T00:00:00Z')/1000}],has_more:false}};
   return{status:200,json:{account_number:'SYNTHETICMERCHANT',total_pages:1,transaction_details:[{transaction_info:{transaction_id:'SHARED_ACCOUNT',transaction_amount:{value:'10.00',currency_code:'EUR'},fee_amount:{value:'-0.30',currency_code:'EUR'},transaction_event_code:'T0006',transaction_initiation_date:'2026-10-14T00:00:00Z'}}]}};
  };
  const service=new IntegrationService(new CredentialVault(root,new TestProtector()),async input=>{seenAccounts.push(input.transactions[0].account);const result=prepareProviderImport(state,input);state=result.state;return result.importedEvents;},transport,()=>new Date('2026-10-15T00:00:00Z'));
  try{
   const credentials:Record<string,string>=provider==='stripe'?{apiKey:'rk_test_synthetic1234'}:{clientId:'synthetic-client',clientSecret:'synthetic-secret'};
   await service.configure({subject},provider,environment,credentials);expect((await service.synchronize({subject},provider,environment)).imported).toBe(1);const ids=[...state.transactions.keys()];
   await service.configure({subject:'USR-other-synthetic-actor'},provider,environment,credentials);expect((await service.synchronize({subject:'USR-other-synthetic-actor'},provider,environment)).imported).toBe(0);
   expect(seenAccounts[0]).toBe(seenAccounts[1]);expect(seenAccounts[0]).not.toContain(subject);expect([...state.transactions.keys()]).toEqual(ids);expect(state.audit_events).toHaveLength(1);
   expect([...state.transactions.values()].reduce((sum,row)=>sum+row.amount_minor,0)).toBe(970);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 });
 it('fails closed on missing provider account evidence, account-read denial, or inconsistent PayPal page accounts',async()=>{
  let stripeCalls=0;
  const stripe=new StripeClient('rk_test_synthetic1234','test',async()=>{stripeCalls++;return{status:200,json:{data:[],has_more:false}};});
  await expect(stripe.testConnection()).rejects.toThrow('PROVIDER_ACCOUNT_UNAVAILABLE');expect(stripeCalls).toBe(1);
  const denied=new StripeClient('rk_test_synthetic1234','test',async()=>({status:403,json:{message:'synthetic-provider-secret'}}));
  await expect(denied.testConnection()).rejects.toThrow('PROVIDER_PERMISSION_DENIED');
  const absent=new PayPalClient({clientId:'synthetic',clientSecret:'synthetic'},'sandbox',async request=>request.method==='POST'?{status:200,json:{access_token:'synthetic',expires_in:3600}}:{status:200,json:{total_pages:1,transaction_details:[]}});
  await expect(absent.testConnection()).rejects.toThrow('PROVIDER_ACCOUNT_UNAVAILABLE');
  let page=0;const changed=new PayPalClient({clientId:'synthetic',clientSecret:'synthetic'},'sandbox',async request=>request.method==='POST'?{status:200,json:{access_token:'synthetic',expires_in:3600}}:{status:200,json:{account_number:++page===1?'MERCHANTA':'MERCHANTB',total_pages:2,transaction_details:[]}});
  await expect((async()=>{for await(const _ of changed.pages(new Date('2026-10-14'),new Date('2026-10-15'))){} })()).rejects.toThrow('PROVIDER_ACCOUNT_CHANGED');
 });
});
