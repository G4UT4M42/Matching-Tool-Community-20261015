import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
const invoiceSvg=`<svg width="1400" height="700" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g font-family="Arial" font-size="44" fill="black"><text x="40" y="85">Invoice number: SYN-BROWSER-OCR</text><text x="40" y="160">Supplier: Fictional Components</text><text x="40" y="235">Invoice date: 2026-01-12</text><text x="40" y="310">Net total: EUR 10.00</text><text x="40" y="385">VAT: EUR 2.50</text><text x="40" y="460">Grand total: EUR 12.50</text><text x="40" y="535">Payment reference: SYN-BROWSER-OCR</text></g></svg>`;

export async function financialBrowserJourney(h){
    const{page,fill,click}=h;
    const bank=join(h.temp,'bank.csv');writeFileSync(bank,'Datum;Partnername;Betrag;Waehrung;Referenz;Verwendungszweck\n12.01.2026;Fictional Components;-12.50;EUR;SYN-BANK-OCR;SYN-BROWSER-OCR\n12.01.2026;Fictional Table Supplier;-20.00;EUR;SYN-BANK-PARTIAL;SYN-TABLE-INVOICE');
    await h.visit('/import');await fill('input[aria-label="Local account identifier"]','SYNTHETIC-FINANCE');await(await page.$('input[type="file"]')).uploadFile(bank);await click('Preview statement');await page.waitForFunction(()=>document.body.textContent?.includes('SYN-BANK-OCR'));
    assert.equal(h.sql().transactions,0);await click('Confirm import');await page.waitForFunction(()=>document.body.textContent?.includes('New records: 2'));assert.equal(h.sql().transactions,2);
    await h.screenshot('01-bank-imported');

    const invoice=join(h.temp,'synthetic-invoice.png');await sharp(Buffer.from(invoiceSvg)).png().toFile(invoice);
    await h.visit('/documents');await page.waitForSelector('#document-upload-file');await(await page.$('#document-upload-file')).uploadFile(invoice);
    await page.waitForSelector('#document-field-invoice_number');
    await page.waitForFunction(()=>document.querySelector('#document-field-invoice_number')?.value?.includes('SYN-BROWSER-OCR'));
    assert.equal(await page.$eval('#document-field-total_amount',node=>node.value),'12.50');
    assert.equal(h.sql().documents,0,'OCR suggestions are not a confirmed payable document');
    await fill('#document-field-invoice_number','SYN-BROWSER-OCR');await fill('#document-field-supplier_name','Fictional Components Reviewed');await fill('#document-field-document_date','2026-01-12');
    await fill('#document-field-total_amount','12.50');await fill('#document-field-net_amount','10.00');await fill('#document-field-vat_amount','2.50');await fill('#document-field-currency_code','EUR');
    await click('Save corrections');await page.waitForFunction(()=>document.body.textContent?.includes('corrected'));
    await click('Confirm invoice');await page.waitForFunction(()=>!document.querySelector('#document-field-invoice_number'));
    assert.equal(h.sql().documents,1);await h.screenshot('02-offline-ocr-reviewed-and-confirmed');
    await click('Download');const downloadedInvoice=await h.waitDownload('.png');assert.deepEqual(readFileSync(downloadedInvoice),readFileSync(invoice));

    const table=join(h.temp,'invoices.csv');writeFileSync(table,'source_id;invoice_number;supplier_name;document_date;total_amount;currency_code\nSYN-TABLE-2;SYN-TABLE-INVOICE;Fictional Table Supplier;2026-01-12;20.00;EUR');
    await(await page.$('#document-invoice-file')).uploadFile(table);await page.waitForFunction(()=>[...document.querySelectorAll('[data-document-id]')].some(button=>button.textContent?.includes('invoices.csv')));await page.evaluate(()=>[...document.querySelectorAll('[data-document-id]')].find(button=>button.textContent?.includes('invoices.csv')).click());await page.waitForFunction(()=>document.body.textContent?.includes('SYN-TABLE-INVOICE'));assert.equal(h.sql().documents,2);
    const source=h.state();const txOcr=Object.values(source.transactions).find(tx=>tx.source_row_ref==='SYN-BANK-OCR').transaction_id;
    const txPartial=Object.values(source.transactions).find(tx=>tx.source_row_ref==='SYN-BANK-PARTIAL').transaction_id;
    const docOcr=Object.values(source.documents).find(doc=>doc.source_document_ref==='SYN-BROWSER-OCR').document_id;
    const docPartial=Object.values(source.documents).find(doc=>doc.source_document_ref==='SYN-TABLE-2').document_id;
    assert.equal(source.documents[docOcr].total_amount_minor,1250);assert.equal(source.transactions[txOcr].amount_minor,-1250);

    await h.visit('/accounting');await click('Find exact proposals');await page.waitForFunction(()=>document.querySelectorAll('[data-match-id]').length===2);
    let snapshot=(await h.read('/accounting')).data;
    const first=snapshot.match_groups.find(group=>group.document_ids.includes(docOcr));const second=snapshot.match_groups.find(group=>group.document_ids.includes(docPartial));
    await fill('#accounting-evidence','SYNTHETIC-REVIEWED-INVOICE');await click('Accept',`[data-match-id="${first.match_group_id}"]`);
    await page.waitForFunction(id=>document.querySelector(`[data-match-id="${id}"]`)?.textContent?.includes('accepted'),{},first.match_group_id);
    await click('Reject',`[data-match-id="${second.match_group_id}"]`);await page.waitForFunction(id=>document.querySelector(`[data-match-id="${id}"]`)?.textContent?.includes('rejected'),{},second.match_group_id);
    await click('Reopen',`[data-match-id="${second.match_group_id}"]`);await page.waitForFunction(id=>document.querySelector(`[data-match-id="${id}"]`)?.textContent?.includes('proposed'),{},second.match_group_id);
    await click('Reject',`[data-match-id="${second.match_group_id}"]`);await page.waitForFunction(id=>document.querySelector(`[data-match-id="${id}"]`)?.textContent?.includes('rejected'),{},second.match_group_id);
    await page.select('#accounting-transactionId',txPartial);await page.select('#accounting-documentId',docPartial);await fill('#accounting-amount','-500');await fill('#accounting-documentAmount','500');await fill('#accounting-evidence','SYNTHETIC-PARTIAL-REVIEW');await click('Save Create allocation');
    await page.waitForSelector('[data-allocation-id]');assert.equal(h.state().accounting.allocations.length,1);assert.equal(h.sql().snapshot.accounting.allocations[0].document_amount_minor,500);
    await h.screenshot('03-full-review-and-partial-allocation');

    await page.select('#accounting-transactionId',txOcr);await page.select('#accounting-category','expense');await click('Save Classify transaction');
    await page.waitForFunction(id=>[...document.querySelectorAll(`[data-report-transaction="${id}"] td`)].some(cell=>cell.textContent==='expense'),{},txOcr);
    await page.select('#accounting-transactionId',txPartial);await click('Save Classify transaction');await page.waitForFunction(id=>[...document.querySelectorAll(`[data-report-transaction="${id}"] td`)].some(cell=>cell.textContent==='expense'),{},txPartial);
    await page.select('#accounting-documentId',docOcr);await page.select('#accounting-taxCategory','input');await fill('#accounting-vat','250');await fill('#accounting-rateNumerator','1');await fill('#accounting-rateDenominator','4');await page.click('#accounting-eligible');await click('Save Classify document tax');
    await page.waitForFunction(id=>[...document.querySelectorAll(`[data-report-document="${id}"] td`)].some(cell=>cell.textContent==='250'),{},docOcr);
    const report=(await h.read('/accounting/reports?start=2026-01-01&end=2026-12-31')).data;
    const fullInvoice=report.documents.find(doc=>doc.document_id===docOcr);
    const partialInvoice=report.documents.find(doc=>doc.document_id===docPartial);
    assert.equal(fullInvoice.reconciliation,'fully_matched');
    assert.equal(fullInvoice.remaining_minor,0,'The accepted full match must settle the entire document');
    assert.equal(partialInvoice.reconciliation,'partially_matched');
    assert.equal(partialInvoice.remaining_minor,1500);
    assert.equal(report.rows.find(row=>row.transaction_id===txOcr).remaining_minor,0);
    assert.equal(report.rows.find(row=>row.transaction_id===txPartial).remaining_minor,-1500);
    assert.equal(report.totals_by_currency.EUR.expense,-3250,'Financial totals are exact minor units, not counts');
    const committed=h.state().audit_events;
    for(const action of ['MATCH_ACCEPTED','MATCH_REJECTED','ACCOUNTING_ALLOCATED','ACCOUNTING_TAX_CLASSIFIED'])assert.ok(committed.some(event=>event.action===action),`Missing immutable audit event: ${action}`);
    assert.equal(report.vat_by_currency.EUR.eligible_input_minor,250);
    await click('Export JSON');const reportFile=await h.waitDownload('.json');assert.deepEqual(JSON.parse(readFileSync(reportFile,'utf8')),report);
    await h.screenshot('04-exact-report-and-download');

    await h.visit('/data');await click('Create backup');await page.waitForSelector('[data-backup-id]');await click('Download','[data-backup-id]');const backup=await h.waitDownload('.zip');
    const saved=h.state();assert.equal(saved.schema_version,2);assert.equal(h.sql().version,4);
    await h.screenshot('05-managed-attachments-and-allocation-backup');
    // Change the current dataset through normal controls after the backup, so
    // restore proves a real cutover rather than only replacing identical bytes.
    await h.visit('/accounting');await page.waitForSelector('#accounting-transactionId');await page.select('#accounting-transactionId',txPartial);await page.select('#accounting-documentId',docPartial);await fill('#accounting-amount','-1500');await fill('#accounting-documentAmount','1500');await fill('#accounting-evidence','SYNTHETIC-SECOND-PAYMENT');await click('Save Create allocation');
    await page.waitForFunction(()=>document.querySelectorAll('[data-allocation-id]').length===2);assert.equal(h.state().accounting.allocations.length,2);
    await h.visit('/data');await(await page.$('#restore-backup-file')).uploadFile(backup);await click('Stage and verify');await page.waitForFunction(()=>document.body.textContent?.includes('Backup verified.'));
    await click('Activate verified backup');await page.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent==='Data management');
    assert.deepEqual(h.state(),saved);assert.deepEqual(h.sql().snapshot,saved);assert.equal(h.sql().documents,2);
    await h.screenshot('06-explicitly-restored-earlier-partial-state');
    await h.restart();assert.deepEqual(h.state(),saved);await h.visit('/documents');await page.waitForSelector(`[data-document-id="${docOcr}"]`);await page.click(`[data-document-id="${docOcr}"]`);await click('Preview');await page.waitForSelector('img[alt="synthetic-invoice.png"]');
    assert.equal((await h.read('/accounting')).data.allocations.length,1);await h.screenshot('07-restart-and-source-preview');
return{txOcr,txPartial,docOcr,docPartial,report,saved};
}
