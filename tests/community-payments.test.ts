import { describe,it,expect,beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { upCommunityPayments003 } from '../src/migrations/003-community-payments.js';
import { CommunityPaymentService } from '../src/community/payments/service.js';
import { localFakeAdapters, LOCAL_FAKE_BANK_MARKER } from '../src/community/banking/mock.js';
import { candidate, validIban } from '../src/community/payments/validation.js';
import { parseSepaXmlSecure,validatePsaAssertions } from '../src/payments/sepa-assertions.js';
import type { InvoiceEvidence, Principal, PaymentBatch } from '../src/community/payments/types.js';

const iban=(bban='000000001234567890')=>{let rem=0;for(const char of bban+'131400'){for(const digit of char)rem=(rem*10+Number(digit))%97}return `DE${String(98-rem).padStart(2,'0')}${bban}`};
const owner:Principal={subject:'owner',workspace_id:'ws-1',role:'owner',session_id:'s-1',authenticated_at:'2026-10-14T00:00:00Z',reauthenticated_at:'2026-10-14T06:00:00Z',permissions:['finance:read','payments:prepare','payments:approve','payments:submit','integrations:read','integrations:configure','integrations:sync']};
const bookkeeper:Principal={...owner,subject:'book',role:'bookkeeper',session_id:'s-2',permissions:['finance:read','payments:prepare']};
const viewer:Principal={...owner,subject:'viewer',role:'viewer',session_id:'s-3',permissions:['finance:read']};
const other:Principal={...owner,workspace_id:'ws-2',session_id:'s-4'};
const evidence=(id='doc-1'):InvoiceEvidence=>({documentId:id,invoiceId:`inv-${id}`,sourceHash:createHash('sha256').update(`fictional:${id}`).digest('hex'),confirmed:true,archived:false,rejected:false,totalMinor:10235,allocatedMinor:235,currency:'EUR',creditorName:'Fictional GmbH & Co',creditorIban:iban(),reference:'Invoice F-001',dueDate:'2026-11-01',matchIds:['accepted-partial-match']});
let db:Database.Database,records:InvoiceEvidence[],now:Date,service:CommunityPaymentService<{records:InvoiceEvidence[]}>,fake:ReturnType<typeof localFakeAdapters>;
beforeEach(()=>{
  db=new Database(':memory:');upCommunityPayments003(db);records=[evidence()];now=new Date('2026-10-14T06:00:00Z');fake=localFakeAdapters(LOCAL_FAKE_BANK_MARKER);
  service=new CommunityPaymentService({db,now:()=>now,adapter:fake.payment,authorize:(p,permission)=>p.permissions.includes(permission),recentAuth:p=>!!p.reauthenticated_at&&Date.parse(p.reauthenticated_at)>=now.getTime()-5*60000,csrf:(_p,token)=>token==='trusted-csrf',credentialResolver:{resolve:async()=>({synthetic:true})},accounting:{loadState:()=>({records}),persistAndActivate:()=>{},invoiceEvidence:s=>s.records,confirmedReconciliation:(_s,_w,_b,id)=>id==='confirmed-bank-match'}});
  db.prepare('INSERT INTO community_bank_connections(workspace_id,subject,provider,environment,account_ref,vault_ref,configured_at) VALUES (?,?,?,?,?,?,?)').run('ws-1','owner','local-fake-bank','mock','fictional','vault:fictional',now.toISOString());
});
const draft=()=>service.createDraft(owner,['doc-1'],iban('000000001234567891'),'Fictional Debtor');
const approved=()=>{let b=draft();b=service.validate(owner,b.id,b.revision);b=service.review(owner,b.id,b.revision);return service.approve(owner,b.id,b.revision)};
describe('payment qualification with fictional checksummed IBANs',()=>{
  it('computes partial outstanding integer totals and stable XML with escaped text',()=>{
    expect(validIban(iban())).toBe(true);expect(validIban(iban().slice(0,2)+'00'+iban().slice(4))).toBe(false);
    const b=draft();expect(b.items[0].amountMinor).toBe(10000);expect(b.items[0].matchIds).toEqual(['accepted-partial-match']);
    const v=service.validate(owner,b.id,b.revision),xml=service.export(owner,v.id);expect(xml.controlSumMinor).toBe(10000);expect(xml.count).toBe(1);expect(xml.xml).toContain('Fictional GmbH &amp; Co');
    expect(service.export(owner,v.id).sha256).toBe(xml.sha256);
    const parsed=new XMLParser({ignoreAttributes:false}).parse(xml.xml);const root=parsed.Document.CstmrCdtTrfInitn;expect(root.GrpHdr.NbOfTxs).toBe(1);expect(root.GrpHdr.CtrlSum).toBe(100);expect(root.PmtInf.CdtTrfTxInf.Amt.InstdAmt['#text']).toBe(100);
    expect(xml.sha256).toBe(createHash('sha256').update(xml.xml).digest('hex'));
    validatePsaAssertions(parseSepaXmlSecure(Buffer.from(xml.xml)));
  });
  it('rejects incomplete, excluded, paid, foreign currency and invalid reference evidence',()=>{
    const cases=[{confirmed:false},{archived:true},{rejected:true},{allocatedMinor:10235},{currency:'USD'},{creditorIban:'DE000'},{creditorName:null},{reference:'RF00123'},{dueDate:'2026-02-30'}];
    for(const change of cases)expect(candidate({...evidence(),...change}).eligible).toBe(false);
    records=[{...evidence(),confirmed:false}];expect(()=>draft()).toThrow('CANDIDATE_REVIEW_REQUIRED');
  });
  it('prevents duplicate documents and stale evidence, including after partial balance changes',()=>{
    const b=draft();expect(()=>draft()).toThrow();records[0].allocatedMinor=240;expect(()=>service.validate(owner,b.id,b.revision)).toThrow('SOURCE_EVIDENCE_CHANGED');
  });
  it('detects mutated persisted detail before approval or submission',()=>{
    const b=draft();db.prepare('UPDATE community_payment_items SET amount_minor=1 WHERE batch_id=?').run(b.id);
    expect(()=>service.validate(owner,b.id,b.revision)).toThrow('PAYMENT_DETAIL_INTEGRITY_FAILURE');
  });
  it('allows the same external document identifier in a separate workspace without exposing the first batch',()=>{
    const first=draft();const second=service.createDraft(other,['doc-1'],iban('000000001234567891'),'Other Fictional Debtor');
    expect(second.id).not.toBe(first.id);expect(service.repo.get(first.id,other.workspace_id)).toBeNull();
  });
  it('cancels before submission and permits a corrected fresh draft while retaining history',()=>{
    const b=draft();const cancelled=service.cancel(owner,b.id,b.revision);expect(cancelled.status).toBe('cancelled');
    const replacement=draft();expect(replacement.id).not.toBe(b.id);expect(service.repo.audit(b.id,owner.workspace_id).map((e:any)=>e.action)).toEqual(['created','cancelled']);
  });
  it('enforces roles, workspace scope, revision and material edit invalidation',()=>{
    expect(()=>service.createDraft(viewer,['doc-1'],iban(),'Fictional')).toThrow('FORBIDDEN');
    let b=service.createDraft(bookkeeper,['doc-1'],iban(),'Fictional');
    expect(service.repo.get(b.id,other.workspace_id)).toBeNull();
    expect(()=>service.review(bookkeeper,b.id,b.revision)).toThrow('REVISION_CONFLICT');
    b=service.validate(bookkeeper,b.id,b.revision);b=service.review(bookkeeper,b.id,b.revision);
    expect(()=>service.approve(bookkeeper,b.id,b.revision)).toThrow('FORBIDDEN');
    b=service.approve(owner,b.id,b.revision);
    expect(()=>service.approve(owner,b.id,b.revision-1)).toThrow('REVISION_CONFLICT');
    b=service.editDebtor(bookkeeper,b.id,b.revision,iban('000000001234567892'),'Changed Debtor');expect(b.status).toBe('draft');expect(b.approver).toBeUndefined();
    expect(()=>service.issueConfirmation(owner,b.id,b.revision)).toThrow('APPROVAL_STALE');
  });
  it('claims once before transport, refuses duplicate and foreign confirmations',async()=>{
    const b=approved();const confirmation=service.issueConfirmation(owner,b.id,b.revision);
    await expect(service.submit(other,b.id,b.revision,confirmation.token)).rejects.toThrow('APPROVAL_STALE');
    const [a,b2]=await Promise.allSettled([service.submit(owner,b.id,b.revision,confirmation.token),service.submit(owner,b.id,b.revision,confirmation.token)]);
    expect([a.status,b2.status].sort()).toEqual(['fulfilled','rejected']);expect(fake.calls.submit).toBe(1);
    await expect(service.submit(owner,b.id,b.revision,confirmation.token)).rejects.toThrow();expect(fake.calls.submit).toBe(1);
    expect(service.repo.get(b.id,owner.workspace_id)?.status).toBe('acknowledged');
  });
  it('expires one-use confirmation and requires recent authentication',async()=>{
    const b=approved();const c=service.issueConfirmation(owner,b.id,b.revision);now=new Date(now.getTime()+121000);
    await expect(service.submit(owner,b.id,b.revision,c.token)).rejects.toThrow('CONFIRMATION_INVALID');expect(fake.calls.submit).toBe(0);
    expect(()=>service.issueConfirmation({...owner,reauthenticated_at:'2026-10-14T05:00:00Z'},b.id,b.revision)).toThrow('RECENT_AUTH_REQUIRED');
  });
  it('leaves a persisted claim unknown after timeout and only reads status',async()=>{
    const b=approved(),c=service.issueConfirmation(owner,b.id,b.revision);fake.setOutcome('unknown');
    const result=await service.submit(owner,b.id,b.revision,c.token);expect(result.status).toBe('unknown');expect(fake.calls.submit).toBe(1);
    fake.setOutcome('acknowledged');const latest=await service.reconcileProvider(owner,b.id,result.revision);expect(latest.status).toBe('acknowledged');expect(fake.calls.submit).toBe(1);expect(fake.calls.status).toBe(1);
    const again=service.providerCallback({provider:'local-fake-bank',callbackId:'cb-1',claimId:latest.claimId!,outcome:'acknowledged'});expect(again?.status).toBe('acknowledged');
    service.providerCallback({provider:'local-fake-bank',callbackId:'cb-1',claimId:latest.claimId!,outcome:'acknowledged'});expect(fake.calls.submit).toBe(1);
  });
  it('treats thrown transport errors as unknown with one adapter call',async()=>{
    const b=approved(),c=service.issueConfirmation(owner,b.id,b.revision);
    fake.payment.submit=async()=>{fake.calls.submit++;throw new Error('synthetic timeout with secret details')};
    const result=await service.submit(owner,b.id,b.revision,c.token);expect(result.status).toBe('unknown');expect(fake.calls.submit).toBe(1);
    await expect(service.submit(owner,b.id,b.revision,c.token)).rejects.toThrow('APPROVAL_STALE');expect(fake.calls.submit).toBe(1);
  });
  it('treats a crash after a durable claim as unknown and never resubmits',async()=>{
    const b=approved(),c=service.issueConfirmation(owner,b.id,b.revision);
    const claim=service.repo.transition(owner,b.id,b.revision,['approved'],'submission_claimed','submission_claimed',{claim_id:'crash-claim'});
    await expect(service.submit(owner,b.id,b.revision,c.token)).rejects.toThrow('APPROVAL_STALE');expect(fake.calls.submit).toBe(0);
    expect(service.repo.get(b.id,owner.workspace_id)?.claimId).toBe('crash-claim');expect(claim.status).toBe('submission_claimed');
  });
  it('preserves append-only audit and invalidates approvals and claims on restore',()=>{
    const b=approved(),events=service.repo.audit(b.id,owner.workspace_id);expect(events).toHaveLength(4);
    expect(()=>db.prepare('DELETE FROM community_payment_events').run()).toThrow('payment audit immutable');
    service.repo.invalidateActionableOnRestore();const next=service.repo.get(b.id,owner.workspace_id)!;expect(next.status).toBe('reviewed');expect(next.approver).toBeUndefined();expect(service.repo.audit(b.id,owner.workspace_id)).toHaveLength(5);
  });
  it('only reconciles against confirmed accounting evidence',()=>{
    const b=approved();const c=service.issueConfirmation(owner,b.id,b.revision);
    return service.submit(owner,b.id,b.revision,c.token).then(sent=>{expect(()=>service.markReconciled(owner,sent.id,sent.revision,'unconfirmed')).toThrow('MATCH_NOT_CONFIRMED');expect(service.markReconciled(owner,sent.id,sent.revision,'confirmed-bank-match').status).toBe('reconciled')});
  });
});
