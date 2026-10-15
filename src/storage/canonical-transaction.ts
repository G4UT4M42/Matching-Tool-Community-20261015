import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { MatchingState } from '../core/types.js';
import { recordAudit } from '../observability/audit.js';
import { resolveAccountingPaths } from './paths.js';
import { getDb } from './db.js';
import { deserializeCommunityState, serializeCommunityState, validateCommunityJsonState, writeStateFileAtomically } from './json-store.js';
import { synchronizeCanonicalSql, verifyCanonicalSql, verifyCanonicalTransition } from './canonical-sql.js';

const FORMAT='matching-community-financial-journal';
const MAX_BYTES=256*1024*1024;
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
export type CanonicalPhase='before_journal'|'after_journal'|'after_json'|'after_commit';
export interface CanonicalHooks{onPhase?:(phase:CanonicalPhase)=>void}
interface StoredSnapshot{revision:number;run_id:string;operation_id:string;state_sha256:string;state_json:string;updated_at:string}
interface Journal{format:typeof FORMAT;version:2;operation_id:string;before:string;after:string;before_sha256:string;after_sha256:string;previous_revision:number;next_revision:number}
export class CanonicalStateError extends Error {
  constructor(public readonly code:string,message:string){super(message);this.name='CanonicalStateError';}
}
function paths(){const p=resolveAccountingPaths();if(p.mode!=='external-runtime-root')throw new Error('Canonical persistence requires explicit isolated storage');return{state:join(p.stateRoot,'state.json'),journal:join(p.stateRoot,'statement-journal-v1.json')};}
function readRegular(path:string,limit=MAX_BYTES):string{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size>limit)throw new Error('Invalid canonical persistence file');return readFileSync(path,'utf8');}
export function canonicalJournalPending():boolean{return existsSync(paths().journal);}
function readSnapshot(db:Database.Database):StoredSnapshot|undefined{
  const row=db.prepare('SELECT revision,run_id,operation_id,state_sha256,state_json,updated_at FROM community_canonical_state WHERE singleton=1').get() as StoredSnapshot|undefined;
  if(row&&(Buffer.byteLength(row.state_json)>MAX_BYTES||sha(row.state_json)!==row.state_sha256||!Number.isSafeInteger(row.revision)||row.revision<0))throw new CanonicalStateError('SNAPSHOT_INVALID','Canonical SQLite snapshot integrity check failed');
  return row;
}
function writeSnapshot(db:Database.Database,state:MatchingState,text:string,operation:string,revision:number):void{
  db.prepare(`INSERT INTO community_canonical_state(singleton,revision,run_id,operation_id,state_sha256,state_json,updated_at) VALUES(1,?,?,?,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,run_id=excluded.run_id,operation_id=excluded.operation_id,state_sha256=excluded.state_sha256,state_json=excluded.state_json,updated_at=excluded.updated_at`)
    .run(revision,state.run_id,operation,sha(text),text,new Date().toISOString());
}
function sameState(text:string,state:MatchingState):boolean{return isDeepStrictEqual(validateCommunityJsonState(JSON.parse(text)),validateCommunityJsonState(JSON.parse(serializeCommunityState(state))));}
function requireCurrent(db:Database.Database,state:MatchingState,currentText:string):StoredSnapshot{
  if(!sameState(currentText,state))throw new CanonicalStateError('STALE_ACCOUNTING_STATE','The accounting state changed; reload before saving');
  const stored=readSnapshot(db);
  if(!stored||stored.run_id!==state.run_id||stored.state_sha256!==sha(currentText)||!sameState(stored.state_json,state))throw new CanonicalStateError('CROSS_STORE_CONFLICT','SQLite and JSON do not share the same canonical state');
  verifyCanonicalSql(db,state);return stored;
}

/**
 * One-time installation reconciliation permits only missing SQL rows, never a
 * conflicting existing value or an SQL-only source. It preserves JSON evidence
 * produced by an older reviewed version and creates a verified durable snapshot.
 */
export function initializeCanonicalState(state:MatchingState):void{
  const p=paths();if(canonicalJournalPending())throw new CanonicalStateError('RECOVERY_REQUIRED','Recover the pending financial journal first');
  const text=readRegular(p.state);if(!sameState(text,state))throw new CanonicalStateError('STALE_ACCOUNTING_STATE','The accounting snapshot changed before activation');
  const db=getDb();
  db.transaction(()=>{
    const stored=readSnapshot(db);
    if(stored){requireCurrent(db,state,text);return;}
    verifyCanonicalSql(db,state,true);
    synchronizeCanonicalSql(db,state);
    writeSnapshot(db,state,text,'BOOTSTRAP-'+randomUUID(),0);
  }).immediate();
}

