import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inspectBackupBytes, verifyBackupDatabase, verifyRuntimePath, type BackupManifest, type Exclusive } from './backup.js';
import { safeArchivePath } from './zip.js';

export interface RestoreStage{id:string;fingerprint:string;manifest:BackupManifest;target_fingerprint:string}
export type SafeActivate=(change:()=>void,rollback:()=>void)=>Promise<void>;
const hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const safeId=(id:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new Error('Invalid restore identifier');return id;};
const journalName='.restore-operation-v1.json';
const names=['database','state','documents'] as const;
function durable(path:string,bytes:Buffer|string):void{const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function regular(root:string,path:string,limit=512*1024*1024):Buffer{verifyRuntimePath(root,path);const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size>limit)throw new Error('Unsafe restore file');return readFileSync(path);}
function fingerprint(root:string):string{
  const paths=['state/state.json','database/matching.db','database/matching.db-wal'];
  const statePath=join(root,'state','state.json');
  if(existsSync(statePath)){
    const state=JSON.parse(regular(root,statePath).toString('utf8')) as {documents?:Record<string,{filename?:string;meta?:{attachment_path?:string}}>};
    for(const doc of Object.values(state.documents??{})){const name=doc.meta?.attachment_path??doc.filename;if(name){safeArchivePath(name);paths.push('documents/'+name);}}
  }
  const indexPath=join(root,'documents','document-index-v1.json');
  if(existsSync(indexPath)){
    paths.push('documents/document-index-v1.json');const index=JSON.parse(regular(root,indexPath).toString('utf8')) as {records?:Array<{workspace_id:string;hash:string}>};
    for(const record of index.records??[]){if(typeof record.workspace_id!=='string'||!/^[a-f0-9]{64}$/.test(record.hash))throw new Error('Invalid active document index');paths.push('documents/attachments/'+hash(record.workspace_id)+'/'+record.hash);}
  }
  return hash([...new Set(paths)].sort().map(name=>{const path=join(root,...name.split('/'));verifyRuntimePath(root,path);return name+':'+(existsSync(path)?hash(regular(root,path)):'absent');}).join('\n'));
}
function stageDir(root:string,id:string):string{return join(root,'.restore-stage-'+safeId(id));}
function journalPath(root:string):string{return join(root,journalName);}
function assertNoPending(root:string):void{verifyRuntimePath(root,root);if(existsSync(journalPath(root)))throw new Error('Interrupted restore must be recovered first');if(existsSync(join(root,'state','statement-journal-v1.json')))throw new Error('Pending statement journal prevents restore');}
function verifyStageDb(path:string,state:Buffer,manifest:BackupManifest):void{
  const db=new Database(path,{readonly:true,fileMustExist:true});
  try{
    verifyBackupDatabase(db,state,manifest);
    for(const table of ['invoice_bot_profiles','payment_automation_runs'])if(Number(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()))throw new Error('Backup contains excluded sessions or payment authority');
    if(Number(db.prepare('SELECT count(*) FROM invoice_bot_portals WHERE credential_ref IS NOT NULL').pluck().get()))throw new Error('Backup contains credential references');
    if(Number(db.prepare("SELECT count(*) FROM settings WHERE lower(key) GLOB '*password*' OR lower(key) GLOB '*token*' OR lower(key) GLOB '*secret*' OR lower(key) GLOB '*credential*' OR lower(key) GLOB '*auth*'").pluck().get()))throw new Error('Backup contains credentials');
    if(manifest.sqlite_version>=3){
      if(Number(db.prepare('SELECT count(*) FROM community_payment_confirmations').pluck().get())||Number(db.prepare('SELECT count(*) FROM community_bank_connections').pluck().get()))throw new Error('Backup contains reusable provider/payment authority');
      if(Number(db.prepare("SELECT count(*) FROM community_payment_batches WHERE status IN ('approved','submission_claimed','acknowledged')").pluck().get()))throw new Error('Backup contains actionable payment approval');
    }
  }finally{db.close();}
}
function verifyStagedFiles(root:string,stage:RestoreStage):void{
  const folder=stageDir(root,stage.id);verifyRuntimePath(root,folder);
  const wanted=new Set(['stage.json',...Object.keys(stage.manifest.files)]);
  const seen=new Set<string>();
  function walk(path:string,prefix:string):void{
    verifyRuntimePath(root,path);
    for(const item of readdirSync(path,{withFileTypes:true})){
      const name=prefix+item.name;safeArchivePath(name);const file=join(path,item.name);
      if(item.isSymbolicLink())throw new Error('Unsafe staged restore link');
      if(item.isDirectory()){walk(file,name+'/');continue;}
      if(!item.isFile()||!wanted.has(name))throw new Error('Unexpected staged restore member');
      seen.add(name);
      if(name==='stage.json')continue;
      const expected=stage.manifest.files[name],bytes=regular(root,file);
      if(bytes.length!==expected.bytes||hash(bytes)!==expected.sha256)throw new Error('Staged restore file changed after confirmation');
    }
  }
  walk(folder,'');if(seen.size!==wanted.size)throw new Error('Staged restore file is missing');
  verifyStageDb(join(folder,'database','matching.db'),regular(root,join(folder,'state','state.json')),stage.manifest);
}

