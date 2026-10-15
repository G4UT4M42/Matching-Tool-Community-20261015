import Database from 'better-sqlite3';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {join,relative,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
// @ts-expect-error Independent JavaScript fixture is shared with installed browser qualification.
import {createOperationalLegacyFixture} from './helpers/legacy-operational-fixture.mjs';
import type {MatchingState} from '../src/core/types.js';
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const priorRoot=process.env.MATCHING_RUNTIME_ROOT,priorMode=process.env.MATCHING_RUNTIME_MODE;
let base:string,active:string,source:string,fixture:ReturnType<typeof createOperationalLegacyFixture>,state:MatchingState;
let db:typeof import('../src/storage/db.js'),json:typeof import('../src/storage/json-store.js'),canonical:typeof import('../src/storage/canonical-transaction.js');
const exclusive=async<T>(run:()=>Promise<T>)=>run();
function hashes(root:string){const result:Record<string,string>={};function walk(path:string){for(const item of readdirSync(path,{withFileTypes:true})){const file=join(path,item.name);if(item.isDirectory())walk(file);else result[relative(root,file)]=hash(readFileSync(file));}}walk(root);return result;}
beforeEach(async()=>{
 base=mkdtempSync(join(tmpdir(),'community-legacy-operations-'));active=join(base,'active');source=join(base,'source');fixture=createOperationalLegacyFixture(source);
 process.env.MATCHING_RUNTIME_MODE='external-runtime-root';process.env.MATCHING_RUNTIME_ROOT=active;vi.resetModules();
 db=await import('../src/storage/db.js');json=await import('../src/storage/json-store.js');canonical=await import('../src/storage/canonical-transaction.js');db.getDb();state=json.createEmptyState('SYNTHETIC-OPERATIONAL-MIGRATION');json.saveState(state);canonical.initializeCanonicalState(state);
});
afterEach(()=>{db?.closeDb();if(priorRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=priorRoot;if(priorMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=priorMode;if(base){if(!resolve(base).startsWith(resolve(tmpdir())+sep+'community-legacy-operations-'))throw new Error('Unexpected synthetic operational fixture cleanup path');rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});}vi.resetModules();});

it('retains known operational history and linked originals through migration, exact backup, restore and restart without restoring execution authority',async()=>{
 const migration=await import('../src/community/persistence/legacy.js'),restore=await import('../src/community/persistence/restore.js'),backup=await import('../src/community/persistence/backup.js');
 const original=hashes(source),preview=await migration.inspectLegacy(source);expect(preview.operational_history_rows).toBe(9);expect(preview.counts.audit_events).toBe(10);expect(preview.evidence_count).toBe(8);expect(JSON.stringify(preview)).not.toContain('SYNTHETIC-DO-NOT-ARCHIVE');
 const stage=await migration.stageLegacyConversion(active,source,preview.fingerprint,exclusive);
 await restore.activateCommunityRestore(active,stage.id,stage.fingerprint,exclusive,async(change,rollback)=>{db.closeDb();try{change();db.getDb();state=json.loadState()!;canonical.initializeCanonicalState(state);}catch(error){db.closeDb();rollback();db.getDb();state=json.loadState()!;throw error;}});
 const archived=state.audit_events.filter(event=>event.after?.legacy_operational_history_version===1);expect(archived).toHaveLength(9);expect(state.audit_events.slice(0,1)).toEqual(fixture.state.audit_events);
 expect([...new Set(archived.map(event=>event.after!.table))].sort()).toEqual([...fixture.operationalTables].sort());
 expect(archived.every(event=>event.actor_type==='system'&&event.actor_id==='legacy-migration')).toBe(true);expect(JSON.stringify(archived)).not.toContain('SYNTHETIC-DO-NOT-ARCHIVE');expect(JSON.stringify(archived)).not.toContain('example.invalid');
 for(const table of fixture.operationalTables)expect(db.getDb().prepare('SELECT count(*) FROM '+table).pluck().get()).toBe(0);
 const extracted=archived.find(event=>event.after!.table==='invoice_bot_extracted_invoices')!.after!;expect(extracted.fields).toMatchObject({id:'SYN-OLD-EXTRACT',document_id:'SYN-D3',gross_total_minor:10000,currency:'EUR',artifact_id:'SYN-OLD-ARTIFACT'});
 const cost=archived.find(event=>event.after!.table==='ai_cost_sessions')!.after!;expect(cost.fields).toMatchObject({total_cost_usd:0.0027,total_tokens:30});
 const before=json.serializeCommunityState(state),created=await backup.createCommunityBackup(active,exclusive),inspected=backup.inspectBackupBytes(readFileSync(created.path));
 const evidence='documents/legacy-evidence/'+fixture.state.documents['SYN-D3'].file_hash;expect(inspected.files.get(evidence)).toEqual(fixture.attachments['SYN-D3']);expect(inspected.manifest.financial.counts.audit_events).toBe(10);for(const [digest,bytes]of Object.entries(fixture.operationalAttachments))expect(inspected.files.get('documents/legacy-evidence/'+digest)).toEqual(bytes);
 db.closeDb();db.getDb();state=json.loadState()!;canonical.initializeCanonicalState(state);expect(json.serializeCommunityState(state)).toBe(before);expect(hashes(source)).toEqual(original);
 const restaged=await restore.stageCommunityRestore(active,readFileSync(created.path),exclusive);expect(restaged.manifest.financial.counts.audit_events).toBe(10);
  const activeOriginal=join(active,...evidence.split('/'));writeFileSync(activeOriginal,'SYNTHETIC CHANGED AFTER RESTORE REVIEW');
  await expect(restore.activateCommunityRestore(active,restaged.id,restaged.fingerprint,exclusive,async()=>{throw new Error('Stale archive must reject before activation');})).rejects.toThrow(/changed|stale/i);
  expect(json.serializeCommunityState(state)).toBe(before);writeFileSync(activeOriginal,fixture.attachments['SYN-D3']);
});

it('rejects changed operational original bytes without changing the active generation or source data',async()=>{
 const migration=await import('../src/community/persistence/legacy.js'),before=json.serializeCommunityState(state);
 writeFileSync(join(source,'documents','SYN-D3.txt'),'SYNTHETIC CHANGED HISTORICAL ORIGINAL');const original=hashes(source);
 await expect(migration.inspectLegacy(source)).rejects.toThrow(/hash/);expect(json.serializeCommunityState(state)).toBe(before);expect(hashes(source)).toEqual(original);
});

it('rejects an operational document/hash relationship conflict before staging',async()=>{
 const migration=await import('../src/community/persistence/legacy.js'),sourceDb=new Database(join(source,'database','matching.db'));
 try{sourceDb.prepare('UPDATE invoice_bot_files SET document_id=?').run('SYN-D1');}finally{sourceDb.close();}
 const original=hashes(source),before=json.serializeCommunityState(state);await expect(migration.inspectLegacy(source)).rejects.toThrow(/original|hash|document/i);expect(hashes(source)).toEqual(original);expect(json.serializeCommunityState(state)).toBe(before);
});

it('directs already converted versioned Community archives to complete backup/restore before any generic legacy scrubbing',async()=>{
 const migration=await import('../src/community/persistence/legacy.js'),path=join(source,'state','state.json'),input=JSON.parse(readFileSync(path,'utf8'));
 input.audit_events.push({after:{legacy_operational_history_version:1}});writeFileSync(path,JSON.stringify(input));
 const original=hashes(source);await expect(migration.inspectLegacy(source)).rejects.toThrow('requires complete backup/restore');expect(hashes(source)).toEqual(original);
});

it('rejects a linked screenshot whose bytes match its metadata hash but contradict the declared image signature',async()=>{
 const migration=await import('../src/community/persistence/legacy.js'),bytes=Buffer.from('SYNTHETIC NON-IMAGE ORIGINAL');writeFileSync(join(source,'documents','SYN-OLD-REVIEW.png'),bytes);
 const sourceDb=new Database(join(source,'database','matching.db'));try{sourceDb.prepare('UPDATE invoice_bot_artifacts SET sha256=?,size_bytes=? WHERE id=?').run(hash(bytes),bytes.length,'SYN-OLD-SCREENSHOT');}finally{sourceDb.close();}
 const original=hashes(source);await expect(migration.inspectLegacy(source)).rejects.toThrow('image evidence signature mismatch');expect(hashes(source)).toEqual(original);
});
