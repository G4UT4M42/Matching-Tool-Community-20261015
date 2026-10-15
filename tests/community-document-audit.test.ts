import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import PDFDocument from 'pdfkit';
import type {MatchingState} from '../src/core/types.js';
import {CommunityDocumentService} from '../src/community/documents/service.js';
import {recoverAuditedDocumentReviews} from '../src/community/documents/review-audit.js';

const owner={subject:'SYNTHETIC-DOCUMENT-OWNER',workspace_id:'SYNTHETIC-DOCUMENT-WORKSPACE'};
const reviewer={...owner,subject:'SYNTHETIC-DOCUMENT-REVIEWER'};
const fields={invoice_number:'SYN-INV-1',supplier_name:'Synthetic supplier',document_date:'2026-10-15',total_amount:'120.00',net_amount:'100.00',vat_amount:'20.00',currency_code:'EUR'};
const originalRoot=process.env.MATCHING_RUNTIME_ROOT,originalMode=process.env.MATCHING_RUNTIME_MODE;
let root:string,state:MatchingState,db:typeof import('../src/storage/db.js'),json:typeof import('../src/storage/json-store.js'),canonical:typeof import('../src/storage/canonical-transaction.js'),service:CommunityDocumentService;
let failCommit=false;
async function pdf(text='Synthetic original invoice'):Promise<Buffer>{const doc=new PDFDocument(),parts:Buffer[]=[];doc.on('data',part=>parts.push(part));const result=new Promise<Buffer>(ok=>doc.on('end',()=>ok(Buffer.concat(parts))));doc.text(text);doc.end();return result;}
function fresh(){return new CommunityDocumentService({root:join(root,'documents'),getState:()=>state,persistAndActivate:async(expected,next,actor)=>{if(failCommit)throw Error('SYNTHETIC_AUDIT_FAILURE');state=canonical.commitCanonicalState(expected,next,actor);}});}
function restart(){db.closeDb();db.getDb();state=json.loadState()!;canonical.initializeCanonicalState(state);service=fresh();}
function failIndex(){return vi.spyOn(service as unknown as {writeIndex:(index:unknown)=>Promise<void>},'writeIndex').mockRejectedValueOnce(Error('SYNTHETIC_INDEX_INTERRUPTION'));}
const operations=()=>state.audit_events.filter(event=>event.after?.document_review_version===1).map(event=>event.after!.operation);
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),'matching-document-audit-synthetic-'));process.env.MATCHING_RUNTIME_ROOT=root;process.env.MATCHING_RUNTIME_MODE='external-runtime-root';vi.resetModules();
 db=await import('../src/storage/db.js');db.getDb();json=await import('../src/storage/json-store.js');canonical=await import('../src/storage/canonical-transaction.js');
 state=json.createEmptyState('SYNTHETIC_DOCUMENT_AUDIT');json.saveState(state);canonical.initializeCanonicalState(state);failCommit=false;service=fresh();
});
afterEach(()=>{vi.restoreAllMocks();db?.closeDb();if(originalRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=originalRoot;if(originalMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=originalMode;rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});vi.resetModules();});

