import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';

test('actual React choices distinguish equal amounts and localize OCR guidance in English and German',{timeout:60000},async()=>{
  const evidence=process.env.COMMUNITY_UI_CONTEXT_EVIDENCE;
  if(evidence)mkdirSync(resolve(evidence),{recursive:true});
  const out=mkdtempSync(join(evidence?resolve(evidence):tmpdir(),'community-ui-context-'));
  await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{CommunityAccounting}from'./web/src/pages/CommunityAccounting.tsx';import{CommunityDocuments}from'./web/src/pages/CommunityDocuments.tsx';import{LanguageProvider}from'./web/src/i18n/locale.tsx';const locale=new URLSearchParams(location.search).get('locale')==='de'?'de':'en';localStorage.setItem('matching-community-locale',locale);createRoot(document.getElementById('root')).render(<LanguageProvider><div id="accounting-harness"><CommunityAccounting locale={locale}/></div><div id="documents-harness"><CommunityDocuments/></div></LanguageProvider>);`,resolveDir:resolve('.'),sourcefile:'synthetic-context.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',outfile:join(out,'harness.js'),alias:{react:resolve('web/node_modules/react'),'react-dom/client':resolve('web/node_modules/react-dom/client')},logLevel:'silent'});
  const transactions=[
    {transaction_id:'TXN-synthetic-opaque-001',source_system:'sparkasse',source_account_id:'SYN-MAIN-A',posting_at:'2026-10-12',booking_reference:'SYN-BOOK-A',payment_reference:'SYN-PAY-A',source_row_ref:'SYN-ROW-A',counterparty_name:'Fictional Alpha',description_raw:'Synthetic Alpha purchase',amount_minor:-1000,currency_code:'EUR'},
    {transaction_id:'TXN-synthetic-opaque-002',source_system:'visa',source_account_id:'SYN-CARD-B',posting_at:'2026-10-13',booking_reference:'SYN-BOOK-B',payment_reference:'SYN-PAY-B',source_row_ref:'SYN-ROW-B',counterparty_name:'Fictional Beta',description_raw:'Synthetic Beta <img data-injected="bad" src="bad"> purchase',amount_minor:-1000,currency_code:'EUR'},
  ];
  const documents=[
    {document_id:'DOC-synthetic-opaque-001',source_document_ref:'SYN-SOURCE-A',supplier_name:'Fictional Alpha',document_date:'2026-10-10',total_amount_minor:1000,currency_code:'EUR',meta:{invoice_number:'SYN-INV-A'}},
    {document_id:'DOC-synthetic-opaque-002',source_document_ref:'SYN-SOURCE-B',supplier_name:'Fictional Beta',document_date:'2026-10-11',total_amount_minor:1000,currency_code:'EUR',meta:{invoice_number:'SYN-INV-B'}},
  ];
  const rawText='Original OCR evidence: Currency is missing or ambiguous <b data-injected="bad">unchanged</b>';
  const warnings=['DOCUMENT_CURRENCY_MISSING_OR_AMBIGUOUS','Invoice number is missing or ambiguous','OCR_TIMEOUT','The local OCR language resource is unavailable','Original provider notice <img data-injected="bad" src="bad">'];
  const record={id:'DOC-synthetic-review',filename:'synthetic-review.pdf',status:'review',hash:'a'.repeat(64),fields:{invoice_number:'SYN-REVIEW'},recognition:{confidence:0.5,raw_text:rawText,warnings},history:[{at:'2026-10-15T00:00:00Z',actor:'synthetic-original-owner',action:'uploaded'}]};
  const originalRecord=JSON.stringify(record),posts=[],observations=[],app=express();app.use(express.json());
  app.get('/api/accounting',(_req,res)=>res.json({revision:0,transactions,documents,allocations:[],match_groups:[],exclusion_rules:[]}));
  app.get('/api/accounting/reports',(_req,res)=>res.json({rows:[],documents:[],totals_by_currency:{},vat_by_currency:{}}));
  app.post('/api/accounting/allocations',(req,res)=>{posts.push(req.body);res.json({revision:1});});
  app.get('/api/community/documents',(_req,res)=>res.json({items:[record]}));
  app.get('/harness.js',(_req,res)=>res.sendFile(join(out,'harness.js')));
  app.get('/',(_req,res)=>res.type('html').send('<!doctype html><html><body><div id="root"></div><script src="/harness.js"></script></body></html>'));
  const server=app.listen(0,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));let browser;
  try{
    const executablePath=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);assert.ok(executablePath,'An isolated Chromium executable is required');
    browser=await puppeteer.launch({executablePath,headless:true,userDataDir:join(out,'synthetic-browser'),args:['--no-first-run','--disable-background-networking','--disable-extensions']});const page=await browser.newPage();page.setDefaultTimeout(10000);
    for(const locale of ['en','de']){
      await page.goto('http://127.0.0.1:'+server.address().port+'/?locale='+locale,{waitUntil:'networkidle0'});
      await page.waitForSelector('#accounting-transactionId option[value="TXN-synthetic-opaque-002"]');
      const labels=await page.evaluate(()=>({transactions:[...document.querySelectorAll('#accounting-transactionId option')].slice(1).map(n=>({value:n.value,text:n.textContent})),documents:[...document.querySelectorAll('#accounting-documentId option')].slice(1).map(n=>({value:n.value,text:n.textContent}))}));
      assert.equal(labels.transactions[0].value,transactions[0].transaction_id);assert.equal(labels.transactions[1].value,transactions[1].transaction_id);
      assert.notEqual(labels.transactions[0].text,labels.transactions[1].text);assert.notEqual(labels.documents[0].text,labels.documents[1].text);
      const txLabel=labels.transactions[1].text;for(const value of ['visa','SYN-CARD-B','2026-10-13','Fictional Beta','SYN-BOOK-B','SYN-PAY-B','SYN-ROW-B','Synthetic Beta <img','TXN-synthetic-opaque-002'])assert.ok(txLabel.includes(value),value);
      const docLabel=labels.documents[1].text;for(const value of ['Fictional Beta','SYN-INV-B','2026-10-11','DOC-synthetic-opaque-002'])assert.ok(docLabel.includes(value),value);
      assert.ok(txLabel.includes(locale==='de'?'Konto:':'Account:'));assert.ok(docLabel.includes(locale==='de'?'Rechnung:':'Invoice:'));
      assert.ok(txLabel.includes(locale==='de'?'10,00':'10.00'));assert.ok(docLabel.includes(locale==='de'?'10,00':'10.00'));
      // Choose by the owner-visible source/invoice context, then verify only the
      // unchanged canonical IDs are submitted to the accounting endpoint.
      const choice=labels.transactions.find(item=>item.text.includes('SYN-CARD-B')&&item.text.includes('Fictional Beta'));
      const invoice=labels.documents.find(item=>item.text.includes('SYN-INV-B')&&item.text.includes('Fictional Beta'));
      await page.select('#accounting-transactionId',choice.value);await page.select('#accounting-documentId',invoice.value);
      await page.type('#accounting-amount','-1000');await page.type('#accounting-documentAmount','1000');await page.type('#accounting-evidence','SYNTHETIC-CONTEXT');
      const count=posts.length,saved=page.waitForResponse(response=>response.url().endsWith('/api/accounting/allocations')&&response.request().method()==='POST');await page.evaluate(locale=>[...document.querySelectorAll('#accounting-harness button')].find(n=>n.textContent===(locale==='de'?'Speichern Zuordnung erstellen':'Save Create allocation')).click(),locale);await saved;
      await page.waitForFunction(()=>!document.querySelector('#accounting-harness fieldset').disabled);assert.equal(posts.length,count+1);assert.deepEqual(posts.at(-1).allocations[0],{kind:'payment',transaction_id:transactions[1].transaction_id,transaction_amount_minor:-1000,document_id:documents[1].document_id,document_amount_minor:1000});
      await page.click('[data-document-id="DOC-synthetic-review"]');await page.waitForSelector('#documents-harness pre');
      const rendered=await page.evaluate(()=>({warnings:[...document.querySelectorAll('#documents-harness details:first-of-type ul li')].map(n=>n.textContent),raw:document.querySelector('#documents-harness pre').textContent,injected:document.querySelectorAll('[data-injected]').length}));
      assert.equal(rendered.raw,rawText);assert.equal(rendered.injected,0);assert.equal(rendered.warnings.at(-1),warnings.at(-1));
      const expected=locale==='de'?['Die Währung fehlt oder ist mehrdeutig.','Die Rechnungsnummer fehlt oder ist mehrdeutig.','Die Erkennung hat das Zeitlimit pro Seite überschritten. Bitte prüfen Sie die Felder manuell.','Die lokale OCR-Sprachdatei ist nicht verfügbar. Bitte prüfen Sie die Felder manuell.']:['Currency is missing or ambiguous','Invoice number is missing or ambiguous','Recognition exceeded the per-page processing limit. Review fields manually.','The local OCR language resource is unavailable. Review fields manually.'];
      assert.deepEqual(rendered.warnings.slice(0,4),expected);assert.equal(JSON.stringify(record),originalRecord);observations.push({locale,result:'PASS',labels,renderedWarnings:rendered.warnings,submittedIdsUnchanged:true,sourceEvidenceUnchanged:true});
    }
    writeFileSync(join(out,'observations.json'),JSON.stringify({result:'PASS',scope:'Actual React source with controlled synthetic equal-amount records and immutable OCR evidence; independent esbuild output only',observations},null,2)+'\n');
  }finally{if(browser)await browser.close();await new Promise(ok=>server.close(ok));}
});
