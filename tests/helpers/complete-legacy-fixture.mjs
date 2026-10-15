import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const syntheticIban='DE36'+'0'.repeat(18);
const at='2025-06-15T12:00:00.000Z',actor='SYNTHETIC-LEGACY-OWNER';
/** Independent, fictional source generator shared by unit/API/browser qualification. */
export function createCompleteLegacyFixture(root){
  mkdirSync(join(root,'database'),{recursive:true});mkdirSync(join(root,'state'));mkdirSync(join(root,'documents'));
  const transactions={},documents={},match_groups={},attachments={};
  const amounts=[-12000,-6000,-5000,-125,-25000,25000,-700,8000,1000,-3000];
  const providers=['sparkasse','visa','paypal','stripe','enablebanking'];
  for(let i=0;i<amounts.length;i++){
    const id='SYN-T'+(i+1);transactions[id]={transaction_id:id,source_system:providers[i%providers.length],source_account_id:'SYN-ACCOUNT-'+(i%3+1),source_row_ref:'SYN-SOURCE-ROW-'+(i+1),posting_at:'2025-06-15',value_at:'2025-06-16',amount_minor:amounts[i],currency_code:'EUR',description_raw:'Fictional legacy economic event '+(i+1),counterparty_name:'Fictional vendor '+(i+1),counterparty_iban:syntheticIban,booking_reference:'SYN-BOOK-'+i,payment_reference:'SYN-PAY-'+i,tags:['synthetic','legacy'],meta:{synthetic:true,source_identifier:'SYN-EVENT-'+i}};
  }
  transactions['SYN-T10'].fx={original_amount_minor:-3300,original_currency_code:'USD',rate:0.909090909,rate_source:'synthetic-source-rate',fx_fee_minor:0};
  const totals=[12000,6000,10000,8000,1000,3000];
  for(let i=0;i<totals.length;i++){
    const id='SYN-D'+(i+1),bytes=Buffer.from('SYNTHETIC LEGACY RECEIPT '+id+'\nNo real personal or financial data.\n'),filename=id+'.txt';attachments[id]=bytes;
    writeFileSync(join(root,'documents',filename),bytes);
    documents[id]={document_id:id,source_system:i===3||i===4?'income':'upload',source_document_ref:'SYN-INVOICE-'+(i+1),captured_at:at,document_date:'2025-06-15',total_amount_minor:totals[i],currency_code:'EUR',supplier_name:'Fictional vendor '+(i+1),vat_amount_minor:i===0?2000:0,vat_rate:i===0?0.2:0,filename,file_hash:sha(bytes),line_items:[{description:'Fictional line '+(i+1),amount_minor:totals[i],quantity:1}],meta:{synthetic:true,invoice_number:'SYN-INV-'+(i+1)}};
  }
  for(const [id,status,tx,doc] of [['SYN-M1','accepted','SYN-T1','SYN-D1'],['SYN-M2','manual','SYN-T2','SYN-D2'],['SYN-M3','confirmed','SYN-T8','SYN-D4'],['SYN-M4','proposed','SYN-T10','SYN-D6'],['SYN-M5','rejected','SYN-T10','SYN-D6']])match_groups[id]={match_group_id:id,status,created_at:at,created_by:actor,rule_id:'SYNTHETIC-MANUAL',transaction_ids:[tx],document_ids:[doc],amount_total_minor:transactions[tx].amount_minor,currency_code:'EUR',evidence:{synthetic:true,reference:'SYN-EVIDENCE-'+id},reason_codes:['SYNTHETIC'],correlation_id:'SYN-CORR-'+id};
  const allocation=(id,kind,tx,minor,doc,docMinor,batch='SYN-ALLOCATION-BATCH-'+id)=>({allocation_id:id,batch_id:batch,kind,transaction_id:tx,transaction_amount_minor:minor,...(doc?{document_id:doc,document_amount_minor:docMinor}:{}),status:'accepted',created_at:at,created_by:actor,evidence_ref:'SYN-ALLOCATION-EVIDENCE-'+id});
  const state={run_id:'SYNTHETIC-COMPLETE-LEGACY',transactions,documents,match_groups,exclusion_rules:[{exclusion_id:'SYN-EXCLUDE',created_at:at,created_by:actor,field:'description_raw',operator:'contains',value:'private',source_system:'visa',enabled:true,description:'Fictional reviewed private exclusion'}],audit_events:[{audit_id:'SYN-AUDIT-1',timestamp:at,actor_type:'user',actor_id:actor,action:'MATCH_ACCEPTED',entity_type:'MatchGroup',entity_id:'SYN-M1',before:{status:'proposed'},after:{status:'accepted',evidence_ref:'SYN-LEGAL-EVIDENCE'},reason:'Fictional reviewed acceptance',run_id:'SYNTHETIC-COMPLETE-LEGACY',correlation_id:'SYN-AUDIT-CORRELATION'}],matched_transaction_ids:['SYN-T1','SYN-T2','SYN-T3','SYN-T4','SYN-T5','SYN-T6','SYN-T8','SYN-T9','SYN-T10'],matched_document_ids:['SYN-D1','SYN-D2','SYN-D3','SYN-D4','SYN-D5','SYN-D6'],excluded_transaction_ids:['SYN-T7'],accounting:{capability:'exact-accounting-v1',revision:7,allocations:[allocation('SYN-A1','payment','SYN-T3',-5000,'SYN-D3',5000),allocation('SYN-A2','fee','SYN-T4',-125),allocation('SYN-A3','transfer','SYN-T5',-25000,undefined,undefined,'SYN-TRANSFER'),allocation('SYN-A4','transfer','SYN-T6',25000,undefined,undefined,'SYN-TRANSFER'),allocation('SYN-A5','refund','SYN-T9',1000,'SYN-D5',1000)],classifications:[['SYN-T1','expense'],['SYN-T3','expense'],['SYN-T4','fee'],['SYN-T5','transfer'],['SYN-T6','transfer'],['SYN-T7','private'],['SYN-T8','income'],['SYN-T9','refund']].map(([transaction_id,category])=>({transaction_id,category,evidence_ref:'SYN-CLASS-'+transaction_id,set_at:at,set_by:actor})),document_taxes:[{document_id:'SYN-D1',tax_category:'input',rate_numerator:1,rate_denominator:5,vat_minor:2000,input_tax_eligible:true,evidence_ref:'SYN-TAX',set_at:at,set_by:actor}]}};
  writeFileSync(join(root,'state','state.json'),JSON.stringify(state,null,2));
  const db=new Database(join(root,'database','matching.db'));
  for(const name of ['schema.sql','schema-invoicerec.sql','schema-payments.sql'])db.exec(readFileSync(fileURLToPath(new URL('../../src/storage/'+name,import.meta.url)),'utf8'));
  const insert=(table,row)=>{const keys=Object.keys(row);db.prepare('INSERT INTO '+table+' ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k]));};
  for(const tx of Object.values(transactions)){const {fx,tags,meta,...row}=tx;insert('transactions',{...row,tags:JSON.stringify(tags),meta:JSON.stringify(meta),...(fx?{fx_original_amount_minor:fx.original_amount_minor,fx_original_currency_code:fx.original_currency_code,fx_rate:fx.rate,fx_rate_source:fx.rate_source,fx_fee_minor:fx.fx_fee_minor}:{})});}
  for(const doc of Object.values(documents)){const {line_items,meta,...row}=doc;insert('documents',{...row,meta:JSON.stringify(meta)});for(const line of line_items)insert('line_items',{document_id:doc.document_id,...line});}
  for(const match of Object.values(match_groups)){const {transaction_ids,document_ids,evidence,reason_codes,...row}=match;insert('match_groups',{...row,evidence:JSON.stringify(evidence),reason_codes:JSON.stringify(reason_codes)});for(const transaction_id of transaction_ids)insert('match_group_transactions',{match_group_id:match.match_group_id,transaction_id});for(const document_id of document_ids)insert('match_group_documents',{match_group_id:match.match_group_id,document_id});}
  for(const rule of state.exclusion_rules)insert('exclusion_rules',{...rule,enabled:1});
  for(const event of state.audit_events){const {before,after,...row}=event;insert('audit_events',{...row,before_data:JSON.stringify(before),after_data:JSON.stringify(after)});}
  insert('transaction_dispositions',{transaction_id:'SYN-T7',disposition:'privat',set_at:at,set_by:actor,note:'Fictional classification'});
  insert('document_dispositions',{document_id:'SYN-D6',disposition:'open',set_at:at,set_by:actor,note:'Fictional review'});
  insert('private_vendors',{vendor_name:'Fictional private vendor',added_at:at,added_by:actor});
  insert('vendor_overrides',{vendor_key:'fictional-vendor',name:'Fictional corrected supplier',country:'AT',tax_category_kz:'9100',updated_at:at});
  insert('invoice_scans',{scan_id:'SYN-SCAN',created_at:at,original_filename:'SYN-D3.txt',stored_filename:'SYN-D3.txt',file_hash:documents['SYN-D3'].file_hash,file_type:'text/plain',extraction_method:'synthetic-fixture',status:'confirmed',document_id:'SYN-D3',raw_text:'Fictional scanned invoice',meta:'{"synthetic":true}'});
  insert('invoice_templates',{template_id:'SYN-TEMPLATE',vendor_name:'Fictional vendor',created_at:at,updated_at:at,use_count:1,patterns_json:'{"invoice":"SYN-INV"}',meta:'{"synthetic":true}'});
  insert('invoice_extracted_fields',{scan_id:'SYN-SCAN',invoice_number:'SYN-INV-3',seller_name:'Fictional vendor',gross_amount_minor:10000,meta:'{"synthetic":true}'});
  insert('invoice_review_edits',{edit_id:'SYN-EDIT',scan_id:'SYN-SCAN',field_name:'seller_name',old_value:'Fictional old vendor',new_value:'Fictional vendor',edited_by:actor,edited_at:at});
  insert('invoice_payment_candidates',{candidate_id:'SYN-CANDIDATE',document_id:'SYN-D3',scan_id:'SYN-SCAN',creditor_name:'Fictional vendor',creditor_iban:syntheticIban,amount_minor:5000,currency_code:'EUR',remittance_information:'SYN-INV-3',classification:'paid',reason_code:'SYN-HISTORY',source_meta_json:'{"synthetic":true}',validation_errors_json:'[]',created_at:at,updated_at:at});
  insert('payment_batches',{batch_id:'SYN-PAYMENT-HISTORY',revision:1,status:'released',debtor_account_label:'Fictional account',debtor_account_holder:'Fictional holder',debtor_iban:syntheticIban,currency_code:'EUR',item_count:1,control_sum_minor:5000,requested_execution_date:'2025-06-15',reviewed_at:at,xml_sha256:'a'.repeat(64),message_id:'SYN-PAYMENT-MESSAGE',george_package_reference:'SYN-PACKAGE',created_at:at,updated_at:at});
  insert('payment_batch_items',{item_id:'SYN-PAYMENT-ITEM',batch_id:'SYN-PAYMENT-HISTORY',candidate_id:'SYN-CANDIDATE',document_id:'SYN-D3',scan_id:'SYN-SCAN',creditor_name:'Fictional vendor',creditor_iban:syntheticIban,amount_minor:5000,currency_code:'EUR',remittance_information:'SYN-INV-3',item_status:'released',active:0,created_at:at,updated_at:at});
  insert('payment_status_events',{event_id:'SYN-PAYMENT-EVENT',batch_id:'SYN-PAYMENT-HISTORY',actor,occurred_at:at,previous_status:'prepared',new_status:'released',reason:'Fictional historical release',george_evidence_json:JSON.stringify({reference:'SYN-PACKAGE',itemCount:1,controlSumMinor:5000,messageId:'SYN-PAYMENT-MESSAGE',status:'released'}),item_id:'SYN-PAYMENT-ITEM',before_json:'{"status":"prepared","amount_minor":5000}',after_json:'{"status":"released","amount_minor":5000}'});
  insert('settings',{key:'theme',value:'dark'});insert('settings',{key:'locale',value:'en-US'});
  db.pragma('wal_checkpoint(TRUNCATE)');db.pragma('journal_mode=DELETE');
  const expectedSql={};for(const {name}of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())expectedSql[name]=db.prepare('SELECT * FROM "'+name+'"').all();
  db.close();return{root,state,attachments,expectedSql,accountIds:[...new Set(Object.values(transactions).map(tx=>tx.source_account_id))].sort(),signedTotalMinor:amounts.reduce((a,b)=>a+b,0)};
}
