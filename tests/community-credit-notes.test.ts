import {describe,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import PDFDocument from 'pdfkit';
import XLSX from 'xlsx';
import {checkedDocumentAmounts} from '../src/community/documents/amount-contract.js';
import {parseDocumentTable} from '../src/community/documents/tabular.js';
import {CommunityDocumentService} from '../src/community/documents/service.js';
import {createEmptyState} from '../src/storage/json-store.js';
import {acceptAllocations} from '../src/community/accounting/ledger.js';
import {accountingReport} from '../src/community/accounting/reports.js';
const principal={subject:'SYNTHETIC-OWNER',workspace_id:'SYNTHETIC-WORKSPACE'};
const columns='source_id;invoice_number;supplier_name;document_date;total_amount;currency_code;document_type;net_amount;vat_amount\n';
const row='SYN-CREDIT;SYN-CREDIT;Fictional supplier;2026-01-12;-0.25;EUR;credit_note;-0.20;-0.05';
describe('explicit reviewed credit-note source contract',()=>{
 it('imports signed CSV/XLSX credits and rejects implicit or inconsistent negative evidence',()=>{
  const rows=parseDocumentTable(Buffer.from(columns+row),'.csv','invoice');expect(rows[0]).toMatchObject({document_type:'credit_note',total_amount_minor:-25,net_amount_minor:-20,vat_amount_minor:-5});
  const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet([{source_id:'SYN-XLSX',invoice_number:'SYN-XLSX',supplier_name:'Fictional supplier',document_date:'2026-01-12',total_amount:'-0.25',currency_code:'EUR',document_type:'credit_note',net_amount:'-0.20',vat_amount:'-0.05'}]),'Credit notes');
  expect(parseDocumentTable(XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}),'.xlsx','invoice')[0].total_amount_minor).toBe(-25);
  for(const invalid of[row.replace(';credit_note;',';invoice;'),row.replace('-0.25','0.25'),row.replace('-0.05','0.05'),row.replace('credit_note','unknown')])expect(()=>parseDocumentTable(Buffer.from(columns+invalid),'.csv','invoice')).toThrow();
 });
 it('rejects partial net or VAT components exceeding the signed gross',()=>{for(const input of [['invoice',100,200,undefined],['credit_note',-100,-200,undefined],['credit_note',-100,undefined,-200]]as const)expect(()=>checkedDocumentAmounts(input[0],input[1],input[2],input[3])).toThrow('signed totals');});
 it('preserves corrected sub-unit negative amounts, type, bytes, canonical refund direction and restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'community-credit-synthetic-'));let state=createEmptyState('SYN-CREDIT-RUN');
  const options={root,getState:()=>state,persistAndActivate:(before:typeof state,next:typeof state)=>{expect(before).toBe(state);state=next;}};
  try{
   const pdf=new PDFDocument(),chunks:Buffer[]=[];pdf.on('data',(part:Buffer)=>chunks.push(part));const ready=new Promise<Buffer>(resolve=>pdf.on('end',()=>resolve(Buffer.concat(chunks))));pdf.text('Fictional credit note SYN-CREDIT');pdf.end();const bytes=await ready;
   const service=new CommunityDocumentService(options),upload=await service.upload(principal,bytes,'synthetic-credit.pdf');
   const fields={invoice_number:'SYN-CREDIT',supplier_name:'Fictional supplier',document_date:'2026-01-12',currency_code:'EUR',document_type:'credit_note',total_amount:'-0.25',net_amount:'-0.20',vat_amount:'-0.05'};
   await expect(service.correct(principal,upload.record.id,{...fields,document_type:'invoice'})).rejects.toMatchObject({code:'INVALID_AMOUNT'});
   await service.correct(principal,upload.record.id,fields);await service.confirm(principal,upload.record.id);
   const document=state.documents.get(upload.record.id)!;expect(document.total_amount_minor).toBe(-25);expect(document.meta.document_type).toBe('credit_note');
   const reopened=new CommunityDocumentService(options);expect((await reopened.get(principal,document.document_id)).fields).toMatchObject({document_type:'credit_note',total_amount_minor:-25});expect((await reopened.download(principal,document.document_id)).buffer).toEqual(bytes);
   state.transactions.set('SYN-REFUND',{transaction_id:'SYN-REFUND',source_system:'sparkasse',source_account_id:'SYN-ACCOUNT',source_row_ref:'SYN-REFUND',amount_minor:25,currency_code:'EUR',posting_at:'2026-01-12',description_raw:'Fictional refund',tags:[],meta:{}});
   state=acceptAllocations(state,{revision:0,evidence_ref:'SYN-CREDIT-REVIEW',allocations:[{kind:'refund',transaction_id:'SYN-REFUND',transaction_amount_minor:25,document_id:document.document_id,document_amount_minor:-25}]},principal.subject);
   expect(accountingReport(state,{start:'2026-01-01',end:'2026-12-31'}).documents[0].remaining_minor).toBe(0);
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
