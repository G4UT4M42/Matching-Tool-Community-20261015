import test from 'node:test';
import assert from 'node:assert/strict';
import { mainBrowser } from './helpers/main-browser.mjs';

test('owner application advertises only qualified invoice portals and rejects unsupported automation', {timeout:110000},async()=>{
 const h=await mainBrowser('invoice-bot-normal-app');let failure;
 try{
   const {page}=h;await h.createOwner();await h.visit('/invoice-bot');
   await page.waitForFunction(()=>document.body.textContent?.includes('No supported portal adapter is configured'));
   const portal=await h.read('/community/invoice-bot/portals');
   assert.equal(portal.status,200);assert.deepEqual(portal.data.items,[]);
   const runs=await h.read('/community/invoice-bot/runs');
   assert.equal(runs.status,200);assert.deepEqual(runs.data.items,[]);
   const csrf=(await h.read('/auth/session')).data.csrf_token;
   const unsupported=await page.evaluate(async value=>{
      const response=await fetch('/api/community/invoice-bot/portals/unqualified/connect',{
       method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':value},body:'{}'});
      return{status:response.status,data:await response.json()};
   },csrf);
   assert.equal(unsupported.status,400);assert.equal(unsupported.data.code,'UNSUPPORTED_PORTAL');
   assert.deepEqual(h.external,[]);await h.screenshot('01-no-unsafe-provider-adapters');
   await h.prove({normal_owner_page:true,qualified_portals:0,unsupported_connection_refused:true,credentials_not_requested:true,external_requests:0,actual_live_provider_qualified:false});
 }catch(error){failure=error;throw error;}finally{await h.close(failure)}
});
