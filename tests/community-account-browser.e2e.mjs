import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer-core';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const password='Synthetic account browser passphrase 2026';
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function freePort(){const socket=createServer();await new Promise((ok,fail)=>{socket.once('error',fail);socket.listen(0,'127.0.0.1',ok);});const port=socket.address().port;await new Promise(ok=>socket.close(ok));return port;}
function start(runtime,port,setupCode){
  const env={...process.env,PORT:String(port),MATCHING_RUNTIME_MODE:'external-runtime-root',MATCHING_RUNTIME_ROOT:runtime,
    MATCHING_AUTH_MODE:'accounts',MATCHING_DEMO_MODE:'false',MATCHING_SETUP_TOKEN:setupCode,MATCHING_HTTP_HOST:'127.0.0.1',MATCHING_ENABLE_BANK_AUTOMATION:'false'};
  delete env.MATCHING_LOCAL_ACCESS_TOKEN;
  const child=spawn(process.execPath,['--import','tsx','src/server/index.ts'],{cwd:repository,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const result={child,log:'',origin:`http://127.0.0.1:${port}`};
  child.stdout.on('data',chunk=>{result.log=(result.log+chunk).slice(-65536);});child.stderr.on('data',chunk=>{result.log=(result.log+chunk).slice(-65536);});return result;
}
async function ready(server){for(let attempt=0;attempt<100;attempt++){if(server.child.exitCode!==null)throw new Error('Synthetic main server exited: '+server.log);try{const r=await fetch(server.origin+'/health',{signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}await pause(100);}throw new Error('Synthetic main server was not ready');}
async function stop(server){
  if(!server||server.child.exitCode!==null||server.child.signalCode!==null)return;
  const exited=new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(new Error('Test-owned server did not exit')),10000);server.child.once('exit',()=>{clearTimeout(timer);ok();});});
  if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(server.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});else server.child.kill('SIGTERM');
  await exited;
}
function totals(runtime){const db=new Database(join(runtime,'database','matching.db'),{readonly:true,fileMustExist:true});try{return {transactions:Number(db.prepare('SELECT count(*) FROM transactions').pluck().get()),audit:Number(db.prepare('SELECT count(*) FROM audit_events').pluck().get())};}finally{db.close();}}

