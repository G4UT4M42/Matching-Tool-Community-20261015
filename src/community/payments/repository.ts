import type Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import type { PaymentBatch, PaymentItem, PaymentStatus, Principal } from './types.js';

type BatchRow = { id:string; workspace_id:string; debtor_iban:string; debtor_name:string; provider:string; environment:'mock'|'live'|'sandbox'; status:PaymentStatus; revision:number; detail_digest:string; reviewer:string|null; approver:string|null; approval_revision:number|null; approval_digest:string|null; claim_id:string|null; provider_reference:string|null; created_at:string };
type ItemRow = { id:string; document_id:string; invoice_id:string; source_hash:string; creditor_name:string; creditor_iban:string; amount_minor:number; currency:'EUR'; reference:string; due_date:string; match_ids_json:string };
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class PaymentRepository {
  constructor(readonly db:Database.Database, readonly now:()=>Date=()=>new Date()) {}
  event(batch:PaymentBatch,p:Principal,action:string,detail:unknown={}):void {
    this.db.prepare('INSERT INTO community_payment_events(id,batch_id,workspace_id,actor,action,revision,detail_digest,at,detail_json) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),batch.id,p.workspace_id,p.subject,action,batch.revision,batch.detailDigest,this.now().toISOString(),JSON.stringify(detail));
  }
  get(id:string,workspaceId:string):PaymentBatch|null {
    const r=this.db.prepare('SELECT * FROM community_payment_batches WHERE id=? AND workspace_id=?').get(id,workspaceId) as BatchRow|undefined;
    if (!r) return null;
    const rows=this.db.prepare('SELECT * FROM community_payment_items WHERE batch_id=? ORDER BY id').all(id) as ItemRow[];
    const items:PaymentItem[]=rows.map(i=>({id:i.id,documentId:i.document_id,invoiceId:i.invoice_id,sourceHash:i.source_hash,creditorName:i.creditor_name,creditorIban:i.creditor_iban,amountMinor:i.amount_minor,currency:i.currency,reference:i.reference,dueDate:i.due_date,matchIds:JSON.parse(i.match_ids_json)}));
    if(digest({debtorIban:r.debtor_iban,debtorName:r.debtor_name,provider:r.provider,environment:r.environment,items})!==r.detail_digest)throw new Error('PAYMENT_DETAIL_INTEGRITY_FAILURE');
    return {id:r.id,workspaceId:r.workspace_id,debtorIban:r.debtor_iban,debtorName:r.debtor_name,provider:r.provider,environment:r.environment,status:r.status,revision:r.revision,detailDigest:r.detail_digest,items,createdAt:r.created_at,reviewer:r.reviewer??undefined,approver:r.approver??undefined,approvalRevision:r.approval_revision??undefined,approvalDigest:r.approval_digest??undefined,claimId:r.claim_id??undefined,providerReference:r.provider_reference??undefined};
  }
  list(workspaceId:string):PaymentBatch[] { return (this.db.prepare('SELECT id FROM community_payment_batches WHERE workspace_id=? ORDER BY created_at DESC').all(workspaceId) as {id:string}[]).map(x=>this.get(x.id,workspaceId)!); }
  hasDocument(workspaceId:string,documentId:string):boolean { return !!this.db.prepare('SELECT 1 FROM community_payment_items WHERE workspace_id=? AND active_document_id=?').get(workspaceId,documentId); }
  editDebtor(p:Principal,id:string,revision:number,debtorIban:string,debtorName:string):PaymentBatch {
    return this.db.transaction(()=>{
      const b=this.get(id,p.workspace_id); if(!b) throw new Error('BATCH_NOT_FOUND');
      if(b.revision!==revision || !['draft','validated','reviewed','approved'].includes(b.status)) throw new Error('REVISION_CONFLICT');
      const detailDigest=digest({debtorIban,debtorName,provider:b.provider,environment:b.environment,items:b.items});
      const info=this.db.prepare("UPDATE community_payment_batches SET debtor_iban=?,debtor_name=?,detail_digest=?,status='draft',revision=revision+1,reviewer=NULL,approver=NULL,approval_revision=NULL,approval_digest=NULL,updated_at=? WHERE id=? AND workspace_id=? AND revision=?")
        .run(debtorIban,debtorName,detailDigest,this.now().toISOString(),id,p.workspace_id,revision);
      if(info.changes!==1) throw new Error('REVISION_CONFLICT');
      this.db.prepare('DELETE FROM community_payment_confirmations WHERE batch_id=?').run(id);
      const next=this.get(id,p.workspace_id)!;this.event(next,p,'material_edit');return next;
    })();
  }
  create(p:Principal,debtorIban:string,debtorName:string,provider:string,environment:'mock'|'live'|'sandbox',items:PaymentItem[]):PaymentBatch {
    return this.db.transaction(()=>{
      const id=randomUUID(), now=this.now().toISOString();
      items=[...items].sort((a,b)=>a.id.localeCompare(b.id));
      const detailDigest=digest({debtorIban,debtorName,provider,environment,items});
      this.db.prepare('INSERT INTO community_payment_batches(id,workspace_id,debtor_iban,debtor_name,provider,environment,status,revision,detail_digest,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,p.workspace_id,debtorIban,debtorName,provider,environment,'draft',1,detailDigest,now,now);
      const insert=this.db.prepare('INSERT INTO community_payment_items(id,batch_id,workspace_id,document_id,active_document_id,invoice_id,source_hash,creditor_name,creditor_iban,amount_minor,currency,reference,due_date,match_ids_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for(const i of items) insert.run(i.id,id,p.workspace_id,i.documentId,i.documentId,i.invoiceId,i.sourceHash,i.creditorName,i.creditorIban,i.amountMinor,i.currency,i.reference,i.dueDate,JSON.stringify(i.matchIds));
      const batch=this.get(id,p.workspace_id)!; this.event(batch,p,'created'); return batch;
    })();
  }
  transition(p:Principal,id:string,revision:number,from:PaymentStatus[],to:PaymentStatus,action:string,fields:Record<string,unknown>={}):PaymentBatch {
    return this.db.transaction(()=>{
      const batch=this.get(id,p.workspace_id); if(!batch) throw new Error('BATCH_NOT_FOUND');
      if(batch.revision!==revision || !from.includes(batch.status)) throw new Error('REVISION_CONFLICT');
      const allowed=['reviewer','approver','approval_revision','approval_digest','claim_id','provider_reference'];
      const entries=Object.entries(fields).filter(([key])=>allowed.includes(key));
      const assignments=entries.map(([key])=>`${key}=?`).join(',');
      const sql=`UPDATE community_payment_batches SET status=?, revision=revision+1, updated_at=?${assignments?','+assignments:''} WHERE id=? AND workspace_id=? AND revision=?`;
      const info=this.db.prepare(sql).run(to,this.now().toISOString(),...entries.map(([,v])=>v),id,p.workspace_id,revision);
      if(info.changes!==1) throw new Error('REVISION_CONFLICT');
      if(to==='cancelled')this.db.prepare('UPDATE community_payment_items SET active_document_id=NULL WHERE batch_id=?').run(id);
      const next=this.get(id,p.workspace_id)!; this.event(next,p,action); return next;
    })();
  }
  audit(id:string,workspaceId:string):unknown[] { return this.db.prepare('SELECT id,actor,action,revision,detail_digest,at,detail_json FROM community_payment_events WHERE batch_id=? AND workspace_id=? ORDER BY seq').all(id,workspaceId); }
  invalidateActionableOnRestore():void {
    this.db.transaction(()=>{
      this.db.prepare('DELETE FROM community_payment_confirmations').run();
      const rows=this.db.prepare("SELECT id,workspace_id,status FROM community_payment_batches WHERE status IN ('submission_claimed','acknowledged','approved')").all() as Array<{id:string;workspace_id:string;status:PaymentStatus}>;
      for(const row of rows){
        const nextStatus=row.status==='approved'?'reviewed':'unknown';
        this.db.prepare('UPDATE community_payment_batches SET status=?,revision=revision+1,approver=NULL,approval_revision=NULL,approval_digest=NULL,updated_at=? WHERE id=?').run(nextStatus,this.now().toISOString(),row.id);
        const p:Principal={subject:'system:restore',workspace_id:row.workspace_id,role:'system',session_id:'restore',authenticated_at:this.now().toISOString(),permissions:[]};
        this.event(this.get(row.id,row.workspace_id)!,p,'restore_invalidation',{previousStatus:row.status});
      }
    })();
  }
}
