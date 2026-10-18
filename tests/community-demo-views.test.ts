import {describe,it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {upCommunityPayments003} from '../src/migrations/003-community-payments.js';
import {createCommunityDemoState} from '../src/server/community-demo-state.js';
import {communityDemoProjection,ensureCommunityDemoDraft} from '../src/server/community-demo-preview.js';
// @ts-expect-error The backend test config omits JSX; Vitest and web/tsconfig check this frontend module.
import {checkedDemoProjection} from '../web/src/pages/CommunityDemoViews';

function fixture(){
 const transactions=[{transaction_id:'SYN-DEMO-1',source_system:'stripe',source_account_id:'SYN-ACCOUNT',source_row_ref:'SYN-ROW',posting_at:'2026-01-01T00:00:00Z',amount_minor:-1200,currency_code:'EUR',description_raw:'Original German Beschreibung <script>data</script>',counterparty_name:'Original supplier'}];
 return{mode:'synthetic-preview',network_enabled:false,capabilities:{read_only_projection:true,provider_network:false,payment_submission:false,synthetic_data:true},transactions,documents:[{document_id:'SYN-DOC',source_system:'invoice_file',source_document_ref:'SYN-ORIGINAL',document_date:'2026-01-01',total_amount_minor:1200,currency_code:'EUR',supplier_name:'Original supplier',vat_amount_minor:200}],accounts:[{source_system:'stripe',source_account_id:'SYN-ACCOUNT',currencies:['EUR'],transaction_count:1}],reports:{accounting:{capability:'exact-accounting-v1',period:{start:'2026-01-01',end:'2026-12-31'},revision:1,rows:transactions.map(t=>({...t,category:'expense',remaining_minor:1200})),documents:[{document_id:'SYN-DOC',currency_code:'EUR',tax_category:'input',vat_minor:200,reconciliation:'unmatched'}],totals_by_currency:{EUR:{expense:-1200}},vat_by_currency:{EUR:{output_minor:0,eligible_input_minor:0,unclassified_documents:0}}}},payments:[{id:'SYN-DRAFT',provider:'community-simulated-bank',environment:'mock',status:'draft',revision:1,detailDigest:'a'.repeat(64),debtorName:'Fictional debtor',debtorIban:'SYNTHETIC-NONROUTABLE',items:[{id:'SYN-ITEM',documentId:'SYN-DOC',creditorName:'Fictional creditor',creditorIban:'SYNTHETIC-NONROUTABLE',amountMinor:1200,currency:'EUR',reference:'Original reference',dueDate:'2026-01-01'}]}]};
}

describe('read-only synthetic preview presentation contract',()=>{
 it('accepts the actual canonical demonstration projection and persisted unsubmitted SQLite draft',()=>{
  const state=createCommunityDemoState(),db=new Database(':memory:');
  try{upCommunityPayments003(db);ensureCommunityDemoDraft(db,state);const raw=communityDemoProjection(db,state),parsed=checkedDemoProjection(raw);
   expect(parsed.transactions).toHaveLength(17);expect(parsed.documents).toHaveLength(13);expect(parsed.accounts).toHaveLength(6);
   expect(parsed.reports.accounting.totals_by_currency).toEqual(raw.reports.accounting.totals_by_currency);
   expect(parsed.reports.accounting.vat_by_currency).toEqual(raw.reports.accounting.vat_by_currency);
   expect(parsed.payments).toHaveLength(1);expect(parsed.payments[0].status).toBe('draft');
   expect(parsed.payments[0].items.map((i:{amountMinor:number})=>i.amountMinor).sort((a:number,b:number)=>a-b)).toEqual([3600,6000]);
   expect(db.prepare('SELECT count(*) FROM community_payment_confirmations').pluck().get()).toBe(0);
  }finally{db.close();}
 });
 it('retains exact signed financial and freeform source fields while dropping unknown metadata',()=>{
  const raw=fixture();const before=JSON.stringify(raw);
  const parsed=checkedDemoProjection({...raw,credentials:{private:'synthetic forbidden property'},documents:raw.documents.map(d=>({...d,meta:{private:'synthetic forbidden metadata'}}))});
  expect(parsed.transactions).toEqual(raw.transactions);
  expect(parsed.reports.accounting.totals_by_currency).toEqual({EUR:{expense:-1200}});
  expect(parsed.documents[0].total_amount_minor).toBe(1200);
  expect(parsed.payments[0].items[0].amountMinor).toBe(1200);
  expect(JSON.stringify(parsed)).not.toContain('synthetic forbidden');
  expect(JSON.stringify(raw)).toBe(before);
 });
 it('rejects active provider authority, unsafe numbers, contradictory report arithmetic and submitted drafts',()=>{
  const mutations:((x:ReturnType<typeof fixture>)=>void)[]=[
   x=>{x.mode='accounts';},x=>{x.network_enabled=true;},x=>{x.capabilities.provider_network=true;},x=>{x.capabilities.payment_submission=true;},
   x=>{x.transactions[0].amount_minor=Number.MAX_SAFE_INTEGER+1;},x=>{x.reports.accounting.totals_by_currency.EUR.expense=-1199;},
   x=>{x.payments[0].environment='live';},x=>{x.payments[0].status='approved';},x=>{Object.assign(x.payments[0],{claimId:'SYN-CLAIM'});},
   x=>{x.payments[0].items[0].amountMinor=0;},x=>{x.payments[0].detailDigest='invalid';},
  ];
  for(const mutate of mutations){const raw=fixture();mutate(raw);expect(()=>checkedDemoProjection(raw)).toThrow('DEMO_RESPONSE_INVALID');}
 });
});
