import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import express from 'express';
import type {Server} from 'node:http';
import Database from 'better-sqlite3';
import type {MatchingState} from '../src/core/types.js';
import {CommunityAuthStore,type AuthSession} from '../src/server/community-auth-store.js';
import {createCommunityAccountGuard} from '../src/server/community-auth-http.js';

const password='Synthetic independent audit passphrase 2026';
const oldRoot=process.env.MATCHING_RUNTIME_ROOT,oldMode=process.env.MATCHING_RUNTIME_MODE;
let root:string,state:MatchingState,auth:CommunityAuthStore,owner:AuthSession,server:Server|undefined,base:string;
let db:typeof import('../src/storage/db.js'),json:typeof import('../src/storage/json-store.js'),canonical:typeof import('../src/storage/canonical-transaction.js'),workspace:ReturnType<typeof import('../src/server/community-workspace.js')['createCommunityWorkspace']>;
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const stateBytes=()=>readFileSync(join(root,'state','state.json'));
const snapshot=()=>({sha256:sha(json.serializeCommunityState(state)),transactions:state.transactions.size,documents:state.documents.size,audits:state.audit_events.length});
const events=()=>auth.securityEvents(owner.token).events.filter(event=>event.action.startsWith('DATA_OPERATION_'));
function headers(session=owner){return{Cookie:auth.cookieName+'='+session.token,'X-CSRF-Token':session.csrfToken};}
function call(path:string,body?:unknown,session=owner){return fetch(base+'/api/community/persistence'+path,{method:'POST',headers:{...headers(session),'Content-Type':Buffer.isBuffer(body)?'application/zip':'application/json'},body:Buffer.isBuffer(body)?new Uint8Array(body):JSON.stringify(body??{})});}
async function stop(){if(server){await new Promise<void>(ok=>server!.close(()=>ok()));server=undefined;}await workspace?.close();db?.closeDb();}
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),'matching-data-audit-independent-'));process.env.MATCHING_RUNTIME_ROOT=root;process.env.MATCHING_RUNTIME_MODE='external-runtime-root';vi.resetModules();
 const setupToken=randomBytes(32).toString('base64url');auth=new CommunityAuthStore({runtimeRoot:root,setupToken});owner=await auth.setup({username:'synthetic-independent-owner',password,setupToken});
 db=await import('../src/storage/db.js');db.getDb();json=await import('../src/storage/json-store.js');canonical=await import('../src/storage/canonical-transaction.js');
 state=json.createEmptyState('SYNTHETIC_DATA_AUDIT_REVIEW');state.transactions.set('SYN-T1',{transaction_id:'SYN-T1',source_system:'sparkasse',source_account_id:'SYNTHETIC-ACCOUNT',source_row_ref:'SYN-T1',posting_at:'2026-10-15T00:00:00Z',amount_minor:100,currency_code:'EUR',description_raw:'Synthetic first transaction',tags:[],meta:{synthetic:true}});json.saveState(state);canonical.initializeCanonicalState(state);
 const module=await import('../src/server/community-workspace.js');workspace=module.createCommunityWorkspace({runtimeRoot:root,auth,getState:()=>state,activate:next=>{state=next;}});
 const app=express();app.use(express.json());app.use('/api',createCommunityAccountGuard(auth,module.COMMUNITY_WORKSPACE_ROUTES));app.use('/api',workspace.router);
 // A controlled retained import handler exercises the actual shared workspace
 // callback and request context, without a provider/network dependency.
 app.post('/api/import/upload',(_req,res)=>{const before=state,next=structuredClone(before);next.transactions.set('SYN-NEW',{...before.transactions.get('SYN-T1')!,transaction_id:'SYN-NEW',source_row_ref:'SYN-NEW',description_raw:'Synthetic newly imported purchase'});workspace.commit(before,next,res.locals.communityPrincipal.subject);res.json({imported:1});});
 server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server!.once('listening',ok));base='http://127.0.0.1:'+(server.address() as {port:number}).port;
});
afterEach(async()=>{vi.restoreAllMocks();await stop();auth?.close();if(oldRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=oldRoot;if(oldMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=oldMode;rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});vi.resetModules();});

