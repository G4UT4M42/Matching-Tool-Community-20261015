import {isDeepStrictEqual} from 'node:util';
import type {AuditEvent} from '../../core/types.js';
import {DocumentInputError,type RecognizedInvoice} from './recognition.js';
import type {DocumentRecord,ReviewFields} from './service.js';
import {checkedDocumentAmounts} from './amount-contract.js';
const problem=(code:string,message:string):never=>{throw new DocumentInputError(code,message);};
export type ReviewSnapshot = Omit<DocumentRecord, 'recognition' | 'history'>;
export const jsonCopy = <T>(value:T):T => JSON.parse(JSON.stringify(value)) as T;
export const snapshot = (record:DocumentRecord):ReviewSnapshot => {
  const {recognition:_recognition,history:_history,...review}=record; return jsonCopy(review);
};
export const same = (left:unknown,right:unknown) => isDeepStrictEqual(jsonCopy(left),jsonCopy(right));
export const immutableReview = (record:DocumentRecord) => {
  const {fields:_fields,status:_status,archived_from:_archived,source_refs:_refs,...identity}=snapshot(record); return identity;
};
function validateFields(fields:ReviewFields,maxText=100000):void{
  // Recognition suggestions may be incomplete or longer than editable values;
  // they remain review evidence until the stricter correction/confirm contract.
  if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.entries(fields).some(([key,value])=>!['document_type','invoice_number','supplier_name','document_date','total_amount_minor','net_amount_minor','vat_amount_minor','currency_code','payment_reference','iban','due_date'].includes(key)||value!==undefined&&(key.endsWith('_minor')?!Number.isSafeInteger(value):typeof value!=='string'||value.length>maxText))||fields.document_type!==undefined&&!['invoice','credit_note'].includes(fields.document_type)) problem('INVALID_STORAGE','Invalid audited document fields');
}
export function validateReviewRecord(record:DocumentRecord):void {
  if(!record||Object.keys(record).some(key=>!['id','workspace_id','owner_subject','filename','hash','mime','bytes','pages','status','archived_from','fields','recognition','source_id','source_kind','source_refs','history','created_at'].includes(key)))problem('INVALID_STORAGE','Unknown audited document field');
  if(!record||typeof record.id!=='string'||!/^[\w.:-]{1,160}$/.test(record.id)||typeof record.workspace_id!=='string'||!/^[\w.:-]{1,100}$/.test(record.workspace_id)||typeof record.owner_subject!=='string'||record.owner_subject!==''&&!/^[\w.:-]{1,100}$/.test(record.owner_subject)||typeof record.filename!=='string'||!record.filename||record.filename.length>200||/[\\/\u0000-\u001f]/.test(record.filename)||!/^[a-f0-9]{64}$/.test(record.hash)||typeof record.mime!=='string'||record.mime.length>100||!Number.isSafeInteger(record.bytes)||record.bytes<1||record.bytes>256*1024*1024||!Number.isSafeInteger(record.pages)||record.pages<0||record.pages>10||!['review','confirmed','rejected','archived'].includes(record.status)||record.archived_from!==undefined&&!['review','confirmed','rejected'].includes(record.archived_from)||typeof record.created_at!=='string'||!Number.isFinite(Date.parse(record.created_at))) problem('INVALID_STORAGE','Invalid audited document identity');
  validateFields(record.fields);
  if(record.source_id!==undefined&&(typeof record.source_id!=='string'||!/^[\w.:-]{1,160}$/.test(record.source_id))||record.source_kind!==undefined&&!['user-supplied','invoice-bot'].includes(record.source_kind)||record.source_refs!==undefined&&(!Array.isArray(record.source_refs)||record.source_refs.length>100||record.source_refs.some(ref=>!ref||Object.keys(ref).some(key=>!['source_id','kind'].includes(key))||typeof ref.source_id!=='string'||!/^[\w.:-]{1,160}$/.test(ref.source_id)||!['user-supplied','invoice-bot'].includes(ref.kind)))) problem('INVALID_STORAGE','Invalid audited document provenance');
  if(!record.recognition||typeof record.recognition.raw_text!=='string'||record.recognition.raw_text.length>4*1024*1024||!Number.isFinite(record.recognition.confidence)||record.recognition.confidence<0||record.recognition.confidence>1||!Array.isArray(record.recognition.warnings)||record.recognition.warnings.length>1000||record.recognition.warnings.some(value=>typeof value!=='string'||value.length>10000)||!Array.isArray(record.history)||record.history.length>100000||record.history.some(entry=>!entry||Object.keys(entry).some(key=>!['at','actor','action','fields'].includes(key))||typeof entry.at!=='string'||entry.at.length>40||!Number.isFinite(Date.parse(entry.at))||typeof entry.actor!=='string'||entry.actor.length>200||typeof entry.action!=='string'||entry.action.length>100)) problem('INVALID_STORAGE','Invalid audited document review evidence');
  for(const entry of record.history)if(entry.fields!==undefined)validateFields(entry.fields);
}

