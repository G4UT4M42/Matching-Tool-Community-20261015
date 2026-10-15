import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync,readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { mainBrowser } from './helpers/main-browser.mjs';

test('normal owner configures protected read-only bank fields, sees separate capabilities, restarts and disconnects without a bank request',{timeout:120000},async()=>{
 const h=await mainBrowser('banking-normal-app');let failure;
 try{
   await h.createOwner();await h.visit('/banking');const {page,fill,click}=h;
   await page.waitForSelector('#bank-account-ref');
   const capabilities=await h.read('/community-banking/capabilities');assert.equal(capabilities.status,200);assert.equal(capabilities.data[0].paymentInitiation,false);
   const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
   await fill('#bank-account-ref','11111111-1111-4111-8111-111111111111');
   await fill('#bank-application-id','33333333-3333-4333-8333-333333333333');
   await fill('#bank-session-id','22222222-2222-4222-8222-222222222222');await fill('#bank-private-key',key);
   await click('Save connection');await page.waitForFunction(()=>document.body.textContent.includes('Status: Configured'));
   assert.equal(await page.$eval('#bank-private-key',node=>node.value),'');assert.equal(await page.$eval('#bank-session-id',node=>node.value),'');
   assert.equal((await h.read('/community-banking/status')).data.configured,true);
   const vault=join(h.runtime,'identity','bank-vault');const files=readdirSync(vault);assert.equal(files.length,1);const encrypted=readFileSync(join(vault,files[0]),'utf8');assert.ok(!encrypted.includes('PRIVATE KEY'));assert.ok(!encrypted.includes(key));
   const db=new Database(join(h.runtime,'database','matching.db'),{readonly:true});try{const stored=JSON.stringify(db.prepare('SELECT * FROM community_bank_connections').all());assert.ok(!stored.includes('PRIVATE KEY'));assert.ok(!stored.includes(key));}finally{db.close();}
   await h.screenshot('01-protected-bank-configuration');await h.restart();await h.visit('/banking');
   await page.waitForFunction(()=>document.body.textContent.includes('Status: Configured'));await click('Disconnect bank');await page.waitForFunction(()=>document.body.textContent.includes('No connection configured'));
   assert.equal((await h.read('/community-banking/status')).data.configured,false);assert.deepEqual(readdirSync(vault),[]);assert.deepEqual(h.external,[]);
   await h.screenshot('02-bank-disconnected');await h.prove({actual_main_server:true,read_only:true,owner_form:true,windows_encryption:true,restart:true,disconnect:true,provider_calls:0,real_payment:false,live_provider_accepted:false});
 }catch(error){failure=error;throw error;}finally{await h.close(failure);}
});
