import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import PDFDocument from 'pdfkit';
import type {MatchingState} from '../src/core/types.js';

const owner={subject:'SYNTHETIC-REVIEW-BACKUP-OWNER',workspace_id:'SYNTHETIC-REVIEW-BACKUP-WORKSPACE'};
const reviewer={...owner,subject:'SYNTHETIC-REVIEW-BACKUP-REVIEWER'};
const fields={document_type:'credit_note',invoice_number:'SYN-CREDIT-BACKUP-1',supplier_name:'Synthetic backup supplier',document_date:'2026-10-15',total_amount:'-0.30',net_amount:'-0.25',vat_amount:'-0.05',currency_code:'EUR',payment_reference:'SYNTHETIC-BACKUP-REFERENCE'};
const exclusive=async<T>(work:()=>Promise<T>)=>work();
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const originalRoot=process.env.MATCHING_RUNTIME_ROOT,originalMode=process.env.MATCHING_RUNTIME_MODE;
let root:string,state:MatchingState,db:typeof import('../src/storage/db.js'),json:typeof import('../src/storage/json-store.js'),canonical:typeof import('../src/storage/canonical-transaction.js');
let backup:typeof import('../src/community/persistence/backup.js'),restore:typeof import('../src/community/persistence/restore.js'),zip:typeof import('../src/community/persistence/zip.js');
let documents:typeof import('../src/community/documents/service.js'),service:import('../src/community/documents/service.js').CommunityDocumentService;
async function originalPdf(){const doc=new PDFDocument(),parts:Buffer[]=[];doc.on('data',part=>parts.push(part));const result=new Promise<Buffer>(ok=>doc.on('end',()=>ok(Buffer.concat(parts))));doc.text('Synthetic credit-note original. Manual review is required.');doc.end();return result;}
function freshService(){return new documents.CommunityDocumentService({root:join(root,'documents'),getState:()=>state,persistAndActivate:(before,next,actor)=>{state=canonical.commitCanonicalState(before,next,actor);}});}
const sqlAudit=()=>db.getDb().prepare('SELECT * FROM audit_events ORDER BY audit_id').all();
async function pendingReview(){
 const bytes=await originalPdf(),uploaded=await service.upload(owner,bytes,'synthetic-original.pdf','synthetic:manual-source');
 const record=await service.correct(reviewer,uploaded.record.id,fields);
 const blobName='documents/attachments/'+sha(owner.workspace_id)+'/'+record.hash,blobPath=join(root,...blobName.split('/'));
 expect(state.documents.size).toBe(0);expect(state.audit_events).toHaveLength(2);unlinkSync(join(root,'documents','document-index-v1.json'));
 return{bytes,record,blobName,blobPath};
}
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),'matching-review-backup-synthetic-'));process.env.MATCHING_RUNTIME_ROOT=root;process.env.MATCHING_RUNTIME_MODE='external-runtime-root';vi.resetModules();
 db=await import('../src/storage/db.js');db.getDb();json=await import('../src/storage/json-store.js');canonical=await import('../src/storage/canonical-transaction.js');backup=await import('../src/community/persistence/backup.js');restore=await import('../src/community/persistence/restore.js');zip=await import('../src/community/persistence/zip.js');documents=await import('../src/community/documents/service.js');
 state=json.createEmptyState('SYNTHETIC_REVIEW_BACKUP');json.saveState(state);canonical.initializeCanonicalState(state);service=freshService();
});
afterEach(()=>{vi.restoreAllMocks();db?.closeDb();if(originalRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=originalRoot;if(originalMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=originalMode;rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});vi.resetModules();});

describe('canonical unconfirmed-review evidence backup without a derived index',()=>{
 it('backs up and restores the audited original, exact fields/history and SQL/JSON audit without creating a financial document',async()=>{
  const {bytes,record,blobName,blobPath}=await pendingReview(),indexPath=join(root,'documents','document-index-v1.json');
  const jsonBefore=readFileSync(join(root,'state','state.json')),auditBefore=structuredClone(state.audit_events),sqlBefore=sqlAudit();
  // Creating the backup must not depend on an incidental UI/read reconstruction.
  const list=vi.spyOn(service,'list').mockRejectedValue(Error('UNEXPECTED_REVIEW_READ'));
  const get=vi.spyOn(service,'get').mockRejectedValue(Error('UNEXPECTED_REVIEW_READ'));
  const created=await backup.createCommunityBackup(root,exclusive),archive=readFileSync(created.path),inspected=backup.inspectBackupBytes(archive);
  expect(list).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();expect(existsSync(indexPath)).toBe(false);
  expect(inspected.files.has('documents/document-index-v1.json')).toBe(false);expect(inspected.files.get(blobName)).toEqual(bytes);expect(created.manifest.files[blobName]).toEqual({bytes:bytes.length,sha256:sha(bytes)});expect(created.manifest.financial.counts).toMatchObject({documents:0,audit_events:2});
  const decoded=zip.decodeZip(archive),manifest=JSON.parse(decoded.get('manifest.json')!.toString());decoded.delete(blobName);delete manifest.files[blobName];decoded.set('manifest.json',Buffer.from(JSON.stringify(manifest)));
  const incomplete=zip.encodeZip(decoded);expect(()=>backup.inspectBackupBytes(incomplete)).toThrow(/Missing or altered referenced document/);await expect(restore.stageCommunityRestore(root,incomplete,exclusive)).rejects.toThrow(/Missing or altered referenced document/);
  expect(readFileSync(join(root,'state','state.json'))).toEqual(jsonBefore);expect(readFileSync(blobPath)).toEqual(bytes);
  unlinkSync(blobPath);db.closeDb();
  const stage=await restore.stageCommunityRestore(root,archive,exclusive);
  await restore.activateCommunityRestore(root,stage.id,stage.fingerprint,exclusive,async change=>{change();});
  db.getDb();state=json.loadState()!;canonical.initializeCanonicalState(state);service=freshService();
  const recovered=await service.get(owner,record.id);expect(recovered).toEqual(record);expect(recovered.status).toBe('review');expect(recovered.fields).toMatchObject({document_type:'credit_note',total_amount_minor:-30,net_amount_minor:-25,vat_amount_minor:-5});expect(recovered.source_refs).toEqual([{source_id:'synthetic:manual-source',kind:'user-supplied'}]);
  expect((await service.download(owner,record.id)).buffer).toEqual(bytes);expect(recovered.hash).toBe(sha(bytes));expect(state.documents.size).toBe(0);expect(db.getDb().prepare('SELECT count(*) FROM documents').pluck().get()).toBe(0);
  expect(readFileSync(join(root,'state','state.json'))).toEqual(jsonBefore);expect(state.audit_events).toEqual(auditBefore);expect(sqlAudit()).toEqual(sqlBefore);
  expect(JSON.parse(json.serializeCommunityState(state))).toEqual(JSON.parse(jsonBefore.toString()));
 });
 it('invalidates staged restore confirmation if an audited review original changes while its index is absent',async()=>{
  const {bytes,blobPath}=await pendingReview();const created=await backup.createCommunityBackup(root,exclusive),archive=readFileSync(created.path);db.closeDb();
  const stage=await restore.stageCommunityRestore(root,archive,exclusive),changed=Buffer.from(bytes);changed[changed.length-1]^=1;writeFileSync(blobPath,changed);
  let activated=false;await expect(restore.activateCommunityRestore(root,stage.id,stage.fingerprint,exclusive,async change=>{activated=true;change();})).rejects.toThrow(/stale/);
  expect(activated).toBe(false);expect(readFileSync(blobPath)).toEqual(changed);
 });
});
