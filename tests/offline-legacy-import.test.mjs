import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { stageLegacyV2 } from '../src/migration/offline-v2.mjs';
import { verifyLegacyStage } from '../src/migration/verify-offline-stage.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture() {
 const base=mkdtempSync(join(tmpdir(),'matching-community-migration-synthetic-'));
 const source=join(base,'old-app'),destination=join(base,'new-stage');
 mkdirSync(join(source,'data'),{recursive:true});
 mkdirSync(join(source,'Belege'),{recursive:true});
 const dbFile=join(source,'data','matching.db');
 const db=new Database(dbFile);
 db.pragma('journal_mode=WAL');db.pragma('wal_autocheckpoint=0');
 db.exec('CREATE TABLE transactions(id TEXT PRIMARY KEY); CREATE TABLE documents(id TEXT PRIMARY KEY); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);');
 db.prepare('INSERT INTO transactions(id) VALUES(?)').run('TXN_SYNTHETIC');
 db.prepare('INSERT INTO documents(id) VALUES(?)').run('DOC_SYNTHETIC');
 db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('openrouter_api_key','DO_NOT_REUSE_SYNTHETIC_TOKEN');
 db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('paypal_sandbox','true');
 const docBytes=Buffer.from('Synthetic fictional invoice receipt, no real person or account.');
 writeFileSync(join(source,'Belege','demo-receipt.txt'),docBytes);
 const state={
  run_id:'LEGACY_TEST_ONLY',
  transactions:{TXN_SYNTHETIC:{transaction_id:'TXN_SYNTHETIC',amount_minor:-1540,currency_code:'EUR',source_system:'sparkasse',meta:{api_key:'SYNTHETIC_FAKE_TOKEN'}}},
  documents:{DOC_SYNTHETIC:{document_id:'DOC_SYNTHETIC',source_system:'upload',total_amount_minor:-1540,
   filename:'demo-receipt.txt',file_hash:sha(docBytes),meta:{source:'TEST_SYNTHETIC'}}},
  match_groups:{MATCH_SYNTHETIC:{match_group_id:'MATCH_SYNTHETIC',status:'proposed',
    transaction_ids:['TXN_SYNTHETIC'],document_ids:['DOC_SYNTHETIC']}},
  audit_events:[{event_id:'SYNTHETIC_AUDIT',action:'test'}],
  exclusion_rules:[],
  matched_transaction_ids:['TXN_SYNTHETIC'],
  matched_document_ids:['DOC_SYNTHETIC'],
  excluded_transaction_ids:[]
 };
 const statePath=join(source,'data','state.json');
 writeFileSync(statePath,JSON.stringify(state,null,2));
 return {base,source,destination,db,statePath,sourceBytes:readFileSync(statePath)};
}
test('offline preview does not write to the original and inventories all economic links',async()=>{
 const f=fixture();
 try{
  const output=await stageLegacyV2({sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true});
  assert.equal(output.dry_run,true);
  assert.equal(output.activation_allowed,false);
  assert.deepEqual(output.signed_totals_minor_by_currency,{EUR:-1540});
  assert.deepEqual(output.match_statuses,{proposed:1});
  assert.equal(output.evidence_count,1);
  assert.equal(output.credential_fields_removed,1);
  assert.equal(existsSync(f.destination),false);
  assert.deepEqual(readFileSync(f.statePath),f.sourceBytes);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true})}
});
test('offline stage preserves evidence hashes, WAL rows and match status while dropping credentials',async()=>{
 const f=fixture();
 try{
  const outcome=await stageLegacyV2({sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true,dryRun:false});
  assert.equal(outcome.activation_allowed,false);
  assert.equal(outcome.dry_run,false);
  const stagedDb=new Database(join(f.destination,'database','matching.db'),{readonly:true,fileMustExist:true});
  assert.equal(stagedDb.prepare('SELECT COUNT(*) FROM transactions').pluck().get(),1);
  assert.equal(stagedDb.prepare("SELECT COUNT(*) FROM settings WHERE key='openrouter_api_key'").pluck().get(),0);
  assert.equal(stagedDb.prepare("SELECT value FROM settings WHERE key='paypal_sandbox'").pluck().get(),'true');
  stagedDb.close();
  const state=JSON.parse(readFileSync(join(f.destination,'state','state.json'),'utf8'));
  assert.equal(state.match_groups.MATCH_SYNTHETIC.status,'proposed');
  assert.equal(state.transactions.TXN_SYNTHETIC.meta.api_key,undefined);
  const manifest=JSON.parse(readFileSync(join(f.destination,'migration-manifest.json'),'utf8'));
  assert.equal(manifest.bank_actions_enabled,false);
  assert.equal(manifest.activation_allowed,false);
  assert.equal(manifest.documents.length,1);
  const evidenceFile=join(f.destination,manifest.documents[0].path);
  assert.equal(sha(readFileSync(evidenceFile)),manifest.documents[0].sha256);
  assert.deepEqual(readFileSync(f.statePath),f.sourceBytes);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true})}
});
test('unsafe imports fail closed: missing documents, orphan links, no offline confirmation',async()=>{
 const f=fixture();
 try{
  await assert.rejects(stageLegacyV2({sourceRoot:f.source,destinationRoot:f.destination}),/offline/i);
  let state=JSON.parse(f.sourceBytes.toString());
  state.match_groups.MATCH_SYNTHETIC.document_ids.push('MISSING_DOC');
  writeFileSync(f.statePath,JSON.stringify(state));
  await assert.rejects(stageLegacyV2({sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true}),/Orphan/);
  assert.equal(existsSync(f.destination),false);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true})}
});

