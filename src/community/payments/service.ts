import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { candidate, itemFromCandidate, validIban, validText } from './validation.js';
import { PaymentRepository } from './repository.js';
import { sepaExport } from './sepa.js';
import type { AccountingCallbacks, Candidate, CredentialResolver, PaymentAdapter, PaymentBatch, PaymentPermission, Principal } from './types.js';

export interface PaymentDependencies<State> {
  db: Database.Database; accounting: AccountingCallbacks<State>;
  authorize: (principal:Principal, permission:PaymentPermission)=>boolean;
  recentAuth: (principal:Principal)=>boolean;
  csrf: (principal:Principal, token:string|undefined)=>boolean;
  credentialResolver: CredentialResolver;
  adapter:PaymentAdapter;
  now?:()=>Date;
}
const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
function fail(code:string):never { throw new Error(code); }
export class CommunityPaymentService<State> {
  readonly repo:PaymentRepository;
  constructor(readonly d:PaymentDependencies<State>) { this.repo=new PaymentRepository(d.db,d.now); }
  private time():Date { return (this.d.now??(()=>new Date()))(); }
  require(p:Principal|undefined,permission:PaymentPermission):Principal {
    if(!p?.subject || !p.workspace_id || !p.session_id) return fail('UNAUTHENTICATED');
    if(!this.d.authorize(p,permission)) return fail('FORBIDDEN');
    return p;
  }
  candidates(p:Principal):Candidate[] {
    this.require(p,'finance:read');
    const state=this.d.accounting.loadState();
    return this.d.accounting.invoiceEvidence(state,p.workspace_id).map(e=>{
      const c=candidate(e); if([p.workspace_id,...(e.paymentWorkspaceIds??[]),...(e.originalWorkspaceId?[e.originalWorkspaceId]:[])].some(workspace=>this.repo.hasDocument(workspace,e.documentId))) { c.issues.push('CANDIDATE_ALREADY_CREATED'); c.eligible=false; } return c;
    });
  }
  createDraft(p:Principal,documentIds:string[],debtorIban:string,debtorName:string):PaymentBatch {
    this.require(p,'payments:prepare');
    if(!Array.isArray(documentIds) || documentIds.length===0 || documentIds.length>100 || new Set(documentIds).size!==documentIds.length) return fail('INVALID_DOCUMENT_SELECTION');
    if(!validIban(debtorIban) || !validText(debtorName,70)) return fail('INVALID_DEBTOR');
    const found=this.candidates(p).filter(c=>documentIds.includes(c.evidence.documentId));
    if(found.length!==documentIds.length || found.some(c=>!c.eligible)) return fail('CANDIDATE_REVIEW_REQUIRED');
    return this.repo.create(p,debtorIban.replace(/\s/g,'').toUpperCase(),debtorName,this.d.adapter.provider,this.d.adapter.environment,found.map(itemFromCandidate));
  }
  private currentEvidence(p:Principal,b:PaymentBatch):void {
    const state=this.d.accounting.loadState();
    const evidence=this.d.accounting.invoiceEvidence(state,p.workspace_id);
    for(const item of b.items) {
      const current=evidence.find(e=>e.documentId===item.documentId);
      if(!current) return fail('SOURCE_EVIDENCE_CHANGED');
      if([...(current.paymentWorkspaceIds??[]),...(current.originalWorkspaceId?[current.originalWorkspaceId]:[])].some(workspace=>workspace!==p.workspace_id&&this.repo.hasDocument(workspace,item.documentId)))return fail('SOURCE_EVIDENCE_CHANGED');
      const c=candidate(current);
      if(!c.eligible || c.outstandingMinor!==item.amountMinor || current.invoiceId!==item.invoiceId || current.sourceHash!==item.sourceHash || current.creditorName!==item.creditorName || current.creditorIban?.replace(/\s/g,'').toUpperCase()!==item.creditorIban || current.reference!==item.reference || current.dueDate!==item.dueDate || JSON.stringify([...current.matchIds].sort())!==JSON.stringify([...item.matchIds].sort())) return fail('SOURCE_EVIDENCE_CHANGED');
    }
  }
  validate(p:Principal,id:string,revision:number):PaymentBatch {
    this.require(p,'payments:prepare'); const b=this.repo.get(id,p.workspace_id); if(!b) return fail('BATCH_NOT_FOUND');
    this.currentEvidence(p,b); sepaExport({...b,status:'validated'});
    return this.repo.transition(p,id,revision,['draft'],'validated','validated');
  }
  editDebtor(p:Principal,id:string,revision:number,debtorIban:string,debtorName:string):PaymentBatch {
    this.require(p,'payments:prepare');
    if(!validIban(debtorIban) || !validText(debtorName,70)) return fail('INVALID_DEBTOR');
    return this.repo.editDebtor(p,id,revision,debtorIban.replace(/\s/g,'').toUpperCase(),debtorName);
  }
  review(p:Principal,id:string,revision:number):PaymentBatch {
    this.require(p,'payments:prepare'); const b=this.repo.get(id,p.workspace_id); if(!b) return fail('BATCH_NOT_FOUND'); this.currentEvidence(p,b);
    return this.repo.transition(p,id,revision,['validated'],'reviewed','reviewed',{reviewer:p.subject});
  }
  approve(p:Principal,id:string,revision:number):PaymentBatch {
    this.require(p,'payments:approve'); if(p.role==='bookkeeper') return fail('FORBIDDEN');
    const b=this.repo.get(id,p.workspace_id); if(!b) return fail('BATCH_NOT_FOUND'); this.currentEvidence(p,b);
    if(b.revision!==revision) return fail('REVISION_CONFLICT');
    if(b.status!=='reviewed' || (!b.reviewer)) return fail('REVIEW_REQUIRED');
    if(b.reviewer===p.subject && p.role!=='owner') return fail('SEPARATE_APPROVER_REQUIRED');
    return this.repo.transition(p,id,revision,['reviewed'],'approved','approved',{approver:p.subject,approval_revision:revision+1,approval_digest:b.detailDigest});
  }
  cancel(p:Principal,id:string,revision:number):PaymentBatch {
    this.require(p,'payments:prepare');
    return this.repo.transition(p,id,revision,['draft','validated','reviewed','approved'],'cancelled','cancelled',{approver:null,approval_revision:null,approval_digest:null});
  }
  export(p:Principal,id:string):ReturnType<typeof sepaExport> {
    this.require(p,'finance:read'); const b=this.repo.get(id,p.workspace_id); if(!b) return fail('BATCH_NOT_FOUND'); return sepaExport(b);
  }
  issueConfirmation(p:Principal,id:string,revision:number):{token:string;expiresAt:string;batch:PaymentBatch} {
    this.require(p,'payments:submit');
    if(!this.d.recentAuth(p)) return fail('RECENT_AUTH_REQUIRED');
    const b=this.repo.get(id,p.workspace_id); if(!b || b.status!=='approved' || b.revision!==revision || b.approvalRevision!==revision || b.approvalDigest!==b.detailDigest) return fail('APPROVAL_STALE');
    this.currentEvidence(p,b);
    const token=randomBytes(32).toString('base64url'), expiresAt=new Date(this.time().getTime()+120000).toISOString();
    this.d.db.prepare('INSERT INTO community_payment_confirmations(token_hash,batch_id,workspace_id,subject,session_id,provider,debtor_iban,revision,detail_digest,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(tokenHash(token),id,p.workspace_id,p.subject,p.session_id,b.provider,b.debtorIban,revision,b.detailDigest,expiresAt);
    return {token,expiresAt,batch:b};
  }
  async submit(p:Principal,id:string,revision:number,token:string):Promise<PaymentBatch> {
    this.require(p,'payments:submit'); if(!this.d.recentAuth(p)) return fail('RECENT_AUTH_REQUIRED');
    if(typeof token!=='string' || token.length<30) return fail('CONFIRMATION_REQUIRED');
    const claim=this.d.db.transaction(()=>{
      const b=this.repo.get(id,p.workspace_id);
      if(!b || b.status!=='approved' || b.revision!==revision || b.approvalRevision!==revision || b.approvalDigest!==b.detailDigest) return fail('APPROVAL_STALE');
      this.currentEvidence(p,b);
      const row=this.d.db.prepare('SELECT * FROM community_payment_confirmations WHERE token_hash=?').get(tokenHash(token)) as Record<string,unknown>|undefined;
      if(!row || row.used_at || row.batch_id!==id || row.workspace_id!==p.workspace_id || row.subject!==p.subject || row.session_id!==p.session_id || row.provider!==b.provider || row.debtor_iban!==b.debtorIban || row.revision!==revision || row.detail_digest!==b.detailDigest || String(row.expires_at)<=this.time().toISOString()) return fail('CONFIRMATION_INVALID');
      this.d.db.prepare('UPDATE community_payment_confirmations SET used_at=? WHERE token_hash=? AND used_at IS NULL').run(this.time().toISOString(),tokenHash(token));
      const claimId=randomUUID();
      const claimed=this.repo.transition(p,id,revision,['approved'],'submission_claimed','submission_claimed',{claim_id:claimId});
      return {claimed,claimId};
    })();
    // The durable claim precedes the only transport call. Any exception is uncertain.
    let result:{outcome:'acknowledged'|'failed'|'unknown';reference?:string};
    try { const credential=await this.d.credentialResolver.resolve({subject:p.subject,workspaceId:p.workspace_id,provider:claim.claimed.provider,environment:claim.claimed.environment,vaultRef:this.vaultRef(p,claim.claimed)}); result=await this.d.adapter.submit({claimId:claim.claimId,batch:claim.claimed,credential}); }
    catch { result={outcome:'unknown'}; }
    const latest=this.repo.get(id,p.workspace_id)!;
    if(latest.status!=='submission_claimed' || latest.claimId!==claim.claimId) return latest;
    return this.repo.transition(p,id,latest.revision,['submission_claimed'],result.outcome,result.outcome,{provider_reference:result.reference??null});
  }
  private vaultRef(p:Principal,b:PaymentBatch):string {
    // Local simulation is not a bank connection. Only its fixed no-network
    // adapter may use this sentinel; live providers always require a vault.
    if(b.provider==='community-simulated-bank'&&b.environment==='mock')return 'SIMULATION_ONLY';
    const row=this.d.db.prepare('SELECT vault_ref FROM community_bank_connections WHERE workspace_id=? AND subject=? AND provider=? AND environment=?').get(p.workspace_id,p.subject,b.provider,b.environment) as {vault_ref:string}|undefined;
    if(!row) return fail('BANK_CONNECTION_REQUIRED'); return row.vault_ref;
  }
  async reconcileProvider(p:Principal,id:string,revision:number):Promise<PaymentBatch> {
    this.require(p,'payments:submit'); const b=this.repo.get(id,p.workspace_id); if(!b || !b.claimId || !['unknown','submission_claimed','acknowledged'].includes(b.status) || b.revision!==revision) return fail('REVISION_CONFLICT');
    let outcome:{outcome:'acknowledged'|'failed'|'unknown';reference?:string};
    try { const credential=await this.d.credentialResolver.resolve({subject:p.subject,workspaceId:p.workspace_id,provider:b.provider,environment:b.environment,vaultRef:this.vaultRef(p,b)}); outcome=await this.d.adapter.readStatus({claimId:b.claimId,reference:b.providerReference,credential}); }
    catch { outcome={outcome:'unknown'}; }
    if(outcome.outcome==='unknown' || b.status===outcome.outcome) return b;
    return this.repo.transition(p,id,revision,['unknown','submission_claimed','acknowledged'],outcome.outcome,'provider_status',{provider_reference:outcome.reference??b.providerReference??null});
  }
  /** Only a trusted adapter dispatcher may call this method; it is deliberately absent from HTTP routes. */
  providerCallback(input:{provider:string;callbackId:string;claimId:string;outcome:'acknowledged'|'failed'|'unknown';reference?:string}):PaymentBatch|null {
    if(!/^[A-Za-z0-9:_-]{1,120}$/.test(input.callbackId)) return fail('INVALID_CALLBACK');
    return this.d.db.transaction(()=>{
      const row=this.d.db.prepare('SELECT id,workspace_id FROM community_payment_batches WHERE claim_id=? AND provider=?').get(input.claimId,input.provider) as {id:string;workspace_id:string}|undefined;
      if(!row)return fail('UNKNOWN_CLAIM');
      const prior=this.d.db.prepare('SELECT claim_id FROM community_payment_callbacks WHERE provider=? AND callback_id=?').get(input.provider,input.callbackId) as {claim_id:string}|undefined;
      if(prior){if(prior.claim_id!==input.claimId)return fail('CALLBACK_ID_COLLISION');return this.repo.get(row.id,row.workspace_id)}
      this.d.db.prepare('INSERT INTO community_payment_callbacks(provider,callback_id,claim_id,received_at) VALUES (?,?,?,?)').run(input.provider,input.callbackId,input.claimId,this.time().toISOString());
      const batch=this.repo.get(row.id,row.workspace_id)!;
      if(!['submission_claimed','unknown'].includes(batch.status) || input.outcome==='unknown')return batch;
      const actor:Principal={subject:'system:provider',workspace_id:row.workspace_id,role:'system',session_id:'adapter',authenticated_at:this.time().toISOString(),permissions:[]};
      return this.repo.transition(actor,batch.id,batch.revision,['submission_claimed','unknown'],input.outcome,'provider_callback',{provider_reference:input.reference??null});
    })();
  }
  markReconciled(p:Principal,id:string,revision:number,matchId:string):PaymentBatch {
    this.require(p,'payments:prepare'); if(!matchId) return fail('MATCH_REQUIRED');
    const b=this.repo.get(id,p.workspace_id); if(!b) return fail('BATCH_NOT_FOUND');
    if(!this.d.accounting.confirmedReconciliation(this.d.accounting.loadState(),p.workspace_id,b,matchId)) return fail('MATCH_NOT_CONFIRMED');
    return this.repo.transition(p,id,revision,['acknowledged'],'reconciled','reconciled',{provider_reference:matchId});
  }
}
