import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync,readdirSync,existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { mainBrowser } from './helpers/main-browser.mjs';
import {acceptancePackage} from './helpers/acceptance-package.mjs';

test('normal owner verifies a synthetic preauthorized read-only bank session, restarts and disconnects',{timeout:120000},async()=>{
 const h=await mainBrowser('banking-normal-app',{entrypoint:'tests/helpers/banking-server.mjs'});let failure;
 try{
   await h.createOwner();await h.visit('/banking');const {page,fill,click}=h;
   await page.waitForSelector('#bank-account-ref');await page.click('details summary');
   const capabilities=await h.read('/community-banking/capabilities');assert.equal(capabilities.status,200);assert.equal(capabilities.data[0].paymentInitiation,false);
   const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
   await fill('#bank-account-ref','11111111-1111-4111-8111-111111111111');
   await fill('#bank-application-id','33333333-3333-4333-8333-333333333333');
   await fill('#bank-session-id','22222222-2222-4222-8222-222222222222');await fill('#bank-private-key',key);
   await click('Save connection');await page.waitForFunction(()=>document.body.textContent.includes('Status: Configured'));
   assert.equal(await page.$eval('#bank-private-key',node=>node.value),'');assert.equal(await page.$eval('#bank-session-id',node=>node.value),'');
   assert.equal((await h.read('/community-banking/status')).data.configured,true);
   const vault=join(h.runtime,'identity','bank-vault');const files=readdirSync(vault);assert.equal(files.length,2);for(const file of files){const encrypted=readFileSync(join(vault,file),'utf8');assert.ok(!encrypted.includes('PRIVATE KEY'));assert.ok(!encrypted.includes(key));}
   const db=new Database(join(h.runtime,'database','matching.db'),{readonly:true});try{const stored=JSON.stringify(db.prepare('SELECT * FROM community_bank_connections').all());assert.ok(!stored.includes('PRIVATE KEY'));assert.ok(!stored.includes(key));}finally{db.close();}
   await h.screenshot('01-protected-bank-configuration');await h.restart();await h.visit('/banking');
   await page.waitForFunction(()=>document.body.textContent.includes('Status: Configured'));await click('Disconnect bank');await page.waitForFunction(()=>document.body.textContent.includes('No connection configured'));
   assert.equal((await h.read('/community-banking/status')).data.configured,false);assert.deepEqual(readdirSync(vault),[]);assert.deepEqual(h.external,[]);
   await h.screenshot('02-bank-disconnected');await h.prove({actual_main_server:true,read_only:true,owner_form:true,windows_encryption:true,restart:true,disconnect:true,synthetic_provider_transport:true,application_environment_verified:true,real_payment:false,live_provider_accepted:false});
 }catch(error){failure=error;throw error;}finally{await h.close(failure);}
});

test('new banking consent routes deny owner requests without CSRF and authenticated viewers before provider access',{timeout:120000},async()=>{
 const h=await mainBrowser('banking-consent-access',{entrypoint:'tests/helpers/banking-server.mjs'});let failure;
 try{
  await h.createOwner();const {page}=h,id='44444444-4444-4444-8444-444444444444';
  const paths=['/application','/consents',`/consents/${id}/complete`,`/consents/${id}/select`,`/consents/${id}/cancel`];
  const post=async(path,csrf)=>page.evaluate(async({path,csrf})=>{const response=await fetch('/api/community-banking'+path,{method:'POST',headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body:'{}'});return{status:response.status,data:await response.json()};},{path,csrf});
  for(const path of paths){h.expectHttpFailure({method:'POST',path:'/api/community-banking'+path,status:403,reason:'Owner mutation without session CSRF must fail before banking logic'});const result=await post(path);assert.equal(result.status,403);assert.equal(result.data.code,'CSRF_TOKEN_REQUIRED');}
  const session=(await h.read('/auth/session')).data;
  const created=await page.evaluate(async csrf=>{const response=await fetch('/api/auth/users',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'synthetic-bank-viewer',password:'Synthetic bank viewer passphrase 2026 safe',role:'viewer'})});return response.status;},session.csrf_token);assert.equal(created,201);
  const login=await page.evaluate(async csrf=>{const logout=await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'});const login=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'synthetic-bank-viewer',password:'Synthetic bank viewer passphrase 2026 safe'})});return{logout:logout.status,login:login.status};},session.csrf_token);assert.deepEqual(login,{logout:204,login:200});
  const viewer=(await h.read('/auth/session')).data;assert.equal(viewer.principal.role,'viewer');
  for(const path of paths){h.expectHttpFailure({method:'POST',path:'/api/community-banking'+path,status:403,reason:'Authenticated viewer with valid CSRF lacks bank configuration permission'});const result=await post(path,viewer.csrf_token);assert.equal(result.status,403);assert.equal(result.data.code,'PERMISSION_REQUIRED');}
  h.expectHttpFailure({method:'GET',path:'/api/community-banking/banks?country=AT',status:403,reason:'Viewer cannot discover banks through protected application authority'});assert.equal((await h.read('/community-banking/banks?country=AT')).status,403);
  assert.equal(existsSync(join(h.runtime,'synthetic-bank-transport-count.json')),false,'Denied actions must not invoke the synthetic provider transport');assert.equal(h.sql().transactions,0);
  await h.prove({actual_main_server:true,owner_missing_csrf_denied:5,viewer_valid_csrf_denied:5,viewer_bank_discovery_denied:true,synthetic_provider_calls:0,real_payment:false,live_provider_accepted:false});
 }catch(error){failure=error;throw error;}finally{await h.close(failure);}
});

