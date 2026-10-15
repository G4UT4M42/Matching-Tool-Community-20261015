import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { MatchingState, Document } from '../src/core/types.js';

let root:string,state:MatchingState,db:typeof import('../src/storage/db.js'),json:typeof import('../src/storage/json-store.js'),canonical:typeof import('../src/storage/canonical-transaction.js');
const originalRoot=process.env.MATCHING_RUNTIME_ROOT,originalMode=process.env.MATCHING_RUNTIME_MODE;
const supplier=(id='SYN-D1'):Document=>({document_id:id,source_system:'upload',source_document_ref:'SYN-INVOICE-'+id,captured_at:'2026-01-12T12:00:00Z',document_date:'2026-01-12',total_amount_minor:1250,currency_code:'EUR',supplier_name:'Fictional supplier',meta:{synthetic:true}});
beforeEach(async()=>{
  root=mkdtempSync(join(tmpdir(),'matching-canonical-synthetic-'));
  process.env.MATCHING_RUNTIME_ROOT=root;process.env.MATCHING_RUNTIME_MODE='external-runtime-root';vi.resetModules();
  db=await import('../src/storage/db.js');db.getDb();json=await import('../src/storage/json-store.js');canonical=await import('../src/storage/canonical-transaction.js');
  state=json.createEmptyState('SYNTHETIC_CANONICAL_DATASET');json.saveState(state);canonical.initializeCanonicalState(state);
});
afterEach(()=>{db?.closeDb();if(originalRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=originalRoot;if(originalMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=originalMode;rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});vi.resetModules();});
const count=(table:string)=>Number(db.getDb().prepare(`SELECT count(*) FROM ${table}`).pluck().get());
const snapshot=()=>readFileSync(join(root,'state','state.json'),'utf8');
function addDocument(){const next=structuredClone(state);next.documents.set('SYN-D1',supplier());return next;}