test('blocks unmapped tables and credential-bearing SQLite columns before copying',async()=>{
 const first=fixture();
 try{
  first.db.exec('CREATE TABLE opaque_extension(payload TEXT)');
  await assert.rejects(stageLegacyV2({
    sourceRoot:first.source,destinationRoot:first.destination,confirmedOffline:true,dryRun:false
  }),/Unsupported SQLite table/);
  assert.equal(existsSync(first.destination),false);
  assert.deepEqual(readFileSync(first.statePath),first.sourceBytes);
 }finally{first.db.close();rmSync(first.base,{recursive:true,force:true})}
 const second=fixture();
 try{
  second.db.exec('ALTER TABLE transactions ADD COLUMN oauthToken TEXT');
  await assert.rejects(stageLegacyV2({
    sourceRoot:second.source,destinationRoot:second.destination,confirmedOffline:true
  }),/Credential-bearing SQLite column/);
 }finally{second.db.close();rmSync(second.base,{recursive:true,force:true})}
});

test('rejects unmapped settings rather than silently exporting an opaque credential',async()=>{
 const f=fixture();
 try{
  f.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)')
    .run('unclassified_provider_configuration','SYNTHETIC_UNCLASSIFIED_DATA');
  await assert.rejects(stageLegacyV2({
    sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true
  }),/Unreviewed SQLite setting/);
  assert.equal(existsSync(f.destination),false);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true})}
});

test('removes mixed-case secrets while retaining source event identity and verified evidence',async()=>{
 const f=fixture();
 try{
  const state=JSON.parse(f.sourceBytes.toString('utf8'));
  state.transactions.TXN_SYNTHETIC.meta.serviceApiKey='SYNTHETIC_DO_NOT_KEEP';
  state.transactions.TXN_SYNTHETIC.meta.oauthAccessToken='SYNTHETIC_DO_NOT_KEEP';
  state.transactions.TXN_SYNTHETIC.meta.source_event_token='SOURCE_EVENT_STABLE_REFERENCE';
  state.documents.DOC_SYNTHETIC.meta.Authorization='SYNTHETIC_DO_NOT_KEEP';
  writeFileSync(f.statePath,JSON.stringify(state));
  f.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)')
    .run('providerClientSecret','SYNTHETIC_DO_NOT_KEEP');
  const outcome=await stageLegacyV2({
    sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true,dryRun:false
  });
  assert.ok(outcome.credential_fields_removed>=5);
  const staged=JSON.parse(readFileSync(join(f.destination,'state','state.json'),'utf8'));
  assert.equal(staged.transactions.TXN_SYNTHETIC.meta.serviceApiKey,undefined);
  assert.equal(staged.transactions.TXN_SYNTHETIC.meta.oauthAccessToken,undefined);
  assert.equal(staged.documents.DOC_SYNTHETIC.meta.Authorization,undefined);
  assert.equal(staged.transactions.TXN_SYNTHETIC.meta.source_event_token,'SOURCE_EVENT_STABLE_REFERENCE');
  const copy=new Database(join(f.destination,'database','matching.db'),{readonly:true});
  try{
   assert.equal(copy.prepare('SELECT COUNT(*) FROM settings WHERE key=?').pluck().get('providerClientSecret'),0);
  }finally{copy.close()}
  assert.equal(existsSync(join(f.destination,'migration-manifest.json')),true);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true})}
});

test('rejects repeated financial match links and unsafe JSON object keys',async()=>{
 const f=fixture();
 try{
  const duplicated=JSON.parse(f.sourceBytes.toString('utf8'));
  duplicated.match_groups.MATCH_SYNTHETIC.transaction_ids.push('TXN_SYNTHETIC');
  writeFileSync(f.statePath,JSON.stringify(duplicated));
  await assert.rejects(stageLegacyV2({
    sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true
  }),/Repeated match-group membership/);
  const polluted=JSON.parse(f.sourceBytes.toString('utf8'));
  polluted.transactions.TXN_SYNTHETIC.meta=JSON.parse('{"__proto__":{"bankApproved":true}}');
  writeFileSync(f.statePath,JSON.stringify(polluted));
  await assert.rejects(stageLegacyV2({
    sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true
  }),/Unsafe state object key/);
  assert.equal(existsSync(f.destination),false);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true})}
});