export async function stageCommunityRestore(runtimeRoot:string,archive:Buffer,withExclusiveAccess:Exclusive):Promise<RestoreStage>{
  return withExclusiveAccess(async()=>{
    const root=resolve(runtimeRoot);assertNoPending(root);const{manifest,files}=inspectBackupBytes(archive);
    const id=randomUUID(),target=fingerprint(root),folder=stageDir(root,id);verifyRuntimePath(root,folder);mkdirSync(folder);
    try{
      mkdirSync(join(folder,'documents'));
      for(const[name,bytes]of files){if(name==='manifest.json')continue;const path=join(folder,...name.split('/'));mkdirSync(dirname(path),{recursive:true});durable(path,bytes);}
      const token=hash(Buffer.concat([archive,Buffer.from(target)]));const result:RestoreStage={id,fingerprint:token,manifest,target_fingerprint:target};durable(join(folder,'stage.json'),JSON.stringify(result));
      verifyStagedFiles(root,result);return result;
    }catch(error){rmSync(folder,{recursive:true,force:true});throw error;}
  });
}
function loadStage(root:string,id:string):RestoreStage{
  const raw=JSON.parse(regular(root,join(stageDir(root,id),'stage.json'),1024*1024).toString('utf8')) as RestoreStage;
  if(!raw||raw.id!==id||!/^[a-f0-9]{64}$/.test(raw.fingerprint)||!/^[a-f0-9]{64}$/.test(raw.target_fingerprint)||!raw.manifest||!raw.manifest.files)throw new Error('Invalid restore stage');
  for(const name of Object.keys(raw.manifest.files)){safeArchivePath(name);if(!['database/matching.db','state/state.json'].includes(name)&&!name.startsWith('documents/'))throw new Error('Unapproved staged restore member');}
  return raw;
}

/** Recover only fixed, verified installation-owned directories before opening DBs. */
export function recoverInterruptedRestore(runtimeRoot:string):boolean{
  const root=resolve(runtimeRoot),path=journalPath(root);verifyRuntimePath(root,path);if(!existsSync(path))return false;
  const info=JSON.parse(regular(root,path,65536).toString('utf8')) as {format:string;id:string;existed:string[]};
  if(!info||info.format!=='matching-community-restore-operation-v1'||!Array.isArray(info.existed)||new Set(info.existed).size!==info.existed.length||info.existed.some(name=>!names.includes(name as typeof names[number])))throw new Error('Invalid restore operation journal');
  safeId(info.id);const previous=join(root,'.restore-previous-'+info.id),stage=stageDir(root,info.id);
  for(const directory of [previous,stage,...names.map(name=>join(root,name)),...names.map(name=>join(previous,name)),...names.map(name=>join(stage,name))])verifyRuntimePath(root,directory);
  // Validate every existing relevant path before the first destructive/rename action.
  for(const directory of [previous,stage,...names.map(name=>join(root,name)),...names.map(name=>join(previous,name)),...names.map(name=>join(stage,name))])if(existsSync(directory)&&!lstatSync(directory).isDirectory())throw new Error('Invalid restore directory');
  for(const name of names){
    const old=join(previous,name),live=join(root,name),pending=join(stage,name);
    if(existsSync(old)){
      if(existsSync(live)){mkdirSync(stage,{recursive:true});if(existsSync(pending))rmSync(pending,{recursive:true,force:true});renameSync(live,pending);}
      renameSync(old,live);
    }else if(!info.existed.includes(name)&&existsSync(live)){
      mkdirSync(stage,{recursive:true});if(existsSync(pending))rmSync(pending,{recursive:true,force:true});renameSync(live,pending);
    }
  }
  if(existsSync(previous))rmSync(previous,{recursive:true,force:true});if(existsSync(stage))rmSync(stage,{recursive:true,force:true});rmSync(path);return true;
}

export async function activateCommunityRestore(runtimeRoot:string,id:string,confirmation:string,withExclusiveAccess:Exclusive,safeActivate:SafeActivate):Promise<BackupManifest>{
  return withExclusiveAccess(async()=>{
    const root=resolve(runtimeRoot);assertNoPending(root);const stage=loadStage(root,safeId(id));
    if(confirmation!==stage.fingerprint||fingerprint(root)!==stage.target_fingerprint)throw new Error('Restore confirmation is stale');
    verifyStagedFiles(root,stage);
    const previous=join(root,'.restore-previous-'+id),pending=stageDir(root,id);verifyRuntimePath(root,previous);if(existsSync(previous))throw new Error('Previous restore operation remains');mkdirSync(previous);
    durable(journalPath(root),JSON.stringify({format:'matching-community-restore-operation-v1',id,existed:names.filter(name=>existsSync(join(root,name)))}));
    let changed=false;
    const rollback=()=>{recoverInterruptedRestore(root);};
    const change=()=>{
      if(changed)throw new Error('Restore activation callback may execute only once');changed=true;
      for(const name of names){const live=join(root,name),staged=join(pending,name);verifyRuntimePath(root,live);verifyRuntimePath(root,staged);if(existsSync(live))renameSync(live,join(previous,name));if(existsSync(staged))renameSync(staged,live);}
    };
    try{
      await safeActivate(change,rollback);
      if(!changed)throw new Error('Restore activation was not performed');
      verifyStageDb(join(root,'database','matching.db'),regular(root,join(root,'state','state.json')),stage.manifest);
      rmSync(journalPath(root));rmSync(pending,{recursive:true,force:true});return stage.manifest;
    }catch(error){if(existsSync(journalPath(root)))rollback();throw error;}
  });
}