describe('shared canonical financial unit of work',()=>{
  it('commits an invoice, SQL evidence, canonical snapshot and actor audit without mutating its input',()=>{
    const next=canonical.commitCanonicalState(state,addDocument(),'synthetic-owner');
    expect(state.documents.size).toBe(0);expect(next.documents.size).toBe(1);expect(count('documents')).toBe(1);expect(count('audit_events')).toBe(1);
    expect(json.loadState()).toEqual(next);expect(next.audit_events[0]).toMatchObject({actor_id:'synthetic-owner',action:'STATE_COMMITTED'});
    const persisted=db.getDb().prepare('SELECT state_json FROM community_canonical_state WHERE singleton=1').pluck().get() as string;
    expect(JSON.parse(persisted)).toEqual(JSON.parse(snapshot()));expect(canonical.canonicalJournalPending()).toBe(false);
  });
  it('preserves exact same-total distinct source rows and rejects conflicting SQL even when aggregate totals agree',()=>{
    const next=structuredClone(state);
    for(const[id,amount]of[['SYN-T1',-100],['SYN-T2',-200]] as const)next.transactions.set(id,{transaction_id:id,source_system:'sparkasse',source_account_id:'SYN-ACCOUNT',source_row_ref:id,posting_at:'2026-01-12',amount_minor:amount,currency_code:'EUR',description_raw:'Synthetic value',tags:[],meta:{}});
    state=canonical.commitCanonicalState(state,next,'synthetic-owner');
    db.getDb().prepare("UPDATE transactions SET amount_minor=CASE transaction_id WHEN 'SYN-T1' THEN -200 ELSE -100 END").run();
    expect(()=>canonical.commitCanonicalState(state,structuredClone(state),'synthetic-owner')).toThrow(/disagree/);
    expect(json.loadState()).toEqual(state);expect(count('transactions')).toBe(2);
  });
  it('rejects source amount replacement, dataset replacement and audit rewrites before committing',()=>{
    state=canonical.commitCanonicalState(state,addDocument(),'synthetic-owner');
    const changed=structuredClone(state);changed.documents.get('SYN-D1')!.total_amount_minor=999;
    expect(()=>canonical.commitCanonicalState(state,changed,'synthetic-owner')).toThrow(/Immutable/);
    const removed=structuredClone(state);removed.documents.delete('SYN-D1');expect(()=>canonical.commitCanonicalState(state,removed,'synthetic-owner')).toThrow(/deletion/);
    const audit=structuredClone(state);audit.audit_events[0].actor_id='forged';expect(()=>canonical.commitCanonicalState(state,audit,'synthetic-owner')).toThrow(/append only/);
    const dataset=structuredClone(state);dataset.run_id='OTHER';expect(()=>canonical.commitCanonicalState(state,dataset,'synthetic-owner')).toThrow(/Dataset/);
    expect(json.loadState()).toEqual(state);expect(count('audit_events')).toBe(1);
  });
  it('preserves allocation-enabled JSON and exact document/transaction relationships across restart',async()=>{
    const first=addDocument();first.transactions.set('SYN-T1',{transaction_id:'SYN-T1',source_system:'sparkasse',source_account_id:'SYN-A',source_row_ref:'SYN-T1',posting_at:'2026-01-12',amount_minor:-1250,currency_code:'EUR',description_raw:'Synthetic invoice settlement',tags:[],meta:{}});
    state=canonical.commitCanonicalState(state,first,'synthetic-owner');
    const {acceptAllocations}=await import('../src/community/accounting/ledger.js');
    const allocated=acceptAllocations(state,{revision:0,evidence_ref:'SYNTHETIC',allocations:[{kind:'payment',transaction_id:'SYN-T1',document_id:'SYN-D1',transaction_amount_minor:-500,document_amount_minor:500}]},'synthetic-owner');
    state=canonical.commitCanonicalState(state,allocated,'synthetic-owner');
    expect(JSON.parse(snapshot()).schema_version).toBe(2);db.closeDb();db.getDb();
    expect(()=>canonical.initializeCanonicalState(json.loadState()!)).not.toThrow();expect(json.loadState()?.accounting?.allocations).toHaveLength(1);
    expect(count('documents')).toBe(1);expect(count('transactions')).toBe(1);
  });
  it.each(['before_journal','after_journal','after_json'] as const)('rolls back SQL, snapshot and JSON after injected failure at %s',phase=>{
    const before=snapshot();const rev=db.getDb().prepare('SELECT revision FROM community_canonical_state').pluck().get();
    expect(()=>canonical.commitCanonicalState(state,addDocument(),'synthetic-owner',{onPhase:current=>{if(current===phase)throw new Error('SYNTHETIC_WRITE_FAILURE');}})).toThrow('SYNTHETIC_WRITE_FAILURE');
    expect(snapshot()).toBe(before);expect(count('documents')).toBe(0);expect(count('audit_events')).toBe(0);
    expect(db.getDb().prepare('SELECT revision FROM community_canonical_state').pluck().get()).toBe(rev);expect(canonical.canonicalJournalPending()).toBe(false);
  });
  it('returns the proved committed result after a post-commit failure instead of reporting a retryable import',()=>{
    const result=canonical.commitCanonicalState(state,addDocument(),'synthetic-owner',{onPhase:phase=>{if(phase==='after_commit')throw new Error('SYNTHETIC_POST_COMMIT');}});
    expect(result.documents.size).toBe(1);expect(json.loadState()).toEqual(result);expect(count('audit_events')).toBe(1);expect(canonical.canonicalJournalPending()).toBe(false);
  });
  it('rejects competing stale writer state and an asynchronous preparation callback',()=>{
    const original=state;state=canonical.commitCanonicalState(state,addDocument(),'synthetic-owner');
    expect(()=>canonical.commitCanonicalState(original,structuredClone(original),'synthetic-owner')).toThrow(/changed/);
    expect(()=>canonical.commitCanonicalMutation(state,'synthetic-owner',(()=>Promise.resolve({state,result:null})) as never)).toThrow(/synchronous/);
    expect(json.loadState()).toEqual(state);expect(count('documents')).toBe(1);
  });
  it('does not overwrite a damaged snapshot or a forged journal commit decision',()=>{
    let preserved='';
    expect(()=>canonical.commitCanonicalState(state,addDocument(),'synthetic-owner',{onPhase:phase=>{
      if(phase==='after_commit'){const p=join(root,'state','statement-journal-v1.json');preserved=readFileSync(p,'utf8');const j=JSON.parse(preserved);j.after_sha256='forged';writeFileSync(p,JSON.stringify(j));throw new Error('SYNTHETIC_CORRUPTION');}
    }})).toThrow(/checksum/);
    expect(canonical.canonicalJournalPending()).toBe(true);expect(count('documents')).toBe(1);
    expect(()=>json.saveState(state)).toThrow(/recovery/);
    writeFileSync(join(root,'state','statement-journal-v1.json'),preserved);expect(canonical.recoverCanonicalTransaction()?.committed).toBe(true);
  });
  it.each(['after_journal','after_json','after_commit'] as const)('recovers actual child-process termination at %s without losing the prior state',phase=>{
    db.closeDb();const code=`const db=await import('./src/storage/db.ts');db.getDb();const json=await import('./src/storage/json-store.ts');const canonical=await import('./src/storage/canonical-transaction.ts');const before=json.loadState();const after=structuredClone(before);after.documents.set('SYN-D1',${JSON.stringify(supplier())});canonical.commitCanonicalState(before,after,'synthetic-child',{onPhase(p){if(p===${JSON.stringify(phase)})process.exit(86)}});process.exit(87);`;
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env},encoding:'utf8',windowsHide:true,timeout:15000});
    expect(result.status,result.stderr).toBe(86);expect(canonical.canonicalJournalPending()).toBe(true);
    const recovered=canonical.recoverCanonicalTransaction();const committed=phase==='after_commit';expect(recovered?.committed).toBe(committed);
    expect(count('documents')).toBe(committed?1:0);expect(count('audit_events')).toBe(committed?1:0);expect(json.loadState()?.documents.size).toBe(committed?1:0);
    expect(canonical.canonicalJournalPending()).toBe(false);
  },20000);
});
