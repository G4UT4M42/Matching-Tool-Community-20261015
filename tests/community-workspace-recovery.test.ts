import {afterEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createEmptyState,serializeCommunityState} from '../src/storage/json-store.js';
import type {MatchingState} from '../src/core/types.js';
import {CommunityDocumentService,type DocumentRecord,type Principal} from '../src/community/documents/service.js';
import {snapshot} from '../src/community/documents/review-audit.js';
import {recordAudit} from '../src/observability/audit.js';
import {inspectWorkspaceRecovery,prepareWorkspaceRecovery,workspaceRecoveryDocumentIds,workspaceRecoveryPaymentWorkspaceIds} from '../src/community/persistence/workspace-recovery.js';
import {currentPaymentInvoices,provedPaymentReconciliation} from '../src/community/payments/community-evidence.js';
import {CommunityPaymentService} from '../src/community/payments/service.js';
import {upCommunityPayments003} from '../src/migrations/003-community-payments.js';
import {localFakeAdapters,LOCAL_FAKE_BANK_MARKER} from '../src/community/banking/mock.js';
import type {Principal as PaymentPrincipal} from '../src/community/payments/types.js';
import {candidate,itemFromCandidate} from '../src/community/payments/validation.js';

const source:Principal={subject:'synthetic-original-owner',workspace_id:'synthetic-original-workspace'};
const target:Principal={subject:'synthetic-recovery-owner',workspace_id:'synthetic-recovery-workspace'};
const csv=Buffer.from('source_id,invoice_number,supplier_name,document_date,total_amount,currency_code,net_amount,vat_amount\nORIGINAL-1,INV-1,Fictional Seller,2026-10-14,120.00,EUR,100.00,20.00\n');
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const dirs:string[]=[];
afterEach(async()=>{for(const root of dirs.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'community-recovery-test-'));dirs.push(root);
  let state=createEmptyState('SYNTHETIC-RECOVERY');
  const service=(workspaceId=target.workspace_id)=>new CommunityDocumentService({root,workspaceId,getState:()=>state,persistAndActivate:(before,next)=>{if(before!==state)throw Error('stale');state=next;}});
  const imported=await service(source.workspace_id).importTable(source,csv,'synthetic-invoices.csv','invoice');
  const id=imported.records[0].id;
  return{root,id,service,get state(){return state;},set state(next:MatchingState){state=next;},async adopt(){const review=await inspectWorkspaceRecovery(state,root,target);state=await prepareWorkspaceRecovery(state,root,target,review.fingerprint);return review;}};
}
async function addReview(f:Awaited<ReturnType<typeof fixture>>){
  const bytes=Buffer.from('Synthetic unconfirmed original receipt; no external service.'),hash=sha(bytes),dir=join(f.root,'attachments',sha(source.workspace_id));await mkdir(dir,{recursive:true});await writeFile(join(dir,hash),bytes);
  const record:DocumentRecord={id:'synthetic-unconfirmed',workspace_id:source.workspace_id,owner_subject:source.subject,filename:'synthetic-review.pdf',hash,mime:'application/pdf',bytes:bytes.length,pages:1,status:'review',fields:{},recognition:{confidence:0,raw_text:'Synthetic original',warnings:[]},created_at:'2026-10-15T00:00:00Z',history:[{at:'2026-10-15T00:00:00Z',actor:source.subject,action:'uploaded'}]};
  recordAudit(f.state,'STATE_COMMITTED','Document',record.id,{actor_type:'user',actor_id:source.subject,after:{document_review_version:1,operation:'uploaded',review:snapshot(record),history_entry:record.history[0],baseline:{recognition:record.recognition,history:[]}},before:{review:null}});
  return{record,bytes};
}
async function paymentFixture(){
  const f=await fixture(),review=await addReview(f),service=f.service(source.workspace_id);
  await service.correct(source,review.record.id,{invoice_number:'SYNTHETIC-PAYMENT',supplier_name:'Fictional Seller',document_date:'2026-10-14',total_amount:'1.25',currency_code:'EUR',iban:'DE36'+'0'.repeat(18),payment_reference:'SYNTHETIC INVOICE',due_date:'2026-11-15'});
  await service.confirm(source,review.record.id);f.id=review.record.id;return f;
}
describe('explicit original-preserving workspace recovery',()=>{
  it('requires explicit adoption then preserves exact canonical/source/audit identities and original downloads',async()=>{
    const f=await fixture(),before=serializeCommunityState(f.state),original=f.state.documents.get(f.id)!;
    expect(await f.service().list(target)).toEqual([]);
    expect(currentPaymentInvoices(f.state,target.workspace_id)).toEqual([]);
    const review=await inspectWorkspaceRecovery(f.state,f.root,target);
    expect(review).toMatchObject({target_workspace_id:target.workspace_id,target_subject:target.subject,source_workspaces:[source.workspace_id],documents:[{document_id:f.id,source_workspace_id:source.workspace_id,hash:sha(csv),status:'confirmed'}]});
    expect(JSON.stringify(review)).not.toContain(f.root);
    expect(serializeCommunityState(f.state)).toBe(before);
    f.state=await prepareWorkspaceRecovery(f.state,f.root,target,review.fingerprint);
    const withoutGrant={...f.state,audit_events:f.state.audit_events.slice(0,-1)};
    expect(serializeCommunityState(withoutGrant)).toBe(before);
    expect(f.state.documents.get(f.id)).toBe(original);
    expect((await f.service().list(target)).map(r=>r.id)).toEqual([f.id]);
    expect((await f.service().download(target,f.id)).buffer.equals(csv)).toBe(true);
    expect(currentPaymentInvoices(f.state,target.workspace_id)[0]).toMatchObject({documentId:f.id,originalWorkspaceId:source.workspace_id,totalMinor:12000});
    expect((await inspectWorkspaceRecovery(f.state,f.root,target)).documents).toEqual([]);
    await expect(prepareWorkspaceRecovery(f.state,f.root,target,review.fingerprint)).rejects.toMatchObject({code:'STALE_REVIEW'});
    const empty=await inspectWorkspaceRecovery(f.state,f.root,target);
    await expect(prepareWorkspaceRecovery(f.state,f.root,target,empty.fingerprint)).rejects.toMatchObject({code:'NOTHING_TO_RECOVER'});
  });
  it('binds review to canonical changes, target owner/workspace, and every original byte',async()=>{
    const f=await fixture(),review=await inspectWorkspaceRecovery(f.state,f.root,target);
    await expect(prepareWorkspaceRecovery(f.state,f.root,{...target,subject:'another-owner'},review.fingerprint)).rejects.toMatchObject({code:'STALE_REVIEW'});
    await expect(prepareWorkspaceRecovery(f.state,f.root,{...target,workspace_id:'another-workspace'},review.fingerprint)).rejects.toMatchObject({code:'STALE_REVIEW'});
    recordAudit(f.state,'STATE_COMMITTED','Run','synthetic-change');
    await expect(prepareWorkspaceRecovery(f.state,f.root,target,review.fingerprint)).rejects.toMatchObject({code:'STALE_REVIEW'});
    const path=join(f.root,...String(f.state.documents.get(f.id)!.meta.attachment_path).split('/'));await writeFile(path,Buffer.alloc(csv.length,65));
    await expect(inspectWorkspaceRecovery(f.state,f.root,target)).rejects.toMatchObject({code:'ORIGINAL_UNAVAILABLE'});
  });
  it('grants receiving-workspace access with exact actor provenance, hash and immutable identity checks',async()=>{
    const f=await fixture();await f.adopt();
    const sameWorkspace={...target,subject:'another-workspace-user'};
    expect(workspaceRecoveryDocumentIds(f.state,sameWorkspace).size).toBe(0); // Optional actor filter is diagnostic only.
    expect((await f.service().get(sameWorkspace,f.id)).id).toBe(f.id);
    expect((await f.service().list(sameWorkspace)).map(record=>record.id)).toEqual([f.id]);
    expect((await inspectWorkspaceRecovery(f.state,f.root,sameWorkspace)).documents).toEqual([]);
    const foreign={...target,workspace_id:'another-workspace'};
    expect(workspaceRecoveryDocumentIds(f.state,foreign).size).toBe(0);await expect(f.service().get(foreign,f.id)).rejects.toMatchObject({code:'NOT_FOUND'});
    const altered=structuredClone(f.state);altered.documents.get(f.id)!.file_hash='a'.repeat(64);
    expect(workspaceRecoveryDocumentIds(altered,target).size).toBe(0);
    const malformed=structuredClone(f.state);(malformed.audit_events.at(-1)!.after!.documents as unknown[]).push({document_id:'*'});
    expect(()=>workspaceRecoveryDocumentIds(malformed,target)).toThrow('Invalid workspace recovery document scope');
    const forged=structuredClone(f.state);forged.audit_events.at(-1)!.actor_id='different-actor';expect(()=>workspaceRecoveryDocumentIds(forged,target)).toThrow('Invalid workspace recovery grant');
  });
  it('recovers unconfirmed audited reviews without an index and preserves source workspace through correction/confirmation',async()=>{
    const f=await fixture(),review=await addReview(f);await unlink(join(f.root,'document-index-v1.json'));
    const inspected=await f.adopt();expect(inspected.documents.find(doc=>doc.document_id===review.record.id)?.status).toBe('review');
    expect((await f.service().download(target,review.record.id)).buffer.equals(review.bytes)).toBe(true);
    const sourceSnapshot=structuredClone(f.state.audit_events);
    await f.service().correct(target,review.record.id,{invoice_number:'REVIEW-1',supplier_name:'Fictional Seller',document_date:'2026-10-14',total_amount:'1.25',currency_code:'EUR'});
    await f.service().confirm(target,review.record.id);
    const confirmed=f.state.documents.get(review.record.id)!;
    expect(confirmed.meta).toMatchObject({workspace_id:source.workspace_id,owner_subject:source.subject,attachment_path:'attachments/'+sha(source.workspace_id)+'/'+review.record.hash});
    expect(f.state.audit_events.slice(0,sourceSnapshot.length)).toEqual(sourceSnapshot);
    expect((await f.service().get(target,review.record.id)).history.at(-1)?.actor).toBe(target.subject);
    expect((await f.service().download(target,review.record.id)).buffer.equals(review.bytes)).toBe(true);
    expect(currentPaymentInvoices(f.state,target.workspace_id).map(e=>e.documentId)).toContain(review.record.id);
  });
  it('deduplicates exact recovered table rows, rejects changed values and preserves original economic/source IDs',async()=>{
    const f=await fixture();await f.adopt();const before=serializeCommunityState(f.state);
    expect(await f.service().importTable(target,csv,'synthetic-invoices.csv','invoice')).toMatchObject({imported:0,duplicates:1});
    expect(serializeCommunityState(f.state)).toBe(before);
    await expect(f.service().importTable(target,Buffer.from(csv.toString().replace('120.00','121.00').replace('20.00','21.00')),'synthetic-invoices.csv','invoice')).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    expect(f.state.documents.size).toBe(1);
    expect((await f.service(source.workspace_id).get(source,f.id)).workspace_id).toBe(source.workspace_id);
  });
  it('rejects ambiguous table namespaces from multiple explicitly recovered source workspaces',async()=>{
    const f=await fixture();await f.service('synthetic-second-source').importTable({...source,workspace_id:'synthetic-second-source'},csv,'synthetic.csv','invoice');await f.adopt();
    await expect(f.service().importTable(target,csv,'synthetic.csv','invoice')).rejects.toMatchObject({code:'SOURCE_CONFLICT'});expect(f.state.documents.size).toBe(2);
  });
  it('refuses unaudited foreign review cache and immutable cache/canonical conflicts',async()=>{
    const f=await fixture(),index=JSON.parse(await readFile(join(f.root,'document-index-v1.json'),'utf8'));
    index.records[0].filename='different.csv';await writeFile(join(f.root,'document-index-v1.json'),JSON.stringify(index));
    await expect(inspectWorkspaceRecovery(f.state,f.root,target)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    const g=await fixture(),unconfirmed=await addReview(g);const cached={version:1,records:[unconfirmed.record]};g.state.audit_events=g.state.audit_events.filter(e=>e.entity_id!==unconfirmed.record.id);await writeFile(join(g.root,'document-index-v1.json'),JSON.stringify(cached));
    await expect(inspectWorkspaceRecovery(g.state,g.root,target)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  });
  it('retains adoption when a historical confirmed original gains its first audited disposition baseline',async()=>{
    const f=await fixture();f.state.audit_events=[];
    await f.adopt();await f.service().disposition(target,f.id,'archive');
    expect((await f.service().get(target,f.id)).status).toBe('archived');
    expect(workspaceRecoveryDocumentIds(f.state,target).has(f.id)).toBe(true);
    await f.service().disposition(target,f.id,'restore');
    expect((await f.service().download(target,f.id)).buffer.equals(csv)).toBe(true);
  });
  it.each([
    ['iban','SYNTHETIC-CHANGED-IBAN'],['payment_reference','SYNTHETIC-CHANGED-REFERENCE'],['due_date','2026-12-01'],['document_type','credit_note'],['settlement_convention','signed-cashflow-v1'],
  ])('rejects audited original recovery when only canonical %s differs, before and after adoption',async(field,value)=>{
    const f=await paymentFixture(),initial=await inspectWorkspaceRecovery(f.state,f.root,target),before=structuredClone(f.state);
    expect(initial.documents.some(record=>record.document_id===f.id)).toBe(true);
    f.state.documents.get(f.id)!.meta[field]=value;
    await expect(inspectWorkspaceRecovery(f.state,f.root,target)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    await expect(prepareWorkspaceRecovery(f.state,f.root,target,initial.fingerprint)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    f.state=before;await f.adopt();f.state.documents.get(f.id)!.meta[field]=value;
    expect(workspaceRecoveryDocumentIds(f.state,{workspace_id:target.workspace_id}).has(f.id)).toBe(false);
    expect(currentPaymentInvoices(f.state,target.workspace_id).some(record=>record.documentId===f.id)).toBe(false);
  });
  it.each(['iban','payment_reference','due_date','document_type','settlement_convention'])('binds unaudited legacy %s in the exact grant identity',async field=>{
    const f=await paymentFixture();f.state.audit_events=[];await unlink(join(f.root,'document-index-v1.json'));
    await f.adopt();expect(workspaceRecoveryDocumentIds(f.state,target).has(f.id)).toBe(true);
    f.state.documents.get(f.id)!.meta[field]=field==='settlement_convention'?'signed-cashflow-v1':field==='document_type'?'credit_note':'SYNTHETIC-CHANGED';
    expect(workspaceRecoveryDocumentIds(f.state,target).has(f.id)).toBe(false);
  });
  it.each([['source_document_ref','SYNTHETIC-ALTERED-REF'],['captured_at','2026-10-16T00:00:00Z']])('rejects altered known-upload %s against the original review contract',async(field,value)=>{
    const f=await paymentFixture(),before=structuredClone(f.state);
    Object.assign(f.state.documents.get(f.id)!,{[field]:value});
    await expect(inspectWorkspaceRecovery(f.state,f.root,target)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    f.state=before;await f.adopt();Object.assign(f.state.documents.get(f.id)!,{[field]:value});
    expect(workspaceRecoveryDocumentIds(f.state,target).has(f.id)).toBe(false);
  });
  it('checks imported table source references while retaining separately generated capture timestamps',async()=>{
    const f=await fixture();f.state.documents.get(f.id)!.captured_at='2026-10-15T00:00:00Z';
    expect((await inspectWorkspaceRecovery(f.state,f.root,target)).documents.some(doc=>doc.document_id===f.id)).toBe(true);
    f.state.documents.get(f.id)!.source_document_ref='SYNTHETIC-ALTERED-ROW';
    await expect(inspectWorkspaceRecovery(f.state,f.root,target)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  });
  it('retains absent legacy signed-cashflow semantics and grants through mutable status/classification and baseline creation',async()=>{
    const f=await fixture();f.state.audit_events=[];await unlink(join(f.root,'document-index-v1.json'));
    const original=f.state.documents.get(f.id)!;delete original.meta.settlement_convention;delete original.meta.table_kind;
    original.total_amount_minor=-12000;original.vat_amount_minor=-2000;original.meta.net_amount_minor=-10000;
    const before=serializeCommunityState(f.state);await f.adopt();
    expect(serializeCommunityState({...f.state,audit_events:f.state.audit_events.slice(0,-1)})).toBe(before);
    expect(original.meta.settlement_convention).toBeUndefined();expect(currentPaymentInvoices(f.state,target.workspace_id)).toEqual([]);
    original.meta.tax_category='SYNTHETIC-CLASSIFICATION';original.meta.accounting_status='reviewed';
    expect(workspaceRecoveryDocumentIds(f.state,target).has(f.id)).toBe(true);
    await f.service().disposition(target,f.id,'archive');expect(workspaceRecoveryDocumentIds(f.state,target).has(f.id)).toBe(true);
    await f.service().disposition(target,f.id,'restore');expect(workspaceRecoveryDocumentIds(f.state,target).has(f.id)).toBe(true);
    expect(f.state.documents.get(f.id)!.meta.settlement_convention).toBeUndefined();
    const third={subject:'synthetic-third-owner',workspace_id:'synthetic-third-workspace'},review=await inspectWorkspaceRecovery(f.state,f.root,third);f.state=await prepareWorkspaceRecovery(f.state,f.root,third,review.fingerprint);
    expect(workspaceRecoveryDocumentIds(f.state,third).has(f.id)).toBe(true);
    f.state.documents.get(f.id)!.meta.settlement_convention='receivable-face-v1';
    expect(workspaceRecoveryDocumentIds(f.state,third).has(f.id)).toBe(false);
  });
  it('does not treat an unaudited cached imported history as an authoritative new payable workflow',async()=>{
    const f=await fixture();f.state.audit_events=[];f.state.documents.get(f.id)!.meta.settlement_convention='signed-cashflow-v1';
    await f.adopt();await f.service().disposition(target,f.id,'archive');
    expect(workspaceRecoveryDocumentIds(f.state,target).has(f.id)).toBe(true);
    await f.service().disposition(target,f.id,'restore');
    expect(f.state.documents.get(f.id)!.meta.settlement_convention).toBe('signed-cashflow-v1');
    expect(currentPaymentInvoices(f.state,target.workspace_id)).toEqual([]);
  });
  it('derives income direction from the immutable imported source ID instead of mutable table metadata',async()=>{
    const f=await fixture(),imported=await f.service(source.workspace_id).importTable(source,csv,'synthetic-income.csv','income'),id=imported.records[0].id;
    await f.adopt();expect(workspaceRecoveryDocumentIds(f.state,target).has(id)).toBe(true);
    expect(currentPaymentInvoices(f.state,target.workspace_id).some(invoice=>invoice.documentId===id)).toBe(false);
    f.state.documents.get(id)!.meta.table_kind='invoice';f.state.documents.get(id)!.meta.settlement_convention='payable-face-v1';
    expect(workspaceRecoveryDocumentIds(f.state,target).has(id)).toBe(false);
  });
  it('retains audited supplier credit-note signs without promoting them to payment candidates',async()=>{
    const f=await fixture(),review=await addReview(f),service=f.service(source.workspace_id);
    await service.correct(source,review.record.id,{document_type:'credit_note',invoice_number:'SYNTHETIC-CREDIT',supplier_name:'Fictional Seller',document_date:'2026-10-14',total_amount:'-1.25',currency_code:'EUR'});
    await service.confirm(source,review.record.id);await f.adopt();
    expect(workspaceRecoveryDocumentIds(f.state,target).has(review.record.id)).toBe(true);
    expect(f.state.documents.get(review.record.id)!.total_amount_minor).toBe(-125);
    expect(currentPaymentInvoices(f.state,target.workspace_id).some(invoice=>invoice.documentId===review.record.id)).toBe(false);
  });
  it('rejects an ambiguous historical implicit-payable convention instead of guessing a new direction',async()=>{
    const f=await fixture();f.state.audit_events=[];await unlink(join(f.root,'document-index-v1.json'));
    delete f.state.documents.get(f.id)!.meta.settlement_convention;
    await expect(inspectWorkspaceRecovery(f.state,f.root,target)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  });
  it('keeps old payment batches non-actionable and blocks a duplicate draft against unresolved original payments',async()=>{
    const f=await paymentFixture();
    const db=new Database(':memory:');try{
      upCommunityPayments003(db);const fake=localFakeAdapters(LOCAL_FAKE_BANK_MARKER);
      const p:PaymentPrincipal={...source,role:'owner',session_id:'synthetic-session',authenticated_at:'2026-10-15T00:00:00Z',permissions:['finance:read','payments:prepare']};
      const service=new CommunityPaymentService({db,adapter:fake.payment,authorize:()=>true,recentAuth:()=>true,csrf:()=>true,credentialResolver:{resolve:async()=>({synthetic:true})},accounting:{loadState:()=>f.state,persistAndActivate:()=>{},invoiceEvidence:currentPaymentInvoices,confirmedReconciliation:provedPaymentReconciliation}});
      const old=service.createDraft(p,[f.id],'DE36'+'0'.repeat(18),'Synthetic Debtor');
      // Model restored unresolved transport outcome using repository's guarded transition.
      service.repo.transition(p,old.id,old.revision,['draft'],'unknown','synthetic-restore-unknown');
      await f.adopt();const current={...p,subject:target.subject,workspace_id:target.workspace_id};
      expect(service.repo.get(old.id,current.workspace_id)).toBeNull();
      expect(service.candidates(current).find(candidate=>candidate.evidence.documentId===f.id)).toMatchObject({eligible:false,issues:['CANDIDATE_ALREADY_CREATED']});
      expect(()=>service.createDraft(current,[f.id],'DE36'+'0'.repeat(18),'Synthetic Debtor')).toThrow('CANDIDATE_REVIEW_REQUIRED');
      expect(fake.calls.submit).toBe(0);
      expect(provedPaymentReconciliation(f.state,target.workspace_id,{...old,status:'acknowledged'},'arbitrary')).toBe(false);
      expect(f.state.documents.get(f.id)!.meta.workspace_id).toBe(source.workspace_id);
    }finally{db.close();}
  });
  it('carries exact A-to-B-to-C payment history scopes and excludes wrong-hash historical grants',async()=>{
    const f=await paymentFixture();await f.adopt();const third={subject:'synthetic-third-owner',workspace_id:'synthetic-third-workspace'};
    const inspected=await inspectWorkspaceRecovery(f.state,f.root,third);f.state=await prepareWorkspaceRecovery(f.state,f.root,third,inspected.fingerprint);
    expect(workspaceRecoveryDocumentIds(f.state,third).has(f.id)).toBe(true);
    expect(workspaceRecoveryPaymentWorkspaceIds(f.state,f.id)).toEqual([source.workspace_id,target.workspace_id,third.workspace_id].sort());
    const wrong=structuredClone(f.state),grant=wrong.audit_events.find(e=>e.after?.workspace_recovery_version===1)!;
    (grant.after!.documents as Array<{document_id:string;hash:string}>).find(scope=>scope.document_id===f.id)!.hash='b'.repeat(64);
    expect(workspaceRecoveryPaymentWorkspaceIds(wrong,f.id)).toEqual([source.workspace_id,third.workspace_id].sort());
    const db=new Database(':memory:');try{
      upCommunityPayments003(db);const fake=localFakeAdapters(LOCAL_FAKE_BANK_MARKER),p:PaymentPrincipal={...target,permissions:['finance:read','payments:prepare'],role:'owner',session_id:'synthetic',authenticated_at:'2026-10-15T00:00:00Z'};
      const service=new CommunityPaymentService({db,adapter:fake.payment,authorize:()=>true,recentAuth:()=>true,csrf:()=>true,credentialResolver:{resolve:async()=>({synthetic:true})},accounting:{loadState:()=>f.state,persistAndActivate:()=>{},invoiceEvidence:currentPaymentInvoices,confirmedReconciliation:provedPaymentReconciliation}});
      const batch=service.createDraft(p,[f.id],'DE36'+'0'.repeat(18),'Synthetic Debtor');service.repo.transition(p,batch.id,batch.revision,['draft'],'unknown','synthetic-unresolved');
      const current={...p,...third};expect(service.candidates(current).find(candidate=>candidate.evidence.documentId===f.id)!.eligible).toBe(false);expect(()=>service.createDraft(current,[f.id],'DE36'+'0'.repeat(18),'Synthetic Debtor')).toThrow('CANDIDATE_REVIEW_REQUIRED');
      // Returning to original A must also see unresolved B history.
      expect(service.candidates({...p,subject:source.subject,workspace_id:source.workspace_id}).find(candidate=>candidate.evidence.documentId===f.id)!.eligible).toBe(false);
      expect(fake.calls.submit).toBe(0);
    }finally{db.close();}
  });
  it('retains old legacy payment namespaces conservatively without grandfathering document or batch authority',async()=>{
    const f=await paymentFixture();f.state.audit_events=[];await unlink(join(f.root,'document-index-v1.json'));
    const doc=f.state.documents.get(f.id)!;
    // Exact retired prototype digest: payment/type/convention metadata was not
    // included. This is historical evidence, not a current access capability.
    const oldIdentity={document_id:f.id,workspace_id:doc.meta.workspace_id,owner_subject:doc.meta.owner_subject,source_system:doc.source_system,source_document_ref:doc.source_document_ref,captured_at:doc.captured_at,filename:doc.filename,file_hash:doc.file_hash,attachment_path:doc.meta.attachment_path,document_date:doc.document_date,total_amount_minor:doc.total_amount_minor,currency_code:doc.currency_code,supplier_name:doc.supplier_name,vat_amount_minor:doc.vat_amount_minor,invoice_number:doc.meta.invoice_number,net_amount_minor:doc.meta.net_amount_minor};
    const oldDigest=sha(JSON.stringify(Object.fromEntries(Object.entries(oldIdentity).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)))));
    recordAudit(f.state,'STATE_COMMITTED','Run',target.workspace_id,{actor_type:'user',actor_id:target.subject,after:{workspace_recovery_version:1,target_workspace_id:target.workspace_id,target_subject:target.subject,fingerprint:'a'.repeat(64),documents:[{document_id:f.id,source_workspace_id:source.workspace_id,hash:doc.file_hash,identity_sha256:oldDigest}]}});
    expect(workspaceRecoveryDocumentIds(f.state,{workspace_id:target.workspace_id}).has(f.id)).toBe(false);
    await expect(f.service().get(target,f.id)).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(workspaceRecoveryPaymentWorkspaceIds(f.state,f.id)).toEqual([source.workspace_id,target.workspace_id].sort());
    const third={subject:'synthetic-third-owner',workspace_id:'synthetic-third-workspace'},review=await inspectWorkspaceRecovery(f.state,f.root,third);
    f.state=await prepareWorkspaceRecovery(f.state,f.root,third,review.fingerprint);
    expect(workspaceRecoveryDocumentIds(f.state,{workspace_id:third.workspace_id}).has(f.id)).toBe(true);
    expect(workspaceRecoveryDocumentIds(f.state,{workspace_id:target.workspace_id}).has(f.id)).toBe(false);
    const db=new Database(':memory:');try{
      upCommunityPayments003(db);const fake=localFakeAdapters(LOCAL_FAKE_BANK_MARKER),p:PaymentPrincipal={...target,permissions:['finance:read','payments:prepare'],role:'owner',session_id:'synthetic',authenticated_at:'2026-10-15T00:00:00Z'};
      const service=new CommunityPaymentService({db,adapter:fake.payment,authorize:()=>true,recentAuth:()=>true,csrf:()=>true,credentialResolver:{resolve:async()=>({synthetic:true})},accounting:{loadState:()=>f.state,persistAndActivate:()=>{},invoiceEvidence:currentPaymentInvoices,confirmedReconciliation:provedPaymentReconciliation}});
      // Seed the durable B batch created by the retired prototype. Current B
      // access is intentionally denied; only the receiving C service is tested.
      const evidence=currentPaymentInvoices(f.state,source.workspace_id).find(invoice=>invoice.documentId===f.id)!;
      const old=service.repo.create(p,'DE36'+'0'.repeat(18),'Synthetic Debtor',fake.payment.provider,'mock',[itemFromCandidate(candidate(evidence))]);
      service.repo.transition(p,old.id,old.revision,['draft'],'unknown','synthetic-historical-unknown');
      const current={...p,...third};
      expect(service.candidates(current).find(item=>item.evidence.documentId===f.id)).toMatchObject({eligible:false,issues:['CANDIDATE_ALREADY_CREATED']});
      expect(()=>service.createDraft(current,[f.id],'DE36'+'0'.repeat(18),'Synthetic Debtor')).toThrow('CANDIDATE_REVIEW_REQUIRED');
      expect(()=>service.validate(current,old.id,old.revision)).toThrow('BATCH_NOT_FOUND');expect(fake.calls.submit).toBe(0);
    }finally{db.close();}
    for(const patch of [{document_id:'DOC-synthetic-foreign'},{hash:'b'.repeat(64)},{source_workspace_id:'synthetic-foreign-source'}]){
      const changed=structuredClone(f.state),scope=(changed.audit_events[0].after!.documents as Array<Record<string,unknown>>)[0];Object.assign(scope,patch);
      expect(workspaceRecoveryPaymentWorkspaceIds(changed,f.id)).toEqual([source.workspace_id,third.workspace_id].sort());
    }
    const malformed=structuredClone(f.state);(malformed.audit_events[0].after!.documents as Array<Record<string,unknown>>)[0].unexpected=true;
    expect(()=>workspaceRecoveryPaymentWorkspaceIds(malformed,f.id)).toThrow('Invalid workspace recovery document scope');
  });
});
