import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {normalizePayPal} from '../src/community/integrations/paypal.js';
import {providerAccountIdentity} from '../src/community/integrations/provider-account.js';
import {prepareProviderImport} from '../src/community/integrations/canonical-import.js';
import {createEmptyState} from '../src/storage/json-store.js';
import {accountingReport} from '../src/community/accounting/reports.js';
import {classifyTransaction} from '../src/community/accounting/ledger.js';
import {CredentialVault,type KeyProtector} from '../src/community/integrations/vault.js';
import {IntegrationService} from '../src/community/integrations/service.js';
import type {CanonicalTransaction,Transport} from '../src/community/integrations/types.js';

const account=providerAccountIdentity('paypal','sandbox','SYNTHETICEVENTMERCHANT');
const entry=(code:string,amount='10.00',status:unknown='S',id='SYN-'+code)=>({transaction_info:{transaction_id:id,transaction_event_code:code,transaction_status:status,transaction_amount:{value:amount,currency_code:'EUR'},transaction_initiation_date:'2026-01-02T00:00:00Z'}});
const normalize=(code:string,amount='10.00')=>normalizePayPal(entry(code,amount),'sandbox',account)[0];

it('uses PayPal economic event codes rather than the sign for purchases, refunds, fees, funding, withdrawals and chargebacks',()=>{
 expect(normalize('T0006','-10.00')).toMatchObject({classification:'payment',amountMinor:-1000});
 for(const code of ['T1107','T1115','T1120'])for(const amount of ['10.00','-10.00'])expect(normalize(code,amount)).toMatchObject({classification:'refund',amountMinor:amount.startsWith('-')?-1000:1000,revenue:true});
 for(const code of ['T0100','T0106','T0114','T1108','T1109'])expect(normalize(code,'-1.25')).toMatchObject({classification:'fee',amountMinor:-125,revenue:false});
 for(const code of ['T0200','T0201','T0300','T0301','T0701','T1101','T1104','T1112','T2000'])expect(normalize(code)).toMatchObject({classification:'transfer',revenue:false});
 for(const code of ['T0400','T0401','T1700'])expect(normalize(code,'-10.00')).toMatchObject({classification:'payout',revenue:false});
 for(const code of ['T1106','T1201','T1202','T1205','T1207','T1208'])expect(normalize(code)).toMatchObject({classification:'dispute'});
 for(const code of ['T0600','T0700','T1200','T1204','T1900','T9900','T7777','T0020','T0021','T2103'])expect(normalize(code)).toMatchObject({classification:'other',revenue:false});
 for(const code of ['T9800','T1300','T1301','T1302','T0505'])expect(normalizePayPal(entry(code),'sandbox',account)).toEqual([]);
 expect(()=>normalize('not-a-code')).toThrow('INVALID_PROVIDER_RESPONSE');
});

it('does not invent a second cash reversal for status V or import a pending, denied or incomplete event as settled money',()=>{
 const successful=normalizePayPal(entry('T0006'),'sandbox',account),reversed=normalizePayPal(entry('T0006','10.00','V'),'sandbox',account);
 expect(reversed.map(({providerStatus,...cash})=>cash)).toEqual(successful.map(({providerStatus,...cash})=>cash));
 const original=createEmptyState('SYNTHETIC_PAYPAL_REVERSAL'),batch={principal:{subject:'synthetic-owner'},provider:'paypal' as const,environment:'sandbox' as const,checkpoint:{cursor:null,seen:[]}};
 const first=prepareProviderImport(original,{...batch,transactions:successful});
 const next=prepareProviderImport(first.state,{...batch,transactions:[...reversed,normalize('T1107','-10.00')]});
 expect(next.state.transactions.size).toBe(2);expect([...next.state.transactions.values()].reduce((sum,row)=>sum+row.amount_minor,0)).toBe(0);
 expect([...next.state.transactions.values()].find(row=>row.booking_reference==='SYN-T0006')).toEqual([...first.state.transactions.values()][0]);
 expect(next.state.audit_events.flatMap(audit=>(audit.after?.provider_observations as Array<{status:string}>|undefined)??[]).map(observation=>observation.status)).toEqual(['S','V','S']);
 const retry=prepareProviderImport(next.state,{...batch,transactions:[...reversed,normalize('T1107','-10.00')]});expect(retry.added).toBe(0);expect(retry.observations).toBe(0);expect(retry.state.audit_events).toEqual(next.state.audit_events);
 expect(normalizePayPal(entry('T0006','10.00','D'),'sandbox',account)).toEqual([]);
 expect(()=>normalizePayPal(entry('T0006','10.00','P'),'sandbox',account)).toThrow('PROVIDER_TRANSACTION_PENDING');
 expect(()=>normalizePayPal(entry('T0006','10.00',null),'sandbox',account)).toThrow('INVALID_PROVIDER_RESPONSE');
 for(const status of [['S'],['V'],{status:'S'},1])expect(()=>normalizePayPal(entry('T0006','10.00',status),'sandbox',account)).toThrow('INVALID_PROVIDER_RESPONSE');
 const incomplete=entry('T0006');delete (incomplete.transaction_info as Record<string,unknown>).transaction_status;
 expect(()=>normalizePayPal(incomplete,'sandbox',account)).toThrow('PROVIDER_TRANSACTION_INCOMPLETE');
});

