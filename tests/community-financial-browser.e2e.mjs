import test from 'node:test';
import {mainBrowser} from './helpers/main-browser.mjs';
import {financialBrowserJourney} from './helpers/financial-journey.mjs';

test('normal application financial journey: offline OCR, invoice table, full/partial matching, tax report, export, backup and restore',{timeout:180000},async()=>{
 const h=await mainBrowser('financial-workflows');let failure;try{await h.createOwner();await financialBrowserJourney(h);await h.prove({bank_import:true,offline_english_ocr:true,document_review:true,invoice_table:true,exact_proposals:true,accept_reject:true,partial_allocations:true,explicit_tax_classification:true,report_export:true,content_addressed_backup:true,earlier_state_restore:true,restart:true,financial:{transactions:2,documents:2,partial_allocations:1,input_tax_minor:250},live_provider_connections:false});}catch(error){failure=error;throw error;}finally{await h.close(failure);}
});