/** Bounded canonical audit replay; callers must verify referenced attachment bytes. */
export function recoverAuditedDocumentReviews(events:readonly AuditEvent[]):DocumentRecord[]{
  if(!Array.isArray(events)||events.length>1000000)problem('INVALID_STORAGE','Document review audit exceeds supported size');
  const recovered=new Map<string,DocumentRecord>();
    for(const event of events){
      if(event.entity_type!=='Document'||event.after?.document_review_version===undefined)continue;
      const after=event.after;
      if(after.document_review_version!==1||Object.keys(after).some(key=>!['document_review_version','operation','review','history_entry','baseline'].includes(key))||!after.review||typeof after.review!=='object'||Array.isArray(after.review)||!after.history_entry||typeof after.history_entry!=='object'||Array.isArray(after.history_entry)||Buffer.byteLength(JSON.stringify(after))>8*1024*1024)problem('INVALID_STORAGE','Invalid document review audit');
      if(Object.keys(after.review as object).some(key=>['recognition','history'].includes(key)))problem('INVALID_STORAGE','Invalid document review snapshot');
      const previous=recovered.get(event.entity_id);
      const baseline=after.baseline as {recognition:RecognizedInvoice;history:DocumentRecord['history']}|undefined;
      if(!previous&&!baseline||previous&&baseline)problem('INVALID_STORAGE','Missing or repeated document review baseline');
      if(baseline&&(Object.keys(baseline).some(key=>!['recognition','history'].includes(key))||!Array.isArray(baseline.history)||baseline.history.length>100000))problem('INVALID_STORAGE','Invalid document review baseline');
      const entry=jsonCopy(after.history_entry) as DocumentRecord['history'][number];
      const record={...jsonCopy(after.review as ReviewSnapshot),recognition:previous?.recognition??jsonCopy(baseline!.recognition),history:previous?.history??jsonCopy(baseline!.history)} as DocumentRecord;
      // Validate the baseline once, then each new entry. Replay is linear in
      // retained history, and never mutates the canonical input events.
      validateReviewRecord({...record,history:previous?[entry]:[...record.history,entry]});
      if(record.history.length>=100000)problem('INVALID_STORAGE','Document review history exceeds supported size');
      record.history.push(entry);
      if(!['uploaded','corrected','confirmed','imported','reject','archive','restore','source_observed:user-supplied','source_observed:invoice-bot'].includes(String(after.operation)))problem('INVALID_STORAGE','Invalid document review operation');
      if(event.entity_id!==record.id||event.actor_type!=='user'||record.history.at(-1)!.actor!==event.actor_id||record.history.at(-1)!.action!==after.operation)problem('INVALID_STORAGE','Document review audit actor or identity mismatch');
      const before=event.before?.review as ReviewSnapshot|null|undefined;
      if(before===undefined||before!==null&&(typeof before!=='object'||Array.isArray(before)))problem('INVALID_STORAGE','Missing document before evidence');
      if(before){
        const prior={...before,recognition:record.recognition,history:[]};validateReviewRecord(prior);
        if(!same(immutableReview(prior),immutableReview(record))||previous&&(!same(snapshot(previous),before)))problem('SOURCE_CONFLICT','Document audit before evidence disagrees');
        if(after.operation!=='corrected'&&!same(before.fields,record.fields))problem('SOURCE_CONFLICT','Document fields changed outside correction');
        if(!String(after.operation).startsWith('source_observed:')&&!same(before.source_refs??[],record.source_refs??[]))problem('SOURCE_CONFLICT','Document provenance changed outside observation');
      }
      if(after.operation==='uploaded'&&(before!==null||previous||record.status!=='review'||baseline!.history.length!==0)||after.operation==='imported'&&(before!==null||previous||record.status!=='confirmed'||baseline!.history.length!==0)||!['uploaded','imported'].includes(String(after.operation))&&!before)problem('INVALID_STORAGE','Invalid initial document review transition');
      if(after.operation==='corrected'&&(before!.status!=='review'||record.status!=='review')||after.operation==='confirmed'&&(before!.status!=='review'||record.status!=='confirmed')||after.operation==='reject'&&(before!.status!=='review'||record.status!=='rejected')||after.operation==='archive'&&(before!.status==='archived'||record.status!=='archived'||record.archived_from!==before!.status)||after.operation==='restore'&&(before!.status!=='archived'||record.status!==(before!.archived_from??'review')||record.archived_from!==undefined))problem('INVALID_STORAGE','Invalid document review transition');
      if(String(after.operation).startsWith('source_observed:')){
        const added=(record.source_refs??[]).filter(ref=>!before!.source_refs?.some(old=>same(ref,old)));
        if(record.status!==before!.status||added.length!==1||after.operation!=='source_observed:'+added[0].kind)problem('INVALID_STORAGE','Invalid document source observation');
      }
      if(before){
        const expected=jsonCopy(before);
        if(after.operation==='corrected')expected.fields=record.fields;
        else if(after.operation==='confirmed')expected.status='confirmed';
        else if(after.operation==='reject')expected.status='rejected';
        else if(after.operation==='archive'){expected.archived_from=before.status as DocumentRecord['archived_from'];expected.status='archived';}
        else if(after.operation==='restore'){expected.status=before.archived_from??'review';delete expected.archived_from;}
        else if(String(after.operation).startsWith('source_observed:'))expected.source_refs=record.source_refs;
        if(!same(expected,snapshot(record)))problem('SOURCE_CONFLICT','Unexpected audited document change');
      }
      if(after.operation==='corrected'||after.operation==='confirmed'){
        const fields=record.fields;
        validateFields(fields,200);
        if(!fields.invoice_number||!fields.supplier_name||!fields.document_date||!Number.isFinite(Date.parse(fields.document_date))||!fields.currency_code||!/^[A-Z]{3}$/.test(fields.currency_code))problem('INVALID_STORAGE','Incomplete audited financial review');
        checkedDocumentAmounts(fields.document_type,fields.total_amount_minor!,fields.net_amount_minor,fields.vat_amount_minor);
      }
      if(previous&&(!same(immutableReview(previous),immutableReview(record))||previous.source_refs?.some(ref=>!record.source_refs?.some(next=>same(ref,next)))))problem('SOURCE_CONFLICT','Audited document source evidence changed');
      if((after.operation==='corrected'||after.operation==='confirmed')&&(!entry.fields||!same(entry.fields,record.fields)))problem('INVALID_STORAGE','Document history fields disagree');
      recovered.set(record.id,record);
    }
  return [...recovered.values()];
}
