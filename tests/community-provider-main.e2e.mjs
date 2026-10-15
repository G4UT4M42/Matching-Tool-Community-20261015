import test from 'node:test';
import assert from 'node:assert/strict';
import { mainBrowser } from './helpers/main-browser.mjs';

test('normal owner can configure independent read-only PayPal/Stripe vaults, revoke, and block viewer/CSRF', {timeout:150000}, async()=>{
  const h=await mainBrowser('provider-normal-app');let failure;
  try {
    const {page,fill,click}=h; await h.createOwner();
    await h.visit('/integrations'); await page.waitForSelector('#integration-client-id');
    assert.ok(await page.$eval('h1',node=>node.textContent?.includes('Integrations')));
    await fill('#integration-client-id','synthetic-client');
    await fill('#integration-client-secret','synthetic-secret');
    await click('Save configuration');
    await page.waitForFunction(()=>document.querySelector('[data-testid="integration-status"]')?.textContent?.includes('Configured'));
    assert.equal(await page.$eval('#integration-client-secret',node=>node.value),'');
    const paypal=(await h.read('/community/integrations/paypal/sandbox')).data;
    assert.equal(paypal.configured,true);assert.equal(paypal.lastSuccess,null);
    assert.ok(!JSON.stringify(paypal).includes('synthetic-secret'),'A status response must not disclose credentials');
    await h.screenshot('01-owner-paypal-vault-status');
    await page.select('#integration-provider','stripe');
    await page.waitForSelector('#integration-api-key');
    await fill('#integration-api-key','rk_test_synthetic12345678');
    await click('Save configuration');
    await page.waitForFunction(()=>document.querySelector('[data-testid="integration-status"]')?.textContent?.includes('Configured'));
    assert.equal((await h.read('/community/integrations/stripe/test')).data.configured,true);
    await h.screenshot('02-owner-stripe-vault-status');
    await page.select('#integration-provider','paypal');
    await page.waitForFunction(()=>document.querySelector('[data-testid="integration-status"]')?.textContent?.includes('Configured'));
    await click('Disconnect');
    await page.waitForFunction(()=>document.querySelector('[data-testid="integration-status"]')?.textContent?.includes('Not configured'));
    assert.equal((await h.read('/community/integrations/paypal/sandbox')).data.configured,false);
    assert.equal((await h.read('/community/integrations/stripe/test')).data.configured,true);
    const unauthorized=await page.evaluate(async()=>{const response=await fetch('/api/community/integrations/paypal/sandbox',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({credentials:{clientId:'fake',clientSecret:'fake'}})});return{status:response.status,data:await response.json()};});
    assert.equal(unauthorized.status,403);assert.equal(unauthorized.data.code,'CSRF_TOKEN_REQUIRED');
    const session=(await h.read('/auth/session')).data;
    assert.equal(session.authenticated,true);
    const create=await page.evaluate(async csrf=>{
      const response=await fetch('/api/auth/users',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'synthetic-provider-viewer',password:'Synthetic viewer password 2026 safe',role:'viewer'})});
      return {status:response.status,data:await response.json()};
    },session.csrf_token);
    assert.equal(create.status,201);
    const loggedIn=await page.evaluate(async csrf=>{
      const logout=await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'});
      const login=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'synthetic-provider-viewer',password:'Synthetic viewer password 2026 safe'})});
      return {logout:logout.status,login:login.status};
    },session.csrf_token);
    assert.deepEqual(loggedIn,{logout:204,login:200});
    await page.reload({waitUntil:'networkidle2'});
    await page.waitForSelector('nav');
    assert.equal(await page.$('nav a[href="/integrations"]'),null,'Viewer must not see a privileged integration link');
    const forbidden=await h.read('/community/integrations/stripe/test');
    assert.equal(forbidden.status,403);
    await h.prove({provider_vault_status:true,paypal_sandbox_owner:true,stripe_test_owner:true,independent_disconnect:true,csrf_denial:true,viewer_denial:true,live_provider_requests:false,payment_execution:false});
  } catch(error){failure=error;throw error;} finally {await h.close(failure);}
});
