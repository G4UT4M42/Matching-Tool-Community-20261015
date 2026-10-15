import test from 'node:test';
import assert from 'node:assert/strict';
import { mainBrowser } from './helpers/main-browser.mjs';

test('owner application exposes assisted portal collection with explicit login boundaries and rejects unsupported automation', {timeout:110000},async()=>{
 const h=await mainBrowser('invoice-bot-normal-app');let failure;
 try{
   const {page}=h;await h.createOwner();await h.visit('/invoice-bot');
   await page.waitForFunction(()=>document.body.textContent?.includes('Assisted collection'));
   const portal=await h.read('/community/invoice-bot/portals');
   assert.equal(portal.status,200);assert.equal(portal.data.items.length,8);assert.ok(portal.data.items.every(item=>item.label.includes('assisted download')));assert.ok(portal.data.items.every(item=>item.origin.startsWith('https://')));
   const runs=await h.read('/community/invoice-bot/runs');
   assert.equal(runs.status,200);assert.deepEqual(runs.data.items,[]);
   const csrf=(await h.read('/auth/session')).data.csrf_token;
   const unsupported=await page.evaluate(async value=>{
      const response=await fetch('/api/community/invoice-bot/portals/unqualified/connect',{
       method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':value},body:'{}'});
      return{status:response.status,data:await response.json()};
   },csrf);
   assert.equal(unsupported.status,400);assert.equal(unsupported.data.code,'UNSUPPORTED_PORTAL');
   assert.deepEqual(h.external,[]);await h.screenshot('01-assisted-portals-explicit-owner-login');
   await h.prove({normal_owner_page:true,assisted_portals:8,qualified_live_portals:0,unsupported_connection_refused:true,credentials_not_requested:true,external_requests:0,actual_live_provider_qualified:false});
 }catch(error){failure=error;throw error;}finally{await h.close(failure)}
});