test('real application browser: create owner, import reviewed statement, manage viewer, enforce roles, restart and sign out', {timeout:90000}, async()=>{
  const temporary=mkdtempSync(join(tmpdir(),'matching-real-account-browser-synthetic-'));
  const runtime=join(temporary,'runtime');mkdirSync(runtime);
  const setupCode=randomBytes(32).toString('base64url'),port=await freePort();
  const statement=join(temporary,'fictional-statement.csv');writeFileSync(statement,'Datum;Partnername;Betrag;Waehrung;Referenz;Verwendungszweck\n13.01.2026;Fictional Browser Supplier;-12,34;EUR;SYN-REAL-BROWSER;Synthetic test purchase');
  const artifactRoot=process.env.MATCHING_ACCOUNT_BROWSER_EVIDENCE_DIR?resolve(process.env.MATCHING_ACCOUNT_BROWSER_EVIDENCE_DIR):join(temporary,'evidence');mkdirSync(artifactRoot,{recursive:true});
  let server,browser,page;const captures=[],pageErrors=[],external=[];
  try{
    server=start(runtime,port,setupCode);await ready(server);
    const executablePath=[process.env.MATCHING_TEST_BROWSER,'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(path=>existsSync(path));
    assert.ok(executablePath,'An installed browser is required');
    browser=await puppeteer.launch({executablePath,headless:true,userDataDir:join(temporary,'fresh-browser'),defaultViewport:{width:1280,height:900},args:['--no-first-run','--no-default-browser-check']});
    page=await browser.newPage();page.setDefaultTimeout(12000);
    page.on('pageerror',error=>pageErrors.push(error.message));
    await page.setRequestInterception(true);page.on('request',request=>{const url=new URL(request.url());if(url.origin===server.origin||['data:','blob:','about:'].includes(url.protocol))void request.continue();else{external.push(url.origin);void request.abort();}});
    const screenshot=async name=>{const path=join(artifactRoot,name+'.png');await page.screenshot({path,fullPage:true});captures.push({name,sha256:sha(readFileSync(path))});};
    const click=async text=>{const selector='button';await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(node=>node.textContent?.trim()===text&&!node.disabled),{},text);await page.evaluate(text=>{const button=[...document.querySelectorAll('button')].find(node=>node.textContent?.trim()===text&&!node.disabled);if(!button)throw new Error('Missing enabled button');button.click();},text);};
    const fill=async(selector,value)=>{await page.waitForSelector(selector);await page.click(selector);await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.press('Backspace');await page.type(selector,value);assert.equal(await page.$eval(selector,node=>node.value),value,'Typed test form value must replace the previous value');};
    await page.goto(server.origin,{waitUntil:'networkidle2'});await page.waitForSelector('#account-setup-code');
    await screenshot('01-first-run-owner-form');
    await fill('#account-username','synthetic-owner');await fill('#account-password',password);await fill('#account-confirm',password);await fill('#account-setup-code',setupCode);
    await click('Create account');await page.waitForSelector('a[href="/import"]');await screenshot('02-owner-in-application');
    const session=await page.evaluate(async()=>{const data=await(await fetch('/api/auth/session')).json();return {authenticated:data.authenticated,role:data.principal.role};});
    assert.deepEqual(session,{authenticated:true,role:'owner'});
    await page.click('a[href="/import"]');await page.waitForSelector('input[type="file"]');
    await fill('input[aria-label="Local account identifier"]','SYNTHETIC-BROWSER-ACCOUNT');await(await page.$('input[type="file"]')).uploadFile(statement);
    await click('Preview statement');await page.waitForFunction(()=>document.body.textContent?.includes('SYN-REAL-BROWSER'));
    assert.deepEqual(totals(runtime),{transactions:0,audit:0});await screenshot('03-preview-without-write');
    const csrfDenied=await page.evaluate(async()=> (await fetch('/api/import/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'a'.repeat(43)})})).status);
    assert.equal(csrfDenied,403);
    await page.select('#community-language','de');await click('Import bestätigen');await page.waitForFunction(()=>document.body.textContent?.includes('Neue Buchungen: 1'));
    assert.deepEqual(totals(runtime),{transactions:1,audit:1});await screenshot('04-confirmed-import-german');
    await page.select('#community-language','en');await page.click('a[href="/accounts"]');await page.waitForSelector('#new-account-username');
    await fill('#new-account-username','synthetic-viewer');await fill('#new-account-password',password);await page.select('#new-account-role','viewer');await click('Add account');
    await page.waitForSelector('tr[data-account="synthetic-viewer"]');await screenshot('05-viewer-created');
    const persistedClient=await page.evaluate(()=>JSON.stringify({session:Object.fromEntries(Object.entries(sessionStorage)),local:Object.fromEntries(Object.entries(localStorage))}));
    assert.ok(!persistedClient.includes(password));assert.ok(!persistedClient.includes(setupCode));assert.ok(!persistedClient.includes('csrf_token'));
    assert.ok((await page.cookies()).some(cookie=>cookie.name.endsWith('_session')&&cookie.httpOnly));
    await click('Sign out');await page.waitForSelector('#account-password');
    await fill('#account-username','synthetic-viewer');await fill('#account-password','deliberately incorrect');await click('Sign in');await page.waitForSelector('[role="alert"]');
    assert.ok((await page.$eval('[role="alert"]',node=>node.textContent)).includes('incorrect'));
    await fill('#account-password',password);await click('Sign in');await page.waitForSelector('a[href="/accounts"]');
    assert.equal(await page.$('a[href="/import"]'),null);
    await page.goto(server.origin+'/import',{waitUntil:'networkidle2'});await page.waitForSelector('[role="alert"]');
    assert.ok((await page.$eval('[role="alert"]',node=>node.textContent)).includes('permission'));
    const viewerDenied=await page.evaluate(async()=>{const session=await(await fetch('/api/auth/session')).json();return(await fetch('/api/import/preview',{method:'POST',headers:{'X-CSRF-Token':session.csrf_token}})).status;});
    assert.equal(viewerDenied,403);await screenshot('06-viewer-cannot-import');
    await stop(server);server=start(runtime,port,setupCode);await ready(server);await page.reload({waitUntil:'networkidle2'});
    const restored=await page.evaluate(async()=>{const value=await(await fetch('/api/auth/session')).json();return {authenticated:value.authenticated,role:value.principal.role};});
    assert.deepEqual(restored,{authenticated:true,role:'viewer'});assert.deepEqual(totals(runtime),{transactions:1,audit:1});
    await page.goto(server.origin+'/accounts',{waitUntil:'networkidle2'});await page.waitForSelector('#password-new');assert.equal(await page.$('#new-account-username'),null);
    await screenshot('07-role-and-state-survive-restart');
    await click('Sign out');await page.waitForSelector('#account-password');
    assert.equal((await page.evaluate(async()=>await fetch('/api/summary').then(response=>response.status))),401);
    assert.ok(!server.log.includes(password));assert.ok(!server.log.includes(setupCode));assert.deepEqual(pageErrors,[]);assert.deepEqual(external,[]);
    writeFileSync(join(artifactRoot,'account-browser-result.json'),JSON.stringify({result:'PASS',mode:'actual-main-server-and-built-ui',owner_setup:true,reviewed_import:true,viewer_role_enforced:true,missing_csrf_denied:true,sign_in_out:true,process_restart:true,languages:['en','de'],screenshots:captures,page_errors:pageErrors,external_requests:external,financial:totals(runtime),release_accepted:false},null,2));
  }catch(error){if(page)await page.screenshot({path:join(artifactRoot,'failure.png'),fullPage:true}).catch(()=>{});writeFileSync(join(artifactRoot,'failure.json'),JSON.stringify({error:String(error),page_errors:pageErrors,external_requests:external,server_log:server?.log},null,2));throw error;}
  finally{if(browser)await browser.close();await stop(server);rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