describe('independent data-operation audit boundary review',()=>{
 it('binds real actor and live role, stores hash snapshots append-only and exposes no session capability',async()=>{
  await auth.createUser(owner.token,{username:'synthetic-independent-viewer',password,role:'viewer'});const viewer=await auth.login({username:'synthetic-independent-viewer',password});
  expect((await call('/backups',{},viewer)).status).toBe(403);expect(events()).toEqual([]);const before=snapshot(),bytes=stateBytes();
  expect((await call('/backups',{actor:'spoofed',role:'owner',workspace_id:'spoofed'})).status).toBe(201);
  const audit=events();expect(audit).toHaveLength(2);for(const event of audit)expect(event).toMatchObject({actor_id:owner.principal.subject,operation:'backup',before,after:before});expect(audit[0].entity_id).toBe(audit[1].entity_id);expect(stateBytes()).toEqual(bytes);
  const serialized=JSON.stringify(auth.securityEvents(viewer.token));expect(serialized).not.toContain(owner.token);expect(serialized).not.toContain(owner.csrfToken);expect(serialized).not.toContain(password);expect(serialized).not.toContain('spoofed');
  const identity=new Database(join(root,'identity','auth.sqlite'));try{expect(()=>identity.prepare('UPDATE auth_security_events SET metadata=? WHERE event_id=?').run('{}',audit[0].audit_id)).toThrow(/append only/);expect(()=>identity.prepare('DELETE FROM auth_security_events WHERE event_id=?').run(audit[0].audit_id)).toThrow(/append only/);}finally{identity.close();}auth.verifyAudit();
  const second=await auth.createUser(owner.token,{username:'synthetic-independent-second-owner',password,role:'owner'});const session=await auth.login({username:'synthetic-independent-second-owner',password});auth.updateUser(owner.token,second.user_id,{role:'viewer'});expect((await call('/backups',{},session)).status).toBe(401);expect(events()).toHaveLength(2);
 });
 it('fails before backup mutation if the durable started event cannot be written',async()=>{
  const before=stateBytes(),original=auth.recordDataOperation.bind(auth);vi.spyOn(auth,'recordDataOperation').mockImplementation((token,entry)=>{if(entry.phase==='started')throw Error('SYNTHETIC_START_AUDIT_UNAVAILABLE');original(token,entry);});
  expect((await call('/backups')).status).toBe(500);expect(events()).toEqual([]);expect(stateBytes()).toEqual(before);expect(existsSync(join(root,'backups'))?readdirSync(join(root,'backups')).filter(name=>name.endsWith('.zip')):[]).toEqual([]);
 });
 it('surfaces completion-audit failure after a completed backup and retains a durable unresolved start',async()=>{
  const before=snapshot(),bytes=stateBytes(),original=auth.recordDataOperation.bind(auth);vi.spyOn(auth,'recordDataOperation').mockImplementation((token,entry)=>{if(entry.phase==='succeeded')throw Error('SYNTHETIC_COMPLETION_AUDIT_UNAVAILABLE');original(token,entry);});
  expect((await call('/backups')).status).toBe(500);expect(readdirSync(join(root,'backups')).filter(name=>name.endsWith('.zip'))).toHaveLength(1);expect(stateBytes()).toEqual(bytes);expect(events()).toHaveLength(1);expect(events()[0]).toMatchObject({action:'DATA_OPERATION_STARTED',before,after:before});
  const reopened=new CommunityAuthStore({runtimeRoot:root});try{reopened.verifyAudit();expect(reopened.securityEvents(owner.token).events.filter(event=>event.action.startsWith('DATA_OPERATION_'))).toEqual(events());}finally{reopened.close();}
 });
 it('records a failed operation with the same correlation and unchanged target snapshots',async()=>{
  const before=snapshot(),bytes=stateBytes();expect((await call('/restore/stage',Buffer.from('Synthetic invalid backup'))).status).toBe(422);const audit=events();expect(audit).toHaveLength(2);expect(audit.map(event=>event.action).sort()).toEqual(['DATA_OPERATION_FAILED','DATA_OPERATION_STARTED']);expect(audit[0].entity_id).toBe(audit[1].entity_id);for(const event of audit)expect(event).toMatchObject({actor_id:owner.principal.subject,operation:'restore-stage',before,after:before});expect(stateBytes()).toEqual(bytes);auth.verifyAudit();
 });
 it('records exact before/after restore hashes outside the restored historical financial state',async()=>{
  const historical=stateBytes();const backupResponse=await call('/backups');expect(backupResponse.status).toBe(201);const backup=await backupResponse.json(),archive=readFileSync(join(root,'backups',backup.id+'.zip'));
  const next=structuredClone(state);next.transactions.set('SYN-T2',{...next.transactions.get('SYN-T1')!,transaction_id:'SYN-T2',source_row_ref:'SYN-T2',amount_minor:200});state=canonical.commitCanonicalState(state,next,owner.principal.subject);const current=snapshot();
  const stagedResponse=await call('/restore/stage',archive);expect(stagedResponse.status).toBe(201);const stage=await stagedResponse.json();const activated=await call('/restore/'+stage.id+'/activate',{fingerprint:stage.fingerprint});expect(activated.status).toBe(200);
  expect(stateBytes()).toEqual(historical);expect(state.transactions.size).toBe(1);const completed=events().find(event=>event.operation==='restore-activate'&&event.action==='DATA_OPERATION_SUCCEEDED');expect(completed).toMatchObject({actor_id:owner.principal.subject,before:current,after:{sha256:sha(historical),transactions:1,documents:0,audits:0}});expect(state.audit_events).toEqual([]);auth.verifyAudit();canonical.initializeCanonicalState(state);
 });
 it('applies active rules in the real workspace callback and authorizes PATCH before disabling imported ownership',async()=>{
  const created=await fetch(base+'/api/accounting/exclusions',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({revision:0,field:'description_raw',operator:'contains',value:'newly imported'})});expect(created.status).toBe(200);const rule=state.exclusion_rules[0];
  const imported=await fetch(base+'/api/import/upload',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:'{}'});expect(imported.status).toBe(200);expect(state.excluded_transaction_ids.has('SYN-NEW')).toBe(true);expect(state.audit_events.at(-1)).toMatchObject({actor_id:owner.principal.subject,entity_id:rule.exclusion_id,after:{applied_transaction_ids:['SYN-NEW']}});
  await auth.createUser(owner.token,{username:'synthetic-wiring-viewer',password,role:'viewer'});const viewer=await auth.login({username:'synthetic-wiring-viewer',password});const revision=state.accounting!.revision,body=JSON.stringify({revision,enabled:false});
  expect((await fetch(base+'/api/accounting/exclusions/'+rule.exclusion_id,{method:'PATCH',headers:{...headers(viewer),'Content-Type':'application/json'},body})).status).toBe(403);expect(state.excluded_transaction_ids.has('SYN-NEW')).toBe(true);
  expect((await fetch(base+'/api/accounting/exclusions/'+rule.exclusion_id,{method:'PATCH',headers:{...headers(),'Content-Type':'application/json'},body})).status).toBe(200);expect(state.excluded_transaction_ids.has('SYN-NEW')).toBe(false);db.closeDb();db.getDb();expect(json.loadState()).toEqual(state);
 });
 it('retains only a durable started attempt through real restore-cutover process interruption and rollback',async()=>{
  const historical=stateBytes(),backed=await call('/backups');expect(backed.status).toBe(201);const backup=await backed.json();const next=structuredClone(state);next.transactions.set('SYN-T2',{...next.transactions.get('SYN-T1')!,transaction_id:'SYN-T2',source_row_ref:'SYN-T2',amount_minor:200});state=canonical.commitCanonicalState(state,next,owner.principal.subject);const current=stateBytes(),currentSnapshot=snapshot();
  await stop();auth.close();
  const script=`import express from 'express';import{readFileSync}from'node:fs';import{join}from'node:path';const db=await import('./src/storage/db.ts'),json=await import('./src/storage/json-store.ts'),canonical=await import('./src/storage/canonical-transaction.ts'),identity=await import('./src/server/community-auth-store.ts'),http=await import('./src/server/community-auth-http.ts'),module=await import('./src/server/community-workspace.ts');let state=json.loadState();db.getDb();canonical.initializeCanonicalState(state);const auth=new identity.CommunityAuthStore({runtimeRoot:${JSON.stringify(root)}});const workspace=module.createCommunityWorkspace({runtimeRoot:${JSON.stringify(root)},auth,getState:()=>state,activate:next=>{state=next},afterRestoreCutover:()=>process.exit(86)});const app=express();app.use(express.json());app.use('/api',http.createCommunityAccountGuard(auth,module.COMMUNITY_WORKSPACE_ROUTES));app.use('/api',workspace.router);const server=app.listen(0,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));const base='http://127.0.0.1:'+server.address().port+'/api/community/persistence',headers={Cookie:${JSON.stringify(auth.cookieName+'='+owner.token)},'X-CSRF-Token':${JSON.stringify(owner.csrfToken)}};const staged=await fetch(base+'/restore/stage',{method:'POST',headers:{...headers,'Content-Type':'application/zip'},body:readFileSync(join(${JSON.stringify(root)},'backups',${JSON.stringify(backup.id+'.zip')}))});if(staged.status!==201)throw Error('Stage failed: '+await staged.text());const stage=await staged.json();await fetch(base+'/restore/'+stage.id+'/activate',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({fingerprint:stage.fingerprint})});process.exit(87);`;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env},encoding:'utf8',windowsHide:true,timeout:20000});expect(child.status,child.stderr).toBe(86);expect(existsSync(join(root,'.restore-operation-v1.json'))).toBe(true);expect(stateBytes()).toEqual(historical);
  const recovery=await import('../src/community/persistence/restore.js');expect(recovery.recoverInterruptedRestore(root)).toBe(true);db.getDb();state=json.loadState()!;canonical.initializeCanonicalState(state);expect(stateBytes()).toEqual(current);auth=new CommunityAuthStore({runtimeRoot:root});auth.verifyAudit();const restoreEvents=events().filter(event=>event.operation==='restore-activate');expect(restoreEvents).toHaveLength(1);expect(restoreEvents[0]).toMatchObject({action:'DATA_OPERATION_STARTED',actor_id:owner.principal.subject,before:currentSnapshot,after:currentSnapshot});
 },30000);
});
