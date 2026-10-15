/**
 * Legacy-V2 isolated offline staging importer.
 *
 * NEVER touches the source, never uploads data, never enables banking.
 * This is an import-preview/staging tool; activation requires separate
 * schema certification and explicit owner review.
 */
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync, copyFileSync, readdirSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const hash = data => createHash('sha256').update(data).digest('hex');
// Retain economic IDs, but strip credential-like keys regardless of case or separators.
function secretKey(name) {
  const collapsed = String(name).replace(/[^a-zA-Z0-9]/g,'').toLowerCase();
  return /(?:password|passwd|secret|credential|cookie|authorization|bearer|privatekey|apikey|apitoken|authkey|authtoken|clientkey|oauth|accesstoken|refreshtoken|sessiontoken|clientid|sessionid|otpcode|mfacode|^token$|^session$|^auth$)/.test(collapsed);
}
const safeSettingValues = {
  theme:/^(?:light|dark|system)$/,
  locale:/^[a-z]{2}(?:-[A-Z]{2})?$/,
  language:/^[a-z]{2}(?:-[A-Z]{2})?$/,
  timezone:/^(?:UTC|[A-Za-z_]+\/[A-Za-z_+.-]+)$/,
  currency:/^[A-Z]{3}$/,
  default_currency:/^[A-Z]{3}$/,
  date_format:/^(?:YYYY-MM-DD|DD.MM.YYYY|MM\/DD\/YYYY)$/,
  number_format:/^[a-z]{2}(?:-[A-Z]{2})?$/,
  paypal_sandbox:/^(?:true|false)$/
};
const allowedStatus = new Set(['proposed','accepted','rejected','manual','confirmed']);
const tableWhitelist = new Set([
  'transactions','documents','line_items','match_groups','match_group_transactions',
  'match_group_documents','exclusion_rules','transaction_dispositions',
  'document_dispositions','audit_events','private_vendors','vendor_overrides',
  'settings','payment_batches','payment_batch_items','payment_batch_events',
  'payment_candidates','payment_automation_runs','invoice_scans','invoicerec_scans',
  'invoicerec_templates','schema_migrations',
]);

function fail(message) { throw new Error('LEGACY_IMPORT_BLOCKED: ' + message); }
function within(parent,target) {
  const diff=relative(parent,target);
  return diff===''||(!diff.startsWith('..')&&!isAbsolute(diff));
}
function layout(root) {
  const layouts=[
    {state:join(root,'state','state.json'),db:join(root,'database','matching.db'), evidence:join(root,'documents')},
    {state:join(root,'data','state.json'),db:join(root,'data','matching.db'), evidence:join(root,'Belege')},
    {state:join(root,'state.json'),db:join(root,'matching.db'), evidence:join(root,'Belege')},
  ];
  const found=layouts.filter(x=>existsSync(x.state)&&existsSync(x.db));
  if(found.length!==1)fail('Source storage layout incomplete or ambiguous');
  return found[0];
}
export function totalsAndReferences(state) {
  if(!state||typeof state!=='object')fail('State JSON missing');
  const keys=['transactions','documents','match_groups'];
  for(const key of keys) {
    if(!state[key]||typeof state[key]!=='object'||Array.isArray(state[key]))fail('Malformed '+key);
  }
  if(!Array.isArray(state.audit_events)||!Array.isArray(state.exclusion_rules))fail('Audit or exclusions missing');
  const txIds=new Set(Object.keys(state.transactions)),docIds=new Set(Object.keys(state.documents));
  const totals={};const approval={};
  for(const [id,tx] of Object.entries(state.transactions)) {
    if(tx.transaction_id!==id||!Number.isSafeInteger(tx.amount_minor)||!(/^[A-Z]{3}$/.test(tx.currency_code)))fail('Invalid financial transaction');
    const currency=tx.currency_code;
    totals[currency]=(totals[currency]??0)+tx.amount_minor;
    if(!Number.isSafeInteger(totals[currency]))fail('Unsafe totals overflow');
  }
  for(const [id,doc] of Object.entries(state.documents)) {
    if(doc.document_id!==id||!Number.isSafeInteger(doc.total_amount_minor)||typeof doc.source_system!=='string')fail('Invalid evidence document');
  }
  for(const [id,match] of Object.entries(state.match_groups)) {
    if(match.match_group_id!==id||!allowedStatus.has(match.status))fail('Unknown match group status');
    if(!Array.isArray(match.transaction_ids)||!Array.isArray(match.document_ids))fail('Invalid match-group links');
    if(new Set(match.transaction_ids).size!==match.transaction_ids.length
       ||new Set(match.document_ids).size!==match.document_ids.length)fail('Repeated match-group membership');
    if(!match.transaction_ids.every(x=>txIds.has(x))||!match.document_ids.every(x=>docIds.has(x)))fail('Orphan match-group link');
    approval[match.status]=(approval[match.status]??0)+1;
  }
  for(const [key,allowed] of [['matched_transaction_ids',txIds],['matched_document_ids',docIds]]) {
    if(!Array.isArray(state[key])||!state[key].every(id=>allowed.has(id)))fail('Orphan reservation '+key);
    if(new Set(state[key]).size!==state[key].length)fail('Repeated reservation '+key);
  }
  return {
    counts:{transactions:txIds.size,documents:docIds.size,match_groups:Object.keys(state.match_groups).length,audit_events:state.audit_events.length},
    signed_totals_minor_by_currency:totals,match_statuses:approval,
  };
}
function stripSecrets(source,counter) {
  if(Array.isArray(source))return source.map(x=>stripSecrets(x,counter));
  if(!source||typeof source!=='object')return source;
  const out=Object.create(null);
  for(const [key,value] of Object.entries(source)) {
    if(['__proto__','constructor','prototype'].includes(key))fail('Unsafe state object key');
    if(secretKey(key)){counter.count++;continue}
    out[key]=stripSecrets(value,counter);
  }
  return out;
}
function safeArtifact(sourceRoot,evidenceRoot,filename) {
  if(typeof filename!=='string'||!filename.trim())return null;
  if(isAbsolute(filename)||filename.includes('\0')||filename.split(/[\\/]/).includes('..'))fail('Unsafe invoice evidence path');
  const candidates=[
    resolve(evidenceRoot,filename),
    resolve(sourceRoot,filename),
  ];
  const target=candidates.find(x=>within(sourceRoot,x)&&existsSync(x));
  if(!target)return null;
  const real=realpathSync(target);
  if(!within(sourceRoot,real)||!statSync(real).isFile())fail('Evidence symlink or non-file escape');
  return real;
}
function inspectArtifacts(state,sourceRoot,evidenceRoot,stageRoot,copy) {
  const artifacts=[],missing=[];
  for(const [id,doc] of Object.entries(state.documents)) {
    const filename=doc.filename;
    if(!filename) {
      if(doc.file_hash)missing.push(id);
      continue;
    }
    const source=safeArtifact(sourceRoot,evidenceRoot,filename);
    if(!source){missing.push(id);continue}
    const bytes=readFileSync(source);
    const digest=hash(bytes);
    if(doc.file_hash && doc.file_hash.toLowerCase()!==digest)fail('Source document content hash mismatch');
    const rel='evidence/'+id.replace(/[^a-zA-Z0-9_-]/g,'_')+'-'+digest;
    if(copy){
      const dest=join(stageRoot,rel);
      mkdirSync(dirname(dest),{recursive:true});
      writeFileSync(dest,bytes,{flag:'wx',mode:0o600});
    }
    artifacts.push({document_id:id,path:rel,sha256:digest,bytes:bytes.length});
  }
  return {artifacts,missing};
}

