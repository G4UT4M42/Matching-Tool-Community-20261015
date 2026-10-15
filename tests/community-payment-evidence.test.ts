import { expect, it } from 'vitest';
import { createEmptyState } from '../src/storage/json-store.js';
import { currentPaymentInvoices } from '../src/community/payments/community-evidence.js';
import { candidate } from '../src/community/payments/validation.js';
import type { Document } from '../src/core/types.js';

const workspace='WS-synthetic-owner-payments';
// ISO checksum-valid synthetic account with a zero bank code; never routable.
const syntheticIban='DE36'+'0'.repeat(18);
const doc=(id:string,meta:Record<string,unknown>={}):Document=>({
 document_id:id,source_system:'upload',source_document_ref:id,captured_at:'2026-10-15T00:00:00Z',
 document_date:'2026-10-01',total_amount_minor:1250,currency_code:'EUR',
 supplier_name:'Fictional Supplier',filename:'synthetic.pdf',file_hash:'a'.repeat(64),
 meta:{workspace_id:workspace,invoice_number:id,document_review_status:'confirmed',settlement_convention:'payable-face-v1',
  iban:syntheticIban,payment_reference:'TEST INVOICE',due_date:'2026-11-15',...meta}
});
it('proposes only workspace-owned, source-backed supplier payables and exact remaining balances',()=>{
 const state=createEmptyState('SYNTHETIC_PAYMENT_EVIDENCE');
 state.documents.set('one',doc('one'));state.documents.set('foreign',doc('foreign',{workspace_id:'WS-elsewhere'}));
 state.documents.set('income',{...doc('income'),meta:{...doc('income').meta,settlement_convention:'receivable-face-v1'}});
 state.transactions.set('bank',{transaction_id:'bank',source_system:'sparkasse',source_account_id:'TEST',source_row_ref:'test',
  posting_at:'2026-10-10',amount_minor:-500,currency_code:'EUR',description_raw:'Synthetic partial',tags:[],meta:{}});
 state.accounting={capability:'exact-accounting-v1',revision:1,allocations:[{
  allocation_id:'allocation',batch_id:'batch',kind:'payment',transaction_id:'bank',document_id:'one',
  transaction_amount_minor:-500,document_amount_minor:500,status:'accepted',created_at:'2026-10-15T00:00:00Z',
  created_by:'USR-owner',evidence_ref:'synthetic'
 }],classifications:[],document_taxes:[]};
 const records=currentPaymentInvoices(state,workspace);
 expect(records).toHaveLength(1);
 expect(records[0]).toMatchObject({documentId:'one',totalMinor:1250,allocatedMinor:500,matchIds:['allocation'],confirmed:true,
  creditorIban:syntheticIban,dueDate:'2026-11-15'});
 expect(candidate(records[0])).toMatchObject({eligible:true,outstandingMinor:750});
 const missing=doc('missing',{iban:undefined,due_date:undefined});
 state.documents.set('missing',missing);
 const evidence=currentPaymentInvoices(state,workspace).find(e=>e.documentId==='missing')!;
 expect(candidate(evidence).eligible).toBe(false);
 expect(candidate(evidence).issues).toContain('IBAN_REVIEW_REQUIRED');
 expect(candidate(evidence).issues).toContain('DUE_DATE_REVIEW_REQUIRED');
});

it('keeps explicit supplier credits out of payable candidates without breaking ordinary invoices',()=>{
 const state=createEmptyState('SYNTHETIC-CREDIT-PAYMENT');state.documents.set('invoice',doc('invoice'));
 const credit={...doc('credit',{document_type:'credit_note'}),total_amount_minor:-25};state.documents.set('credit',credit);
 const records=currentPaymentInvoices(state,workspace);expect(records.map(row=>row.documentId)).toEqual(['invoice']);expect(candidate(records[0]).eligible).toBe(true);
 state.documents.set('credit',{...credit,total_amount_minor:25});expect(()=>currentPaymentInvoices(state,workspace)).toThrow('PAYMENT_EVIDENCE_INVALID');
 state.documents.set('credit',{...credit,meta:{...credit.meta,document_type:undefined}});expect(()=>currentPaymentInvoices(state,workspace)).toThrow('PAYMENT_EVIDENCE_INVALID');
});
