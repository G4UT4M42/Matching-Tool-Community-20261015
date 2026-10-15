import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { mainBrowser } from './helpers/main-browser.mjs';
// Zero bank code, ISO checksum-valid, synthetic and not routable.
const syntheticIban='DE36'+'0'.repeat(18);

const svg='<svg width="1200" height="420" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g font-family="Arial" font-size="40" fill="black"><text x="20" y="80">Invoice SYN-PAYMENT-E2E</text><text x="20" y="145">Supplier Fictional Supplier</text><text x="20" y="210">2026-01-12</text><text x="20" y="275">EUR 12.50</text></g></svg>';

test('actual owner application prepares SEPA, enforces review and one-time confirmation, simulates without contacting any bank, restarts', {timeout:160000}, async()=>{
 const h=await mainBrowser('payment-normal-app');let failure;
 try{
   const {page,fill,click}=h;await h.createOwner();
   const image=join(h.temp,'synthetic-payment.png');await sharp(Buffer.from(svg)).png().toFile(image);
   await h.visit('/documents');await page.waitForSelector('#document-upload-file');
   await (await page.$('#document-upload-file')).uploadFile(image);
   await page.waitForSelector('#document-field-invoice_number');
   await fill('#document-field-invoice_number','SYN-PAYMENT-E2E');
   await fill('#document-field-supplier_name','Fictional Supplier');
   await fill('#document-field-document_date','2026-01-12');
   await fill('#document-field-total_amount','12.50');
   await fill('#document-field-currency_code','EUR');
   await fill('#document-field-payment_reference','SYN PAYMENT E2E');
   await fill('#document-field-iban',syntheticIban);
   await fill('#document-field-due_date','2026-11-15');
   await click('Save corrections');
   await page.waitForFunction(()=>document.body.textContent?.includes('corrected'));
   await click('Confirm invoice');
   await page.waitForFunction(()=>!document.querySelector('#document-field-invoice_number'));
   const financial=h.state();
   const docs=Object.values(financial.documents);
   assert.equal(docs.length,1);assert.equal(docs[0].meta.due_date,'2026-11-15');
   await h.visit('/payments');
   assert.ok(await page.$eval('h1',node=>node.textContent?.includes('Payments')));
   await page.waitForSelector(`input[aria-label="Select ${docs[0].document_id}"]`);
   await page.click(`input[aria-label="Select ${docs[0].document_id}"]`);
   await fill('input[aria-label="Debtor name"]','Fictional Debtor');
   await fill('input[aria-label="Debtor IBAN"]',syntheticIban);
   await click('Create draft');await page.waitForFunction(()=>document.body.textContent?.includes('draft'));
   assert.deepEqual(h.external,[]);await h.screenshot('01-reviewed-payment-draft');
   await click('Validate');await page.waitForFunction(()=>document.querySelector('strong')?.textContent?.includes('validated'));
   await click('Review');await page.waitForFunction(()=>document.querySelector('strong')?.textContent?.includes('reviewed'));
   await click('Download SEPA XML');
   const xml=await h.waitDownload('.xml');
   assert.ok(xml);
   await click('Approve');await page.waitForFunction(()=>document.querySelector('strong')?.textContent?.includes('approved'));
   await click('Confirm this exact payment');await page.waitForFunction(()=>document.body.textContent?.includes('My confirmation expires'));
   await click('Simulate submission (no transfer)');
   await page.waitForFunction(()=>document.querySelector('strong')?.textContent?.includes('acknowledged'));
   await h.screenshot('02-synthetic-submission-acknowledged');
   const dbase=new Database(join(h.runtime,'database','matching.db'),{readonly:true,fileMustExist:true});
   try{
     const rows=dbase.prepare('SELECT id,status,provider,environment,revision,claim_id FROM community_payment_batches').all();
     assert.equal(rows.length,1);assert.equal(rows[0].status,'acknowledged');
     assert.equal(rows[0].provider,'community-simulated-bank');assert.equal(rows[0].environment,'mock');
     assert.ok(rows[0].claim_id);
     const events=dbase.prepare('SELECT action FROM community_payment_events ORDER BY seq').all().map(row=>row.action);
     assert.ok(events.includes('submission_claimed'));assert.ok(events.includes('acknowledged'));
     const confirmation=dbase.prepare('SELECT used_at FROM community_payment_confirmations').get();
     assert.ok(confirmation.used_at,'One-use confirmation must be durably consumed');
     assert.equal(dbase.prepare('SELECT count(*) FROM transactions').pluck().get(),0);
   }finally{dbase.close();}
   await h.restart();await h.visit('/payments');
   await page.waitForFunction(()=>document.body.textContent?.includes('acknowledged'));
   assert.equal(h.state().documents[docs[0].document_id].meta.due_date,'2026-11-15');
   assert.deepEqual(h.external,[]);await h.screenshot('03-reopened-local-payment-history');
   await h.prove({mock_payment:true,actual_main_server:true,real_bank_transfer:false,review_and_approval:true,one_time_confirmation:true,durable_claim:true,sepa_export:true,restart:true,no_external_requests:true});
 }catch(error){failure=error;throw error;}finally{await h.close(failure);}
});
