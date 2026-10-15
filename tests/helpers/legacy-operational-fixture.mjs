import Database from 'better-sqlite3';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCompleteLegacyFixture} from './complete-legacy-fixture.mjs';

/** Independent fictional historical operations, with real linked source bytes. */
export function createOperationalLegacyFixture(root){
 const fixture=createCompleteLegacyFixture(root),db=new Database(join(root,'database','matching.db'));
 const at='2025-06-15T12:00:00.000Z',digest=fixture.state.documents['SYN-D3'].file_hash;
 const screenshot=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9kAAAAASUVORK5CYII=','base64'),screenshotHash=createHash('sha256').update(screenshot).digest('hex');
 writeFileSync(join(root,'documents','SYN-OLD-REVIEW.png'),screenshot);
 const insert=(table,row)=>{const keys=Object.keys(row);db.prepare('INSERT INTO '+table+' ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(key=>row[key]));};
 try{
  for(const name of ['schema-invoicebot.sql','schema-costmonitor.sql'])db.exec(readFileSync(fileURLToPath(new URL('../../src/storage/'+name,import.meta.url)),'utf8'));
  insert('invoice_bot_portals',{id:'SYN-OLD-PORTAL',name:'Fictional historical portal',base_url:'https://example.invalid/orders',openclaw_profile:'SYNTHETIC-DO-NOT-ARCHIVE',created_at:at,updated_at:at});
  insert('invoice_bot_runs',{id:'SYN-OLD-RUN',portal_id:'SYN-OLD-PORTAL',requested_start:'2025-06-01',requested_end:'2025-06-30',status:'completed',started_at:at,finished_at:at,error_message:'SYNTHETIC-DO-NOT-ARCHIVE',stats_json:'{"found":1,"downloaded":1,"imported":1,"duplicates":0,"failed":0}',created_at:at,updated_at:at});
  insert('invoice_bot_files',{id:'SYN-OLD-FILE',run_id:'SYN-OLD-RUN',portal_id:'SYN-OLD-PORTAL',original_filename:'SYN-D3.txt',stored_path:'SYN-D3.txt',sha256:digest,invoice_date:'2025-06-15',supplier_hint:'Fictional vendor 3',import_status:'imported',document_id:'SYN-D3',created_at:at,updated_at:at});
  insert('invoice_bot_events',{id:'SYN-OLD-EVENT',run_id:'SYN-OLD-RUN',level:'info',code:'IMPORT_COMPLETED',message:'SYNTHETIC-DO-NOT-ARCHIVE',payload_json:'{"synthetic_private_note":"SYNTHETIC-DO-NOT-ARCHIVE"}',created_at:at});
  insert('invoice_bot_artifacts',{id:'SYN-OLD-ARTIFACT',run_id:'SYN-OLD-RUN',type:'download',local_path:'SYN-D3.txt',mime_type:'text/plain',sha256:digest,source_url:'https://example.invalid/orders/private',label:'Fictional invoice original',size_bytes:fixture.attachments['SYN-D3'].length,created_at:at});
  insert('invoice_bot_artifacts',{id:'SYN-OLD-SCREENSHOT',run_id:'SYN-OLD-RUN',type:'screenshot',local_path:'SYN-OLD-REVIEW.png',mime_type:'image/png',sha256:screenshotHash,size_bytes:screenshot.length,created_at:at});
  insert('invoice_bot_extracted_invoices',{id:'SYN-OLD-EXTRACT',run_id:'SYN-OLD-RUN',portal_id:'SYN-OLD-PORTAL',supplier_name:'Fictional vendor 3',invoice_number:'SYN-INV-3',invoice_date:'2025-06-15',currency:'EUR',gross_total_minor:10000,portal_reference:'SYN-ORDER-3',downloaded_filename:'SYN-D3.txt',artifact_id:'SYN-OLD-ARTIFACT',sha256:digest,extraction_confidence:0.75,requires_review:1,evidence_artifact_id:'SYN-OLD-SCREENSHOT',import_status:'imported',document_id:'SYN-D3',created_at:at,updated_at:at});
  insert('ai_cost_sessions',{id:'SYN-OLD-COST',started_at:at,ended_at:at,source:'invoicerec',total_tokens:30,prompt_tokens:20,completion_tokens:10,total_cost_usd:0.0027,call_count:1,status:'completed'});
  insert('ai_cost_entries',{id:1,session_id:'SYN-OLD-COST',created_at:at,model:'fictional-synthetic-model',prompt_tokens:20,completion_tokens:10,total_tokens:30,cost_usd:0.0027,source:'invoicerec',context:'SYNTHETIC-DO-NOT-ARCHIVE'});
  db.pragma('wal_checkpoint(TRUNCATE)');db.pragma('journal_mode=DELETE');
  const operationalTables=['invoice_bot_portals','invoice_bot_runs','invoice_bot_files','invoice_bot_events','invoice_bot_artifacts','invoice_bot_extracted_invoices','ai_cost_sessions','ai_cost_entries'];
  return {...fixture,operationalTables,operationalAttachments:{[digest]:fixture.attachments['SYN-D3'],[screenshotHash]:screenshot},operationalRows:Object.fromEntries(operationalTables.map(table=>[table,db.prepare('SELECT * FROM '+table).all()]))};
 }finally{db.close();}
}
