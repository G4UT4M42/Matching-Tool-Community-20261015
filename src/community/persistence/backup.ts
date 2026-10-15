import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { communitySchemaDigest } from '../../migrations/001-community-sqlite-baseline.js';
import { COMMUNITY_SCHEMA_VERSION, verifyCommunitySchema } from '../../migrations/community-registry.js';
import { deserializeCommunityState, validateCommunityJsonState } from '../../storage/json-store.js';
import { verifyCanonicalSql } from '../../storage/canonical-sql.js';
import { PaymentRepository } from '../payments/repository.js';
import {recoverAuditedDocumentReviews} from '../documents/review-audit.js';
import { decodeZip, encodeZip, safeArchivePath } from './zip.js';
import type { MatchingState } from '../../core/types.js';

export type Exclusive=<T>(operation:()=>Promise<T>)=>Promise<T>;
export interface FinancialSummary{counts:{transactions:number;documents:number;match_groups:number;audit_events:number};totals_minor_by_currency:Record<string,number>;match_statuses:Record<string,number>}
export interface BackupManifest{
  format:'matching-community-backup';version:1|2;sqlite_version:number;json_version:number;created_at:string;
  files:Record<string,{bytes:number;sha256:string}>;financial:FinancialSummary;
  sqlite_financial:{transactions:number;totals_minor_by_currency:Record<string,number>;transaction_ids_sha256:string};
  canonical_state_sha256?:string;
}
const MAX_FILE=256*1024*1024;
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const schemaDir=resolve(dirname(fileURLToPath(import.meta.url)),'..','..','storage');
export function backupBaselineDigest():string{return communitySchemaDigest(['schema.sql','schema-invoicerec.sql','schema-invoicebot.sql','schema-costmonitor.sql','schema-payments.sql'].map(name=>readFileSync(join(schemaDir,name),'utf8')));}
function regular(path:string,limit=MAX_FILE):Buffer{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size>limit)throw new Error('Unsafe or oversized persistence file');return readFileSync(path);}
export function verifyRuntimePath(root:string,path:string):void{
  const base=resolve(root),target=resolve(path);if(target!==base&&!target.startsWith(base+sep))throw new Error('Path escapes runtime');
  let current=target;
  while(true){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('Runtime link is unsafe');const parent=dirname(current);if(parent===current)break;current=parent;}
}
function safeTotals(entries:Iterable<{currency_code:string;amount_minor:number}>):Record<string,number>{
  const result=new Map<string,bigint>();for(const row of entries){if(!Number.isSafeInteger(row.amount_minor)||!/^[A-Z]{3}$/.test(row.currency_code))throw new Error('Invalid financial value');result.set(row.currency_code,(result.get(row.currency_code)??0n)+BigInt(row.amount_minor));}
  return Object.fromEntries([...result].sort(([a],[b])=>a.localeCompare(b)).map(([code,total])=>{if(total>BigInt(Number.MAX_SAFE_INTEGER)||total<BigInt(Number.MIN_SAFE_INTEGER))throw new Error('Financial total exceeds exact range');return[code,Number(total)];}));
}
function financial(state:MatchingState):FinancialSummary{
  const statuses:Record<string,number>={};for(const group of state.match_groups.values())statuses[group.status]=(statuses[group.status]??0)+1;
  return{counts:{transactions:state.transactions.size,documents:state.documents.size,match_groups:state.match_groups.size,audit_events:state.audit_events.length},totals_minor_by_currency:safeTotals(state.transactions.values()),match_statuses:statuses};
}
function sqliteFinancial(db:Database.Database):BackupManifest['sqlite_financial']{
  const rows=db.prepare('SELECT transaction_id,currency_code,amount_minor FROM transactions ORDER BY transaction_id').all() as Array<{transaction_id:string;currency_code:string;amount_minor:number}>;
  return{transactions:rows.length,totals_minor_by_currency:safeTotals(rows),transaction_ids_sha256:sha(JSON.stringify(rows.map(row=>row.transaction_id)))};
}
function rejectSecrets(value:unknown,depth=0):void{
  if(depth>48)throw new Error('Excessively nested persisted metadata');if(!value||typeof value!=='object')return;
  for(const[key,child]of Object.entries(value)){
    if(/^(?:password|passwd|secret|client_secret|api_key|access_token|refresh_token|authorization|cookie|cookies|session_token|private_key|credential|credentials|approval_token|confirmation_token)$/i.test(key))throw new Error('Credential or reusable authorization data cannot enter an accounting backup');
    rejectSecrets(child,depth+1);
  }
}
function hasTable(db:Database.Database,name:string):boolean{return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));}
/** Retain bounded economic evidence; unknown provider payloads require explicit review. */
export function sanitizeHistoricalPaymentEvidence(text:unknown):string|null{
  if(text===null||text===undefined)return null;
  if(typeof text!=='string'||text.length>65536)throw new Error('Unreviewed historical payment evidence size');
  const scalarKeys=new Set(['id','batchid','itemid','candidateid','documentid','scanid','reference','packagereference','confirmationnumber','messageid','importfilename','artifactsha256','xmlsha256','status','previousstatus','newstatus','itemstatus','approvalstatus','reason','reasoncode','errorcode','actor','occurredat','createdat','updatedat','reviewedat','approvedat','approvedby','releasedat','exportedat','requestedexecutiondate','amountminor','controlsumminor','itemcount','revision','currency','currencycode','creditorname','creditoriban','debtorname','debtoriban','iban','name','label','accountholder','accountlabel','remittanceinformation','structuredcreditorreference','invoicenumber','duedate','active','synthetic']);
  for(const key of ['debtoraccountlabel','debtoraccountholder','georgepackagereference','classification'])scalarKeys.add(key);
  const nestedKeys=new Set(['account','expectedaccount','observedaccount','items','before','after','counts','totals']);
  const secret=(key:string)=>/password|passwd|secret|credential|cookie|authorization|bearer|privatekey|apikey|token|session|confirmationcode|approvalcapability|releaseconfirmation|releaseclick|releaserequest|releaseretry|exportartifactdata|exportartifactpath|otp|mfacode/.test(key);
  const visit=(value:unknown,depth:number):unknown=>{
    if(depth>8)throw new Error('Historical payment evidence nesting exceeds limit');
    if(Array.isArray(value)){if(value.length>1000)throw new Error('Historical payment evidence array exceeds limit');return value.map(item=>{if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('Unreviewed historical payment evidence array');return visit(item,depth+1);});}
    if(!value||typeof value!=='object')throw new Error('Unreviewed historical payment evidence structure');
    const entries=Object.entries(value);if(entries.length>64)throw new Error('Historical payment evidence fields exceed limit');
    const out:Record<string,unknown>={};
    for(const[key,child]of entries){
      const normalized=key.replace(/[^a-zA-Z0-9]/g,'').toLowerCase();
      if(secret(normalized))continue;
      if(nestedKeys.has(normalized)){out[key]=visit(child,depth+1);continue;}
      if(!scalarKeys.has(normalized)||['__proto__','prototype','constructor'].includes(key))throw new Error('Unreviewed historical payment evidence field');
      if(child===null||typeof child==='boolean'||typeof child==='number'&&Number.isSafeInteger(child)){out[key]=child;continue;}
      if(typeof child!=='string'||child.length>300||!/^[-\p{L}\p{N}\s_.:/+@,()']*$/u.test(child)||/[\x00-\x1f\x7f]|Bearer\s|PRIVATE KEY|password\s*[:=]|secret\s*[:=]/i.test(child))throw new Error('Unreviewed historical payment evidence value');
      out[key]=child;
    }
    return out;
  };
  let parsed:unknown;try{parsed=JSON.parse(text);}catch{throw new Error('Invalid historical payment evidence JSON');}
  return JSON.stringify(visit(parsed,0));
}
function scrubSnapshot(db:Database.Database):void{
  const oldTriggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='payment_status_events' ORDER BY name").all() as Array<{name:string;sql:string}>;
  db.transaction(()=>{
    db.prepare('DELETE FROM invoice_bot_profiles').run();db.prepare("UPDATE invoice_bot_portals SET credential_ref=NULL,login_strategy='manual',active=0").run();
    db.prepare('DELETE FROM payment_automation_runs').run();db.prepare('UPDATE payment_batches SET export_artifact_data=NULL,export_artifact_path=NULL').run();
    for(const trigger of oldTriggers){if(!['trg_payment_status_events_no_update','trg_payment_status_events_no_delete'].includes(trigger.name)||!trigger.sql)throw new Error('Unreviewed legacy payment event trigger');db.exec(`DROP TRIGGER "${trigger.name}"`);}
    const updateEvidence=db.prepare('UPDATE payment_status_events SET george_evidence_json=?,before_json=?,after_json=? WHERE event_id=?');
    for(const row of db.prepare('SELECT event_id,george_evidence_json,before_json,after_json FROM payment_status_events').all() as Array<{event_id:string;george_evidence_json:string|null;before_json:string|null;after_json:string|null}>){
      updateEvidence.run(sanitizeHistoricalPaymentEvidence(row.george_evidence_json),sanitizeHistoricalPaymentEvidence(row.before_json),sanitizeHistoricalPaymentEvidence(row.after_json),row.event_id);
    }
    for(const trigger of oldTriggers)db.exec(trigger.sql);
    for(const row of db.prepare('SELECT key,value FROM settings').all() as Array<{key:string;value:string}>){
      if(/password|secret|credential|cookie|token|session|approval|auth|key/i.test(row.key))db.prepare('DELETE FROM settings WHERE key=?').run(row.key);
      else if(!['theme','locale','language','timezone','currency','default_currency','date_format','number_format'].includes(row.key)||row.value.length>80||!/^[A-Za-z0-9_./+-]+$/.test(row.value))throw new Error('Unreviewed setting in financial backup');
    }
    if(hasTable(db,'community_bank_connections'))db.prepare('DELETE FROM community_bank_connections').run();
    if(hasTable(db,'community_payment_confirmations'))new PaymentRepository(db).invalidateActionableOnRestore();
  }).immediate();
}

/** Managed invoice metadata plus content-addressed blobs, never browser profiles. */
function documentReferences(state:MatchingState,indexBytes?:Buffer):Map<string,{hash?:string;bytes?:number}>{
  const references=new Map<string,{hash?:string;bytes?:number}>();
  const audited=recoverAuditedDocumentReviews(state.audit_events),auditedById=new Map(audited.map(record=>[record.id,record]));
  for(const doc of state.documents.values()){
    const attachment=typeof doc.meta?.attachment_path==='string'?doc.meta.attachment_path:doc.filename;
    if(!attachment){if(doc.file_hash)throw new Error('Missing referenced document');continue;}
    safeArchivePath(attachment);references.set('documents/'+attachment,{hash:doc.file_hash});
  }
  if(indexBytes){
    if(indexBytes.length>MAX_FILE)throw new Error('Document index exceeds supported size');
    const index=JSON.parse(indexBytes.toString('utf8')) as {version:number;records:Array<{id:string;workspace_id:string;hash:string;bytes:number;status:string}>};
    if(index.version!==1||!Array.isArray(index.records)||index.records.length>100000)throw new Error('Unsupported document index');
    const ids=new Set<string>();
    for(const record of index.records){
      if(!record||typeof record.id!=='string'||ids.has(record.id)||typeof record.workspace_id!=='string'||!/^[\w.:-]{1,100}$/.test(record.workspace_id)||!/^[a-f0-9]{64}$/.test(record.hash)||!Number.isSafeInteger(record.bytes)||record.bytes<1||record.bytes>MAX_FILE||!['review','confirmed','rejected','archived'].includes(record.status))throw new Error('Invalid document index record');
      ids.add(record.id);const name='documents/attachments/'+sha(record.workspace_id)+'/'+record.hash;
      const canonical=auditedById.get(record.id);if(canonical&&(canonical.workspace_id!==record.workspace_id||canonical.hash!==record.hash||canonical.bytes!==record.bytes))throw new Error('Document index disagrees with immutable review evidence');
      references.set(name,{hash:record.hash,bytes:record.bytes});
      if(record.status==='confirmed'&&(!state.documents.has(record.id)||state.documents.get(record.id)?.file_hash?.toLowerCase()!==record.hash))throw new Error('Confirmed document index and financial evidence disagree');
    }
    rejectSecrets(index);references.set('documents/document-index-v1.json',{});
  }
  // Unconfirmed review records are durable accounting evidence too. A missing
  // or stale derived index cannot remove their original blobs from a backup.
  for(const record of audited){
    const name='documents/attachments/'+sha(record.workspace_id)+'/'+record.hash;
    references.set(name,{hash:record.hash,bytes:record.bytes});
    if(record.status==='confirmed'&&(!state.documents.has(record.id)||state.documents.get(record.id)?.file_hash?.toLowerCase()!==record.hash))throw new Error('Confirmed review audit and financial evidence disagree');
  }
  return references;
}

export function inspectBackupBytes(archive:Buffer):{manifest:BackupManifest;files:Map<string,Buffer>}{
  const files=decodeZip(archive),raw=files.get('manifest.json');if(!raw||raw.length>1024*1024)throw new Error('Backup manifest missing or oversized');
  const manifest=JSON.parse(raw.toString('utf8')) as BackupManifest;
  if(manifest.format!=='matching-community-backup'||![1,2].includes(manifest.version)||!Number.isInteger(manifest.sqlite_version)||manifest.sqlite_version<2||manifest.sqlite_version>COMMUNITY_SCHEMA_VERSION||![1,2].includes(manifest.json_version)||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw new Error('Unsupported backup version');
  if(files.size!==Object.keys(manifest.files).length+1)throw new Error('Unexpected backup entry');
  for(const[name,record]of Object.entries(manifest.files)){
    safeArchivePath(name);if(!['database/matching.db','state/state.json'].includes(name)&&!name.startsWith('documents/'))throw new Error('Unapproved backup member');
    const bytes=files.get(name);if(!record||!Number.isSafeInteger(record.bytes)||record.bytes<0||record.bytes>MAX_FILE||!/^[a-f0-9]{64}$/.test(record.sha256)||!bytes||bytes.length!==record.bytes||sha(bytes)!==record.sha256)throw new Error('Backup checksum or size mismatch');
  }
  const stateBytes=files.get('state/state.json');if(!stateBytes||!files.has('database/matching.db'))throw new Error('Backup accounting files missing');
  const rawState=JSON.parse(stateBytes.toString('utf8'));validateCommunityJsonState(rawState);rejectSecrets(rawState);
  if(rawState.schema_version!==manifest.json_version)throw new Error('Backup JSON version disagrees with the state');
  const state=deserializeCommunityState(rawState);
  if(!isDeepStrictEqual(financial(state),manifest.financial))throw new Error('Backup financial summary mismatch');
  if(sha(JSON.stringify([...state.transactions.keys()].sort()))!==manifest.sqlite_financial?.transaction_ids_sha256)throw new Error('Backup transaction identity mismatch');
  if(manifest.version===2&&sha(stateBytes)!==manifest.canonical_state_sha256)throw new Error('Canonical backup snapshot checksum mismatch');
  const references=documentReferences(state,files.get('documents/document-index-v1.json'));
  for(const[name,expected]of references){const bytes=files.get(name);if(!bytes||(expected.hash&&sha(bytes)!==expected.hash.toLowerCase())||(expected.bytes!==undefined&&bytes.length!==expected.bytes))throw new Error('Missing or altered referenced document');}
  for(const name of files.keys())if(name.startsWith('documents/')&&!references.has(name))throw new Error('Unreferenced backup document');
  return{manifest,files};
}

/** Full cross-store values and embedded canonical snapshot must all agree. */
export function verifyBackupDatabase(db:Database.Database,stateBytes:Buffer,manifest?:BackupManifest):void{
  const state=deserializeCommunityState(JSON.parse(stateBytes.toString('utf8')));
  const version=Number(db.pragma('user_version',{simple:true}));verifyCommunitySchema(db,backupBaselineDigest(),manifest?.sqlite_version??version);
  if(db.pragma('integrity_check',{simple:true})!=='ok')throw new Error('Backup database integrity check failed');
  verifyCanonicalSql(db,state);
  if(version>=4){
    const stored=db.prepare('SELECT run_id,state_json,state_sha256 FROM community_canonical_state WHERE singleton=1').get() as {run_id:string;state_json:string;state_sha256:string}|undefined;
    if(stored&&(stored.run_id!==state.run_id||sha(stored.state_json)!==stored.state_sha256||!isDeepStrictEqual(JSON.parse(stored.state_json),JSON.parse(stateBytes.toString('utf8')))))throw new Error('Canonical SQLite snapshot and JSON backup disagree');
  }
  if(manifest&&!isDeepStrictEqual(sqliteFinancial(db),manifest.sqlite_financial))throw new Error('Backup SQLite financial summary mismatch');
}

export async function createCommunityBackup(runtimeRoot:string,withExclusiveAccess:Exclusive):Promise<{id:string;path:string;manifest:BackupManifest}>{
  return withExclusiveAccess(async()=>{
    const root=resolve(runtimeRoot),statePath=join(root,'state','state.json'),sourcePath=join(root,'database','matching.db');
    for(const path of[statePath,sourcePath,join(root,'backups')])verifyRuntimePath(root,path);
    if(existsSync(join(root,'state','statement-journal-v1.json'))||existsSync(join(root,'.restore-operation-v1.json')))throw new Error('Pending statement or restore journal prevents backup');
    const stateBytes=regular(statePath),rawState=JSON.parse(stateBytes.toString('utf8'));validateCommunityJsonState(rawState);rejectSecrets(rawState);
    const state=deserializeCommunityState(rawState),summary=financial(state),id=randomUUID(),dir=join(root,'backups'),snapshot=join(dir,'.'+id+'.db');mkdirSync(dir,{recursive:true});
    try{
      const source=new Database(sourcePath,{readonly:true,fileMustExist:true});
      try{verifyBackupDatabase(source,stateBytes);await source.backup(snapshot);}finally{source.close();}
      const db=new Database(snapshot);let sql:BackupManifest['sqlite_financial'];let version:number;
      try{
        db.pragma('foreign_keys=ON');db.pragma('secure_delete=ON');scrubSnapshot(db);db.exec('VACUUM');
        version=Number(db.pragma('user_version',{simple:true}));verifyBackupDatabase(db,stateBytes);sql=sqliteFinancial(db);
        if(version>=4&&!db.prepare('SELECT 1 FROM community_canonical_state WHERE singleton=1').get()){
          db.prepare('INSERT INTO community_canonical_state(singleton,revision,run_id,operation_id,state_sha256,state_json,updated_at) VALUES(1,0,?,?,?,?,?)').run(state.run_id,'BACKUP-'+id,sha(stateBytes),stateBytes.toString('utf8'),new Date().toISOString());
        }
        db.pragma('wal_checkpoint(TRUNCATE)');
        // A self-contained archive must not create WAL/SHM sidecars merely when verified.
        db.pragma('journal_mode = DELETE');
      }finally{db.close();}
      const indexPath=join(root,'documents','document-index-v1.json');verifyRuntimePath(root,indexPath);
      const index=existsSync(indexPath)?regular(indexPath):undefined;
      const references=documentReferences(state,index);
      // Preflight the complete set before allocating any attachment buffers.
      // Reserve room for manifest and ZIP records in the 512 MiB archive limit.
      if(references.size+3>4096)throw new Error('Backup file count exceeds limit');
      let total=stateBytes.length+lstatSync(snapshot).size;
      for(const name of references.keys()){
        const path=join(root,...name.split('/'));verifyRuntimePath(root,path);const stat=lstatSync(path);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE)throw new Error('Unsafe or oversized persistence file');
        total+=stat.size;if(total>510*1024*1024)throw new Error('Backup aggregate size exceeds limit');
      }
      const files=new Map<string,Buffer>([['database/matching.db',regular(snapshot)],['state/state.json',stateBytes]]);
      for(const[name,expected]of references){
        const path=join(root,...name.split('/'));verifyRuntimePath(root,path);const bytes=regular(path);
        if(expected.hash&&sha(bytes)!==expected.hash.toLowerCase()||expected.bytes!==undefined&&bytes.length!==expected.bytes)throw new Error('Document hash or size mismatch');files.set(name,bytes);
      }
      const manifest:BackupManifest={format:'matching-community-backup',version:2,sqlite_version:version!,json_version:rawState.schema_version,created_at:new Date().toISOString(),
        files:Object.fromEntries([...files].map(([name,bytes])=>[name,{bytes:bytes.length,sha256:sha(bytes)}])),financial:summary,sqlite_financial:sql!,canonical_state_sha256:sha(stateBytes)};
      files.set('manifest.json',Buffer.from(JSON.stringify(manifest)));const archive=encodeZip(files);inspectBackupBytes(archive);
      const target=join(dir,id+'.zip'),pending=target+'.pending';const fd=openSync(pending,'wx',0o600);
      try{writeFileSync(fd,archive);fsyncSync(fd);}finally{closeSync(fd);}
      renameSync(pending,target);return{id,path:target,manifest};
    }finally{for(const path of[snapshot,snapshot+'-wal',snapshot+'-shm'])if(existsSync(path))rmSync(path);}
  });
}
export function listCommunityBackups(runtimeRoot:string):Array<{id:string;manifest:BackupManifest}>{
  const root=resolve(runtimeRoot),dir=join(root,'backups');verifyRuntimePath(root,dir);if(!existsSync(dir))return[];
  return readdirSync(dir).filter(name=>/^[a-f0-9-]{36}\.zip$/.test(name)).map(name=>{const path=join(dir,name);verifyRuntimePath(root,path);return{id:name.slice(0,-4),manifest:inspectBackupBytes(regular(path,512*1024*1024)).manifest};});
}
export function readCommunityBackup(runtimeRoot:string,id:string):Buffer{
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid backup identifier');const root=resolve(runtimeRoot),path=join(root,'backups',id+'.zip');verifyRuntimePath(root,path);return regular(path,512*1024*1024);
}