function hasUnsafeJsonKey(value,depth=0) {
  if(depth>32)fail('Excessively nested SQLite metadata');
  if(Array.isArray(value))return value.some(item=>hasUnsafeJsonKey(item,depth+1));
  if(value&&typeof value==='object') {
    return Object.entries(value).some(([key,item])=>
      ['__proto__','constructor','prototype'].includes(key)
      || secretKey(key)||hasUnsafeJsonKey(item,depth+1));
  }
  return false;
}
function inspectSqliteMetadata(db,name,columns) {
  for(const column of columns) {
    if(!/(?:meta|payload|config|json|context)/i.test(column.name))continue;
    const escaped=String(column.name).replace(/"/g,'""');
    const statement=db.prepare('SELECT "'+escaped+'" AS payload FROM "'+name+'"');
    for(const row of statement.iterate()) {
      if(row.payload===null)continue;
      if(typeof row.payload!=='string'||row.payload.length>1048576)
        fail('Unreviewed SQLite metadata type or size');
      const first=row.payload.trimStart()[0];
      if(first!=='{'&&first!=='[')continue;
      let parsed;
      try{parsed=JSON.parse(row.payload)}catch{fail('Invalid SQLite JSON metadata')}
      if(hasUnsafeJsonKey(parsed))fail('Credential-bearing SQLite JSON metadata requires review');
    }
  }
}
function describeDb(db) {
  if(db.pragma('integrity_check',{simple:true})!=='ok')fail('SQLite integrity check failed');
  if(db.pragma('foreign_key_check').length)fail('SQLite foreign-key constraint failed');
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);
  if(!tables.includes('transactions')||!tables.includes('documents')||!tables.includes('settings'))fail('Legacy schema is missing required tables');
  // This is a conservative staging adapter, not a full schema translator.
  // An unknown table or a credential-bearing column must NEVER be copied into the candidate.
  for(const name of tables) {
    if(!tableWhitelist.has(name))fail('Unsupported SQLite table requires an explicit migration mapping');
    const columns=db.pragma('table_info('+name+')');
    if(columns.some(col=>secretKey(col.name)))fail('Credential-bearing SQLite column requires explicit mapping');
    inspectSqliteMetadata(db,name,columns);
  }
  const settings=db.prepare('SELECT key, value FROM settings').all();
  for(const row of settings) {
    if(typeof row.key!=='string')fail('Unclassified SQLite settings key');
    if(secretKey(row.key))continue; // Removed from the isolated candidate, never reused.
    const validator=Object.hasOwn(safeSettingValues,row.key)?safeSettingValues[row.key]:null;
    if(!validator)fail('Unreviewed SQLite setting requires explicit migration mapping');
    if(typeof row.value!=='string'||!validator.test(row.value)) {
      fail('Unreviewed SQLite setting value requires explicit migration mapping');
    }
  }
  return tables;
}