test('normal owner completes one-use synthetic bank consent, selects account and imports idempotently in an installed package',{timeout:600000},async()=>{
 const bundle=process.env.MATCHING_BANK_CONSENT_PACKAGE?null:acceptancePackage();let h,failure;
 try{
  h=await mainBrowser('banking-consent-normal-app',{entrypoint:'tests/helpers/banking-server.mjs',packageDirectory:process.env.MATCHING_BANK_CONSENT_PACKAGE??bundle.packageDirectory});
  await h.createOwner();await h.visit('/banking');const {page,fill,click}=h;
  const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
  await fill('#bank-application-id','33333333-3333-4333-8333-333333333333');await fill('#bank-private-key',key);await click('Verify and save application');
  await page.waitForFunction(()=>!document.querySelector('#bank-load-banks').matches(':disabled'));
  assert.equal(await page.$eval('#bank-private-key',node=>node.value),'');
  assert.equal((await h.read('/community-banking/status')).data.applicationEnvironment,'sandbox');
  await click('Find banks');await page.waitForSelector('#bank-choice');await page.select('#bank-choice','Synthetic consent bank');await click('Start bank consent');await page.waitForSelector('#bank-authorize');
  // Restart discards in-flight authority while retaining only protected application configuration.
  await h.restart();await h.visit('/banking');assert.equal((await h.read('/community-banking/status')).data.pendingConsent,null);
  await click('Find banks');await page.waitForSelector('#bank-choice');await page.select('#bank-choice','Synthetic consent bank');await click('Start bank consent');await page.waitForSelector('#bank-authorize');
  const authorization=new URL(await page.$eval('#bank-authorize',node=>node.href)),state=authorization.searchParams.get('sessionid');assert.match(state,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(authorization.origin,'https://auth.enablebanking.com');
  const receive=async values=>{const response=await fetch(h.origin+'/api/community-banking/callback?'+new URLSearchParams(values),{redirect:'manual'});assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/banking');assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(await response.text(),'');};
  // Browser-external callback intentionally carries no account cookie or CSRF token.
  await receive({state:'X'.repeat(43),code:'synthetic-once-code'});assert.equal((await h.read('/community-banking/status')).data.pendingConsent.stage,'awaiting_callback');
  await receive({state,code:'synthetic-once-code'});await receive({state,code:'synthetic-forged-replay'});
  assert.equal((await h.read('/community-banking/status')).data.pendingConsent.stage,'callback_received');
  await click('Refresh consent status');await click('Complete connection');await page.waitForSelector('#bank-consent-account');await h.visit('/banking');await page.waitForSelector('#bank-consent-account');
  await page.select('#bank-consent-account','11111111-1111-4111-8111-111111111111');await click('Connect selected account');await page.waitForFunction(()=>document.querySelector('[data-testid=bank-status]').textContent.includes('Configured'));
  await h.screenshot('01-bank-consent-selected');
  // React date input uses its native setter for browser-realistic form state.
  await page.evaluate(()=>{for(const [id,value]of [['bank-import-from','2026-10-01'],['bank-import-to','2026-10-15']]){const node=document.getElementById(id);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));}});
  await click('Import transactions');await page.waitForFunction(()=>document.body.textContent.includes('Imported: 1'));
  const sql=h.sql();assert.equal(sql.transactions,1);await click('Import transactions');await page.waitForFunction(()=>document.body.textContent.includes('Imported: 0'));assert.equal(h.sql().transactions,1);
  await h.screenshot('02-bank-consent-idempotent-import');await h.restart();await h.visit('/banking');assert.equal((await h.read('/community-banking/status')).data.configured,true);await click('Disconnect bank');await page.waitForFunction(()=>document.body.textContent.includes('No connection configured'));const status=(await h.read('/community-banking/status')).data;assert.equal(status.configured,false);assert.equal(status.applicationConfigured,false);
  await h.prove({actual_main_server:true,installed_package:!!h.installedManifest,synthetic_provider_transport:true,bank_consent:true,callback_without_account_cookie:true,forged_state_ignored:true,replay_ignored:true,restart_invalidates_pending:true,account_selection:true,idempotent_sync:true,environment:'sandbox',real_payment:false,live_provider_accepted:false});
 }catch(error){failure=error;throw error;}finally{try{await h?.close(failure);}finally{bundle?.close();}}
});
