import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error Synthetic reusable JavaScript fixture has no declaration file.
import { createCompleteLegacyFixture } from './helpers/complete-legacy-fixture.mjs';
import type { MatchingState } from '../src/core/types.js';

const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const originalRoot=process.env.MATCHING_RUNTIME_ROOT,originalMode=process.env.MATCHING_RUNTIME_MODE;
let base:string,active:string,legacy:string,fixture:ReturnType<typeof createCompleteLegacyFixture>,state:MatchingState;
let store:typeof import('../src/storage/db.js'),json:typeof import('../src/storage/json-store.js'),canonical:typeof import('../src/storage/canonical-transaction.js'),migration:typeof import('../src/community/persistence/legacy.js'),restore:typeof import('../src/community/persistence/restore.js');
const exclusive=async<T>(run:()=>Promise<T>)=>run();
function fileHashes(root:string){const out:Record<string,string>={};function walk(path:string){for(const item of readdirSync(path,{withFileTypes:true})){const target=join(path,item.name);if(item.isDirectory())walk(target);else out[relative(root,target)]=hash(readFileSync(target));}}walk(root);return out;}
function expectedState(){
  const expected=structuredClone(fixture.state);expected.schema_version=2;expected.format='matching-community-state-v2';
  for(const[id,doc]of Object.entries(expected.documents) as Array<[string,{filename:string;file_hash:string}]>)doc.filename=id+'-'+hash(fixture.attachments[id]);
  return expected;
}
function compareSql(db:Database.Database){
  for(const[table,sourceRows]of Object.entries(fixture.expectedSql) as Array<[string,Array<Record<string,unknown>>]>){
    const expected=structuredClone(sourceRows);if(table==='documents')for(const row of expected)row.filename=String(row.document_id)+'-'+hash(fixture.attachments[String(row.document_id)]);
    if(table==='invoice_scans')for(const row of expected)row.stored_filename=String(row.document_id)+'-'+hash(fixture.attachments[String(row.document_id)]);
    const actual=db.prepare('SELECT * FROM "'+table+'"').all() as Array<Record<string,unknown>>;
    expect(actual,table).toHaveLength(expected.length);
    for(const row of expected)expect(actual,table).toContainEqual(row);
  }
}
beforeEach(async()=>{
  base=mkdtempSync(join(tmpdir(),'community-complete-legacy-synthetic-'));active=join(base,'active');legacy=join(base,'source');fixture=createCompleteLegacyFixture(legacy);
  process.env.MATCHING_RUNTIME_ROOT=active;process.env.MATCHING_RUNTIME_MODE='external-runtime-root';vi.resetModules();
  store=await import('../src/storage/db.js');store.getDb();json=await import('../src/storage/json-store.js');canonical=await import('../src/storage/canonical-transaction.js');migration=await import('../src/community/persistence/legacy.js');restore=await import('../src/community/persistence/restore.js');
  state=json.createEmptyState('SYNTHETIC-ACTIVE-BEFORE-MIGRATION');json.saveState(state);canonical.initializeCanonicalState(state);
});
afterEach(()=>{
  store?.closeDb();if(originalRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=originalRoot;if(originalMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=originalMode;
  rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});vi.resetModules();
});
async function activate(stage:{id:string;fingerprint:string}){
  return restore.activateCommunityRestore(active,stage.id,stage.fingerprint,exclusive,async(change,rollback)=>{
    store.closeDb();try{change();store.getDb();state=json.loadState()!;canonical.initializeCanonicalState(state);}catch(error){store.closeDb();rollback();store.getDb();state=json.loadState()!;throw error;}
  });
}

