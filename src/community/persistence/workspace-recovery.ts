import {createHash,randomUUID} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {Document,MatchingState} from '../../core/types.js';
import {recordAudit} from '../../observability/audit.js';
import {serializeCommunityState} from '../../storage/json-store.js';
import {immutableReview,recoverAuditedDocumentReviews,same,validateReviewRecord} from '../documents/review-audit.js';
import type {DocumentRecord,Principal} from '../documents/service.js';
import {tableDocumentId} from '../documents/tabular.js';
import {documentSettlementConvention,type DocumentSettlementConvention} from '../accounting/document-settlement.js';
import {verifyRuntimePath} from './backup.js';
import {safeArchivePath} from './zip.js';

/** Recovery grants are accounting audit evidence, never imported login authority. */
export class WorkspaceRecoveryError extends Error {
  constructor(public readonly code:string,message:string){super(message);this.name='WorkspaceRecoveryError';}
}
function fail(code:string,message:string):never{throw new WorkspaceRecoveryError(code,message);}
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[\w.:-]{1,100}$/.test(value);
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function principal(value:Principal):void{if(!identifier(value?.subject)||!identifier(value?.workspace_id))fail('INVALID_PRINCIPAL','Current owner workspace is required');}
function stable(value:unknown):string {
  const ordered=(v:unknown):unknown=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([,child])=>child!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,ordered(child)])):v;
  return JSON.stringify(ordered(value));
}
interface Scope {document_id:string;source_workspace_id:string;hash:string;identity_sha256:string}
type ReviewOrigin='uploaded'|'imported'|'legacy';
interface ReviewSources {records:Map<string,DocumentRecord>;origins:Map<string,ReviewOrigin>}
function reviewSources(state:MatchingState):ReviewSources{
  const records=new Map(recoverAuditedDocumentReviews(state.audit_events).map(record=>[record.id,record])),origins=new Map<string,ReviewOrigin>();
  for(const event of state.audit_events){
    if(event.entity_type!=='Document'||event.after?.document_review_version!==1||origins.has(event.entity_id))continue;
    const operation=event.after.operation;
    origins.set(event.entity_id,operation==='uploaded'||operation==='imported'?operation:'legacy');
  }
  return{records,origins};
}
export interface WorkspaceRecoveryDocument {document_id:string;source_workspace_id:string;hash:string;status:DocumentRecord['status']}
export interface WorkspaceRecoveryReview {fingerprint:string;documents:WorkspaceRecoveryDocument[];source_workspaces:string[];target_workspace_id:string;target_subject:string}
function legacyConvention(doc:Document):DocumentSettlementConvention|undefined{
  try{
    const convention=documentSettlementConvention(doc);
    // An absent historical marker must not be promoted to a payable merely
    // because today's upload/table fallback would infer a new face-value model.
    return doc.meta.settlement_convention===undefined&&convention!=='signed-cashflow-v1'?undefined:convention;
  }catch{return;}
}
function reviewContract(doc:Document|undefined,record:DocumentRecord,origin:ReviewOrigin):{convention:DocumentSettlementConvention;kind:string}|undefined{
  // Only the first canonical event establishes the source workflow. A later
  // audit baseline may contain older cache history, which is not an import.
  if(origin==='uploaded')return !doc||doc.source_system==='upload'?{convention:'payable-face-v1',kind:'reviewed-upload'}:undefined;
  if(origin==='imported'){
    for(const kind of ['invoice','income'] as const){
      if(record.source_id&&record.id===tableDocumentId(record.workspace_id,kind,record.source_id)){
        if(doc&&(doc.source_system!==(kind==='income'?'income':'invoice_file')||doc.meta.table_kind!==kind))return;
        return{convention:kind==='income'?'signed-cashflow-v1':'payable-face-v1',kind:'reviewed-'+kind+'-table'};
      }
    }
    // Retained imported upload reviews use the same supplier face-value
    // contract as the explicit upload/confirm workflow.
    if(doc?.source_system==='upload'&&doc.meta.table_kind===undefined)return{convention:'payable-face-v1',kind:'reviewed-upload'};
  }
  const convention=doc&&legacyConvention(doc);
  return convention?{convention,kind:'legacy'}:undefined;
}
function validTypeSign(doc:Document,convention:DocumentSettlementConvention):boolean{
  const type=doc.meta.document_type;
  if(type!==undefined&&type!=='invoice'&&type!=='credit_note')return false;
  if(type==='credit_note')return doc.total_amount_minor<0;
  return convention!=='payable-face-v1'||doc.total_amount_minor>0;
}
function financialReviewMatches(doc:Document,record:DocumentRecord,origin:ReviewOrigin):boolean{
  const f=record.fields,contract=reviewContract(doc,record,origin);
  if(!contract||!validTypeSign(doc,contract.convention)||contract.kind!=='legacy'&&doc.meta.settlement_convention!==contract.convention)return false;
  if(contract.kind==='reviewed-upload'&&(doc.source_document_ref!==(record.source_id??f.invoice_number)||doc.captured_at!==record.created_at))return false;
  if((contract.kind==='reviewed-invoice-table'||contract.kind==='reviewed-income-table')&&doc.source_document_ref!==record.source_id)return false;
  return doc.meta.workspace_id===record.workspace_id&&String(doc.meta.owner_subject??'')===record.owner_subject&&doc.file_hash?.toLowerCase()===record.hash&&doc.filename===record.filename&&doc.total_amount_minor===f.total_amount_minor&&doc.currency_code===f.currency_code&&doc.document_date===f.document_date&&doc.supplier_name===f.supplier_name&&doc.vat_amount_minor===f.vat_amount_minor&&doc.meta.net_amount_minor===f.net_amount_minor&&String(doc.meta.invoice_number??doc.source_document_ref)===f.invoice_number&&doc.meta.iban===f.iban&&doc.meta.payment_reference===f.payment_reference&&doc.meta.due_date===f.due_date&&(doc.meta.document_type??'invoice')===(f.document_type??'invoice');
}
function originalScope(state:MatchingState,id:string,reviews:ReviewSources):Scope|undefined {
  const review=reviews.records.get(id),doc=state.documents.get(id),origin=reviews.origins.get(id)??'legacy';
  if(review){
    if(doc&&!financialReviewMatches(doc,review,origin))return;
    const contract=reviewContract(doc,review,origin);if(!contract)return;
    const settlement={...contract,...(contract.kind==='legacy'?{source_system:doc!.source_system,table_kind:doc!.meta.table_kind,settlement_convention:doc!.meta.settlement_convention}:{})};
    const identity=contract.kind==='legacy'?{review:immutableReview(review),settlement}:immutableReview(review);
    return{document_id:id,source_workspace_id:review.workspace_id,hash:review.hash,identity_sha256:sha(stable(identity))};
  }
  return canonicalScope(state,id);
}
function canonicalScope(state:MatchingState,id:string):Scope|undefined{
  const doc=state.documents.get(id);
  if(!doc||!identifier(doc.meta.workspace_id)||typeof doc.file_hash!=='string'||!hash(doc.file_hash.toLowerCase()))return;
  const convention=legacyConvention(doc);if(!convention||!validTypeSign(doc,convention))return;
  const identity={document_id:id,workspace_id:doc.meta.workspace_id,owner_subject:doc.meta.owner_subject,source_system:doc.source_system,source_document_ref:doc.source_document_ref,captured_at:doc.captured_at,filename:doc.filename,file_hash:doc.file_hash.toLowerCase(),attachment_path:doc.meta.attachment_path,document_date:doc.document_date,total_amount_minor:doc.total_amount_minor,currency_code:doc.currency_code,supplier_name:doc.supplier_name,vat_amount_minor:doc.vat_amount_minor,invoice_number:doc.meta.invoice_number,net_amount_minor:doc.meta.net_amount_minor,iban:doc.meta.iban,payment_reference:doc.meta.payment_reference,due_date:doc.meta.due_date,document_type:doc.meta.document_type,settlement_convention:doc.meta.settlement_convention,table_kind:doc.meta.table_kind};
  return{document_id:id,source_workspace_id:doc.meta.workspace_id,hash:doc.file_hash.toLowerCase(),identity_sha256:sha(stable(identity))};
}
function validatedGrants(state:MatchingState,reviews:ReviewSources,mode:'access'|'payment-history'='access'):Array<{workspace:string;subject:string;scope:Scope}>{
  const result:Array<{workspace:string;subject:string;scope:Scope}>=[];
  for(const event of state.audit_events){
    const after=event.after;if(after?.workspace_recovery_version===undefined)continue;
    if(after.workspace_recovery_version!==1||Object.keys(after).some(key=>!['workspace_recovery_version','target_workspace_id','target_subject','fingerprint','documents'].includes(key))||!identifier(after.target_workspace_id)||!identifier(after.target_subject)||!hash(after.fingerprint)||!Array.isArray(after.documents)||after.documents.length<1||after.documents.length>10000||event.action!=='STATE_COMMITTED'||event.entity_type!=='Run'||event.entity_id!==after.target_workspace_id||event.actor_type!=='user'||event.actor_id!==after.target_subject||event.before!==undefined)fail('INVALID_STORAGE','Invalid workspace recovery grant');
    const seen=new Set<string>();
    for(const raw of after.documents){
      const scope=raw as Scope;
      if(!scope||typeof scope!=='object'||Object.keys(scope).sort().join(',')!=='document_id,hash,identity_sha256,source_workspace_id'||typeof scope.document_id!=='string'||!/^[\w.:-]{1,160}$/.test(scope.document_id)||!identifier(scope.source_workspace_id)||scope.source_workspace_id===after.target_workspace_id||!hash(scope.hash)||!hash(scope.identity_sha256)||seen.has(scope.document_id))fail('INVALID_STORAGE','Invalid workspace recovery document scope');
      seen.add(scope.document_id);
      const current=originalScope(state,scope.document_id,reviews);
      // A historical canonical record may gain its first review-audit baseline
      // after adoption. Its original canonical identity remains valid too.
      const fullIdentity=current&&(same(current,scope)||same(canonicalScope(state,scope.document_id)??null,scope));
      // Retired legacy identities cannot confer access. Their exact original
      // id/workspace/blob scope still identifies where an unresolved payment
      // may exist. Callers require strong current access before reading history;
      // this conservative evidence never authorizes a document or batch write.
      const paymentSource=mode==='payment-history'&&current&&current.document_id===scope.document_id&&current.source_workspace_id===scope.source_workspace_id&&current.hash===scope.hash;
      if(fullIdentity||paymentSource)result.push({workspace:after.target_workspace_id,subject:after.target_subject,scope});
    }
  }
  return result;
}
/** Exact source scopes only. A grant never confers a portal/account namespace. */
export function workspaceRecoveryDocumentIds(state:MatchingState,target:{workspace_id:string;subject?:string}):Set<string>{
  const reviews=reviewSources(state);
  return new Set(validatedGrants(state,reviews).filter(grant=>grant.workspace===target.workspace_id&&(target.subject===undefined||grant.subject===target.subject)).map(grant=>grant.scope.document_id));
}
/** Read-only payment history/dedup scope, only after invoice access is checked. */
export function workspaceRecoveryPaymentWorkspaceIds(state:MatchingState,documentId:string):string[]{
  return workspaceRecoveryPaymentWorkspaceIndex(state).get(documentId)??[];
}
/** Bulk equivalent for a candidate list; replay audit once per state read. */
export function workspaceRecoveryPaymentWorkspaceIndex(state:MatchingState):Map<string,string[]>{
  const reviews=reviewSources(state),result=new Map<string,Set<string>>();
  for(const id of new Set([...state.documents.keys(),...reviews.records.keys()])){const scope=originalScope(state,id,reviews);if(scope)result.set(id,new Set([scope.source_workspace_id]));}
  for(const grant of validatedGrants(state,reviews,'payment-history'))result.get(grant.scope.document_id)?.add(grant.workspace);
  return new Map([...result].map(([id,workspaces])=>[id,[...workspaces].sort()]));
}