it('keeps funding and withdrawals out of revenue reports, preserves exact fees and rejects silent reclassification of older imported evidence',()=>{
 const entries=[normalize('T0300','100.00'),normalize('T0006','10.00'),normalize('T0100','-1.25'),normalize('T0400','-50.00')];
 const batch={principal:{subject:'synthetic-owner'},provider:'paypal' as const,environment:'sandbox' as const,transactions:entries,checkpoint:{cursor:'2026-01-03T00:00:00Z',seen:[]}};
 const initial=createEmptyState('SYNTHETIC_PAYPAL_EVENTS'),first=prepareProviderImport(initial,batch),again=prepareProviderImport(first.state,batch);
 expect(first.added).toBe(4);expect(again.added).toBe(0);expect(again.state.transactions).toEqual(first.state.transactions);
 const funding=[...first.state.transactions.values()].find(row=>row.booking_reference==='SYN-T0300')!;
 expect(funding.meta.accounting_event_kind).toBe('provider_transfer');
 expect(()=>classifyTransaction(first.state,{revision:0,transaction_id:funding.transaction_id,category:'income',evidence_ref:'SYN-FUNDING'},'synthetic-owner')).toThrow('revenue');
 const report=accountingReport(first.state,{start:'2026-01-01',end:'2026-01-31'});
 expect(report.totals_by_currency.EUR.transfer).toBe(5000);expect(report.totals_by_currency.EUR.income).toBeUndefined();
 expect([...first.state.transactions.values()].find(row=>row.booking_reference==='SYN-T0100')).toMatchObject({amount_minor:-125,meta:{provider_classification:'fee'}});
 const old=prepareProviderImport(initial,{...batch,transactions:[{...entries[0],classification:'payment',revenue:true}]});
 expect(()=>prepareProviderImport(old.state,{...batch,transactions:[entries[0]]})).toThrow('PROVIDER_SOURCE_CONFLICT');
 expect(old.state.transactions.size).toBe(1);expect([...old.state.transactions.values()][0].meta.provider_classification).toBe('payment');
});

class SyntheticProtector implements KeyProtector{
 private key=randomBytes(32);
 protect(plain:Buffer,context:Buffer){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(context);return Buffer.concat([iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);}
 unprotect(value:Buffer,context:Buffer){const cipher=createDecipheriv('aes-256-gcm',this.key,value.subarray(0,12));cipher.setAAD(context);cipher.setAuthTag(value.subarray(-16));return Buffer.concat([cipher.update(value.subarray(12,-16)),cipher.final()]);}
}
it('retries an unresolved historical window after a multi-day delay and restart without advancing its cursor or duplicating accounting',async()=>{
 const root=await mkdtemp(join(tmpdir(),'community-paypal-pending-')),protector=new SyntheticProtector(),owner={subject:'synthetic-pending-owner'};
 let now=new Date('2026-01-10T00:00:00Z'),status:unknown='P';const starts:string[]=[],commits:CanonicalTransaction[][]=[];
 const transport:Transport=async request=>{const url=new URL(request.url);if(url.pathname==='/v1/oauth2/token')return{status:200,json:{access_token:'synthetic-token',expires_in:3600}};expect(url.searchParams.get('balance_affecting_records_only')).toBe('Y');starts.push(url.searchParams.get('start_date')!);const detail=entry('T0006','10.00',status,'SYN-PENDING');if(status===undefined)delete (detail.transaction_info as Record<string,unknown>).transaction_status;return{status:200,json:{account_number:'SYNTHETICEVENTMERCHANT',total_pages:1,transaction_details:[detail]}};};
 const service=()=>new IntegrationService(new CredentialVault(root,protector),async batch=>{commits.push(batch.transactions);},transport,()=>now);
 try{
  let instance=service();await instance.configure(owner,'paypal','sandbox',{clientId:'synthetic-client',clientSecret:'synthetic-secret'});
  await expect(instance.synchronize(owner,'paypal','sandbox')).rejects.toThrow('PROVIDER_TRANSACTION_PENDING');expect(commits).toHaveLength(0);expect((await instance.status(owner,'paypal','sandbox')).lastSuccess).toBeNull();
  now=new Date('2026-01-12T00:00:00Z');status=undefined;instance=service();await expect(instance.synchronize(owner,'paypal','sandbox')).rejects.toThrow('PROVIDER_TRANSACTION_INCOMPLETE');expect(commits).toHaveLength(0);expect((await instance.status(owner,'paypal','sandbox')).lastSuccess).toBeNull();
  now=new Date('2026-01-15T00:00:00Z');status='S';instance=service();expect((await instance.synchronize(owner,'paypal','sandbox')).imported).toBe(1);
  expect(starts[1]).toBe(starts[0]);expect(starts[2]).toBe(starts[0]);expect(commits.flat().filter(event=>event.reference==='SYN-PENDING').length).toBeGreaterThan(0);
  expect((await instance.synchronize(owner,'paypal','sandbox')).imported).toBe(0);
 }finally{const absolute=resolveRoot(root);await rm(absolute,{recursive:true,force:true});}
});
function resolveRoot(root:string){if(!root.startsWith(join(tmpdir(),'community-paypal-pending-')))throw Error('Unexpected synthetic root');return root;}