test('fails closed on credentials hidden in SQLite JSON metadata',async()=>{
 const f=fixture();
 try {
  f.db.exec('ALTER TABLE transactions ADD COLUMN metadata TEXT');
  f.db.prepare('UPDATE transactions SET metadata=? WHERE id=?')
    .run(JSON.stringify({source_event:'STABLE',provider:{accessToken:'SYNTHETIC_NOT_EXPORTABLE'}}),'TXN_SYNTHETIC');
  await assert.rejects(stageLegacyV2({
    sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true,dryRun:false
  }),/Credential-bearing SQLite JSON metadata/);
  assert.equal(existsSync(f.destination),false);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true})}
});

test('disallows unclassified values even under allowlisted settings names',async()=>{
 const f=fixture();
 try{
  f.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)')
    .run('language',JSON.stringify({apiKey:'SYNTHETIC_NOT_EXPORTABLE'}));
  await assert.rejects(stageLegacyV2({
    sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true
  }),/Unreviewed SQLite setting value/);
  assert.equal(existsSync(f.destination),false);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true})}
});

test('offline staged candidate can be independently verified without activation',async()=>{
 const f=fixture();
 try{
  await stageLegacyV2({sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true,dryRun:false});
  const result=verifyLegacyStage({destinationRoot:f.destination});
  assert.equal(result.verified,true);
  assert.equal(result.activation_allowed,false);
  assert.equal(result.bank_actions_enabled,false);
  assert.equal(result.evidence_count,1);
  assert.deepEqual(result.signed_totals_minor_by_currency,{EUR:-1540});
  assert.deepEqual(readFileSync(f.statePath),f.sourceBytes);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true})}
});

test('staged verifier rejects artifact tampering and unmanifested files',async()=>{
 const f=fixture();
 try{
  await stageLegacyV2({sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true,dryRun:false});
  const manifest=JSON.parse(readFileSync(join(f.destination,'migration-manifest.json'),'utf8'));
  const artifact=join(f.destination,manifest.documents[0].path);
  writeFileSync(artifact,'TAMPERED_SYNTHETIC_FILE');
  assert.throws(()=>verifyLegacyStage({destinationRoot:f.destination}),/document content mismatch/);
  writeFileSync(artifact,Buffer.from('Synthetic fictional invoice receipt, no real person or account.'));
  writeFileSync(join(f.destination,'unexpected-source.txt'),'SYNTHETIC_ONLY');
  assert.throws(()=>verifyLegacyStage({destinationRoot:f.destination}),/Unexpected file/);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true})}
});

test('staged verifier detects mismatched accounting totals even with rehashed JSON',async()=>{
 const f=fixture();
 try{
  await stageLegacyV2({sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true,dryRun:false});
  const statePath=join(f.destination,'state','state.json');
  const state=JSON.parse(readFileSync(statePath,'utf8'));
  state.transactions.TXN_SYNTHETIC.amount_minor=-1350;
  const serialized=JSON.stringify(state);
  writeFileSync(statePath,serialized);
  const manifestPath=join(f.destination,'migration-manifest.json');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  manifest.stage_state_sha256=sha(Buffer.from(serialized));
  writeFileSync(manifestPath,JSON.stringify(manifest));
  assert.throws(()=>verifyLegacyStage({destinationRoot:f.destination}),/financial counts or signed minor-unit totals/);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true})}
});

test('staged verifier blocks path escapes and unsafe activation flags',async()=>{
 const f=fixture();
 try{
  await stageLegacyV2({sourceRoot:f.source,destinationRoot:f.destination,confirmedOffline:true,dryRun:false});
  const manifestPath=join(f.destination,'migration-manifest.json');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  manifest.documents[0].path='../outside';
  writeFileSync(manifestPath,JSON.stringify(manifest));
  assert.throws(()=>verifyLegacyStage({destinationRoot:f.destination}),/artifact manifest/);
  manifest.documents[0].path='evidence/DOC_SYNTHETIC-'+manifest.documents[0].sha256;
  manifest.activation_allowed=true;
  writeFileSync(manifestPath,JSON.stringify(manifest));
  assert.throws(()=>verifyLegacyStage({destinationRoot:f.destination}),/unsafe activation/);
 }finally{f.db.close();rmSync(f.base,{recursive:true,force:true})}
});
