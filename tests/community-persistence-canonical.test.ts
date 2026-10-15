import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { MatchingState } from '../src/core/types.js';

let root:string,state:MatchingState,db:typeof import('../src/storage/db.js'),json:typeof import('../src/storage/json-store.js'),atomic:typeof import('../src/storage/canonical-transaction.js');
let backup:typeof import('../src/community/persistence/backup.js'),restore:typeof import('../src/community/persistence/restore.js');
let documents:import('../src/community/documents/service.js').CommunityDocumentService;
const owner={subject:'synthetic-owner',workspace_id:'synthetic-workspace'};
const exclusive=async<T>(operation:()=>Promise<T>)=>operation();
const table=Buffer.from('source_id;invoice_number;supplier_name;document_date;total_amount;currency_code;net_amount;vat_amount\nSYN-I1;SYN-INVOICE-1;Synthetic supplier;2026-01-12;12,50;EUR;10,00;2,50');
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const oldRoot=process.env.MATCHING_RUNTIME_ROOT,oldMode=process.env.MATCHING_RUNTIME_MODE;
beforeEach(async()=>{
  root=mkdtempSync(join(tmpdir(),'matching-backup-canonical-synthetic-'));
  process.env.MATCHING_RUNTIME_ROOT=root;process.env.MATCHING_RUNTIME_MODE='external-runtime-root';vi.resetModules();
  db=await import('../src/storage/db.js');db.getDb();json=await import('../src/storage/json-store.js');atomic=await import('../src/storage/canonical-transaction.js');
  backup=await import('../src/community/persistence/backup.js');restore=await import('../src/community/persistence/restore.js');
  state=json.createEmptyState('SYNTHETIC_CANONICAL_BACKUP');json.saveState(state);atomic.initializeCanonicalState(state);
  const {CommunityDocumentService}=await import('../src/community/documents/service.js');
  documents=new CommunityDocumentService({root:join(root,'documents'),getState:()=>state,persistAndActivate:(before,next,actor)=>{state=atomic.commitCanonicalState(before,next,actor);}});
});
afterEach(()=>{db?.closeDb();if(oldRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=oldRoot;if(oldMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=oldMode;rmSync(root,{force:true,recursive:true,maxRetries:10,retryDelay:100});vi.resetModules();});
async function invoiceAndPayment(){
  const uploaded=await documents.importTable(owner,table,'synthetic-invoices.csv','invoice');const document=uploaded.records[0].id;
  const next=structuredClone(state);next.transactions.set('SYN-T1',{transaction_id:'SYN-T1',source_system:'sparkasse',source_account_id:'SYN-A',source_row_ref:'SYN-T1',posting_at:'2026-01-12',amount_minor:-1250,currency_code:'EUR',description_raw:'Synthetic invoice payment',tags:[],meta:{}});
  state=atomic.commitCanonicalState(state,next,owner.subject);
  const{acceptAllocations}=await import('../src/community/accounting/ledger.js');
  state=atomic.commitCanonicalState(state,acceptAllocations(state,{revision:0,evidence_ref:'SYNTHETIC-PARTIAL',allocations:[{kind:'payment',transaction_id:'SYN-T1',document_id:document,transaction_amount_minor:-500,document_amount_minor:500}]},owner.subject),owner.subject);
  return document;
}

describe('complete canonical document and allocation backup lifecycle',()=>{
  it('backs up SQL4/JSON2, exact source rows, partial allocations and content-addressed invoice evidence',async()=>{
    const id=await invoiceAndPayment();const before=json.serializeCommunityState(state);
    const generated=await backup.createCommunityBackup(root,exclusive);const bytes=readFileSync(generated.path);const inspected=backup.inspectBackupBytes(bytes);
    expect(inspected.manifest).toMatchObject({version:2,sqlite_version:4,json_version:2,financial:{counts:{transactions:1,documents:1,match_groups:0,audit_events:3},totals_minor_by_currency:{EUR:-1250}}});
    const attachment=state.documents.get(id)!.meta.attachment_path as string;
    expect(inspected.files.get('documents/'+attachment)).toEqual(table);expect(inspected.files.has('documents/document-index-v1.json')).toBe(true);
    expect(JSON.parse(inspected.files.get('state/state.json')!.toString()).accounting.allocations).toHaveLength(1);
    expect([...inspected.files.keys()].some(name=>/identity|vault|credential|confirmation/.test(name))).toBe(false);
    expect(json.serializeCommunityState(state)).toBe(before);
    const stage=await restore.stageCommunityRestore(root,bytes,exclusive);
    await restore.activateCommunityRestore(root,stage.id,stage.fingerprint,exclusive,async change=>{db.closeDb();change();db.getDb();state=json.loadState()!;atomic.initializeCanonicalState(state);});
    expect(json.serializeCommunityState(state)).toBe(before);expect((await documents.download(owner,id)).buffer).toEqual(table);
    expect(state.accounting?.allocations[0].document_amount_minor).toBe(500);
  });
  it('rejects tampered per-document SQL values even when transaction counts and totals are unchanged',async()=>{
    const id=await invoiceAndPayment();db.getDb().prepare('UPDATE documents SET supplier_name=? WHERE document_id=?').run('FORGED',id);
    await expect(backup.createCommunityBackup(root,exclusive)).rejects.toThrow(/documents disagree/);
    expect(state.documents.get(id)?.supplier_name).toBe('Synthetic supplier');
  });
  it('rejects orphan/changed managed blobs and never resets a valid index on missing evidence',async()=>{
    const id=await invoiceAndPayment();const index=readFileSync(join(root,'documents','document-index-v1.json'));
    const file=join(root,'documents',state.documents.get(id)!.meta.attachment_path as string);writeFileSync(file,'corrupted synthetic blob');
    await expect(documents.download(owner,id)).rejects.toThrow();await expect(backup.createCommunityBackup(root,exclusive)).rejects.toThrow(/hash|size/);
    expect(readFileSync(join(root,'documents','document-index-v1.json'))).toEqual(index);
  });
  it('keeps accepted partial-payment evidence from being archived',async()=>{
    const id=await invoiceAndPayment();await expect(documents.disposition(owner,id,'archive')).rejects.toThrow(/Accepted match evidence/);
    expect((await documents.get(owner,id)).status).toBe('confirmed');
  });
  it('archives and restores an unallocated confirmed invoice through the canonical transaction',async()=>{
    const uploaded=await documents.importTable(owner,table,'synthetic-invoices.csv','invoice');const id=uploaded.records[0].id;
    await documents.disposition(owner,id,'archive');expect(state.documents.get(id)?.meta.accounting_status).toBe('cancelled');
    expect(json.loadState()?.documents.get(id)?.meta.document_review_status).toBe('archived');
    await documents.disposition(owner,id,'restore');expect(state.documents.get(id)?.meta.accounting_status).toBeUndefined();
    expect((await documents.get(owner,id)).status).toBe('confirmed');
  });
  it('refuses a false-success activation callback and preserves the prior dataset',async()=>{
    await invoiceAndPayment();const before=readFileSync(join(root,'state','state.json'));const archive=await backup.createCommunityBackup(root,exclusive);const stage=await restore.stageCommunityRestore(root,readFileSync(archive.path),exclusive);
    await expect(restore.activateCommunityRestore(root,stage.id,stage.fingerprint,exclusive,async()=>{})).rejects.toThrow(/not performed/);
    expect(readFileSync(join(root,'state','state.json'))).toEqual(before);expect(existsSync(join(root,'.restore-operation-v1.json'))).toBe(false);
  });
  it('fails closed on malformed restore journals and linked directories before changing any source',async()=>{
    await invoiceAndPayment();const before=readFileSync(join(root,'state','state.json'));const journal=join(root,'.restore-operation-v1.json');
    writeFileSync(journal,JSON.stringify({format:'matching-community-restore-operation-v1',id:'00000000-0000-4000-8000-000000000000',existed:['../outside']}));
    expect(()=>restore.recoverInterruptedRestore(root)).toThrow(/Invalid/);expect(readFileSync(join(root,'state','state.json'))).toEqual(before);rmSync(journal);
    const other=join(root,'synthetic-link-target');mkdirSync(other);const previous=join(root,'.restore-previous-00000000-0000-4000-8000-000000000000');symlinkSync(other,previous,process.platform==='win32'?'junction':'dir');
    writeFileSync(journal,JSON.stringify({format:'matching-community-restore-operation-v1',id:'00000000-0000-4000-8000-000000000000',existed:['database','state','documents']}));
    expect(()=>restore.recoverInterruptedRestore(root)).toThrow(/link/);expect(readFileSync(join(root,'state','state.json'))).toEqual(before);
  });
  it('rolls back an actual process termination after the restore directory cutover',async()=>{
    await invoiceAndPayment();const archived=await backup.createCommunityBackup(root,exclusive);const stage=await restore.stageCommunityRestore(root,readFileSync(archived.path),exclusive);
    const original=readFileSync(join(root,'state','state.json'));db.closeDb();
    const script=`const restore=await import('./src/community/persistence/restore.ts');await restore.activateCommunityRestore(${JSON.stringify(root)},${JSON.stringify(stage.id)},${JSON.stringify(stage.fingerprint)},async fn=>fn(),async change=>{change();process.exit(86)});process.exit(87);`;
    // Closing the live database checkpoints WAL and invalidates an earlier raw
    // target fingerprint. Re-stage with the stopped runtime before the child.
    const stoppedStage=await restore.stageCommunityRestore(root,readFileSync(archived.path),exclusive);
    const corrected=script.replaceAll(stage.id,stoppedStage.id).replaceAll(stage.fingerprint,stoppedStage.fingerprint);
    const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',corrected],{cwd:process.cwd(),env:{...process.env},encoding:'utf8',windowsHide:true,timeout:15000});
    expect(child.status,child.stderr).toBe(86);expect(existsSync(join(root,'.restore-operation-v1.json'))).toBe(true);
    expect(restore.recoverInterruptedRestore(root)).toBe(true);db.getDb();expect(readFileSync(join(root,'state','state.json'))).toEqual(original);
    expect(json.loadState()?.accounting?.allocations).toHaveLength(1);expect(existsSync(join(root,'.restore-operation-v1.json'))).toBe(false);
  },25000);
});