async function inspect(state:MatchingState,documentsRoot:string,target:Principal):Promise<{review:WorkspaceRecoveryReview;scopes:Scope[]}> {
  principal(target);
  const root=resolve(documentsRoot),reviews=reviewSources(state);
  const allowed=workspaceRecoveryDocumentIds(state,{workspace_id:target.workspace_id}),cached=new Map<string,DocumentRecord>();let indexSha:string|undefined;
  const indexPath=join(root,'document-index-v1.json');verifyRuntimePath(root,indexPath);
  try{
    const stat=await lstat(indexPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024*1024)fail('INVALID_STORAGE','Invalid document index');
    const indexBytes=await readFile(indexPath);indexSha=sha(indexBytes);
    const index=JSON.parse(indexBytes.toString('utf8')) as {version:number;records:DocumentRecord[]};
    if(index.version!==1||!Array.isArray(index.records)||index.records.length>100000)fail('INVALID_STORAGE','Invalid document index');
    for(const record of index.records){
      validateReviewRecord(record);if(cached.has(record.id))fail('SOURCE_CONFLICT','Duplicate document index identity');cached.set(record.id,record);
      const audited=reviews.records.get(record.id),doc=state.documents.get(record.id);
      if(audited&&!same(immutableReview(audited),immutableReview(record))||doc&&!audited&&!financialReviewMatches(doc,record,'legacy')||doc&&(doc.meta.workspace_id!==record.workspace_id||doc.file_hash?.toLowerCase()!==record.hash)||!audited&&!doc&&record.workspace_id!==target.workspace_id)fail('SOURCE_CONFLICT','Document index disagrees with canonical source evidence');
    }
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const scopes:Scope[]=[],documents:WorkspaceRecoveryDocument[]=[],verified=new Map<string,{path:string;hash:string;bytes:number}>();
  const ids=[...new Set([...state.documents.keys(),...reviews.records.keys()])].sort();
  for(const id of ids){
    const record=reviews.records.get(id),doc=state.documents.get(id),workspace=record?.workspace_id??doc?.meta.workspace_id;
    if(workspace===target.workspace_id||workspace===undefined)continue;
    const scope=originalScope(state,id,reviews);if(!scope)fail('SOURCE_CONFLICT','Historical document lacks an exact original source scope');
    if(record&&doc&&!financialReviewMatches(doc,record,reviews.origins.get(id)??'legacy'))fail('SOURCE_CONFLICT','Financial document disagrees with audited review');
    const expected='attachments/'+sha(scope.source_workspace_id)+'/'+scope.hash;
    const original=doc?(typeof doc.meta.attachment_path==='string'?doc.meta.attachment_path:doc.filename):expected;
    if(typeof original!=='string')fail('ORIGINAL_UNAVAILABLE','Historical document original is unavailable');
    // Both the canonical original and the review content-addressed original must
    // be present; this operation never creates or rewrites attachment bytes.
    for(const relative of new Set([original,...(record?[expected]:[])])){
      const previous=verified.get(relative);
      if(previous){if(previous.hash!==scope.hash||record&&previous.bytes!==record.bytes)fail('SOURCE_CONFLICT','Shared original evidence disagrees');continue;}
      safeArchivePath(relative);const path=join(root,...relative.split('/'));verifyRuntimePath(root,path);
      try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>256*1024*1024||record&&stat.size!==record.bytes)fail('ORIGINAL_UNAVAILABLE','Historical original size or kind disagrees');const bytes=await readFile(path);if(sha(bytes)!==scope.hash)fail('ORIGINAL_UNAVAILABLE','Historical original checksum disagrees');verified.set(relative,{path:relative,hash:scope.hash,bytes:bytes.length});}
      catch(error){if(error instanceof WorkspaceRecoveryError)throw error;fail('ORIGINAL_UNAVAILABLE','Historical original cannot be verified');}
    }
    if(allowed.has(id))continue;
    scopes.push(scope);documents.push({document_id:id,source_workspace_id:scope.source_workspace_id,hash:scope.hash,status:record?.status??(doc?.meta.document_review_status==='archived'?'archived':'confirmed')});
  }
  if(scopes.length>10000)fail('INVALID_STORAGE','Workspace recovery review exceeds supported size');
  const fingerprint=sha(stable({state_sha256:sha(serializeCommunityState(state)),index_sha256:indexSha,target_workspace_id:target.workspace_id,target_subject:target.subject,scopes,verified:[...verified.values()]}));
  return{scopes,review:{fingerprint,documents,source_workspaces:[...new Set(documents.map(item=>item.source_workspace_id))].sort(),target_workspace_id:target.workspace_id,target_subject:target.subject}};
}
export async function inspectWorkspaceRecovery(state:MatchingState,documentsRoot:string,targetPrincipal:Principal):Promise<WorkspaceRecoveryReview>{return(await inspect(state,documentsRoot,targetPrincipal)).review;}
/** Caller rechecks current owner/recent auth and commits atomically after await. */
export async function prepareWorkspaceRecovery(state:MatchingState,documentsRoot:string,targetPrincipal:Principal,fingerprint:string):Promise<MatchingState>{
  if(!hash(fingerprint))fail('STALE_REVIEW','Inspect restored source evidence before confirming');
  const {review,scopes}=await inspect(state,documentsRoot,targetPrincipal);
  if(review.fingerprint!==fingerprint)fail('STALE_REVIEW','Restored source evidence changed; inspect it again');
  if(!scopes.length)fail('NOTHING_TO_RECOVER','No restored documents require adoption');
  const next={...state,audit_events:[...state.audit_events]};
  recordAudit(next,'STATE_COMMITTED','Run',targetPrincipal.workspace_id,{actor_type:'user',actor_id:targetPrincipal.subject,reason:'Explicit restored document recovery preserving originals',correlation_id:'workspace-recovery-'+randomUUID(),after:{workspace_recovery_version:1,target_workspace_id:targetPrincipal.workspace_id,target_subject:targetPrincipal.subject,fingerprint,documents:scopes}});
  return next;
}