export async function stageLegacyV2({sourceRoot,destinationRoot,confirmedOffline=false,dryRun=true}) {
  if(!confirmedOffline)fail('Owner must confirm the source application is offline');
  if(!sourceRoot||!destinationRoot)fail('Both paths are required');
  const source=realpathSync(resolve(sourceRoot));
  const destination=resolve(destinationRoot);
  const parent=realpathSync(dirname(destination));
  if(!within(parent,destination)||within(source,destination)||within(destination,source)||existsSync(destination)) {
    fail('Destination must be a new, separate directory');
  }
  const sourceLayout=layout(source);
  const db=new Database(sourceLayout.db,{readonly:true,fileMustExist:true});
  let stage;
  try {
    const before=readFileSync(sourceLayout.state);
    const state=JSON.parse(before.toString('utf8'));
    const check=totalsAndReferences(state);
    const scrubCount={count:0};
    const sanitized=stripSecrets(state,scrubCount);
    const afterCheck=totalsAndReferences(sanitized);
    if(JSON.stringify(afterCheck)!==JSON.stringify(check))fail('Credential scrub affected accounting invariants');
    const tables=describeDb(db);
    const dataVersion=db.pragma('data_version',{simple:true});
    const preview=inspectArtifacts(sanitized,source,sourceLayout.evidence,null,false);
    if(preview.missing.length)fail('Missing evidence for '+preview.missing.length+' linked documents');
    const warnings=[];
    if(tables.some(x=>x.startsWith('payment_')))warnings.push('Payment history will be retained, but releases remain disabled and require owner review');
    if(scrubCount.count)warnings.push('Credential-like fields in state were removed for reconnection');
    const outcome={dry_run:dryRun,activation_allowed:false,source_unchanged:true,
      source_sha256:hash(before),...check,credential_fields_removed:scrubCount.count,
      document_sha256:hash(JSON.stringify(preview.artifacts)),evidence_count:preview.artifacts.length,
      tables_count:tables.length,requires_reconnection:['banking','oauth','payment_provider','invoice_bot'],warnings};
    if(dryRun)return outcome;

    const stageName='.pending-community-'+randomUUID();
    stage=join(parent,stageName);
    mkdirSync(stage,{recursive:false});
    const databaseDir=join(stage,'database'),stateDir=join(stage,'state');
    mkdirSync(databaseDir);mkdirSync(stateDir);
    const dbTarget=join(databaseDir,'matching.db');
    await db.backup(dbTarget);
    const copiedDb=new Database(dbTarget);
    try {
      describeDb(copiedDb);
      if(tables.includes('settings')) {
        const rows=copiedDb.prepare('SELECT key FROM settings').all();
        const ids=rows.map(x=>String(x.key)).filter(k=>secretKey(k));
        const drop=copiedDb.transaction(() => {
          const stmt=copiedDb.prepare('DELETE FROM settings WHERE key=?');
          for(const key of ids)stmt.run(key);
        });
        drop();
        outcome.credential_fields_removed += ids.length;
      }
      describeDb(copiedDb);
    }finally{copiedDb.close()}
    const serialized=JSON.stringify(sanitized,null,2);
    writeFileSync(join(stateDir,'state.json'),serialized,{flag:'wx',mode:0o600});
    const copied=inspectArtifacts(sanitized,source,sourceLayout.evidence,stage,true);
    if(hash(readFileSync(sourceLayout.state))!==hash(before))fail('Source JSON changed during backup');
    if(db.pragma('data_version',{simple:true})!==dataVersion)fail('Source SQLite changed during backup');
    if(JSON.stringify(copied.artifacts)!==JSON.stringify(preview.artifacts))fail('Evidence changed between preview and copy');
    const manifest={format:'matching-tool-offline-v2-stage-v1',source_snapshot_sha256:hash(before),
      stage_state_sha256:hash(serialized),stage_database_sha256:hash(readFileSync(dbTarget)),
      check,documents:copied.artifacts,removed_credential_fields:outcome.credential_fields_removed,
      bank_actions_enabled:false,activation_allowed:false};
    writeFileSync(join(stage,'migration-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
    renameSync(stage,destination);stage=undefined;
    return {...outcome,dry_run:false,staged_directory:destination};
  }finally{
    db.close();
    if(stage&&existsSync(stage))rmSync(stage,{recursive:true,force:true});
  }
}
