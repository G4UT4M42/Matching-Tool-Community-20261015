import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import express from 'express';
import type {Server} from 'node:http';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';
import type {MatchingState} from '../src/core/types.js';
import {accountingOf,acceptAllocations,createSafeExclusionRule,setExclusionRuleEnabled,setPrivateOrExcluded,classifyTransaction,classifyTax,applyActiveExclusionsForNewTransactions} from '../src/community/accounting/ledger.js';
import {createCommunityAccountingRouter} from '../src/server/routes/community-accounting.js';
const actor='SYNTHETIC-RULE-OWNER',workspace='SYNTHETIC-RULE-WORKSPACE';
const originalRoot=process.env.MATCHING_RUNTIME_ROOT,originalMode=process.env.MATCHING_RUNTIME_MODE;
let root:string,state:MatchingState,db:typeof import('../src/storage/db.js'),json:typeof import('../src/storage/json-store.js'),canonical:typeof import('../src/storage/canonical-transaction.js'),server:Server|undefined;
const rev=()=>accountingOf(state).revision;
function commit(next:MatchingState){state=canonical.commitCanonicalState(state,next,actor);}
function create(value='shared',operator='contains'){commit(createSafeExclusionRule(state,{revision:rev(),field:'description_raw',operator,value},actor));return state.exclusion_rules.at(-1)!.exclusion_id;}
function toggle(id:string,enabled:boolean){commit(setExclusionRuleEnabled(state,id,{revision:rev(),enabled},actor));}
function disposition(transaction_id:string,value:string){commit(setPrivateOrExcluded(state,{revision:rev(),transaction_id,disposition:value,evidence_ref:'SYNTHETIC-MANUAL-DECISION'},actor));}
function restart(){db.closeDb();db.getDb();state=json.loadState()!;canonical.initializeCanonicalState(state);}
async function listen(){
 const app=express();app.use(express.json());app.use((req,res,next)=>{if(req.header('x-no-principal')!=='yes')res.locals.communityPrincipal={subject:actor,workspace_id:req.header('x-workspace')??workspace,role:req.header('x-role')??'owner'};next();});
 app.use('/api',createCommunityAccountingRouter({workspaceId:workspace,getState:()=>state,can:(p,permission)=>p.role==='owner'||p.role==='viewer'&&permission==='finance:read',persistAndActivate:(before,next)=>{expect(before).toBe(state);commit(next);}}));
 server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server!.once('listening',ok));return{app,base:'http://127.0.0.1:'+(server.address() as {port:number}).port};
}
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),'matching-exclusion-synthetic-'));process.env.MATCHING_RUNTIME_ROOT=root;process.env.MATCHING_RUNTIME_MODE='external-runtime-root';vi.resetModules();db=await import('../src/storage/db.js');db.getDb();json=await import('../src/storage/json-store.js');canonical=await import('../src/storage/canonical-transaction.js');
 state=json.createEmptyState('SYNTHETIC_EXCLUSION_LIFECYCLE');
 for(const key of ['T1','T2','TM','OTHER'])state.transactions.set(key,{transaction_id:key,source_system:'sparkasse',source_account_id:'SYNTHETIC-ACCOUNT',source_row_ref:key,posting_at:'2026-10-15T00:00:00Z',amount_minor:-100,currency_code:'EUR',description_raw:key==='OTHER'?'Synthetic other':key==='TM'?'Synthetic shared manual':'Synthetic shared supplier',tags:[],meta:{synthetic:true}});
 state.documents.set('D1',{document_id:'D1',source_system:'manual',source_document_ref:'SYNTHETIC-DOC',captured_at:'2026-10-15T00:00:00Z',document_date:'2026-10-15',total_amount_minor:-100,currency_code:'EUR',meta:{synthetic:true}});
 json.saveState(state);canonical.initializeCanonicalState(state);
});
afterEach(async()=>{if(server)await new Promise<void>(ok=>server!.close(()=>ok()));server=undefined;db?.closeDb();if(originalRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=originalRoot;if(originalMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=originalMode;rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});vi.resetModules();});
describe('audited literal exclusion rule lifecycle',()=>{
 it('preserves overlapping enabled rules, manual exclusions and existing classifications across disable and re-enable',()=>{
  disposition('TM','excluded');commit(classifyTransaction(state,{revision:rev(),transaction_id:'T2',category:'expense',evidence_ref:'SYNTHETIC-EXPENSE'},actor));const classifications=structuredClone(state.accounting!.classifications),originals=structuredClone(state.transactions);
  const first=create(),second=create('Synthetic shared supplier','equals');toggle(first,false);expect([...state.excluded_transaction_ids].sort()).toEqual(['T1','T2','TM']);toggle(second,false);expect([...state.excluded_transaction_ids]).toEqual(['TM']);
  toggle(first,true);expect([...state.excluded_transaction_ids].sort()).toEqual(['T1','T2','TM']);expect(state.accounting!.classifications).toEqual(classifications);expect(state.transactions).toEqual(originals);
  disposition('T1','restore');expect(state.excluded_transaction_ids.has('T1')).toBe(true);disposition('T1','excluded');toggle(first,false);expect([...state.excluded_transaction_ids].sort()).toEqual(['T1','TM']);
  expect(state.audit_events.at(-1)).toMatchObject({action:'EXCLUSION_TOGGLED',actor_id:actor,after:{rule_ownership_version:1,released_transaction_ids:['T2']}});
 });
 it('preserves unknown preexisting exclusions and only releases new proven additions for historical literal rules',()=>{
  const next=structuredClone(state);next.excluded_transaction_ids.add('T1');next.exclusion_rules.push({exclusion_id:'SYN-LEGACY-LITERAL',created_at:'2026-10-14T00:00:00Z',created_by:'unknown-historical-actor',field:'description_raw',operator:'contains',value:'shared',enabled:true});commit(next);
  toggle('SYN-LEGACY-LITERAL',false);expect([...state.excluded_transaction_ids]).toEqual(['T1']);toggle('SYN-LEGACY-LITERAL',true);toggle('SYN-LEGACY-LITERAL',false);expect([...state.excluded_transaction_ids]).toEqual(['T1']);
  expect(state.accounting!.classifications).toEqual([]);expect(state.audit_events.some(event=>event.after?.legacy_exclusions_preserved===true)).toBe(true);
 });
 it('never enables unsupported legacy regex or fields and conservatively retains ambiguous exclusions',()=>{
  const first=create();const next=structuredClone(state);next.exclusion_rules.push({exclusion_id:'SYN-LEGACY-REGEX',created_at:'2026-10-14T00:00:00Z',created_by:'historical',field:'description_raw',operator:'regex',value:'SYNTHETIC.*',enabled:true});commit(next);
  toggle(first,false);expect(state.excluded_transaction_ids.has('T1')).toBe(true);toggle('SYN-LEGACY-REGEX',false);expect(state.excluded_transaction_ids.has('T1')).toBe(true);
  expect(()=>setExclusionRuleEnabled(state,'SYN-LEGACY-REGEX',{revision:rev(),enabled:true},actor)).toThrow(/literal/);
  const malformed=structuredClone(state);malformed.exclusion_rules[0].field='unreviewed';malformed.exclusion_rules[0].enabled=false;expect(()=>setExclusionRuleEnabled(malformed,first,{revision:rev(),enabled:true},actor)).toThrow(/literal/);
 });
 it('rejects stale revisions, unknown IDs and invalid bodies before changing state, and makes exact retries no-ops',()=>{
  const first=create(),before=json.serializeCommunityState(state);expect(()=>setExclusionRuleEnabled(state,first,{revision:rev()-1,enabled:false},actor)).toThrow(/changed/);expect(()=>setExclusionRuleEnabled(state,'missing',{revision:rev(),enabled:false},actor)).toThrow(/not found/);
  for(const body of [{revision:rev(),enabled:'false'},{revision:rev(),enabled:false,actor:'spoof'},{revision:rev(),enabled:false,value:'other'}])expect(()=>setExclusionRuleEnabled(state,first,body,actor)).toThrow();
  expect(setExclusionRuleEnabled(state,first,{revision:rev(),enabled:true},actor)).toBe(state);expect(json.serializeCommunityState(state)).toBe(before);
 });
 it.each(['allocation','full-match'])('blocks re-enable across an accepted %s without altering the decision',kind=>{
  const first=create();toggle(first,false);
  if(kind==='allocation')commit(acceptAllocations(state,{revision:rev(),evidence_ref:'SYNTHETIC-ACCEPTED',allocations:[{kind:'payment',transaction_id:'T1',document_id:'D1',transaction_amount_minor:-100,document_amount_minor:-100}]},actor));
  else{const next=structuredClone(state);next.match_groups.set('SYN-ACCEPTED',{match_group_id:'SYN-ACCEPTED',status:'accepted',created_at:'2026-10-15T00:00:00Z',created_by:actor,rule_id:'MANUAL',transaction_ids:['T1'],document_ids:['D1'],amount_total_minor:-100,currency_code:'EUR',reason_codes:[]});commit(next);}
  const before=json.serializeCommunityState(state);expect(()=>setExclusionRuleEnabled(state,first,{revision:rev(),enabled:true},actor)).toThrow(/intersects/);expect(json.serializeCommunityState(state)).toBe(before);
 });
 it('restarts exact canonical rule flags, excluded IDs, manual ownership and append-only audit',()=>{
  disposition('TM','excluded');const first=create(),second=create('Synthetic shared supplier','equals');toggle(first,false);const before=json.serializeCommunityState(state),audit=structuredClone(state.audit_events);restart();expect(json.serializeCommunityState(state)).toBe(before);expect(state.audit_events).toEqual(audit);
  expect(db.getDb().prepare('SELECT enabled FROM exclusion_rules WHERE exclusion_id=?').pluck().get(first)).toBe(0);toggle(second,false);expect([...state.excluded_transaction_ids]).toEqual(['TM']);restart();expect([...state.excluded_transaction_ids]).toEqual(['TM']);expect(state.audit_events.slice(0,audit.length)).toEqual(audit);
 });
 it('applies active literal rules to new imported rows with durable overlapping/manual ownership and no classification changes',()=>{
  const first=create(),second=create('Synthetic shared supplier','equals'),before=state;
  let imported=structuredClone(state);for(const key of ['NEW','NEW-MANUAL'])imported.transactions.set(key,{...state.transactions.get('T1')!,transaction_id:key,source_row_ref:key});imported.excluded_transaction_ids.add('NEW-MANUAL');
  imported=classifyTransaction(imported,{revision:rev(),transaction_id:'NEW',category:'expense',evidence_ref:'SYNTHETIC-IMPORTED-CLASSIFICATION'},actor);const original=json.serializeCommunityState(imported),classifications=structuredClone(imported.accounting!.classifications);
  const applied=applyActiveExclusionsForNewTransactions(before,imported,actor);expect(applied).not.toBe(imported);expect(json.serializeCommunityState(imported)).toBe(original);expect(applied.accounting!.classifications).toEqual(classifications);expect(applied.excluded_transaction_ids.has('NEW')).toBe(true);expect(applied.audit_events.slice(-2).every(event=>(event.after?.applied_transaction_ids as string[]).includes('NEW'))).toBe(true);expect(applyActiveExclusionsForNewTransactions(before,applied,actor)).toBe(applied);
  commit(applied);restart();toggle(first,false);expect(state.excluded_transaction_ids.has('NEW')).toBe(true);toggle(second,false);expect(state.excluded_transaction_ids.has('NEW')).toBe(false);expect(state.excluded_transaction_ids.has('NEW-MANUAL')).toBe(true);expect(state.accounting!.classifications).toEqual(classifications);restart();expect(state.excluded_transaction_ids.has('NEW')).toBe(false);expect(state.excluded_transaction_ids.has('NEW-MANUAL')).toBe(true);
 });
 it('applies no unsupported historical rules and never reapplies rules to preexisting IDs',()=>{
  const next=structuredClone(state);next.exclusion_rules.push({exclusion_id:'SYN-LEGACY-REGEX',created_at:'2026-10-14T00:00:00Z',created_by:'historical',field:'description_raw',operator:'regex',value:'SYNTHETIC.*',enabled:true});commit(next);create('does-not-match');
  const imported=structuredClone(state);imported.transactions.set('NEW',{...state.transactions.get('T1')!,transaction_id:'NEW',source_row_ref:'NEW'});expect(applyActiveExclusionsForNewTransactions(state,imported,actor)).toBe(imported);expect(imported.excluded_transaction_ids.has('NEW')).toBe(false);
  const unchangedIds=structuredClone(state);unchangedIds.transactions.get('T1')!.description_raw='does-not-match';expect(applyActiveExclusionsForNewTransactions(state,unchangedIds,actor)).toBe(unchangedIds);expect(unchangedIds.excluded_transaction_ids.has('T1')).toBe(false);
 });
 it('rejects applying an active rule to a new already-allocated import without mutating its candidate',()=>{
  create();let imported=structuredClone(state);imported.transactions.set('NEW',{...state.transactions.get('T1')!,transaction_id:'NEW',source_row_ref:'NEW'});
  imported=acceptAllocations(imported,{revision:rev(),evidence_ref:'SYNTHETIC-NEW-ALLOCATED',allocations:[{kind:'payment',transaction_id:'NEW',document_id:'D1',transaction_amount_minor:-100,document_amount_minor:-100}]},actor);const before=json.serializeCommunityState(imported);expect(()=>applyActiveExclusionsForNewTransactions(state,imported,actor)).toThrow(/intersects/);expect(json.serializeCommunityState(imported)).toBe(before);
 });
 it('records exact explicit before and after values for dispositions, classifications and tax reviews',()=>{
  commit(classifyTransaction(state,{revision:rev(),transaction_id:'OTHER',category:'expense',evidence_ref:'SYNTHETIC-CLASSIFICATION'},actor));expect(state.audit_events.at(-1)).toMatchObject({before:{classification:null},after:{classification:{category:'expense'}}});disposition('OTHER','private');expect(state.audit_events.at(-1)).toMatchObject({before:{excluded:false,classification:{category:'expense'}},after:{excluded:false,classification:{category:'private'}}});
  commit(classifyTax(state,{revision:rev(),document_id:'D1',tax_category:'input',rate_numerator:1,rate_denominator:5,vat_minor:-20,input_tax_eligible:true,evidence_ref:'SYNTHETIC-TAX'},actor));expect(state.audit_events.at(-1)).toMatchObject({before:{tax:null},after:{tax:{vat_minor:-20}}});
 });
 it('authenticates lifecycle requests, rejects spoofing/stale state and lists rule capabilities through the coordinator',async()=>{
  const first=create(),{base}=await listen();const patch=(body:unknown,headers:Record<string,string>={})=>fetch(base+'/api/accounting/exclusions/'+first,{method:'PATCH',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  for(const [headers,status]of [[{'x-no-principal':'yes'},401],[{'x-role':'viewer'},403],[{'x-workspace':'other'},403]] as const)expect((await patch({revision:rev(),enabled:false},headers)).status).toBe(status);
  expect((await patch({revision:rev(),enabled:false,actor:'spoof'})).status).toBe(400);const initialRevision=rev();expect((await patch({revision:initialRevision,enabled:false})).status).toBe(200);expect((await patch({revision:initialRevision,enabled:true})).status).toBe(409);
  const count=state.audit_events.length;expect((await patch({revision:rev(),enabled:false})).status).toBe(200);expect(state.audit_events).toHaveLength(count);
  const snapshot=await (await fetch(base+'/api/accounting', {headers:{'x-role':'viewer'}})).json();expect(snapshot.exclusion_rules).toMatchObject([{exclusion_id:first,enabled:false,can_enable:true,ownership_known:true}]);expect(state.audit_events.at(-1)?.actor_id).toBe(actor);
 });
 it('creates, disables and re-enables a literal rule through normal browser controls',async()=>{
  const executablePath=['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(existsSync);expect(executablePath).toBeTruthy();
  const runtime=join(root,'synthetic-browser');mkdirSync(runtime);await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import{CommunityAccounting}from'../web/src/pages/CommunityAccounting.tsx';createRoot(document.getElementById('root')).render(React.createElement(CommunityAccounting,{apiBase:'/api',locale:location.search.includes('de')?'de':'en',permissions:location.search.includes('viewer')?['finance:read']:['finance:read','finance:annotate']}));",resolveDir:resolve('tests'),loader:'tsx',sourcefile:'synthetic-rule-harness.tsx'},bundle:true,platform:'browser',format:'iife',outfile:join(runtime,'harness.js'),logLevel:'silent',alias:{react:resolve('web/node_modules/react'),'react-dom/client':resolve('web/node_modules/react-dom/client')}});
  const {app,base}=await listen();app.get('/harness.js',(_req,res)=>res.sendFile(join(runtime,'harness.js')));app.get('/',(_req,res)=>res.type('html').send('<!doctype html><div id="root"></div><script src="/harness.js"></script>'));
  const browser=await puppeteer.launch({executablePath,headless:true,userDataDir:join(runtime,'fresh-profile'),args:['--no-first-run','--disable-background-networking','--disable-extensions']});
  try{
   const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));await page.goto(base,{waitUntil:'networkidle0'});await page.type('#accounting-exclusionValue','shared');await page.evaluate(()=>{const button=Array.from(document.querySelectorAll('button')).find(node=>node.textContent==='Save Literal exclusion rule');if(!button)throw Error('Missing create rule control');button.click();});
   await page.waitForSelector('[data-exclusion-id] button');const first=state.exclusion_rules[0].exclusion_id;expect(state.excluded_transaction_ids.has('T1')).toBe(true);await page.click('[data-exclusion-id] button');await page.waitForFunction(()=>document.querySelector('[data-exclusion-id] button')?.textContent==='Enable');expect(state.excluded_transaction_ids.has('T1')).toBe(false);
   await page.click('[data-exclusion-id] button');await page.waitForFunction(()=>document.querySelector('[data-exclusion-id] button')?.textContent==='Disable');expect(state.excluded_transaction_ids.has('T1')).toBe(true);expect(state.exclusion_rules[0].exclusion_id).toBe(first);
   await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('[data-exclusion-id] button');expect(await page.$eval('[data-exclusion-id]',node=>node.textContent)).toContain('Enabled');await page.goto(base+'/?viewer',{waitUntil:'networkidle0'});await page.waitForSelector('[data-exclusion-id]');expect(await page.$('[data-exclusion-id] button')).toBeNull();await page.goto(base+'/?de',{waitUntil:'networkidle0'});await page.evaluate(()=>{const button=Array.from(document.querySelectorAll('button')).find(node=>node.textContent==='Bericht laden');if(!button)throw Error('Missing German report control');button.click();});await page.waitForSelector('[data-report-vat-currency]');const german=await page.$eval('body',node=>node.innerText);expect(german).toContain('USt Summen nach Währung');expect(german).toContain('Nicht klassifizierte Belege');expect(german).not.toContain('eligible_input_minor');expect(await page.$eval('[data-report-total=excluded]',node=>node.textContent)).toBe('-300');expect(errors).toEqual([]);
  }finally{await browser.close();}
 },30000);
});
