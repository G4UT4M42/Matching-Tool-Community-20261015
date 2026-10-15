import {afterEach,describe,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createEmptyState} from '../src/storage/json-store.js';
import {recordAudit} from '../src/observability/audit.js';
import {extractLegacyOperationalHistory,legacyOperationalEvidenceReferences,type LegacyOperationalExtraction} from '../src/community/persistence/legacy-operational-history.js';
const original=Buffer.from('Synthetic original financial evidence'),hash=createHash('sha256').update(original).digest('hex'),at='2026-10-15T00:00:00Z';
const dbs:Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();}); // All datasets are in memory; no filesystem deletion.
function fixture(){
  const db=new Database(':memory:');dbs.push(db);
  db.exec(readFileSync(new URL('../src/storage/schema-invoicebot.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../src/storage/schema-costmonitor.sql',import.meta.url),'utf8'));
  db.exec('CREATE TABLE documents(document_id TEXT PRIMARY KEY,file_hash TEXT); ALTER TABLE invoice_bot_portals ADD COLUMN credential_ref TEXT; ALTER TABLE invoice_bot_portals ADD COLUMN task_prompt TEXT; ALTER TABLE invoice_bot_runs ADD COLUMN total_cost REAL; ALTER TABLE invoice_bot_runs ADD COLUMN total_tokens INTEGER;');
  db.prepare('INSERT INTO documents VALUES(?,?)').run('SYN-DOC',hash);
  db.prepare('INSERT INTO invoice_bot_portals(id,name,base_url,default_download_path,credential_ref,task_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('SYN-PORTAL','Fictional provider','https://fictional.invalid/?access_token=synthetic-secret','C:\\synthetic-private\\downloads','synthetic-secret-reference','synthetic-secret-prompt',at,at);
  db.prepare('INSERT INTO invoice_bot_runs(id,portal_id,requested_start,requested_end,status,error_message,stats_json,total_cost,total_tokens,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('SYN-RUN','SYN-PORTAL','2026-10-01','2026-10-15','completed','synthetic-secret-error','{"found":1,"downloaded":1,"imported":1,"duplicates":0,"failed":0}',0.1,3,at,at);
  db.prepare('INSERT INTO invoice_bot_files(id,run_id,portal_id,original_filename,stored_path,sha256,import_status,document_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('SYN-FILE','SYN-RUN','SYN-PORTAL','synthetic.txt','synthetic/original.txt',hash,'imported','SYN-DOC',at,at);
  db.prepare('INSERT INTO invoice_bot_events(id,run_id,level,code,message,payload_json,created_at) VALUES(?,?,?,?,?,?,?)').run('SYN-EVENT','SYN-RUN','info','RUN_COMPLETED','Bearer synthetic-secret-log','{"password":"synthetic-secret-payload"}',at);
  db.prepare('INSERT INTO invoice_bot_artifacts(id,run_id,type,local_path,mime_type,sha256,source_url,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('SYN-ARTIFACT','SYN-RUN','download','synthetic/original.txt','text/plain',hash,'https://fictional.invalid/?token=synthetic-secret-url',original.length,at);
  db.prepare('INSERT INTO invoice_bot_extracted_invoices(id,run_id,portal_id,supplier_name,invoice_number,invoice_date,currency,gross_total_minor,downloaded_filename,artifact_id,sha256,extraction_confidence,source_url,import_status,document_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('SYN-EXTRACTED','SYN-RUN','SYN-PORTAL','Fictional Seller','SYN-INVOICE','2026-10-01','EUR',12000,'synthetic.txt','SYN-ARTIFACT',hash,0.9,'https://fictional.invalid/?token=synthetic-secret-source','imported','SYN-DOC',at,at);
  db.prepare('INSERT INTO ai_cost_sessions(id,started_at,total_tokens,prompt_tokens,completion_tokens,total_cost_usd,call_count,status) VALUES(?,?,?,?,?,?,?,?)').run('SYN-COST',at,3,2,1,0.1,1,'completed');
  db.prepare('INSERT INTO ai_cost_entries(id,session_id,created_at,model,prompt_tokens,completion_tokens,total_tokens,cost_usd,context) VALUES(?,?,?,?,?,?,?,?,?)').run(9,'SYN-COST',at,'synthetic-model',2,1,3,0.1,'synthetic-secret-context');
  return db;
}
function archived(result:LegacyOperationalExtraction){
  const state=createEmptyState('SYNTHETIC-LEGACY-OPERATIONS');state.documents.set('SYN-DOC',{document_id:'SYN-DOC',source_system:'upload',source_document_ref:'SYN-INVOICE',captured_at:at,document_date:'2026-10-01',total_amount_minor:12000,currency_code:'EUR',filename:'synthetic.txt',file_hash:hash,meta:{}});
  for(const row of result.rows){
    const identity='LEGACY-OPERATIONAL-'+createHash('sha256').update(JSON.stringify([row.table,row.id,row.source_sha256])).digest('hex');
    const event=recordAudit(state,'STATE_COMMITTED','Run',identity,{actor_type:'system',actor_id:'legacy-migration',after:{legacy_operational_history_version:1,...row,evidence:result.evidence.filter(item=>item.table===row.table&&item.id===row.id).map(item=>({path:'legacy-evidence/'+item.sha256,sha256:item.sha256,bytes:original.length,...(item.mime_type?{mime_type:item.mime_type}:{})}))}});
    event.audit_id=identity;event.timestamp=row.timestamp;
  }
  return state;
}
describe('secret-free immutable legacy operational history',()=>{
  it('extracts all eight known linked tables read-only, retaining exact typed financial and cost evidence',()=>{
    const db=fixture(),before=db.serialize(),result=extractLegacyOperationalHistory(db);
    expect(db.serialize().equals(before)).toBe(true);expect(result.rows).toHaveLength(8);expect(result.evidence).toHaveLength(3);
    expect(JSON.stringify(result.rows)).not.toContain('synthetic-secret');expect(JSON.stringify(result.rows)).not.toContain('synthetic-private');expect(JSON.stringify(result.rows)).not.toContain('https://');
    const invoice=result.rows.find(row=>row.table==='invoice_bot_extracted_invoices')!;
    expect(invoice.fields).toMatchObject({id:'SYN-EXTRACTED',run_id:'SYN-RUN',portal_id:'SYN-PORTAL',artifact_id:'SYN-ARTIFACT',document_id:'SYN-DOC',gross_total_minor:12000,currency:'EUR'});
    expect(result.rows.find(row=>row.table==='ai_cost_entries')!.fields).toMatchObject({id:9,total_tokens:3,cost_usd:0.1,source_real_bits:{cost_usd:'9a9999999999b93f'}});
    const portal=result.rows.find(row=>row.table==='invoice_bot_portals')!;expect(portal.fields).not.toHaveProperty('active');expect(portal.fields).not.toHaveProperty('credential_ref');expect(portal.omitted).toEqual(expect.arrayContaining([expect.objectContaining({field:'credential_ref',reason:'credential-reference',sha256:expect.stringMatching(/^[a-f0-9]{64}$/)})]));
    // Paths occur only in ephemeral requirements; extraction never reads them.
    expect(result.evidence.every(item=>item.source_path==='synthetic/original.txt')).toBe(true);
    expect(legacyOperationalEvidenceReferences(archived(result))).toEqual([{path:'legacy-evidence/'+hash,sha256:hash,bytes:original.length}]);
  });
  it('binds omitted source values by digest and is deterministic for identical input',()=>{
    const db=fixture(),first=extractLegacyOperationalHistory(db);expect(extractLegacyOperationalHistory(db)).toEqual(first);
    db.prepare('UPDATE invoice_bot_portals SET credential_ref=?').run('different-synthetic-secret');const changed=extractLegacyOperationalHistory(db);
    expect(changed.rows[0].fields).toEqual(first.rows[0].fields);expect(changed.rows[0].source_sha256).not.toBe(first.rows[0].source_sha256);expect(changed.rows[0].omitted).not.toEqual(first.rows[0].omitted);
  });
  it.each([
    ['invoice_bot_files','run_id','MISSING-RUN'],['invoice_bot_files','portal_id','MISSING-PORTAL'],['invoice_bot_files','document_id','MISSING-DOC'],['invoice_bot_files','sha256','b'.repeat(64)],['invoice_bot_extracted_invoices','artifact_id','MISSING-ARTIFACT'],['ai_cost_entries','session_id','MISSING-SESSION'],
  ])('rejects missing or conflicting %s.%s relationships', (table,column,value)=>{
    const db=fixture();db.pragma('foreign_keys=OFF'); // Deliberately corrupt only this in-memory negative fixture.
    db.prepare(`UPDATE ${table} SET ${column}=?`).run(value);expect(()=>extractLegacyOperationalHistory(db)).toThrow(/reference|hash/);
  });
  it('rejects unknown populated columns and prototype-looking names while allowing explicit empty omissions',()=>{
    const db=fixture();db.exec('ALTER TABLE invoice_bot_runs ADD COLUMN future_data TEXT');expect(extractLegacyOperationalHistory(db).rows.find(row=>row.table==='invoice_bot_runs')!.omitted).toContainEqual(expect.objectContaining({field:'future_data',reason:'unmapped-empty-column'}));
    db.prepare('UPDATE invoice_bot_runs SET future_data=?').run('must not guess');expect(()=>extractLegacyOperationalHistory(db)).toThrow('unmapped populated column');
    const other=fixture();other.exec('ALTER TABLE invoice_bot_runs ADD COLUMN toString TEXT');other.prepare('UPDATE invoice_bot_runs SET toString=?').run('must not inherit');expect(()=>extractLegacyOperationalHistory(other)).toThrow('unmapped populated column');
  });
  it.each(['2026-02-30','2025-02-29','2026-10-15T24:00:00Z'])('rejects rolled-over source date %s without correcting financial history',date=>{
    const db=fixture();db.prepare('UPDATE invoice_bot_runs SET requested_start=?').run(date);expect(()=>extractLegacyOperationalHistory(db)).toThrow('invalid date');
  });
  it('rejects unsafe integer precision and preflights source value/row bounds',()=>{
    const db=fixture();db.exec('UPDATE invoice_bot_runs SET total_tokens=9223372036854775807');expect(()=>extractLegacyOperationalHistory(db)).toThrow('exact range');
    const large=fixture();large.prepare('UPDATE invoice_bot_events SET message=?').run('x'.repeat(1024*1024+1));expect(()=>extractLegacyOperationalHistory(large)).toThrow('byte limit');
    const many=fixture(),insert=many.prepare('INSERT INTO invoice_bot_portals(id,name,base_url,created_at,updated_at) VALUES(?,?,?,?,?)');many.transaction(()=>{for(let i=0;i<10001;i++)insert.run('SYN-P-'+i,'Synthetic','https://fictional.invalid',at,at);})();expect(()=>extractLegacyOperationalHistory(many)).toThrow('row limit');
  });
  it('keeps unverified pending artifacts as metadata without inventing original bytes or confirmed invoices',()=>{
    const db=fixture();db.exec("DELETE FROM invoice_bot_files; UPDATE invoice_bot_artifacts SET type='html_snapshot',sha256=NULL; UPDATE invoice_bot_extracted_invoices SET sha256='',artifact_id=NULL,document_id=NULL,import_status='pending';");
    const result=extractLegacyOperationalHistory(db);expect(result.evidence).toEqual([]);expect(result.rows.find(row=>row.table==='invoice_bot_extracted_invoices')!.fields).toMatchObject({sha256:'',import_status:'pending',document_id:null});expect(legacyOperationalEvidenceReferences(archived(result))).toEqual([]);
  });
  it.each(['invoice_bot_files','invoice_bot_artifacts','invoice_bot_extracted_invoices'])('rejects dropping required original references for %s',table=>{
    const state=archived(extractLegacyOperationalHistory(fixture())),event=state.audit_events.find(item=>item.after?.table===table)!;event.after!.evidence=[];expect(()=>legacyOperationalEvidenceReferences(state)).toThrow('missing archived original');
  });
  it('revalidates archived relationships, exact real bits and strict portable evidence scope',()=>{
    const originalState=archived(extractLegacyOperationalHistory(fixture()));
    const missing=structuredClone(originalState);missing.audit_events=missing.audit_events.filter(event=>event.after?.table!=='invoice_bot_portals');expect(()=>legacyOperationalEvidenceReferences(missing)).toThrow('invalid reference');
    const real=structuredClone(originalState),entry=real.audit_events.find(event=>event.after?.table==='ai_cost_entries')!;delete(entry.after!.fields as Record<string,unknown>).source_real_bits;expect(()=>legacyOperationalEvidenceReferences(real)).toThrow('missing archived real');
    const path=structuredClone(originalState);((path.audit_events.find(event=>event.after?.table==='invoice_bot_files')!.after!.evidence as Array<{path:string}>)[0]).path='../identity';expect(()=>legacyOperationalEvidenceReferences(path)).toThrow('invalid archived original');
    const unsafe=structuredClone(originalState);(unsafe.audit_events[0].after!.fields as Record<string,unknown>).credential_ref='must not archive';expect(()=>legacyOperationalEvidenceReferences(unsafe)).toThrow('invalid archived fields');
  });
  it.each([['timestamp','2026-10-16T00:00:00Z'],['actor_id','different-system'],['audit_id','ALTERED-AUDIT'],['entity_id','ALTERED-ENTITY'],['run_id',''],['run_id',undefined],['before',{}]])('binds deterministic outer archive envelope %s', (field,value)=>{
    const state=archived(extractLegacyOperationalHistory(fixture()));Object.assign(state.audit_events[0],{[field]:value});expect(()=>legacyOperationalEvidenceReferences(state)).toThrow('audit envelope disagrees');
  });
  it('preserves a nullable historical download MIME without inventing or changing it',()=>{
    const db=fixture();db.exec('UPDATE invoice_bot_artifacts SET mime_type=NULL');const result=extractLegacyOperationalHistory(db);
    expect(result.rows.find(row=>row.table==='invoice_bot_artifacts')!.fields.mime_type).toBeNull();expect(result.evidence.find(row=>row.table==='invoice_bot_artifacts')).not.toHaveProperty('mime_type');
    const state=archived(result);expect(legacyOperationalEvidenceReferences(state)).toHaveLength(1);
    (state.audit_events.find(event=>event.after?.table==='invoice_bot_artifacts')!.after!.evidence as Array<Record<string,unknown>>)[0].mime_type='image/png';expect(()=>legacyOperationalEvidenceReferences(state)).toThrow('MIME disagrees');
  });
  it('preserves explicitly linked financial screenshots as distinct original evidence, excluding unlinked images',()=>{
    const db=fixture(),imageHash='c'.repeat(64);
    db.prepare('INSERT INTO invoice_bot_artifacts(id,run_id,type,local_path,mime_type,sha256,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?)').run('SYN-IMAGE','SYN-RUN','screenshot','synthetic/evidence.png','image/png',imageHash,original.length,at);
    db.prepare('UPDATE invoice_bot_extracted_invoices SET evidence_artifact_id=?').run('SYN-IMAGE');
    const result=extractLegacyOperationalHistory(db);expect(result.evidence).toHaveLength(4);expect(result.evidence).toContainEqual(expect.objectContaining({table:'invoice_bot_artifacts',id:'SYN-IMAGE',sha256:imageHash,mime_type:'image/png',source_path:'synthetic/evidence.png'}));
    const state=archived(result);expect(legacyOperationalEvidenceReferences(state)).toHaveLength(2);
    const dropped=structuredClone(state);dropped.audit_events.find(event=>event.after?.id==='SYN-IMAGE')!.after!.evidence=[];expect(()=>legacyOperationalEvidenceReferences(dropped)).toThrow('missing archived financial image');
    db.prepare('UPDATE invoice_bot_extracted_invoices SET evidence_artifact_id=NULL').run();const unlinked=extractLegacyOperationalHistory(db);expect(unlinked.evidence).toHaveLength(3);
    const forged=structuredClone(state);(forged.audit_events.find(event=>event.after?.id==='SYN-EXTRACTED')!.after!.fields as Record<string,unknown>).evidence_artifact_id=null;expect(()=>legacyOperationalEvidenceReferences(forged)).toThrow('unlinked archived image');
  });
  it.each([['sha256',null],['sha256','not-a-hash'],['local_path',''],['mime_type','text/html'],['type','log']])('rejects unsupported linked image %s', (field,value)=>{
    const db=fixture();db.prepare('INSERT INTO invoice_bot_artifacts(id,run_id,type,local_path,mime_type,sha256,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?)').run('SYN-IMAGE','SYN-RUN','screenshot','synthetic/evidence.png','image/png','c'.repeat(64),original.length,at);
    db.prepare('UPDATE invoice_bot_extracted_invoices SET evidence_artifact_id=?').run('SYN-IMAGE');db.prepare(`UPDATE invoice_bot_artifacts SET ${field}=? WHERE id=?`).run(value,'SYN-IMAGE');expect(()=>extractLegacyOperationalHistory(db)).toThrow(/evidence|invalid hash/);
  });
  it('preserves valid historical run identity when the current dataset run legitimately changes',()=>{
    const state=archived(extractLegacyOperationalHistory(fixture()));state.run_id='SYNTHETIC-LATER-RUN';expect(legacyOperationalEvidenceReferences(state)).toHaveLength(1);
  });
});