describe('independently generated complete supported legacy economic fixture',()=>{
  it('inspects, dry-runs, compares every record, stages, activates and restarts with exact source and attachment preservation',async()=>{
    const sourceBefore=fileHashes(legacy),activeBefore=readFileSync(join(active,'state','state.json'),'utf8');
    const preview=await migration.inspectLegacy(legacy);expect(preview.dry_run).toBe(true);expect(preview.activation_allowed).toBe(false);expect(preview.source_unchanged).toBe(true);
    expect(preview.counts).toEqual({transactions:10,documents:6,match_groups:5,audit_events:1});expect(preview.signed_totals_minor_by_currency).toEqual({EUR:fixture.signedTotalMinor});expect(preview.match_statuses).toEqual({accepted:1,manual:1,confirmed:1,proposed:1,rejected:1});expect(preview.evidence_count).toBe(6);
    expect(fileHashes(legacy)).toEqual(sourceBefore);expect(readFileSync(join(active,'state','state.json'),'utf8')).toBe(activeBefore);
    const stage=await migration.stageLegacyConversion(active,legacy,preview.fingerprint,exclusive),folder=join(active,'.restore-stage-'+stage.id);
    expect(JSON.parse(readFileSync(join(folder,'state','state.json'),'utf8'))).toEqual(expectedState());
    const stagedDb=new Database(join(folder,'database','matching.db'),{readonly:true});try{compareSql(stagedDb);}finally{stagedDb.close();}
    expect(stage.mapping.mapped).toMatchObject({transactions:10,documents:6,line_items:6,match_groups:5,match_group_transactions:5,match_group_documents:5,invoice_payment_candidates:1,payment_status_events:1,invoice_extracted_fields:1,invoice_review_edits:1});
    expect(readFileSync(join(active,'state','state.json'),'utf8')).toBe(activeBefore);await activate(stage);
    expect(JSON.parse(json.serializeCommunityState(state))).toEqual(expectedState());compareSql(store.getDb());
    expect([...new Set([...state.transactions.values()].map(tx=>tx.source_account_id))].sort()).toEqual(fixture.accountIds);
    for(const[id,bytes]of Object.entries(fixture.attachments) as Array<[string,Buffer]>){const doc=state.documents.get(id)!;expect(readFileSync(join(active,'documents',doc.filename!))).toEqual(bytes);expect(doc.file_hash).toBe(hash(bytes));}
    store.closeDb();store.getDb();const restarted=json.loadState()!;canonical.initializeCanonicalState(restarted);expect(JSON.parse(json.serializeCommunityState(restarted))).toEqual(expectedState());compareSql(store.getDb());
    expect(fileHashes(legacy)).toEqual(sourceBefore);expect(restore.recoverInterruptedRestore(active)).toBe(false);
  });
  it('rolls activation back when the receiving application fails, keeping source and prior accounting unchanged',async()=>{
    store.closeDb();const before=fileHashes(legacy),preview=await migration.inspectLegacy(legacy),stage=await migration.stageLegacyConversion(active,legacy,preview.fingerprint,exclusive),activeBefore=readFileSync(join(active,'state','state.json'),'utf8');
    await expect(restore.activateCommunityRestore(active,stage.id,stage.fingerprint,exclusive,async change=>{change();throw new Error('SYNTHETIC_ACTIVATION_FAILURE');})).rejects.toThrow('SYNTHETIC_ACTIVATION_FAILURE');
    expect(readFileSync(join(active,'state','state.json'),'utf8')).toBe(activeBefore);store.getDb();canonical.initializeCanonicalState(json.loadState()!);expect(fileHashes(legacy)).toEqual(before);expect(existsSync(join(active,'.restore-operation-v1.json'))).toBe(false);
  });
  it('recovers actual process interruption during activation back to the prior canonical dataset',async()=>{
    store.closeDb();const before=fileHashes(legacy),preview=await migration.inspectLegacy(legacy),stage=await migration.stageLegacyConversion(active,legacy,preview.fingerprint,exclusive),activeBefore=readFileSync(join(active,'state','state.json'),'utf8');
    const code=`const {activateCommunityRestore}=await import('./src/community/persistence/restore.ts');await activateCommunityRestore(${JSON.stringify(active)},${JSON.stringify(stage.id)},${JSON.stringify(stage.fingerprint)},async run=>run(),async change=>{change();process.exit(86);});process.exit(87);`;
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env},encoding:'utf8',windowsHide:true,timeout:15000});expect(result.status,result.stderr).toBe(86);
    expect(restore.recoverInterruptedRestore(active)).toBe(true);store.getDb();canonical.initializeCanonicalState(json.loadState()!);expect(readFileSync(join(active,'state','state.json'),'utf8')).toBe(activeBefore);expect(fileHashes(legacy)).toEqual(before);
  },20000);
  it('rejects unsupported persisted records explicitly instead of claiming complete migration',async()=>{
    const sourceDb=new Database(join(legacy,'database','matching.db'));sourceDb.exec("CREATE TABLE unsupported_account_registry(id TEXT PRIMARY KEY);INSERT INTO unsupported_account_registry VALUES('SYNTHETIC-UNMAPPED-ACCOUNT')");sourceDb.close();const before=fileHashes(legacy);
    await expect(migration.inspectLegacy(legacy)).rejects.toThrow('Unmapped legacy table with persisted data: unsupported_account_registry');expect(fileHashes(legacy)).toEqual(before);
  });
  it('rejects unknown state fields and detects source changes after dry run',async()=>{
    const preview=await migration.inspectLegacy(legacy),path=join(legacy,'state','state.json'),raw=JSON.parse(readFileSync(path,'utf8'));raw.accounts={'SYN-ACCOUNT':{name:'Fictional unsupported registry'}};writeFileSync(path,JSON.stringify(raw));
    await expect(migration.inspectLegacy(legacy)).rejects.toThrow('Unmapped legacy state field: accounts');await expect(migration.stageLegacyConversion(active,legacy,preview.fingerprint,exclusive)).rejects.toThrow('stale');
  });
  it.each(['browser-profiles/session-synthetic.txt','identity/session-synthetic.txt','documents/browser-profiles/session-synthetic.txt'])('never promotes an excluded private tree to an attachment: %s',async filename=>{
    const path=join(legacy,...filename.split('/'));mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,'SYNTHETIC-PRIVATE-SESSION-CANARY');
    const statePath=join(legacy,'state','state.json'),raw=JSON.parse(readFileSync(statePath,'utf8'));raw.documents['SYN-D1'].filename=filename;delete raw.documents['SYN-D1'].file_hash;writeFileSync(statePath,JSON.stringify(raw));
    const db=new Database(join(legacy,'database','matching.db'));try{db.prepare('UPDATE documents SET filename=?,file_hash=NULL WHERE document_id=?').run(filename,'SYN-D1');}finally{db.close();}
    const before=fileHashes(legacy),activeBefore=readFileSync(join(active,'state','state.json'),'utf8');
    await expect(migration.inspectLegacy(legacy)).rejects.toThrow('Unsafe legacy document path');
    await expect(migration.stageLegacyConversion(active,legacy,migration.legacySourceFingerprint(legacy),exclusive)).rejects.toThrow('Unsafe legacy document path');
    expect(fileHashes(legacy)).toEqual(before);expect(readFileSync(join(active,'state','state.json'),'utf8')).toBe(activeBefore);
    expect(readdirSync(active).some(name=>name.startsWith('.restore-stage-'))).toBe(false);
  });
  it('accepts the exact historical evidence-root prefix and detects changed attachment bytes after confirmation',async()=>{
    const statePath=join(legacy,'state','state.json'),raw=JSON.parse(readFileSync(statePath,'utf8'));raw.documents['SYN-D1'].filename='documents/SYN-D1.txt';delete raw.documents['SYN-D1'].file_hash;writeFileSync(statePath,JSON.stringify(raw));
    const db=new Database(join(legacy,'database','matching.db'));try{db.prepare('UPDATE documents SET filename=?,file_hash=NULL WHERE document_id=?').run('documents/SYN-D1.txt','SYN-D1');}finally{db.close();}
    const preview=await migration.inspectLegacy(legacy);expect(preview.evidence_count).toBe(6);
    const before=readFileSync(join(active,'state','state.json'),'utf8');writeFileSync(join(legacy,'documents','SYN-D1.txt'),'SYNTHETIC-CHANGED-ATTACHMENT-AFTER-DRY-RUN');
    expect(migration.legacySourceFingerprint(legacy)).not.toBe(preview.fingerprint);
    await expect(migration.stageLegacyConversion(active,legacy,preview.fingerprint,exclusive)).rejects.toThrow('stale');
    expect(readFileSync(join(active,'state','state.json'),'utf8')).toBe(before);
  });
  it.each(['documents/SYN-D1.txt:session-synthetic','CON.txt','SYN-D1.txt.','SYN-D1.txt ','documents//SYN-D1.txt','documents/../SYN-D1.txt'])('rejects unsafe Windows attachment components before normalization: %s',async filename=>{
    const statePath=join(legacy,'state','state.json'),raw=JSON.parse(readFileSync(statePath,'utf8'));raw.documents['SYN-D1'].filename=filename;writeFileSync(statePath,JSON.stringify(raw));
    const db=new Database(join(legacy,'database','matching.db'));try{db.prepare('UPDATE documents SET filename=? WHERE document_id=?').run(filename,'SYN-D1');}finally{db.close();}
    const before=fileHashes(legacy);await expect(migration.inspectLegacy(legacy)).rejects.toThrow('Unsafe archive path');expect(fileHashes(legacy)).toEqual(before);
  });
  it('blocks actual NTFS alternate-stream bytes even when they are absent from the confirmed fingerprint',async()=>{
    const filename='SYN-D1.txt:session-synthetic',stream=join(legacy,'documents',filename);writeFileSync(stream,'SYNTHETIC-NTFS-STREAM-BEFORE');
    expect(readFileSync(stream,'utf8')).toBe('SYNTHETIC-NTFS-STREAM-BEFORE');
    if(process.platform==='win32')expect(readdirSync(join(legacy,'documents'))).not.toContain(filename);
    const statePath=join(legacy,'state','state.json'),raw=JSON.parse(readFileSync(statePath,'utf8'));raw.documents['SYN-D1'].filename=filename;delete raw.documents['SYN-D1'].file_hash;writeFileSync(statePath,JSON.stringify(raw));
    const db=new Database(join(legacy,'database','matching.db'));try{db.prepare('UPDATE documents SET filename=?,file_hash=NULL WHERE document_id=?').run(filename,'SYN-D1');}finally{db.close();}
    const fingerprint=migration.legacySourceFingerprint(legacy);writeFileSync(stream,'SYNTHETIC-NTFS-STREAM-AFTER');
    if(process.platform==='win32')expect(migration.legacySourceFingerprint(legacy)).toBe(fingerprint);
    const before=fileHashes(legacy),activeBefore=readFileSync(join(active,'state','state.json'),'utf8');
    await expect(migration.inspectLegacy(legacy)).rejects.toThrow('Unsafe archive path');
    await expect(migration.stageLegacyConversion(active,legacy,migration.legacySourceFingerprint(legacy),exclusive)).rejects.toThrow('Unsafe archive path');
    expect(fileHashes(legacy)).toEqual(before);expect(readFileSync(stream,'utf8')).toBe('SYNTHETIC-NTFS-STREAM-AFTER');expect(readFileSync(join(active,'state','state.json'),'utf8')).toBe(activeBefore);
    expect(readdirSync(active).some(name=>name.startsWith('.restore-stage-'))).toBe(false);
  });
  it('retains documented Windows relative separators without collapsing unsafe components',async()=>{
    const statePath=join(legacy,'state','state.json'),raw=JSON.parse(readFileSync(statePath,'utf8'));raw.documents['SYN-D1'].filename='documents\\SYN-D1.txt';writeFileSync(statePath,JSON.stringify(raw));
    const db=new Database(join(legacy,'database','matching.db'));try{db.prepare('UPDATE documents SET filename=? WHERE document_id=?').run('documents\\SYN-D1.txt','SYN-D1');}finally{db.close();}
    const before=fileHashes(legacy),preview=await migration.inspectLegacy(legacy);expect(preview.evidence_count).toBe(6);
    const stage=await migration.stageLegacyConversion(active,legacy,preview.fingerprint,exclusive),rawStage=JSON.parse(readFileSync(join(active,'.restore-stage-'+stage.id,'state','state.json'),'utf8'));
    expect(readFileSync(join(active,'.restore-stage-'+stage.id,'documents',rawStage.documents['SYN-D1'].filename))).toEqual(fixture.attachments['SYN-D1']);expect(fileHashes(legacy)).toEqual(before);
  });
});
