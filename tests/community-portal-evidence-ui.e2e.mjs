import test from 'node:test';
import assert from 'node:assert/strict';
import {mainBrowser} from './helpers/main-browser.mjs';

test('normal built owner UI captures and imports explicit synthetic receipt evidence with CSRF, role, source-hash and restart proof',{timeout:170000},async()=>{
 const h=await mainBrowser('receipt-evidence-normal-ui',{entrypoint:'tests/helpers/portal-evidence-server.mjs'});let failure;
 try{
  const {page}=h;await h.createOwner();await h.visit('/invoice-bot');
  await h.click('Connect a fresh browser session','[data-portal="aliexpress"]');await page.waitForFunction(()=>document.querySelector('[data-portal="aliexpress"]')?.textContent.includes('Dedicated browser open'));
  await h.click('Find eligible receipt tabs');await page.waitForSelector('input[name="receipt-tab-aliexpress"]');
  assert.equal(await page.$eval('[data-capture-receipt="aliexpress"]',node=>node.disabled),true);
  const tabId=await page.$eval('input[name="receipt-tab-aliexpress"]',node=>node.value),csrf=(await h.read('/auth/session')).data.csrf_token;
  const post=async(path,body,token)=>page.evaluate(async({path,body,token})=>{const response=await fetch('/api'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-CSRF-Token':token}:{})},body:JSON.stringify(body)});return{status:response.status,data:response.status===204?null:await response.json()};},{path,body,token});
  const capturePath='/community/invoice-bot/portals/aliexpress/capture-receipt';
  h.expectHttpFailure({method:'POST',path:'/api'+capturePath,status:403,reason:'Missing CSRF must reject receipt capture before any browser action; exact403 and CSRF_TOKEN_REQUIRED asserted'});
  let denied=await post(capturePath,{tab_id:tabId,confirm_receipt_only:true});assert.equal(denied.status,403);assert.equal(denied.data.code,'CSRF_TOKEN_REQUIRED');
  h.expectHttpFailure({method:'POST',path:'/api'+capturePath,status:400,reason:'Explicit receipt-only affirmation is mandatory; exact400 and INVALID_SELECTION asserted'});
  denied=await post(capturePath,{tab_id:tabId,confirm_receipt_only:false},csrf);assert.equal(denied.status,400);assert.equal(denied.data.code,'INVALID_SELECTION');
  await page.click('input[name="receipt-tab-aliexpress"]');assert.equal(await page.$eval('[data-capture-receipt="aliexpress"]',node=>node.disabled),true);
  await page.click('[data-receipt-confirm="aliexpress"]');await h.click('Capture selected receipt viewport');
  await page.waitForSelector('[data-run]');const runs=await h.read('/community/invoice-bot/runs');assert.equal(runs.status,200);assert.equal(runs.data.items.length,1);const run=runs.data.items[0],evidence=run.discovered[0];
  assert.equal(evidence.evidence_kind,'receipt-capture');assert.equal(evidence.capture.unconfirmed,true);assert.ok(evidence.capture.width*evidence.capture.height<=4000000);assert.match(evidence.filename,/receipt-evidence.*\.png$/);assert.match(evidence.source_id,/^receipt-capture:127\.0\.0\.1:\d{8}T\d{9}Z:[a-f0-9]{64}$/);
  assert.equal(await page.$eval('[data-run]',node=>node.textContent.includes('does not establish a tax invoice')),true);await h.screenshot('01-explicit-unconfirmed-receipt-selection');
  await page.click('[data-run] input[type="checkbox"]');await h.click('Import selected','[data-run]');await page.waitForFunction(()=>document.querySelector('[data-run]')?.textContent.includes('✓'));
  let docs=await h.read('/community/documents');assert.equal(docs.status,200);assert.equal(docs.data.items.length,1);const doc=docs.data.items[0];assert.equal(doc.status,'review');assert.equal(doc.source_kind,'invoice-bot');assert.equal(doc.source_id,'aliexpress:'+evidence.source_id);assert.equal(doc.hash,evidence.source_id.split(':').at(-1));assert.match(doc.filename,/receipt-evidence/);
  const duplicate=await post('/community/invoice-bot/runs/'+run.id+'/import',{source_ids:[evidence.source_id]},csrf);assert.equal(duplicate.status,200);assert.equal((await h.read('/community/documents')).data.items.length,1);
  const sql=h.sql();assert.equal(sql.documents,0);assert.ok(sql.audits>0);assert.ok(JSON.stringify(sql.snapshot).includes(evidence.source_id));assert.ok(!JSON.stringify(sql.snapshot).includes('/p/order/index.html'));
  await h.click('Disconnect','[data-portal="aliexpress"]');await h.restart();docs=await h.read('/community/documents');assert.equal(docs.data.items.length,1);assert.equal(docs.data.items[0].source_id,doc.source_id);assert.equal(docs.data.items[0].hash,doc.hash);assert.equal(docs.data.items[0].status,'review');
  await page.select('#community-language','de');await page.waitForFunction(()=>document.body.textContent.includes('Geführte Sammlung'));await h.screenshot('02-german-receipt-guidance');await page.select('#community-language','en');
  const freshCsrf=(await h.read('/auth/session')).data.csrf_token,password='Synthetic receipt viewer passphrase 2026';const created=await post('/auth/users',{username:'synthetic-receipt-viewer',password,role:'viewer'},freshCsrf);assert.equal(created.status,201);assert.equal((await post('/auth/logout',{},freshCsrf)).status,204);
  await h.visit('/invoice-bot');await h.fill('#account-username','synthetic-receipt-viewer');await h.fill('#account-password',password);await h.click('Sign in');await page.waitForSelector('a[href="/documents"]');await page.waitForSelector('[role="alert"]');assert.equal(await page.$('[data-portal="aliexpress"]'),null);assert.equal(await page.$('[data-capture-receipt]'),null);
  h.expectHttpFailure({method:'GET',path:'/api/community/invoice-bot/portals/aliexpress/receipt-targets',status:403,reason:'Viewer must not inspect or select another actor dedicated receipt tabs; exact403 PERMISSION_REQUIRED asserted'});
  denied=await h.read('/community/invoice-bot/portals/aliexpress/receipt-targets');assert.equal(denied.status,403);assert.equal(denied.data.code,'PERMISSION_REQUIRED');
  const viewerCsrf=(await h.read('/auth/session')).data.csrf_token;h.expectHttpFailure({method:'POST',path:'/api'+capturePath,status:403,reason:'Viewer cannot invoke capture with a valid session token; exact403 PERMISSION_REQUIRED asserted'});
  denied=await post(capturePath,{tab_id:tabId,confirm_receipt_only:true},viewerCsrf);assert.equal(denied.status,403);assert.equal(denied.data.code,'PERMISSION_REQUIRED');await h.screenshot('03-viewer-capture-controls-hidden');
  await h.prove({actual_synthetic_dedicated_chromium_capture:true,explicit_tab_and_receipt_affirmation:true,no_real_accounts_or_provider_calls:true,receipt_not_tax_invoice_label:true,receipt_status:'review',source_id:doc.source_id,source_hash:doc.hash,duplicate_import_idempotent:true,canonical_audit_and_restart_provenance:true,owner_csrf_and_affirmation_negatives:true,viewer_controls_hidden_and_backend_denied:true,languages:['en','de'],qualified_live_provider:false});
 }catch(error){failure=error;throw error;}finally{await h.close(failure);}
});