function parseJournal(path:string):Journal{
  const raw:unknown=JSON.parse(readRegular(path,2*MAX_BYTES+1048576));
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new CanonicalStateError('JOURNAL_INVALID','Invalid financial recovery journal');
  const j=raw as Journal;
  const keys=['format','version','operation_id','before','after','before_sha256','after_sha256','previous_revision','next_revision'];
  if(Object.keys(j).length!==keys.length||Object.keys(j).some(key=>!keys.includes(key))||j.format!==FORMAT||j.version!==2||
    !/^STATE-[a-f0-9-]{36}$/.test(j.operation_id)||typeof j.before!=='string'||typeof j.after!=='string'||Buffer.byteLength(j.before)>MAX_BYTES||Buffer.byteLength(j.after)>MAX_BYTES||
    sha(j.before)!==j.before_sha256||sha(j.after)!==j.after_sha256||!Number.isSafeInteger(j.previous_revision)||j.previous_revision<0||j.next_revision!==j.previous_revision+1){
    throw new CanonicalStateError('JOURNAL_INVALID','Financial journal structure, version or checksum is invalid');
  }
  const before=deserializeCommunityState(JSON.parse(j.before)),after=deserializeCommunityState(JSON.parse(j.after));
  verifyCanonicalTransition(before,after);return j;
}

/** SQLite commit identity decides rollback or completion, never wall time. */
export function recoverCanonicalTransaction():{committed:boolean;state:MatchingState}|null{
  const p=paths();if(!existsSync(p.journal))return null;
  const j=parseJournal(p.journal),db=getDb(),snapshot=readSnapshot(db);
  const current=readRegular(p.state),currentHash=sha(current);
  if(currentHash!==j.before_sha256&&currentHash!==j.after_sha256)throw new CanonicalStateError('RECOVERY_CONFLICT','Concurrent or corrupted accounting state prevents automatic recovery');
  const committed=Boolean(snapshot&&snapshot.operation_id===j.operation_id&&snapshot.revision===j.next_revision&&snapshot.state_sha256===j.after_sha256);
  const rolledBack=Boolean(snapshot&&snapshot.revision===j.previous_revision&&snapshot.state_sha256===j.before_sha256);
  if(!committed&&!rolledBack)throw new CanonicalStateError('RECOVERY_CONFLICT','The financial commit decision does not match the recovery journal');
  const text=committed?j.after:j.before;const state=deserializeCommunityState(JSON.parse(text));
  verifyCanonicalSql(db,state);
  if(current!==text)writeStateFileAtomically(p.state,text);
  unlinkSync(p.journal);
  return{committed,state};
}

/**
 * All callers share one synchronous SQLite write transaction. The callback must
 * not perform network I/O or return a Promise. Expensive provider/OCR work runs
 * before entry; its stale expected state is rejected rather than overwriting a
 * later change. Optional callbacks are injectable failure hooks for local tests.
 */
export function commitCanonicalMutation<T>(input:MatchingState,actor:string,prepare:(db:Database.Database)=>{state:MatchingState;result:T},hooks:CanonicalHooks={}):{state:MatchingState;result:T}{
  if(!actor||actor.length>200||/[\u0000-\u001f]/.test(actor))throw new CanonicalStateError('AUTHENTICATION_REQUIRED','A trusted accounting actor is required');
  const p=paths();if(canonicalJournalPending())throw new CanonicalStateError('RECOVERY_REQUIRED','Pending financial recovery must complete first');
  const db=getDb();if(!readSnapshot(db))initializeCanonicalState(input);
  const operation='STATE-'+randomUUID();let result:T|undefined;let candidate:MatchingState|undefined;
  try{
    db.transaction(()=>{
      if(canonicalJournalPending())throw new CanonicalStateError('RECOVERY_REQUIRED','Another financial operation requires recovery');
      const before=readRegular(p.state),previous=requireCurrent(db,input,before);
      const prepared=prepare(db);
      if(!prepared||typeof(prepared as unknown as {then?:unknown}).then==='function'||!prepared.state)throw new Error('Financial preparation must be synchronous');
      candidate=structuredClone(prepared.state);result=prepared.result;
      verifyCanonicalTransition(input,candidate);
      if(candidate.audit_events.length===input.audit_events.length){
        recordAudit(candidate,'STATE_COMMITTED','Run',operation,{actor_type:'user',actor_id:actor,correlation_id:operation,
          reason:'Explicit reviewed accounting state change',after:{transactions:candidate.transactions.size,documents:candidate.documents.size,match_groups:candidate.match_groups.size}});
      }
      const after=serializeCommunityState(candidate);
      if(Buffer.byteLength(after)>MAX_BYTES)throw new CanonicalStateError('STATE_LIMIT','Canonical state exceeds supported storage size');
      synchronizeCanonicalSql(db,candidate);
      writeSnapshot(db,candidate,after,operation,previous.revision+1);
      const journal:Journal={format:FORMAT,version:2,operation_id:operation,before,after,before_sha256:sha(before),after_sha256:sha(after),previous_revision:previous.revision,next_revision:previous.revision+1};
      hooks.onPhase?.('before_journal');writeStateFileAtomically(p.journal,JSON.stringify(journal));
      hooks.onPhase?.('after_journal');writeStateFileAtomically(p.state,after);hooks.onPhase?.('after_json');
    }).immediate();
    hooks.onPhase?.('after_commit');unlinkSync(p.journal);return{state:candidate!,result:result!};
  }catch(error){
    if(existsSync(p.journal)){
      const recovered=recoverCanonicalTransaction();
      if(recovered?.committed&&candidate)return{state:recovered.state,result:result!};
    }
    throw error;
  }
}
export function commitCanonicalState(input:MatchingState,next:MatchingState,actor:string,hooks:CanonicalHooks={}):MatchingState{
  return commitCanonicalMutation(input,actor,()=>({state:next,result:null}),hooks).state;
}
