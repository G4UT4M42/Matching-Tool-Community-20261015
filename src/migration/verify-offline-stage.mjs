/**
 * Verification-only gate for the synthetic offline V2 stage.
 * Never activates data or reads the original source installation.
 * A successful result is NOT permission to import real bookkeeping.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { totalsAndReferences } from './offline-v2.mjs';

function blocked(reason) { throw new Error('LEGACY_STAGE_VERIFY_BLOCKED: '+reason); }
function within(root,target) {
  const path=relative(root,target);
  return path===''||(!path.startsWith('..'+sep)&&path!=='..'&&!isAbsolute(path));
}
function checkedFile(root,relativePath) {
  if(typeof relativePath!=='string'||!relativePath||isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).includes('..'))blocked('Invalid staged artifact path');
  const target=resolve(root,relativePath);
  if(!within(root,target))blocked('Staged path escapes the candidate');
  let info;
  try { info=lstatSync(target); } catch { blocked('Missing staged artifact') }
  if(info.isSymbolicLink()||!info.isFile())blocked('Non-regular staged artifact');
  if(!within(root,realpathSync(target)))blocked('Staged artifact symlink escape');
  return target;
}
function sha256File(file) {
  const checksum=createHash('sha256');
  const handle=openSync(file,'r');
  try {
    const chunk=Buffer.alloc(64*1024);
    while(true) {
      const length=readSync(handle,chunk,0,chunk.length,null);
      if(!length)break;
      checksum.update(chunk.subarray(0,length));
    }
  } finally { closeSync(handle) }
  return checksum.digest('hex');
}
function readStageJson(root,path) {
  const filename=checkedFile(root,path);
  if(lstatSync(filename).size>16*1024*1024)blocked('JSON verification size limit exceeded');
  let result;
  try { result=JSON.parse(readFileSync(filename,'utf8')); }
  catch { blocked('Invalid staged JSON') }
  return result;
}
function validateContents(root,permitted) {
  const pending=[''];
  let visited=0;
  while(pending.length) {
    const current=pending.pop();
    const location=join(root,current);
    for(const item of readdirSync(location,{withFileTypes:true})) {
      if(++visited>10000)blocked('Too many staged entries');
      const rel=current?current+'/'+item.name:item.name;
      if(item.isSymbolicLink())blocked('Stage must not contain links');
      if(item.isDirectory()) {
        if(!['database','state','evidence'].includes(rel))blocked('Unreviewed directory in staging area');
        pending.push(rel);
      }else if(!item.isFile()||!permitted.has(rel)) {
        blocked('Unexpected file in staged dataset');
      }
    }
  }
  for(const file of permitted)checkedFile(root,file);
}
export function verifyLegacyStage({destinationRoot}) {
  if(typeof destinationRoot!=='string'||!destinationRoot.trim())blocked('Stage path is required');
  let root;
  try { root=realpathSync(resolve(destinationRoot)); }catch { blocked('Candidate stage is missing') }
  if(!lstatSync(root).isDirectory())blocked('Candidate must be a directory');
  const manifest=readStageJson(root,'migration-manifest.json');
  if(manifest.format!=='matching-tool-offline-v2-stage-v1'
    ||manifest.activation_allowed!==false||manifest.bank_actions_enabled!==false)
    blocked('Unreviewed stage contract or unsafe activation flag');
  if(!Array.isArray(manifest.documents)||!manifest.check||typeof manifest.check!=='object')
    blocked('Invalid stage evidence manifest');
  const permitted=new Set(['migration-manifest.json','database/matching.db','state/state.json']);
  const records=new Set();
  for(const record of manifest.documents) {
    if(!record||typeof record.document_id!=='string'||records.has(record.document_id)
      ||typeof record.sha256!=='string'||!(/^[a-f0-9]{64}$/.test(record.sha256))
      ||!Number.isSafeInteger(record.bytes)||record.bytes<0
      ||typeof record.path!=='string'||!(/^evidence\/[A-Za-z0-9_-]+-[a-f0-9]{64}$/.test(record.path)))
      blocked('Unreviewed document artifact manifest');
    records.add(record.document_id);
    if(permitted.has(record.path))blocked('Duplicate stage artifact filename');
    permitted.add(record.path);
  }
  validateContents(root,permitted);
  const dbFile=checkedFile(root,'database/matching.db');
  const stateFile=checkedFile(root,'state/state.json');
  if(sha256File(dbFile)!==manifest.stage_database_sha256
    ||sha256File(stateFile)!==manifest.stage_state_sha256)
    blocked('Staged database or state hash mismatch');
  const state=readStageJson(root,'state/state.json');
  const summary=totalsAndReferences(state);
  if(JSON.stringify(summary)!==JSON.stringify(manifest.check))
    blocked('Stage financial counts or signed minor-unit totals changed');
  const db=new Database(dbFile,{readonly:true,fileMustExist:true});
  try {
    if(db.pragma('integrity_check',{simple:true})!=='ok'||db.pragma('foreign_key_check').length)
      blocked('Stage SQLite integrity verification failed');
  } finally { db.close() }
  for(const record of manifest.documents) {
    const file=checkedFile(root,record.path);
    if(lstatSync(file).size!==record.bytes||sha256File(file)!==record.sha256)
      blocked('Staged evidence document content mismatch');
  }
  if(manifest.documents.length>summary.counts.documents)
    blocked('Stage document manifest exceeds accounting records');
  return {verified:true,activation_allowed:false,bank_actions_enabled:false,
    stage_format:manifest.format,evidence_count:manifest.documents.length,
    counts:summary.counts,signed_totals_minor_by_currency:summary.signed_totals_minor_by_currency};
}
