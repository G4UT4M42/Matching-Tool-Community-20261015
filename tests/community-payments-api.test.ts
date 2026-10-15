import { describe,it,expect } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { createHash } from 'node:crypto';
import { upCommunityPayments003 } from '../src/migrations/003-community-payments.js';
import { CommunityPaymentService } from '../src/community/payments/service.js';
import { createCommunityPaymentsRouter } from '../src/server/routes/community-payments.js';
import { localFakeAdapters,LOCAL_FAKE_BANK_MARKER } from '../src/community/banking/mock.js';
import type { Principal,InvoiceEvidence } from '../src/community/payments/types.js';

const iban=(bban:string)=>{let rem=0;for(const digit of bban+'131400')rem=(rem*10+Number(digit))%97;return `DE${String(98-rem).padStart(2,'0')}${bban}`};
const creditor=iban('000000001234567890'),debtor=iban('000000001234567891');
const evidence:InvoiceEvidence={documentId:'fictional-doc',invoiceId:'fictional-invoice',sourceHash:createHash('sha256').update('fictional').digest('hex'),confirmed:true,archived:false,rejected:false,totalMinor:12345,allocatedMinor:345,currency:'EUR',creditorName:'Fictional Supplier',creditorIban:creditor,reference:'FIC-001',dueDate:'2026-11-01',matchIds:[]};
const owner:Principal={subject:'owner',workspace_id:'one',session_id:'session',role:'owner',authenticated_at:'2026-10-14T06:00:00Z',reauthenticated_at:'2026-10-14T06:00:00Z',permissions:['finance:read','payments:prepare','payments:approve','payments:submit']};
describe('authenticated payment HTTP contract',()=>{
  it('rejects anonymous, forged and CSRF-less writes, and ignores hidden amounts',async()=>{
    const db=new Database(':memory:');upCommunityPayments003(db);const fake=localFakeAdapters(LOCAL_FAKE_BANK_MARKER);
    const service=new CommunityPaymentService({db,adapter:fake.payment,now:()=>new Date('2026-10-14T06:00:00Z'),authorize:(p,permission)=>p.permissions.includes(permission),recentAuth:()=>true,csrf:(_p,token)=>token==='valid-csrf',credentialResolver:{resolve:async()=>({})},accounting:{loadState:()=>({}),persistAndActivate:()=>{},invoiceEvidence:()=>[evidence],confirmedReconciliation:()=>false}});
    const app=express();app.use(express.json());app.use((_req,res,next)=>{const role=_req.get('x-test-principal');if(role==='owner')res.locals.communityPrincipal=owner;if(role==='viewer')res.locals.communityPrincipal={...owner,subject:'viewer',role:'viewer',permissions:['finance:read']};next()});app.use('/api/community-payments',createCommunityPaymentsRouter(service));
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const address=server.address();if(!address||typeof address==='string')throw new Error('no listener');const base=`http://127.0.0.1:${address.port}/api/community-payments`;
    const post=(principal:string,csrf:string)=>fetch(base+'/batches',{method:'POST',headers:{'content-type':'application/json','x-test-principal':principal,'x-csrf-token':csrf},body:JSON.stringify({documentIds:['fictional-doc'],debtorIban:debtor,debtorName:'Fictional Debtor',amountMinor:1,actor:'owner',role:'owner'})});
    try{
      expect((await post('','valid-csrf')).status).toBe(401);expect((await post('viewer','valid-csrf')).status).toBe(403);expect((await post('owner','')).status).toBe(403);
      const response=await post('owner','valid-csrf');expect(response.status).toBe(201);const batch=await response.json() as {id:string;items:Array<{amountMinor:number;creditorIban:string}>};expect(batch.items[0].amountMinor).toBe(12000);expect(batch.items[0].creditorIban).toBe(creditor);
      expect((await post('owner','valid-csrf')).status).toBe(400);
      expect((await fetch(base+'/batches/'+batch.id,{headers:{'x-test-principal':'viewer'}})).status).toBe(200);
    }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));db.close()}
  });
});