describe('durable append-only document review audit',()=>{
 it('records before/after values and actors for review dispositions without creating financial rows',async()=>{
  const bytes=await pdf(),{record}=await service.upload(owner,bytes,'original.pdf','spotify:manual-claim');
  await service.correct(reviewer,record.id,fields);await service.disposition(reviewer,record.id,'archive');await service.disposition(reviewer,record.id,'restore');await service.disposition(reviewer,record.id,'reject');
  expect(state.documents.size).toBe(0);expect(db.getDb().prepare('SELECT count(*) FROM documents').pluck().get()).toBe(0);
  expect(operations()).toEqual(['uploaded','corrected','archive','restore','reject']);
  const correction=state.audit_events[1];expect(correction.actor_id).toBe(reviewer.subject);expect(correction.before).toMatchObject({review:{status:'review',hash:record.hash}});expect(correction.after).toMatchObject({review:{fields:{total_amount_minor:12000,net_amount_minor:10000,vat_amount_minor:2000}}});
  expect(db.getDb().prepare('SELECT count(*) FROM audit_events').pluck().get()).toBe(5);
  const committed=JSON.stringify(state.audit_events);restart();unlinkSync(join(root,'documents','document-index-v1.json'));
  const recovered=await service.get(owner,record.id);expect(recovered.status).toBe('rejected');expect(recovered.fields.total_amount_minor).toBe(12000);expect(recovered.history.map(entry=>entry.action)).toEqual(operations());expect(recovered.source_refs).toEqual([{source_id:'spotify:manual-claim',kind:'user-supplied'}]);
  expect((await service.download(owner,record.id)).buffer.equals(bytes)).toBe(true);expect(JSON.stringify(state.audit_events)).toBe(committed);
 });
 it('recovers committed upload and correction after index interruption and retries without duplicate events',async()=>{
  const bytes=await pdf();failIndex();await expect(service.upload(owner,bytes,'original.pdf')).rejects.toThrow('SYNTHETIC_INDEX_INTERRUPTION');
  expect(state.documents.size).toBe(0);expect(operations()).toEqual(['uploaded']);restart();
  const retry=await service.upload(owner,bytes,'another-name.pdf');expect(retry.duplicate).toBe(true);expect(retry.record.filename).toBe('original.pdf');expect(operations()).toEqual(['uploaded']);
  failIndex();await expect(service.correct(reviewer,retry.record.id,fields)).rejects.toThrow('SYNTHETIC_INDEX_INTERRUPTION');restart();
  const corrected=await service.correct(reviewer,retry.record.id,fields);expect(corrected.fields.total_amount_minor).toBe(12000);expect(operations()).toEqual(['uploaded','corrected']);expect(state.documents.size).toBe(0);
  expect(corrected.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
 });
 it('recovers confirmation and signed credit amounts and archives/restores them atomically',async()=>{
  const bytes=await pdf('Synthetic credit note'),{record}=await service.upload(owner,bytes,'credit.pdf');
  await service.correct(reviewer,record.id,{...fields,document_type:'credit_note',total_amount:'-0.30',net_amount:'-0.25',vat_amount:'-0.05'});
  failIndex();await expect(service.confirm(reviewer,record.id)).rejects.toThrow('SYNTHETIC_INDEX_INTERRUPTION');restart();
  expect((await service.confirm(reviewer,record.id)).status).toBe('confirmed');expect(operations()).toEqual(['uploaded','corrected','confirmed']);expect(state.documents.get(record.id)).toMatchObject({total_amount_minor:-30,vat_amount_minor:-5,meta:{document_type:'credit_note',net_amount_minor:-25,settlement_convention:'payable-face-v1'}});
  for(const action of ['archive','restore'] as const){failIndex();await expect(service.disposition(reviewer,record.id,action)).rejects.toThrow('SYNTHETIC_INDEX_INTERRUPTION');restart();await service.disposition(reviewer,record.id,action);}
  expect(operations()).toEqual(['uploaded','corrected','confirmed','archive','restore']);expect(state.documents.get(record.id)?.meta.accounting_status).toBeUndefined();expect((await service.download(owner,record.id)).buffer.equals(bytes)).toBe(true);
 });
 it('does not publish an unaudited review change when canonical audit persistence fails',async()=>{
  const bytes=await pdf();failCommit=true;await expect(service.upload(owner,bytes,'failure.pdf')).rejects.toThrow('SYNTHETIC_AUDIT_FAILURE');expect(await service.list(owner)).toEqual([]);expect(state.audit_events).toHaveLength(0);
  failCommit=false;const {record}=await service.upload(owner,bytes,'failure.pdf');const before=await service.get(owner,record.id),audit=JSON.stringify(state.audit_events);failCommit=true;
  await expect(service.correct(reviewer,record.id,fields)).rejects.toThrow('SYNTHETIC_AUDIT_FAILURE');await expect(service.disposition(reviewer,record.id,'reject')).rejects.toThrow('SYNTHETIC_AUDIT_FAILURE');
  expect(await service.get(owner,record.id)).toEqual(before);expect(JSON.stringify(state.audit_events)).toBe(audit);expect(state.documents.size).toBe(0);
 });
 it('preserves immutable canonical evidence on observed-source failure and recovers successful observations',async()=>{
  const bytes=await pdf(),{record}=await service.upload(owner,bytes,'original.pdf');await service.correct(owner,record.id,fields);await service.confirm(owner,record.id);const before=JSON.stringify(state.documents.get(record.id)),audit=JSON.stringify(state.audit_events);
  failCommit=true;await expect(service.upload(owner,bytes,'portal.pdf','portal:synthetic','invoice-bot')).rejects.toThrow('SYNTHETIC_AUDIT_FAILURE');expect(JSON.stringify(state.documents.get(record.id))).toBe(before);expect(JSON.stringify(state.audit_events)).toBe(audit);
  failCommit=false;failIndex();await expect(service.upload(owner,bytes,'portal.pdf','portal:synthetic','invoice-bot')).rejects.toThrow('SYNTHETIC_INDEX_INTERRUPTION');restart();await service.upload(owner,bytes,'portal.pdf','portal:synthetic','invoice-bot');
  expect(operations()).toEqual(['uploaded','corrected','confirmed','source_observed:invoice-bot']);expect((await service.get(owner,record.id)).source_refs).toEqual([{source_id:'portal:synthetic',kind:'invoice-bot'}]);expect(state.documents.get(record.id)?.source_document_ref).toBe(fields.invoice_number);
 });
 it('audits table imports atomically, recovers the original table and rejects tampered recovery bytes',async()=>{
  const bytes=Buffer.from('source_id,invoice_number,supplier_name,document_date,total_amount,currency_code\nSYN-TABLE-1,SYN-INV-1,Synthetic supplier,2026-10-15,120.00,EUR\n');failIndex();
  await expect(service.importTable(owner,bytes,'original.csv','invoice')).rejects.toThrow('SYNTHETIC_INDEX_INTERRUPTION');restart();expect((await service.importTable(owner,bytes,'original.csv','invoice')).duplicates).toBe(1);expect(operations()).toEqual(['imported']);
  const record=(await service.list(owner))[0];expect((await service.download(owner,record.id)).buffer.equals(bytes)).toBe(true);
  writeFileSync(join(root,'documents','attachments',createHash('sha256').update(owner.workspace_id).digest('hex'),record.hash),Buffer.alloc(bytes.length,0));
  await expect(service.list(owner)).rejects.toMatchObject({code:'UNSAFE_STORAGE'});
 });
 it('rejects malformed audit versions, identity changes and provenance removal without mutating history',async()=>{
  const {record}=await service.upload(owner,await pdf(),'original.pdf','manual:synthetic');await service.correct(owner,record.id,fields);const original=JSON.stringify(state.audit_events);
  for(const change of [(copy:MatchingState)=>{copy.audit_events[0].after!.document_review_version=2;},(copy:MatchingState)=>{(copy.audit_events[1].after!.review as Record<string,unknown>).hash='f'.repeat(64);},(copy:MatchingState)=>{(copy.audit_events[1].after!.review as Record<string,unknown>).source_refs=[];}]){const copy=structuredClone(state);change(copy);expect(()=>recoverAuditedDocumentReviews(copy.audit_events)).toThrow();}
  expect(recoverAuditedDocumentReviews(state.audit_events)[0].id).toBe(record.id);expect(JSON.stringify(state.audit_events)).toBe(original);
 });
 it('adds a baseline for historical canonical evidence without inventing its missing original owner',async()=>{
  const bytes=await pdf('Synthetic historical evidence'),hash=createHash('sha256').update(bytes).digest('hex'),workspaceHash=createHash('sha256').update(owner.workspace_id).digest('hex');
  const dir=join(root,'documents','attachments',workspaceHash);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,hash),bytes);
  const next=structuredClone(state);next.documents.set('SYN-HISTORICAL-DOC',{document_id:'SYN-HISTORICAL-DOC',source_system:'invoice_file',source_document_ref:'SYN-HISTORICAL-REF',captured_at:'2026-10-14T00:00:00.000Z',document_date:'2026-10-14',total_amount_minor:12000,currency_code:'EUR',file_hash:hash,filename:'historical.pdf',meta:{workspace_id:owner.workspace_id,attachment_path:'attachments/'+workspaceHash+'/'+hash}});
  state=canonical.commitCanonicalState(state,next,owner.subject);const original=JSON.stringify(state.documents.get('SYN-HISTORICAL-DOC'));
  expect((await service.disposition(reviewer,'SYN-HISTORICAL-DOC','archive')).owner_subject).toBe('');restart();unlinkSync(join(root,'documents','document-index-v1.json'));
  const restored=await service.disposition(reviewer,'SYN-HISTORICAL-DOC','restore');expect(restored.owner_subject).toBe('');expect(restored.history[0].action).toBe('index_recovered_from_canonical_state');expect(restored.history.map(entry=>entry.action).slice(1)).toEqual(['archive','restore']);
  const before=JSON.parse(original);expect(state.documents.get('SYN-HISTORICAL-DOC')).toEqual({...before,meta:{...before.meta,document_review_status:'confirmed'}});
 });
});
