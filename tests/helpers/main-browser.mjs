import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import Database from 'better-sqlite3';
import {classifyFailedRequest,expectedHttpFailures} from './browser-observations.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function freePort(){const listener=createServer();await new Promise((ok,fail)=>{listener.once('error',fail);listener.listen(0,'127.0.0.1',ok);});const port=listener.address().port;await new Promise(ok=>listener.close(ok));return port;}
export async function mainBrowser(name,{entrypoint='src/server/index.ts',packageDirectory}={}){
  if(!/^[a-z0-9-]{1,60}$/.test(name))throw new Error('Invalid synthetic test name');
  if(!['src/server/index.ts','tests/helpers/integrated-server.mjs','tests/helpers/portal-evidence-server.mjs'].includes(entrypoint))throw new Error('Unreviewed test server entrypoint');
  if(packageDirectory&&entrypoint==='tests/helpers/portal-evidence-server.mjs')throw new Error('The receipt fixture composition is source-only and cannot claim installed application qualification');
  const temp=mkdtempSync(join(tmpdir(),'matching-real-'+name+'-'));
  const runtime=join(temp,'runtime'),downloads=join(temp,'downloads');mkdirSync(runtime);mkdirSync(downloads);
  const applicationRoot=packageDirectory?join(temp,'installed-application'):repository;
  const evidence=process.env.MATCHING_MAIN_BROWSER_EVIDENCE_DIR?join(resolve(process.env.MATCHING_MAIN_BROWSER_EVIDENCE_DIR),name):join(temp,'evidence');mkdirSync(evidence,{recursive:true});
  let installedManifest,installationObservation;
  if(packageDirectory){
    const installStarted=Date.now();
    const install=spawnSync('powershell.exe',['-NoProfile','-File',join(repository,'scripts/Install-Community.ps1'),'-PackageDirectory',resolve(packageDirectory),'-InstallDirectory',applicationRoot,'-DataDirectory',runtime],{cwd:repository,encoding:'utf8',windowsHide:true,timeout:300000});
    installationObservation={elapsed_ms:Date.now()-installStarted,deadline_ms:300000,exit_code:install.status,error_code:install.error?.code??null,stdout:install.stdout,stderr:install.stderr,...(install.status!==0?{retained_synthetic_root:temp}:{})};
    writeFileSync(join(evidence,'installation-result.json'),JSON.stringify(installationObservation,null,2));
    assert.equal(install.status,0,JSON.stringify({error_code:install.error?.code??null,elapsed_ms:installationObservation.elapsed_ms,output:(install.stderr||install.stdout||String(install.error)).slice(-2000)}));
    installedManifest=JSON.parse(readFileSync(join(applicationRoot,'community-package.json'),'utf8'));
    writeFileSync(join(evidence,'installed-package-manifest.json'),readFileSync(join(applicationRoot,'community-package.json')));
  }
  const port=await freePort(),origin=`http://127.0.0.1:${port}`,setupCode=randomBytes(32).toString('base64url');
  const password='Synthetic main browser owner passphrase 2026';
  let server,browser,page;const screenshots=[],errors=[],external=[],network=[],consoleErrors=[],consoleRecords=[],failedRequests=[],explainedInterruptions=[];
  const httpFailures=expectedHttpFailures(origin);
  let armedInterruption;
  const launch=()=>{
    const env={...process.env,PORT:String(port),MATCHING_RUNTIME_MODE:'external-runtime-root',MATCHING_RUNTIME_ROOT:runtime,MATCHING_AUTH_MODE:'accounts',MATCHING_DEMO_MODE:'false',MATCHING_SETUP_TOKEN:setupCode,MATCHING_HTTP_HOST:'127.0.0.1',MATCHING_ENABLE_BANK_AUTOMATION:'false'};
    delete env.MATCHING_LOCAL_ACCESS_TOKEN;delete env.MATCHING_OCR_LANGUAGE_DIR;
    const serverEntry=entrypoint==='src/server/index.ts'?join(applicationRoot,entrypoint):join(repository,entrypoint);
    const program=packageDirectory?join(applicationRoot,'runtime','node.exe'):process.execPath;
    const child=spawn(program,['--import','tsx',serverEntry,...(entrypoint==='tests/helpers/integrated-server.mjs'?[applicationRoot]:[])],{cwd:applicationRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const result={child,log:''};for(const stream of[child.stdout,child.stderr])stream.on('data',bytes=>{result.log=(result.log+bytes).slice(-65536);});return result;
  };
  const ready=async()=>{for(let n=0;n<150;n++){if(server.child.exitCode!==null)throw new Error('Actual server exited: '+server.log);try{const response=await fetch(origin+'/health',{signal:AbortSignal.timeout(1000)});if(response.ok)return;}catch{}await pause(100);}throw new Error('Actual server readiness deadline exceeded');};
  const stop=async()=>{
    if(!server||server.child.exitCode!==null||server.child.signalCode!==null)return;
    const exited=new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(new Error('Owned synthetic server failed to stop')),10000);server.child.once('exit',()=>{clearTimeout(timer);ok();});});
    if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(server.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});else server.child.kill('SIGTERM');await exited;
  };
  try{
    server=launch();await ready();
    const executablePath=[process.env.MATCHING_TEST_BROWSER,'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(path=>existsSync(path));assert.ok(executablePath,'An installed browser is required');
    browser=await puppeteer.launch({executablePath,headless:true,userDataDir:join(temp,'browser'),defaultViewport:{width:1400,height:1000},args:['--no-first-run','--no-default-browser-check']});page=await browser.newPage();page.setDefaultTimeout(20000);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error'){const location=message.location();consoleRecords.push({index:consoleErrors.length,text:message.text(),url:location.url??'',line:location.lineNumber,column:location.columnNumber});consoleErrors.push(message.text());}});
    page.on('requestfailed',request=>failedRequests.push(classifyFailedRequest({origin,url:request.url(),method:request.method(),error:request.failure()?.errorText,responseStatus:request.response()?.status(),armedInterruptionPath:armedInterruption?.path})));
    page.on('response',async response=>{const url=new URL(response.url());if(url.origin!==origin)return;const method=response.request().method(),status=response.status();httpFailures.observe({url:response.url(),method,status});if(!url.pathname.startsWith('/api/')&&status<400)return;const entry={method,path:url.pathname+url.search,status};network.push(entry);if(status>=400){try{const body=await response.json();entry.code=typeof body.code==='string'?body.code:undefined;entry.error=typeof body.error==='string'?body.error:undefined;}catch{}}});
    await page.setRequestInterception(true);
    page.on('request',request=>{const target=new URL(request.url());if(target.origin===origin||['data:','blob:','about:'].includes(target.protocol))void request.continue();else{external.push(target.origin);void request.abort();}});
    const client=await page.createCDPSession();await client.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
    await page.goto(origin,{waitUntil:'networkidle2'});
  }catch(error){if(browser)await browser.close();await stop();rmSync(temp,{force:true,recursive:true,maxRetries:10,retryDelay:100});throw error;}
  const fill=async(selector,value)=>{await page.waitForSelector(selector);await page.click(selector);await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.press('Backspace');await page.type(selector,String(value));assert.equal(await page.$eval(selector,node=>node.value),String(value));};
  const click=async(text,scope='body')=>{
    await page.waitForFunction((text,scope)=>[...document.querySelector(scope).querySelectorAll('button')].some(button=>button.textContent?.trim()===text&&!button.disabled),{},text,scope);
    await page.evaluate((text,scope)=>{const button=[...document.querySelector(scope).querySelectorAll('button')].find(button=>button.textContent?.trim()===text&&!button.disabled);if(!button)throw new Error('Enabled button disappeared');button.click();},text,scope);
  };
  const screenshot=async(label)=>{const path=join(evidence,label+'.png');await page.screenshot({path,fullPage:true});screenshots.push({name:label,sha256:sha(readFileSync(path))});};
  const read=async(path)=>page.evaluate(async path=>{const response=await fetch('/api'+path);return{status:response.status,data:await response.json()};},path);
  const state=()=>JSON.parse(readFileSync(join(runtime,'state','state.json'),'utf8'));
  const sql=()=>{const db=new Database(join(runtime,'database','matching.db'),{readonly:true,fileMustExist:true});try{return{version:db.pragma('user_version',{simple:true}),transactions:Number(db.prepare('SELECT count(*) FROM transactions').pluck().get()),documents:Number(db.prepare('SELECT count(*) FROM documents').pluck().get()),groups:Number(db.prepare('SELECT count(*) FROM match_groups').pluck().get()),audits:Number(db.prepare('SELECT count(*) FROM audit_events').pluck().get()),snapshot:JSON.parse(db.prepare('SELECT state_json FROM community_canonical_state WHERE singleton=1').pluck().get())};}finally{db.close();}};
  const waitDownload=async(suffix)=>{for(let n=0;n<100;n++){const name=readdirSync(downloads).find(name=>name.endsWith(suffix)&&!name.endsWith('.crdownload'));if(name)return join(downloads,name);await pause(100);}throw new Error('Browser download did not complete');};
  return{temp,runtime,downloads,evidence,page,origin,screenshots,errors,external,fill,click,read,state,sql,waitDownload,screenshot,installedManifest,
    expectHttpFailure(expectation){return httpFailures.expect(expectation);},
    async createOwner(){await fill('#account-username','synthetic-owner');await fill('#account-password',password);await fill('#account-confirm',password);await fill('#account-setup-code',setupCode);await click('Create account');await page.waitForSelector('a[href="/documents"]');},
    async visit(path){await page.goto(origin+path,{waitUntil:'networkidle2'});},
    armCutoverInterruption(path){assert.equal(entrypoint,'tests/helpers/integrated-server.mjs');assert.match(path,/^\/api\/community\/persistence\/restore\/[a-f0-9-]{36}\/activate$/);assert.equal(armedInterruption,undefined);armedInterruption={path,consoleStart:consoleErrors.length,failedStart:failedRequests.length};writeFileSync(join(runtime,'synthetic-cutover-interruption.json'),JSON.stringify({run_id:'SYNTHETIC-COMPLETE-LEGACY'}));},
    async verifyCutoverInterruption(){assert.ok(armedInterruption);for(let n=0;n<150&&server.child.exitCode===null;n++)await pause(100);assert.equal(server.child.exitCode,86,'Synthetic process must exit at the exact cutover hook');assert.deepEqual(JSON.parse(readFileSync(join(runtime,'synthetic-cutover-interruption.json.occurred'),'utf8')),{phase:'after-directory-cutover-before-reopen',exit_code:86});for(let n=0;n<50&&failedRequests.length===armedInterruption.failedStart;n++)await pause(50);const failures=failedRequests.slice(armedInterruption.failedStart);assert.equal(failures.length,1);assert.equal(failures[0].expected,true);assert.match(failures[0].error,/net::ERR_(EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_REFUSED)/);const messages=consoleErrors.slice(armedInterruption.consoleStart);assert.ok(messages.length<=1);assert.ok(messages.every(message=>/^Failed to load resource: net::ERR_(EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_REFUSED)$/.test(message)));explainedInterruptions.push({...armedInterruption,exit_code:86,phase:'after-directory-cutover-before-reopen',failed_requests:failures,console_errors:messages});armedInterruption=undefined;},
    async restart(){const previous=page.url();await page.goto('about:blank');await stop();assert.ok(!server.log.includes(password)&&!server.log.includes(setupCode));server=launch();await ready();await page.goto(previous,{waitUntil:'networkidle2'});},
    async prove(result){assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(armedInterruption,undefined);assert.deepEqual(failedRequests.filter(entry=>!entry.expected),[],'No unexplained network failures');const explainedConsole=new Set(explainedInterruptions.flatMap(entry=>entry.console_errors.map((_,offset)=>entry.consoleStart+offset)));const http=httpFailures.review(consoleRecords.filter(record=>!explainedConsole.has(record.index)));assert.deepEqual(http.unexpected_responses,[],'No unregistered same-origin HTTP errors, including authentication and resources');assert.deepEqual(http.unconsumed_expectations,[],'Every expected HTTP failure must actually occur');assert.deepEqual(http.unexplained_console,[],'No unexplained browser console errors');assert.ok(!server.log.includes(password)&&!server.log.includes(setupCode));writeFileSync(join(evidence,'result.json'),JSON.stringify({result:'PASS',mode:'actual-main-server-built-ui',installation:installationObservation,...result,screenshots,page_errors:errors,console_errors:consoleErrors,console_records:consoleRecords,http_failure_observations:http,api_network:network,failed_requests:failedRequests,explained_interruptions:explainedInterruptions,external_requests:external,release_accepted:false},null,2));},
    async close(error){
      try {
        if(error){
          await page.screenshot({path:join(evidence,'failure.png'),fullPage:true}).catch(()=>{});
          const uiAlerts=await page.evaluate(()=>Array.from(document.querySelectorAll('[role="alert"]'),node=>node.textContent)).catch(()=>[]);
          const inspect=read=>{try{return read();}catch(error){return{inspection_error:String(error)};}};
          writeFileSync(join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error?.stack,server_log:server.log,page_errors:errors,external_requests:external,console_errors:consoleErrors,console_records:consoleRecords,http_failure_observations:httpFailures.review(consoleRecords),network,ui_alerts:uiAlerts,financial_state:inspect(state),sql:inspect(sql)},null,2));
        }
      } finally {
        try { await browser.close(); }
        finally { try { await stop(); } finally { rmSync(temp,{force:true,recursive:true,maxRetries:10,retryDelay:100}); } }
      }
    }
  };
}
