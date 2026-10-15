import {expect,it} from 'vitest';
import {mkdtemp,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import PDFDocument from 'pdfkit';
import {CommunityDocumentService} from '../src/community/documents/service.js';
import {createEmptyState} from '../src/storage/json-store.js';
const owner={subject:'USR-synthetic-provenance',workspace_id:'WS-synthetic-provenance'};
const fields={invoice_number:'SYN-001',supplier_name:'Synthetic supplier',document_date:'2026-10-15',total_amount:'10.00',currency_code:'EUR'};
async function pdf(text:string){const doc=new PDFDocument(),pieces:Buffer[]=[];doc.on('data',x=>pieces.push(x));const result=new Promise<Buffer>(ok=>doc.on('end',()=>ok(Buffer.concat(pieces))));doc.text(text);doc.end();return result;}
it('a manual source ID cannot claim server-observed portal provenance',async()=>{
 const root=await mkdtemp(join(tmpdir(),'document-provenance-'));let state=createEmptyState('SYNTHETIC_PROVENANCE');
 try{
   const service=new CommunityDocumentService({root,getState:()=>state,persistAndActivate:(_before,next)=>{state=next;}});
   const {record}=await service.upload(owner,await pdf('Synthetic invoice'), 'synthetic.pdf','spotify:synthetic-user-claim');await service.correct(owner,record.id,fields);await service.confirm(owner,record.id);
   expect(state.documents.get(record.id)?.meta.portal_source_id).toBeUndefined();expect(record.source_kind).toBe('user-supplied');
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
it('confirmed-then-observed provenance survives canonical persistence and index reconstruction',async()=>{
 const root=await mkdtemp(join(tmpdir(),'document-provenance-'));let state=createEmptyState('SYNTHETIC_PROVENANCE_RECOVERY');
 try{
   const service=new CommunityDocumentService({root,getState:()=>state,persistAndActivate:(_before,next)=>{state=next;}}),bytes=await pdf('Synthetic confirmed invoice');
   const {record}=await service.upload(owner,bytes,'manual.pdf');await service.correct(owner,record.id,fields);await service.confirm(owner,record.id);
   const sourceBefore=state.documents.get(record.id)!.source_document_ref;
   await service.upload(owner,bytes,'portal.pdf','spotify:synthetic-later-observation','invoice-bot');
   expect(state.documents.get(record.id)?.meta.portal_source_refs).toEqual(['spotify:synthetic-later-observation']);expect(state.documents.get(record.id)?.source_document_ref).toBe(sourceBefore);
   await unlink(join(root,'document-index-v1.json'));
   const recovered=new CommunityDocumentService({root,getState:()=>state,persistAndActivate:(_before,next)=>{state=next;}});
   expect((await recovered.list(owner))[0].source_refs).toContainEqual({source_id:'spotify:synthetic-later-observation',kind:'invoice-bot'});
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
it('hash dedupe preserves additional server-observed sources and rejects changed bytes for observed identities',async()=>{
 const root=await mkdtemp(join(tmpdir(),'document-provenance-'));let state=createEmptyState('SYNTHETIC_PROVENANCE');
 try{
   const service=new CommunityDocumentService({root,getState:()=>state,persistAndActivate:(_before,next)=>{state=next;}}),bytes=await pdf('Synthetic invoice');
   const {record}=await service.upload(owner,bytes,'manual.pdf');const observed=await service.upload(owner,bytes,'portal.pdf','spotify:synthetic-observation','invoice-bot');expect(observed.duplicate).toBe(true);expect(observed.record.id).toBe(record.id);
   expect(observed.record.source_refs).toContainEqual({source_id:'spotify:synthetic-observation',kind:'invoice-bot'});
   await service.correct(owner,record.id,fields);await service.confirm(owner,record.id);expect(state.documents.get(record.id)?.meta.portal_source_refs).toEqual(['spotify:synthetic-observation']);
   await expect(service.upload(owner,await pdf('Different synthetic bytes'),'changed.pdf','spotify:synthetic-observation','invoice-bot')).rejects.toMatchObject({code:'SOURCE_CONFLICT'});expect((await service.list(owner))).toHaveLength(1);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
