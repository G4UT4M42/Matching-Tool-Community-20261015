import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { EnableBankingAisAdapter } from '../src/community/banking/enablebanking-ais.js';

const account='11111111-1111-4111-8111-111111111111';
const secret={applicationId:'33333333-3333-4333-8333-333333333333',sessionId:'22222222-2222-4222-8222-222222222222',privateKeyPem:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString()};
const row=(overrides:Record<string,unknown>={})=>({transaction_id:'synthetic-debit',status:'BOOK',booking_date:'2026-10-14',credit_debit_indicator:'DBIT',transaction_amount:{amount:'12.34',currency:'EUR'},remittance_information:['Synthetic invoice'],...overrides});
function fixture(rows:unknown[],access:unknown={valid_until:new Date(Date.now()+60000).toISOString()}){
 const calls:string[]=[];
 const adapter=new EnableBankingAisAdapter((async(input:unknown,init?:RequestInit)=>{
   const url=String(input);calls.push(url);expect(init?.method).toBe('GET');expect(url.startsWith('https://api.enablebanking.com/')).toBe(true);
   return new Response(JSON.stringify(url.includes('/sessions/')?{status:'AUTHORIZED',accounts:[account],accounts_data:[{uid:account,identification_hash:'synthetic-stable-account'}],access}:url.endsWith('/details')?{currency:'EUR',name:'Synthetic account'}:{transactions:rows}));
 }) as typeof fetch);
 return{adapter,calls};
}
describe('official AIS contract regression, independently constructed fixtures',()=>{
 it('takes debit/credit direction from mandatory provider evidence, preserves exact minor units',async()=>{
   const {adapter}=fixture([row(),row({transaction_id:'synthetic-credit',credit_debit_indicator:'CRDT',transaction_amount:{amount:'2.34',currency:'EUR'}})]);
   const records=await adapter.transactions(secret,account,'2026-10-01','2026-10-14');
   expect(records.map(x=>x.amountMinor)).toEqual([-1234,234]);
   expect(records.reduce((sum,x)=>sum+x.amountMinor,0)).toBe(-1000);
 });
 it('accepts official account details without the optional UID after session membership is verified',async()=>{
   const {adapter}=fixture([]);expect(await adapter.accounts(secret,account)).toMatchObject([{accountRef:account,currency:'EUR',name:'Synthetic account'}]);
 });
 it.each([{}, {valid_until:'not-a-date'}, {valid_until:'2020-01-01T00:00:00Z'}])('fails closed for absent, invalid or expired consent: %j',async access=>{
   const {adapter,calls}=fixture([row()],access);await expect(adapter.transactions(secret,account,'2026-10-01','2026-10-14')).rejects.toThrow('BANK_CONSENT_REQUIRED');expect(calls).toHaveLength(1);
 });
 it.each([
   row({credit_debit_indicator:undefined}),row({credit_debit_indicator:'UNKNOWN'}),
   row({transaction_amount:{amount:'-12.34',currency:'EUR'}}),row({status:'PDNG'}),
   row({booking_date:'2026-02-30'}),
 ])('rejects ambiguous or non-booked financial evidence',async invalid=>{
   const {adapter}=fixture([invalid]);await expect(adapter.transactions(secret,account,'2026-01-01','2026-12-31')).rejects.toThrow();
 });
});
