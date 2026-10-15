import assert from'node:assert/strict';
import{mkdirSync,readFileSync,readdirSync,writeFileSync}from'node:fs';
import{join}from'node:path';
import{createServer}from'node:net';
import{randomBytes,createHash}from'node:crypto';
import Database from'better-sqlite3';
const mode=process.argv[2];assert.ok(['aborted','rollback','exclusive'].includes(mode));
const out=process.argv[3];assert.ok(typeof out==='string'&&out.length>0,'Synthetic evidence directory argument required');mkdirSync(out);const runtime=join(out,'runtime');mkdirSync(runtime);
const socket=createServer();await new Promise(ok=>socket.listen(0,'127.0.0.1',ok));const port=socket.address().port;await new Promise(ok=>socket.close(ok));
const setup=randomBytes(32).toString('base64url');Object.assign(process.env,{PORT:String(port),MATCHING_RUNTIME_MODE:'external-runtime-root',MATCHING_RUNTIME_ROOT:runtime,MATCHING_AUTH_MODE:'accounts',MATCHING_DEMO_MODE:'false',MATCHING_SETUP_TOKEN:setup,MATCHING_HTTP_HOST:'127.0.0.1',MATCHING_ENABLE_BANK_AUTOMATION:'false'});delete process.env.MATCHING_LOCAL_ACCESS_TOKEN;
let release,entered;const gate=new Promise(ok=>release=ok),started=new Promise(ok=>entered=ok);let delayed=false;
let releaseBackup,enteredBackup;const backupGate=new Promise(ok=>releaseBackup=ok),backupStarted=new Promise(ok=>enteredBackup=ok);
const originalBackup=Database.prototype.backup;
async function boundedStarted(promise,label){let timer;try{await Promise.race([promise,new Promise((_,fail)=>{timer=setTimeout(()=>fail(Error(label)),5000);})]);}finally{clearTimeout(timer);}}
const providerTransport=async request=>{
 if(request.url==='https://api.stripe.com/v1/account')return{status:200,json:{id:'acct_SYNTHETICLIFECYCLE',object:'account'}};
 assert.ok(request.url.startsWith('https://api.stripe.com/v1/balance_transactions?'));
 if(!delayed){delayed=true;entered();await gate;}
 return{status:200,json:{data:[{id:'txn_SYNTHETIC_AFTER_RESTORE',type:'charge',amount:125,fee:0,net:125,currency:'eur',created:Math.floor(Date.now()/1000)-3600}],has_more:false}};
};
const{createCommunityApplication}=await import(new URL('../../src/server/application.ts',import.meta.url).href);
const application=createCommunityApplication({providerTransport,afterRestoreCutover:()=>{if(mode==='rollback')throw Error('SYNTHETIC_AFTER_CUTOVER_FAILURE');}}),server=application.app.listen(port,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));const origin='http://127.0.0.1:'+port;
let cookie,csrf;
async function send(path,method='GET',body,extra={}){return fetch(origin+'/api'+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),...(body!==undefined&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{}),...extra},...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)})});}
async function json(response,status){const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;}
const state=()=>JSON.parse(readFileSync(join(runtime,'state/state.json'),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
// Checkpoint envelopes remain encrypted. Evidence records only their hashes.
const checkpointHashes=()=>Object.fromEntries(readdirSync(join(runtime,'identity/provider-vault')).filter(name=>name.endsWith('.checkpoint')).sort().map(name=>[name,hash(readFileSync(join(runtime,'identity/provider-vault',name)))]));
try{
 const setupResponse=await send('/auth/setup','POST',{username:'synthetic-lifecycle-owner',password:'Synthetic lifecycle only passphrase 2026',setup_code:setup});cookie=setupResponse.headers.get('set-cookie').split(';')[0];const owner=await json(setupResponse,201);csrf=owner.csrf_token;
 if(mode!=='rollback')await json(await send('/community/integrations/stripe/test','PUT',{credentials:{apiKey:'rk_test_SYNTHETICLIFECYCLE'}}),200);
 const backup=await json(await send('/community/persistence/backups','POST',{}),201),archive=Buffer.from(await(await send('/community/persistence/backups/'+backup.id+'/download')).arrayBuffer());
 const initial=state();assert.equal(Object.keys(initial.transactions).length,0);
 await json(await send('/community-payments/batches'),200);await json(await send('/community-banking/status'),200);
 let pending,controller;
 if(mode!=='rollback'){
  controller=new AbortController();pending=fetch(origin+'/api/community/integrations/stripe/test/sync',{method:'POST',headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:'{}',signal:controller.signal}).then(r=>({status:r.status}),e=>({aborted:e.name==='AbortError',name:e.name}));
  await boundedStarted(started,'Synthetic provider did not reach gate');controller.abort();const disconnected=await pending;assert.equal(disconnected.aborted,true);await new Promise(ok=>setTimeout(ok,150));
 }
 if(mode==='exclusive'){
  // Only this isolated synthetic process replaces the awaited backup method.
  // Its original implementation still creates and verifies the real SQLite copy.
  Database.prototype.backup=async function(...args){enteredBackup();await backupGate;return Reflect.apply(originalBackup,this,args);};
  const backupPending=send('/community/persistence/backups','POST',{});
  await boundedStarted(backupStarted,'Synthetic backup did not reach the real SQLite backup boundary');
  const before=state(),beforeCheckpoint=checkpointHashes();assert.equal(Object.keys(before.transactions).length,0);release();
  for(let n=0;n<100;n++)await new Promise(ok=>setTimeout(ok,50));
  const after=state(),checkpointUnchanged=JSON.stringify(beforeCheckpoint)===JSON.stringify(checkpointHashes());releaseBackup();
  const backupResponse=await backupPending,heldBackup=await json(backupResponse,201);
  const archiveResponse=await send('/community/persistence/backups/'+heldBackup.id+'/download');assert.equal(archiveResponse.status,200);
  const bytes=Buffer.from(await archiveResponse.arrayBuffer()),{inspectBackupBytes,verifyBackupDatabase}=await import(new URL('../../src/community/persistence/backup.ts',import.meta.url).href),checked=inspectBackupBytes(bytes);
  const copiedDatabase=join(out,'verified-held-backup.db');writeFileSync(copiedDatabase,checked.files.get('database/matching.db'));
  const copied=new Database(copiedDatabase,{readonly:true,fileMustExist:true});let sqlTransactions;
  try{verifyBackupDatabase(copied,checked.files.get('state/state.json'),checked.manifest);sqlTransactions=copied.prepare('SELECT count(*) FROM transactions').pluck().get();}finally{copied.close();}
  const result={mode,clientDisconnectedBeforeBackup:true,providerReleasedWhileRealBackupHeld:true,canonicalStateUnchangedWhileBackupHeld:hash(JSON.stringify(before))===hash(JSON.stringify(after)),encryptedCheckpointUnchangedWhileBackupHeld:checkpointUnchanged,transactionsWhileBackupHeld:Object.keys(after.transactions).length,backupStatus:backupResponse.status,backupCrossStoreVerificationPassed:true,backupTransactions:checked.manifest.financial.counts.transactions,backupSqlTransactions:sqlTransactions,backupArchiveSha256:hash(bytes),syntheticTransportOnly:true,productionRuntimeChanged:false};
  writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }else{
 const stage=await json(await send('/community/persistence/restore/stage','POST',archive,{'Content-Type':'application/zip'}),201);
 const activated=await send('/community/persistence/restore/'+stage.id+'/activate','POST',{fingerprint:stage.fingerprint}),activationBody=await activated.json();
 const restored=state();
 if(mode==='aborted'){
  assert.equal(activated.status,200,JSON.stringify(activationBody));assert.equal(Object.keys(restored.transactions).length,0);const beforeCheckpoint=checkpointHashes(),beforeStateHash=hash(JSON.stringify(restored));release();
  // Retain the full observation interval even when the vulnerable commit has
  // already appeared, so its subsequent encrypted checkpoint write is measured.
  for(let n=0;n<100;n++)await new Promise(ok=>setTimeout(ok,50));
  const after=state(),result={mode,clientDisconnectedBeforeRestore:true,activationStatus:activated.status,transactionsImmediatelyAfterRestore:Object.keys(restored.transactions).length,transactionsAfterReleasingRetiredProviderOperation:Object.keys(after.transactions).length,staleOperationCrossedRestoreGeneration:Object.keys(after.transactions).length>0,canonicalStateUnchangedAfterRetiredOperation:beforeStateHash===hash(JSON.stringify(after)),encryptedCheckpointUnchangedAfterRetiredOperation:JSON.stringify(beforeCheckpoint)===JSON.stringify(checkpointHashes()),noRealProviderRequests:true,syntheticTransportOnly:true,productionRuntimeChanged:false};writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }else{
  assert.ok(activated.status>=400);assert.deepEqual(restored,initial);const list=await send('/community-payments/batches'),body=await list.json(),bank=await send('/community-banking/status'),bankBody=await bank.json();
  const result={mode,ordinaryThrowAfterCutover:true,activationStatus:activated.status,activationCode:activationBody.code,canonicalStateRolledBackExactly:true,paymentListStatusAfterRollback:list.status,paymentListBody:body,bankStatusAfterRollback:bank.status,bankStatusBody:bankBody,closedHandleSuspected:list.status!==200||bank.status!==200,syntheticOnly:true,productionRuntimeChanged:false};writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }
 }
}finally{release();releaseBackup();Database.prototype.backup=originalBackup;await new Promise(ok=>setTimeout(ok,150));server.closeAllConnections();await new Promise(ok=>server.close(ok));await application.close();}
