#!/usr/bin/env node
/** Bounded synthetic capacity evidence, never opens an existing financial runtime. */
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2);
if(!process.versions.node.startsWith('22.')||process.versions.modules!=='127')throw new Error('Use the qualified Node22/ABI127 runtime');
const policy={transactions:2000,documents:200,accounts:5,allocations:200,iterations:25,limits:{report_p95_ms:2000,serialization_p95_ms:1000,commit_ms:30000,restart_ms:15000,backup_ms:30000,peak_rss_bytes:1024*1024*1024}};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function external(value){
 if(!value||!isAbsolute(value))throw new Error('Use a new absolute external evidence directory');
 const path=resolve(value),rel=relative(root,path);if(rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)))throw new Error('Capacity evidence must remain outside the checkout');
 for(let current=path;;current=dirname(current)){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('Linked capacity evidence directory rejected');if(dirname(current)===current)break;}return path;
}
if(args.length!==2||!['--out','--worker'].includes(args[0]))throw new Error('Use node --import tsx scripts/qualify-community-capacity.mjs --out <new-absolute-external-directory>');
const out=external(args[1]),marker=join(out,'synthetic-capacity.json');
if(args[0]==='--out'){
 if(existsSync(out))throw new Error('Existing capacity evidence must not be replaced');
 mkdirSync(out,{recursive:true});const id=randomUUID();writeFileSync(marker,JSON.stringify({format:'matching-synthetic-capacity-v1',id,policy}),{flag:'wx'});
 const env={...process.env,MATCHING_RUNTIME_MODE:'external-runtime-root',MATCHING_RUNTIME_ROOT:join(out,'runtime'),MATCHING_DEMO_MODE:'false',MATCHING_AUTH_MODE:'accounts',MATCHING_ENABLE_BANK_AUTOMATION:'false',MATCHING_CAPACITY_RUN_ID:id};delete env.MATCHING_LOCAL_ACCESS_TOKEN;
 const run=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'--worker',out],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
 writeFileSync(join(out,'command-result.json'),JSON.stringify({source_revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),working_tree_dirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),script_sha256:hash(readFileSync(fileURLToPath(import.meta.url))),runtime:process.version,abi:process.versions.modules,exit_code:run.status,error_code:run.error?.code??null,command:'node --import tsx scripts/qualify-community-capacity.mjs --out <new-external-directory>',release_accepted:false},null,2));
 writeFileSync(join(out,'worker.log'),(run.stdout??'')+(run.stderr??''));if(run.status!==0)throw new Error('Synthetic capacity qualification failed; preserve external evidence');console.log(readFileSync(join(out,'result.json'),'utf8'));process.exit(0);
}
const owned=JSON.parse(readFileSync(marker,'utf8'));assert.equal(owned.format,'matching-synthetic-capacity-v1');assert.equal(owned.id,process.env.MATCHING_CAPACITY_RUN_ID);assert.deepEqual(owned.policy,policy);
const runtime=join(out,'runtime');assert.equal(process.env.MATCHING_RUNTIME_ROOT,runtime);assert.equal(existsSync(runtime),false);mkdirSync(runtime);
const json=await import('../src/storage/json-store.ts'),db=await import('../src/storage/db.ts'),atomic=await import('../src/storage/canonical-transaction.ts');
const {accountingReport}=await import('../src/community/accounting/reports.ts'),{acceptAllocations}=await import('../src/community/accounting/ledger.ts');
const {CommunityDocumentService}=await import('../src/community/documents/service.ts'),{createCommunityBackup,inspectBackupBytes}=await import('../src/community/persistence/backup.ts');
const timings={},measure=async(name,work)=>{const start=performance.now();const value=await work();(timings[name]??=[]).push(performance.now()-start);return value;};
let state=json.createEmptyState('COMMUNITY_SYNTHETIC_CAPACITY_V1');db.getDb();json.saveState(state);atomic.initializeCanonicalState(state);
try{
 const next=structuredClone(state),expected={};
 for(let i=0;i<policy.transactions;i++){
  const id='SYN-CAP-T'+i,amount=i<policy.documents?-100:(i%2?1:-1)*(100+i),currency=i<policy.documents?'EUR':i%3===0?'USD':'EUR';expected[currency]=(expected[currency]??0)+amount;
  next.transactions.set(id,{transaction_id:id,source_system:'sparkasse',source_account_id:'SYN-CAP-A'+i%policy.accounts,source_row_ref:id,posting_at:'2026-01-12',amount_minor:amount,currency_code:currency,description_raw:'Fictional generated capacity event '+i,tags:[],meta:{synthetic:true}});
 }
 state=await measure('commit',()=>atomic.commitCanonicalState(state,next,'synthetic-capacity-owner'));
 const docs=new CommunityDocumentService({root:join(runtime,'documents'),workspaceId:'synthetic-capacity-workspace',getState:()=>state,persistAndActivate:(before,nextState,actor)=>{state=atomic.commitCanonicalState(before,nextState,actor);}});
 const table=Buffer.from('source_id;invoice_number;supplier_name;document_date;total_amount;currency_code\n'+Array.from({length:policy.documents},(_,i)=>`SYN-CAP-D${i};SYN-CAP-I${i};Fictional Capacity Supplier;2026-01-12;1.00;EUR`).join('\n'));
 await measure('document_import',()=>docs.importTable({subject:'synthetic-capacity-owner',workspace_id:'synthetic-capacity-workspace'},table,'synthetic-capacity.csv','invoice'));
 const documentByRef=new Map([...state.documents.values()].map(document=>[document.source_document_ref,document.document_id]));
 for(let offset=0;offset<policy.documents;offset+=100){
  const allocations=Array.from({length:100},(_,index)=>{const i=offset+index;return{kind:'payment',transaction_id:'SYN-CAP-T'+i,document_id:documentByRef.get('SYN-CAP-D'+i),transaction_amount_minor:-100,document_amount_minor:100};});
  state=await measure('commit',()=>atomic.commitCanonicalState(state,acceptAllocations(state,{revision:state.accounting?.revision??0,evidence_ref:'SYNTHETIC-CAPACITY-'+offset,allocations},'synthetic-capacity-owner'),'synthetic-capacity-owner'));
 }
 for(let i=0;i<policy.iterations;i++){
  const report=await measure('report',()=>accountingReport(state,{start:'2026-01-01',end:'2026-12-31'}));assert.equal(report.rows.length,policy.transactions);assert.equal(report.documents.length,policy.documents);assert.ok(report.documents.every(document=>document.remaining_minor===0));
  for(const[currency,total]of Object.entries(expected))assert.equal(Object.values(report.totals_by_currency[currency]).reduce((a,b)=>a+b,0),total);
  await measure('serialization',()=>json.serializeCommunityState(state));
 }
 const before=json.serializeCommunityState(state),snapshotHash=hash(before);
 const backup=await measure('backup',()=>createCommunityBackup(runtime,operation=>operation()));const backupBytes=readFileSync(backup.path),backupHash=hash(backupBytes),inspected=inspectBackupBytes(backupBytes);assert.equal(inspected.manifest.financial.counts.transactions,policy.transactions);assert.equal(inspected.manifest.financial.counts.documents,policy.documents);assert.deepEqual(inspected.manifest.financial.totals_minor_by_currency,expected);
 await measure('restart',()=>{db.closeDb();db.getDb();state=json.loadState();atomic.initializeCanonicalState(state);assert.equal(hash(json.serializeCommunityState(state)),snapshotHash);});
 assert.equal(db.getDb().prepare('SELECT count(*) FROM transactions').pluck().get(),policy.transactions);assert.equal(db.getDb().prepare('SELECT count(*) FROM documents').pluck().get(),policy.documents);assert.equal(state.accounting.allocations.length,policy.allocations);
 const summarize=values=>{const sorted=[...values].sort((a,b)=>a-b);return{samples:sorted.length,min_ms:sorted[0],p50_ms:sorted[Math.ceil(sorted.length*.5)-1],p95_ms:sorted[Math.ceil(sorted.length*.95)-1],max_ms:sorted.at(-1)};};
 const summary=Object.fromEntries(Object.entries(timings).map(([name,values])=>[name,summarize(values)])),peak=process.resourceUsage().maxRSS*1024;
 assert.ok(summary.report.p95_ms<=policy.limits.report_p95_ms);assert.ok(summary.serialization.p95_ms<=policy.limits.serialization_p95_ms);assert.ok(summary.commit.max_ms<=policy.limits.commit_ms);assert.ok(summary.restart.max_ms<=policy.limits.restart_ms);assert.ok(summary.backup.max_ms<=policy.limits.backup_ms);assert.ok(peak<=policy.limits.peak_rss_bytes);
 db.closeDb();assert.equal(JSON.parse(readFileSync(marker,'utf8')).id,owned.id);assert.equal(resolve(runtime),join(resolve(out),'runtime'));rmSync(runtime,{recursive:true,force:true,maxRetries:10,retryDelay:100});assert.equal(existsSync(runtime),false);
 writeFileSync(join(out,'result.json'),JSON.stringify({result:'PASS',synthetic_only:true,policy,timings:summary,peak_rss_bytes:peak,independent_totals_minor_by_currency:expected,canonical_state_sha256:snapshotHash,backup_sha256:backupHash,cleanup:true,scope:'Canonical persistence, full reports, source-backed document import, exact allocations, backup and verified reopen; excludes OCR/provider/network throughput',release_accepted:false},null,2),{flag:'wx'});
}finally{db.closeDb();}
