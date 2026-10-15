import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { communitySchemaDigest, initializeCommunitySqliteV1 } from '../../migrations/001-community-sqlite-baseline.js';
import { upgradeCommunitySchema } from '../../migrations/community-registry.js';
import { runMigrations } from '../../storage/db.js';
import { deserializeCommunityState, validateCommunityJsonState } from '../../storage/json-store.js';
import { verifyCanonicalSql } from '../../storage/canonical-sql.js';
import { createCommunityBackup, sanitizeHistoricalPaymentEvidence, verifyRuntimePath, type Exclusive } from './backup.js';
import { stageCommunityRestore } from './restore.js';
import {safeArchivePath} from './zip.js';

const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const schemaDir=resolve(dirname(fileURLToPath(import.meta.url)),'..','..','storage');
const sourceNames=['schema.sql','schema-invoicerec.sql','schema-invoicebot.sql','schema-costmonitor.sql','schema-payments.sql'];
const sources=()=>sourceNames.map(name=>readFileSync(join(schemaDir,name),'utf8'));
const excludedSourceTrees=new Set(['backups','cache','logs','browser-profiles','profiles','sessions','identity','provider-vault','bank-vault','invoice-browsers','node_modules']);
function normalFile(path:string):Buffer{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024*1024)throw new Error('Unsafe legacy source file');return readFileSync(path);}
function walk(root:string,path:string,out:string[]):void{
  verifyRuntimePath(root,path);const stat=lstatSync(path);if(stat.isFile()){out.push(path);return;}if(!stat.isDirectory())throw new Error('Unsupported legacy source entry');
  for(const name of readdirSync(path).sort()){if(out.length>4096)throw new Error('Legacy source has too many files');if(excludedSourceTrees.has(name.toLowerCase()))continue;walk(root,join(path,name),out);}
}
export function legacySourceFingerprint(sourceRoot:string):string{
  const root=resolve(sourceRoot);verifyRuntimePath(root,root);if(!lstatSync(root).isDirectory())throw new Error('Legacy root must be a local directory');const files:string[]=[];walk(root,root,files);
  return sha(files.map(path=>relative(root,path).replaceAll('\\','/')+':'+sha(normalFile(path))).join('\n'));
}
const tableOrder:Array<[string,string]>=[
  ['transactions','transactions'],['documents','documents'],['line_items','line_items'],['match_groups','match_groups'],['match_group_transactions','match_group_transactions'],['match_group_documents','match_group_documents'],
  ['exclusion_rules','exclusion_rules'],['transaction_dispositions','transaction_dispositions'],['document_dispositions','document_dispositions'],['audit_events','audit_events'],['private_vendors','private_vendors'],['vendor_overrides','vendor_overrides'],['trash','trash'],
  ['invoice_scans','invoice_scans'],['invoicerec_scans','invoice_scans'],['invoice_templates','invoice_templates'],['invoicerec_templates','invoice_templates'],['invoice_extracted_fields','invoice_extracted_fields'],['invoice_review_edits','invoice_review_edits'],
  ['payment_candidates','invoice_payment_candidates'],['invoice_payment_candidates','invoice_payment_candidates'],['payment_batches','payment_batches'],['payment_batch_items','payment_batch_items'],['payment_batch_events','payment_status_events'],['payment_status_events','payment_status_events'],['settings','settings'],
];
const authorityTables=new Set(['payment_automation_runs','invoice_bot_profiles']);
const operationalTables=new Set(['schema_migrations','_migration_browser_use','invoice_bot_portals','invoice_bot_runs','invoice_bot_files','invoice_bot_events','invoice_bot_artifacts','invoice_bot_extracted_invoices','ai_cost_sessions','ai_cost_entries']);
const secretKey=(name:string)=>/password|passwd|secret|credential|cookie|authorization|bearer|privatekey|apikey|apitoken|authkey|authtoken|oauth|accesstoken|refreshtoken|sessiontoken|clientid|sessionid|otpcode|mfacode|releaseconfirmation|releaseclick|releaserequest|releaseretry|approvaltoken|confirmationtoken|^token$|^session$|^auth$/.test(name.replace(/[^a-zA-Z0-9]/g,'').toLowerCase());
const safeSettings:Record<string,RegExp>={theme:/^(?:light|dark|system)$/,locale:/^[a-z]{2}(?:-[A-Z]{2})?$/,language:/^[a-z]{2}(?:-[A-Z]{2})?$/,timezone:/^(?:UTC|[A-Za-z_]+\/[A-Za-z_+.-]+)$/,currency:/^[A-Z]{3}$/,default_currency:/^[A-Z]{3}$/,date_format:/^(?:YYYY-MM-DD|DD.MM.YYYY|MM\/DD\/YYYY)$/,number_format:/^[a-z]{2}(?:-[A-Z]{2})?$/};
function scrub(value:unknown,depth=0):unknown{
  if(depth>48)throw new Error('Legacy state nesting exceeds limit');if(Array.isArray(value))return value.map(item=>scrub(item,depth+1));if(!value||typeof value!=='object')return value;
  const out:Record<string,unknown>={};for(const[key,child]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))throw new Error('Unsafe legacy state key');if(!secretKey(key))out[key]=scrub(child,depth+1);}return out;
}
function translateDatabase(sourcePath:string,targetPath:string):{mapped:Record<string,number>;omitted:Record<string,number>}{
  const src=new Database(sourcePath,{readonly:true,fileMustExist:true}),dest=new Database(targetPath);
  try{
    if(src.pragma('integrity_check',{simple:true})!=='ok'||(src.pragma('foreign_key_check') as unknown[]).length)throw new Error('Legacy database integrity failure');
    const sql=sources();dest.pragma('journal_mode=WAL');initializeCommunitySqliteV1(dest,sql,runMigrations);upgradeCommunitySchema(dest,communitySchemaDigest(sql));
    const existing=new Set(src.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[]),mapped:Record<string,number>={},omitted:Record<string,number>={};
    const known=new Set([...tableOrder.map(([name])=>name),...authorityTables,...operationalTables]);
    for(const name of existing){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error('Unsafe legacy table name');const count=Number(src.prepare(`SELECT count(*) FROM "${name}"`).pluck().get());if(!known.has(name)&&count)throw new Error('Unmapped legacy table with persisted data: '+name);if(operationalTables.has(name)&&count&&name!=='schema_migrations'&&name!=='_migration_browser_use')throw new Error('Unsupported legacy operational history requires explicit migration mapping: '+name);if(authorityTables.has(name)||name==='schema_migrations'||name==='_migration_browser_use')omitted[name]=count;}
    dest.pragma('foreign_keys=OFF');
    dest.transaction(()=>{
      for(const[from,to]of tableOrder){
        if(!existing.has(from))continue;const rows=src.prepare(`SELECT * FROM "${from}"`).all() as Array<Record<string,unknown>>;if(!rows.length)continue;
        const targetColumns=new Set((dest.pragma(`table_info(${to})`) as Array<{name:string}>).map(row=>row.name)),columns=Object.keys(rows[0]!).filter(name=>targetColumns.has(name)&&!secretKey(name));
        for(const row of rows){
          for(const[key,value]of Object.entries(row))if(!columns.includes(key)&&value!==null&&!secretKey(key))throw new Error(`Unmapped legacy field ${from}.${key}`);
          if(from==='settings'){
            const key=String(row.key),validator=safeSettings[key];if(secretKey(key)||key==='paypal_sandbox'){omitted[from]=(omitted[from]??0)+1;continue;}
            if(!validator||typeof row.value!=='string'||!validator.test(row.value))throw new Error('Unreviewed legacy setting requires explicit mapping');
          }
          const values=columns.map(name=>{
            const value=row[name];if(to==='payment_status_events'&&['george_evidence_json','before_json','after_json'].includes(name))return sanitizeHistoricalPaymentEvidence(value);
            if(typeof value==='string'&&/(?:meta|payload|config|json|context|data|evidence|reason_codes|tags)$/i.test(name)&&/^[\s]*[\[{]/.test(value)){
              if(value.length>1048576)throw new Error('Legacy SQLite metadata exceeds limit');let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new Error('Invalid legacy SQLite JSON metadata');}return JSON.stringify(scrub(parsed));
            }
            if(to==='payment_batches'&&['export_artifact_path','export_artifact_data'].includes(name))return null;
            return value;
          });
          dest.prepare(`INSERT INTO "${to}" (${columns.map(name=>`"${name}"`).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...values);mapped[from]=(mapped[from]??0)+1;
        }
      }
    })();dest.pragma('foreign_keys=ON');
    if((dest.pragma('foreign_key_check') as unknown[]).length||dest.pragma('integrity_check',{simple:true})!=='ok')throw new Error('Converted legacy relationship failure');
    return{mapped,omitted};
  }finally{src.close();dest.close();}
}
function layout(root:string){
  const choices=[{state:join(root,'state','state.json'),db:join(root,'database','matching.db'),evidence:join(root,'documents')},{state:join(root,'data','state.json'),db:join(root,'data','matching.db'),evidence:join(root,'Belege')},{state:join(root,'state.json'),db:join(root,'matching.db'),evidence:join(root,'Belege')}].filter(item=>existsSync(item.state)&&existsSync(item.db));
  if(choices.length!==1)throw new Error('Legacy source layout is incomplete or ambiguous');for(const path of[choices[0]!.state,choices[0]!.db,choices[0]!.evidence])verifyRuntimePath(root,path);return choices[0]!;
}
/** Only reviewed attachment storage may become financial evidence. Historical
 * root-relative names may include its exact documents/Belege prefix. Authority
 * trees and anything omitted by the source fingerprint are never attachments.
 */
function documentSource(root:string,evidence:string,filename:string):string{
  // Convert historical Windows separators only. Validate before resolve can
  // collapse components or Windows can interpret ADS/reserved-name aliases.
  const normalized=filename.replaceAll('\\','/');
  safeArchivePath(normalized);
  if(isAbsolute(filename)||normalized.includes('\0')||normalized.split('/').some(part=>part==='..'||excludedSourceTrees.has(part.toLowerCase())))throw new Error('Unsafe legacy document path');
  const evidencePrefix=relative(root,evidence).replaceAll('\\','/');
  const candidates=[resolve(evidence,normalized)];
  const prefixMatches=process.platform==='win32'?normalized.toLowerCase().startsWith(evidencePrefix.toLowerCase()+'/'):normalized.startsWith(evidencePrefix+'/');
  if(prefixMatches)candidates.push(resolve(evidence,normalized.slice(evidencePrefix.length+1)));
  const found=[...new Set(candidates)].filter(path=>{
    const boundary=relative(evidence,path);
    if(!boundary||boundary.startsWith('..')||isAbsolute(boundary))throw new Error('Unsafe legacy document outside reviewed evidence storage');
    verifyRuntimePath(root,path);return existsSync(path);
  });
  if(found.length!==1)throw new Error('Missing or ambiguous linked legacy document in reviewed evidence storage');
  // Windows short-name aliases must not bypass the excluded-tree policy.
  const physicalBoundary=relative(realpathSync(evidence),realpathSync(found[0]!));
  safeArchivePath(physicalBoundary.replaceAll('\\','/'));
  if(!physicalBoundary||physicalBoundary.startsWith('..')||isAbsolute(physicalBoundary)||physicalBoundary.split(/[\\/]/).some(part=>excludedSourceTrees.has(part.toLowerCase())))throw new Error('Unsafe legacy document outside reviewed evidence storage');
  return found[0]!;
}
const stateKeys=new Set(['schema_version','format','run_id','transactions','documents','match_groups','exclusion_rules','audit_events','matched_transaction_ids','matched_document_ids','excluded_transaction_ids','accounting']);
function buildCandidate(sourceRoot:string,candidate:string){
  const root=resolve(sourceRoot),paths=layout(root),before=legacySourceFingerprint(root),raw=scrub(JSON.parse(normalFile(paths.state).toString('utf8'))) as Record<string,unknown>;
  for(const[key,value]of Object.entries(raw))if(!stateKeys.has(key)&&value!==null)throw new Error('Unmapped legacy state field: '+key);
  raw.schema_version=raw.accounting===undefined?1:2;raw.format=raw.accounting===undefined?'matching-community-state-v1':'matching-community-state-v2';validateCommunityJsonState(raw);
  mkdirSync(join(candidate,'database'),{recursive:true});mkdirSync(join(candidate,'state'));mkdirSync(join(candidate,'documents'));
  // SQLite opens only this private copy, so even WAL/SHM management cannot alter the source.
  const snapshot=join(candidate,'source-snapshot.db');writeFileSync(snapshot,normalFile(paths.db),{flag:'wx'});if(existsSync(paths.db+'-wal')){verifyRuntimePath(root,paths.db+'-wal');writeFileSync(snapshot+'-wal',normalFile(paths.db+'-wal'),{flag:'wx'});}
  const mapping=translateDatabase(snapshot,join(candidate,'database','matching.db'));for(const suffix of['','-wal','-shm'])if(existsSync(snapshot+suffix))rmSync(snapshot+suffix);
  const dest=new Database(join(candidate,'database','matching.db'));let evidenceCount=0;
  try{
    for(const[id,doc]of Object.entries(raw.documents as Record<string,{filename?:string;file_hash?:string;meta?:Record<string,unknown>}>)){
      const filename=typeof doc.meta?.attachment_path==='string'?doc.meta.attachment_path:doc.filename;if(!filename){if(doc.file_hash)throw new Error('Missing linked legacy document');continue;}
      const source=documentSource(root,paths.evidence,filename);
      const bytes=normalFile(source),digest=sha(bytes);if(doc.file_hash&&doc.file_hash.toLowerCase()!==digest)throw new Error('Legacy document content hash mismatch');
      const name=id.replace(/[^A-Za-z0-9_-]/g,'_')+'-'+digest;writeFileSync(join(candidate,'documents',name),bytes,{flag:'wx'});doc.filename=name;doc.file_hash=digest;if(typeof doc.meta?.attachment_path==='string')doc.meta.attachment_path=name;
      dest.prepare('UPDATE documents SET filename=?,file_hash=?,meta=? WHERE document_id=?').run(name,digest,JSON.stringify(doc.meta??{}),id);
      dest.prepare('UPDATE invoice_scans SET stored_filename=?,file_hash=? WHERE document_id=?').run(name,digest,id);evidenceCount++;
    }
    verifyCanonicalSql(dest,deserializeCommunityState(raw));
  }finally{dest.close();}
  if(legacySourceFingerprint(root)!==before)throw new Error('Legacy source changed during conversion');
  writeFileSync(join(candidate,'state','state.json'),JSON.stringify(raw));
  const totals:Record<string,number>={},statuses:Record<string,number>={};for(const tx of Object.values(raw.transactions as Record<string,{currency_code:string;amount_minor:number}>)){totals[tx.currency_code]=(totals[tx.currency_code]??0)+tx.amount_minor;if(!Number.isSafeInteger(totals[tx.currency_code]))throw new Error('Legacy financial totals exceed exact range');}
  for(const match of Object.values(raw.match_groups as Record<string,{status:string}>))statuses[match.status]=(statuses[match.status]??0)+1;
  return{mapping,fingerprint:before,source_sha256:sha(normalFile(paths.state)),counts:{transactions:Object.keys(raw.transactions as object).length,documents:Object.keys(raw.documents as object).length,match_groups:Object.keys(raw.match_groups as object).length,audit_events:(raw.audit_events as unknown[]).length},signed_totals_minor_by_currency:totals,match_statuses:statuses,evidence_count:evidenceCount,requires_reconnection:['banking','oauth','payment_provider','invoice_bot'],warnings:['Reusable sessions, release authority and exported payment artifacts are excluded; historical economic payment evidence is retained.']};
}
export async function inspectLegacy(sourceRoot:string){
  const candidate=mkdtempSync(join(tmpdir(),'community-legacy-preview-'));try{return{...buildCandidate(sourceRoot,candidate),dry_run:true,activation_allowed:false,source_unchanged:true};}finally{rmSync(candidate,{recursive:true,force:true});}
}
export async function stageLegacyConversion(runtimeRoot:string,sourceRoot:string,fingerprint:string,withExclusiveAccess:Exclusive){
  if(!/^[a-f0-9]{64}$/.test(fingerprint)||legacySourceFingerprint(sourceRoot)!==fingerprint)throw new Error('Legacy dry run confirmation is stale');
  const root=resolve(runtimeRoot),source=resolve(sourceRoot),rel=relative(root,source),reverse=relative(source,root),inside=(path:string)=>!path||path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);if(inside(rel)||inside(reverse))throw new Error('Unsafe legacy source overlaps active runtime');
  const temp=join(root,'temp');verifyRuntimePath(root,temp);mkdirSync(temp,{recursive:true});const candidate=join(temp,'legacy-community-'+randomUUID());
  try{
    const preview=buildCandidate(source,candidate);if(preview.fingerprint!==fingerprint)throw new Error('Legacy source changed after dry run');
    const backup=await createCommunityBackup(candidate,async run=>run());if(legacySourceFingerprint(source)!==fingerprint)throw new Error('Legacy source changed after staging');
    const staged=await stageCommunityRestore(root,normalFile(backup.path),withExclusiveAccess);
    return{...staged,source_fingerprint:fingerprint,source_preview:{...preview,dry_run:false,activation_allowed:false,source_unchanged:true},mapping:preview.mapping,requires_reconnection:preview.requires_reconnection};
  }finally{if(existsSync(candidate))rmSync(candidate,{recursive:true,force:true});}
}
