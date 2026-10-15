import { describe, expect, it } from 'vitest';
import { createEmptyState } from '../src/storage/json-store.js';
import { prepareProviderImport } from '../src/community/integrations/canonical-import.js';
import type { CanonicalTransaction, CommitBatch } from '../src/community/integrations/types.js';
import {providerAccountIdentity} from '../src/community/integrations/provider-account.js';

const subject='USR-synthetic-provider-owner';
const account=providerAccountIdentity('stripe','test','acct_SYNTHETIC');
const event=(overrides:Partial<CanonicalTransaction>={}):CanonicalTransaction=>({
 provider:'stripe', environment:'test',account,reference:'txn_synthetic_charge',
 occurredAt:'2026-10-14T00:00:00.000Z',currency:'EUR',amountMinor:1000,feeMinor:-30,
 netMinor:970,classification:'payment',revenue:true,...overrides,
});
const batch=(transactions:CanonicalTransaction[]):Parameters<CommitBatch>[0]=>({
 principal:{subject},provider:'stripe',environment:'test',transactions,checkpoint:{cursor:'2026-10-15T00:00:00.000Z',seen:[]},
});
describe('provider-to-canonical durable import preparation',()=>{
 it('preserves signed provider gross and fee as separate source-identifiable financial ledger rows',()=>{
   const initial=createEmptyState('SYNTHETIC_PROVIDER_CANONICAL');
   const result=prepareProviderImport(initial,batch([event()]));
   expect(initial.transactions.size).toBe(0);
   expect(result.added).toBe(2);
   expect([...result.state.transactions.values()].map(row=>row.amount_minor).sort((a,b)=>a-b)).toEqual([-30,1000]);
   expect([...result.state.transactions.values()].reduce((sum,row)=>sum+row.amount_minor,0)).toBe(970);
   for(const row of result.state.transactions.values()){
     expect(row.source_system).toBe('stripe');
     expect(row.source_account_id).toBe(account+':test');
     expect(row.booking_reference).toBe('txn_synthetic_charge');
     expect(row.currency_code).toBe('EUR');
   }
   expect(result.state.audit_events.at(-1)).toMatchObject({action:'TRANSACTIONS_IMPORTED',actor_id:subject,
     after:{source_events:1,created_ledger_rows:2}});
 });
 it('is idempotent across repeated provider callbacks and prevents changed-source masquerading as a second economic event',()=>{
   const initial=createEmptyState('SYNTHETIC_PROVIDER_DEDUP');
   const first=prepareProviderImport(initial,batch([event()]));
   const again=prepareProviderImport(first.state,batch([event()]));
   expect(again).toMatchObject({added:0,duplicates:2,events:1});
   expect(again.state.audit_events).toEqual(first.state.audit_events);
   expect(again.state.transactions).toEqual(first.state.transactions);
   expect(()=>prepareProviderImport(first.state,batch([event({amountMinor:1001,netMinor:971})]))).toThrow('PROVIDER_SOURCE_CONFLICT');
   expect(first.state.transactions.size).toBe(2);
 });
 it('preserves refund and payout provenance without automatically classifying underlying payouts as new revenue',()=>{
   const state=createEmptyState('SYNTHETIC_PROVIDER_TRANSFERS');
   const refund=event({reference:'txn_refund',amountMinor:-200,feeMinor:0,netMinor:-200,classification:'refund'});
   const payout=event({reference:'txn_payout',amountMinor:-770,feeMinor:0,netMinor:-770,classification:'payout',revenue:false});
   const result=prepareProviderImport(state,batch([event(),refund,payout]));
   expect(result.added).toBe(4);
   expect([...result.state.transactions.values()].reduce((sum,row)=>sum+row.amount_minor,0)).toBe(0);
   expect([...result.state.transactions.values()].find(row=>row.booking_reference==='txn_payout')?.meta.accounting_event_kind).toBe('provider_payout');
   expect(result.state.accounting?.document_taxes).toBeUndefined();
 });
 it('rejects cross-user, cross-environment, forged financial totals and malformed provider evidence without changing the input',()=>{
   const state=createEmptyState('SYNTHETIC_PROVIDER_INVALID');
   for(const bad of [
     event({account:'different-user'}),
     event({environment:'live'}),
     event({netMinor:999}),
     event({feeMinor:0.5}),
     event({reference:'../secret'}),
     event({occurredAt:'not-a-date'}),
   ])expect(()=>prepareProviderImport(state,batch([bad]))).toThrow();
   expect(state.transactions.size).toBe(0);expect(state.audit_events).toHaveLength(0);
 });
});
