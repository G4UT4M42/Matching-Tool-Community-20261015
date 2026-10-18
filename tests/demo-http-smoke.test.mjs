/**
 * Real loopback HTTP smoke test on independently generated synthetic data.
 * Starts and stops only its own child process; never uses an existing runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r,ms));
async function availablePort() {
  const server=createServer();
  try {
    await new Promise((ok,fail)=>server.once('error',fail).listen(0,'127.0.0.1',ok));
    return server.address().port;
  } finally { await new Promise(ok=>server.close(ok)); }
}
async function boot(rootRuntime,port,token) {
  const env={...process.env,
    MATCHING_RUNTIME_MODE:'external-runtime-root',
    MATCHING_RUNTIME_ROOT:rootRuntime,
    MATCHING_LOCAL_ACCESS_TOKEN: token, MATCHING_DEMO_MODE: 'true', MATCHING_AUTH_MODE: 'synthetic-preview',
    MATCHING_ENABLE_BANK_AUTOMATION:'false',
    MATCHING_HTTP_HOST:'127.0.0.1',
    NODE_ENV:'production',PORT:String(port),
    TMP:join(rootRuntime,'temp'),TEMP:join(rootRuntime,'temp')
  };
  const proc=spawn(process.execPath,[
    join(root,'node_modules','tsx','dist','cli.mjs'),
    join(root,'src','server','index.ts')
  ],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true,
    detached:process.platform!=='win32'});
  let lastOutput='';
  for(const stream of [proc.stdout,proc.stderr])
    stream.on('data',value=>{lastOutput=(lastOutput+value.toString()).slice(-1000)});
  const url='http://127.0.0.1:'+port;
  for(let i=0;i<120;i++){
    if(proc.exitCode!==null || proc.signalCode!==null) {
      throw new Error('Demo child exited early: '+lastOutput.replace(token,'[REDACTED_TOKEN]'));
    }
    try {
      const check=await fetch(url+'/api/community/session',{signal:AbortSignal.timeout(350)});
      if(check.status===401)return {proc,url};
    } catch {}
    await sleep(100);
  }
  await stop(proc);
  throw new Error('Synthetic loopback service did not initialize: '+lastOutput.replace(token,'[REDACTED_TOKEN]'));
}
async function stop(proc) {
  if(proc.exitCode!==null)return;
  const ended = new Promise(resolve=>proc.once('exit',resolve));
  if(process.platform==='win32') {
    // tsx can spawn a server grandchild; kill only the process tree created by this test.
    spawnSync('taskkill',['/PID',String(proc.pid),'/T','/F'],{
      windowsHide:true,stdio:'ignore',timeout:6000
    });
  } else {
    try { process.kill(-proc.pid,'SIGTERM') }
    catch { proc.kill('SIGTERM') }
  }
  await Promise.race([ended,sleep(1500)]);
  if(proc.exitCode===null)proc.kill('SIGKILL');
}
test('synthetic preview boots, rejects unauthenticated/unsafe actions, persists and restarts', {timeout:35000},async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'matching-community-http-synthetic-'));
  mkdirSync(join(runtime,'temp'));
  const token=randomBytes(32).toString('base64url');
  let processInfo;
  try {
    const port=await availablePort();
    processInfo=await boot(runtime,port,token);
    const {url}=processInfo;
    const noAuth=await fetch(url+'/api/transactions');
    assert.equal(noAuth.status,401);
    const headers={'X-Community-Access-Token':token};
    const info=await fetch(url+'/api/community/session',{headers});
    assert.equal(info.status,200);
    assert.equal((await info.json()).banking_enabled,false);
    const rootResponse=await fetch(url+'/');
    assert.equal(rootResponse.status,200);
    const transactions=await fetch(url+'/api/transactions',{headers});
    assert.equal(transactions.status,200);
    const data=await transactions.json();
    assert.ok(JSON.stringify(data).includes('DEMO-TXN-001'));
    const forbidden=await fetch(url+'/api/payments/batches',{
      method:'POST',headers:{...headers,'Content-Type':'application/json'},
      body:'{}'
    });
    assert.equal(forbidden.status,403);
    assert.equal((await forbidden.json()).code,'COMMUNITY_EXTERNAL_ACTION_DISABLED');
    await stop(processInfo.proc);
    processInfo=undefined;
    const persisted=JSON.parse(readFileSync(join(runtime,'state','state.json'),'utf8'));
    assert.equal(persisted.run_id,'COMMUNITY_SYNTHETIC_DEMO_V1');
    assert.equal(Object.keys(persisted.transactions).length,17);
    assert.equal(Object.keys(persisted.documents).length,13);
    // Original fixture identities and economics remain part of the richer demo.
    for(const [id,amount] of [['DEMO-TXN-001',-12900],['DEMO-TXN-002',-5050],['DEMO-TXN-003',5050],['DEMO-TXN-004',39200]]) {
      assert.equal(persisted.transactions[id].transaction_id,id);
      assert.equal(persisted.transactions[id].source_account_id,'NON-ROUTABLE-DEMO');
      assert.equal(persisted.transactions[id].amount_minor,amount);
    }
    assert.equal(persisted.documents['DEMO-DOC-001'].total_amount_minor,-12900);
    assert.equal(persisted.documents['DEMO-DOC-002'].total_amount_minor,-5050);
    const totals={};
    for(const row of Object.values(persisted.transactions))totals[row.currency_code]=(totals[row.currency_code]??0)+row.amount_minor;
    assert.deepEqual(totals,{EUR:36360,USD:5000});
    assert.equal(existsSync(join(runtime,'database','matching.db')),true);
    const secondPort=await availablePort();
    processInfo=await boot(runtime,secondPort,token);
    const afterRestart=await fetch(processInfo.url+'/api/transactions',{headers});
    assert.equal(afterRestart.status,200);
    assert.ok(JSON.stringify(await afterRestart.json()).includes('DEMO-TXN-001'));
  } finally {
    if(processInfo)await stop(processInfo.proc);
    rmSync(runtime,{force:true,recursive:true,maxRetries:20,retryDelay:100});
  }
});
