import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){const server=createServer();await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});const port=server.address().port;await new Promise(ok=>server.close(ok));return port;}
function launch(runtime,port){
  const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-File',join(root,'scripts','Start-Community.ps1'),'-DataDirectory',runtime,'-InstallDirectory',root,'-NodeExe',process.execPath,'-Port',String(port)],{
    cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MATCHING_DEMO_MODE:'true',MATCHING_LOCAL_ACCESS_TOKEN:'synthetic-inherited-demo-token-that-must-be-cleared',MATCHING_ENABLE_BANK_AUTOMATION:'true'},
  });
  const result={child,output:'',origin:`http://127.0.0.1:${port}`};
  for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{result.output=(result.output+data).slice(-65536);});return result;
}
async function ready(server){
  for(let attempt=0;attempt<150;attempt++){
    if(server.child.exitCode!==null)throw new Error('The local launcher exited before readiness (exit '+server.child.exitCode+')');
    try{const response=await fetch(server.origin+'/health',{signal:AbortSignal.timeout(1000)});if(response.ok)return await response.json();}catch{}
    await new Promise(ok=>setTimeout(ok,100));
  }
  throw new Error('The local launcher failed to become ready');
}
async function stop(server){
  if(!server||server.child.exitCode!==null||server.child.signalCode!==null)return;
  const exited=new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(new Error('Owned launcher did not stop')),10000);server.child.once('exit',()=>{clearTimeout(timer);ok();});});
  spawnSync('taskkill.exe',['/PID',String(server.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});await exited;
}
function request(server,path,body){return fetch(server.origin+'/api/auth/'+path,{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});}

test('normal Windows launcher creates first-run authorization and never inherits demonstration or bank-execution modes',{timeout:60000},async()=>{
  const base=mkdtempSync(join(tmpdir(),'matching-launcher-synthetic-'));
  const runtime=join(base,'Daten Übung');const port=await freePort();
  const password='Synthetic local launcher passphrase 2026';let server;
  try{
    server=launch(runtime,port);
    assert.deepEqual(await ready(server),{ok:true,auth_mode:'accounts',release_ready:false});
    const bootstrap=/Local setup code: ([A-Za-z0-9_-]{43})/.exec(server.output)?.[1];assert.ok(bootstrap,'The launcher must display one-use local bootstrap authorization');
    assert.ok(server.output.includes(server.origin+'/'));assert.ok(!server.output.includes(server.origin+'/setup'));
    const status=await(await fetch(server.origin+'/api/auth/session')).json();assert.equal(status.setup_required,true);assert.equal(status.setup_available,true);
    const response=await request(server,'setup',{username:'synthetic-launcher-owner',password,setup_code:bootstrap});assert.equal(response.status,201);
    const session=await response.json();assert.equal(session.principal.role,'owner');assert.ok(response.headers.get('set-cookie')?.includes('HttpOnly'));
    assert.ok(!server.output.includes(password));assert.ok(!server.output.includes('synthetic-inherited-demo-token'));
    assert.equal(Object.keys(JSON.parse(readFileSync(join(runtime,'state','state.json'),'utf8')).transactions).length,0);
    await stop(server);server=launch(runtime,port);await ready(server);
    const another=/Local setup code: ([A-Za-z0-9_-]{43})/.exec(server.output)?.[1];assert.ok(another);assert.notEqual(another,bootstrap);
    const after=await(await fetch(server.origin+'/api/auth/session')).json();assert.equal(after.setup_required,false);
    assert.equal((await request(server,'setup',{username:'synthetic-second-owner',password,setup_code:another})).status,403);
    assert.equal((await request(server,'login',{username:'synthetic-launcher-owner',password})).status,200);
  }finally{await stop(server);rmSync(base,{force:true,recursive:true,maxRetries:10,retryDelay:100});}
});
