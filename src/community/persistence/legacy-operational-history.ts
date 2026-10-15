import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import type {MatchingState} from '../../core/types.js';

const MAX_ROWS=10000,MAX_INPUT_BYTES=32*1024*1024,MAX_OUTPUT_BYTES=16*1024*1024,MAX_VALUE_BYTES=1024*1024;
const MAX_EVIDENCE_BYTES=256*1024*1024;
type Kind='id'|'text'|'label'|'filename'|'date'|'integer'|'real'|'boolean'|'hash'|'currency'|'stats';
interface TableSpec {fields:Record<string,Kind>;excluded:Record<string,string>;timestamp:string;integerId?:boolean}
const specs:Record<string,TableSpec>={
  invoice_bot_portals:{timestamp:'created_at',fields:{id:'id',name:'text',portal_type:'label',adapter_type:'label',portal_state:'label',review_policy:'label',max_cost_per_run:'real',created_at:'date',updated_at:'date'},excluded:{base_url:'source-url',openclaw_profile:'browser-authority',session_mode:'browser-authority',active:'active-configuration',default_download_path:'local-path',invoice_page_hints_json:'unreviewed-configuration',date_field_hints_json:'unreviewed-configuration',run_strategy:'execution-authority',login_strategy:'browser-authority',credential_ref:'credential-reference',task_prompt:'free-form-prompt',requires_human_login:'active-configuration'}},
  invoice_bot_runs:{timestamp:'created_at',fields:{id:'id',portal_id:'id',requested_start:'date',requested_end:'date',status:'label',started_at:'date',finished_at:'date',stats_json:'stats',created_at:'date',updated_at:'date',total_cost:'real',total_tokens:'integer',mode:'label',warnings_count:'integer',invoices_found_count:'integer',files_downloaded_count:'integer'},excluded:{error_message:'free-form-error',profile_id:'browser-authority'}},
  invoice_bot_files:{timestamp:'created_at',fields:{id:'id',run_id:'id',portal_id:'id',original_filename:'filename',sha256:'hash',invoice_date:'date',supplier_hint:'text',import_status:'label',document_id:'id',created_at:'date',updated_at:'date'},excluded:{stored_path:'local-path'}},
  invoice_bot_events:{timestamp:'created_at',fields:{id:'id',run_id:'id',level:'label',code:'label',created_at:'date'},excluded:{message:'free-form-log',payload_json:'unreviewed-log-payload'}},
  invoice_bot_artifacts:{timestamp:'created_at',fields:{id:'id',run_id:'id',type:'label',mime_type:'label',sha256:'hash',size_bytes:'integer',created_at:'date'},excluded:{local_path:'local-path',source_url:'source-url',label:'free-form-label'}},
  invoice_bot_extracted_invoices:{timestamp:'created_at',fields:{id:'id',run_id:'id',portal_id:'id',supplier_name:'text',invoice_number:'text',invoice_date:'date',currency:'currency',gross_total_minor:'integer',portal_reference:'text',downloaded_filename:'filename',artifact_id:'id',sha256:'hash',extraction_confidence:'real',requires_review:'boolean',evidence_artifact_id:'id',import_status:'label',document_id:'id',created_at:'date',updated_at:'date'},excluded:{source_url:'source-url'}},
  ai_cost_sessions:{timestamp:'started_at',fields:{id:'id',started_at:'date',ended_at:'date',source:'label',total_tokens:'integer',prompt_tokens:'integer',completion_tokens:'integer',total_cost_usd:'real',call_count:'integer',status:'label'},excluded:{}},
  ai_cost_entries:{timestamp:'created_at',integerId:true,fields:{id:'integer',session_id:'id',created_at:'date',model:'label',tier:'label',prompt_tokens:'integer',completion_tokens:'integer',total_tokens:'integer',cost_usd:'real',source:'label'},excluded:{context:'free-form-context'}},
};
const tableNames=Object.keys(specs);
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function problem(message:string):never{throw new Error('Legacy operational history: '+message);}
const isHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const isId=(value:unknown):value is string=>typeof value==='string'&&/^[\w.:-]{1,160}$/.test(value);
function realBits(value:number):string{const bytes=Buffer.alloc(8);bytes.writeDoubleLE(value);return bytes.toString('hex');}
function validDate(value:string):boolean{
  const parts=/^(\d{4})-(\d{2})-(\d{2})(?:(?:T| )(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if(!parts||!Number.isFinite(Date.parse(value)))return false;
  const year=Number(parts[1]),month=Number(parts[2]),day=Number(parts[3]),leap=year%4===0&&(year%100!==0||year%400===0);
  return year>0&&month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]!&&(parts[4]===undefined||Number(parts[4])<24&&Number(parts[5])<60&&Number(parts[6]??0)<60);
}
function rawDigest(row:Record<string,unknown>):string{
  return digest(JSON.stringify(Object.entries(row).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,typeof value==='bigint'?{integer:value.toString()}:typeof value==='number'?{real64:realBits(value)}:Buffer.isBuffer(value)?{blob:value.toString('hex')}:value])));
}
export interface LegacyOperationalOmission {field:string;sha256:string;reason:string}
export interface LegacyOperationalRow {table:string;id:string;timestamp:string;source_sha256:string;fields:Record<string,unknown>;omitted:LegacyOperationalOmission[]}
export interface LegacyOperationalEvidenceRequirement {table:string;id:string;source_path:string;sha256:string;document_id?:string;mime_type?:string;bytes?:number}
export interface LegacyOperationalExtraction {rows:LegacyOperationalRow[];evidence:LegacyOperationalEvidenceRequirement[]}
export interface LegacyOperationalEvidenceReference {path:string;sha256:string;bytes:number}
interface ArchivedEvidence extends LegacyOperationalEvidenceReference {mime_type?:string}
type RowMaps=Map<string,Map<string,Record<string,unknown>>>;
const financialImage=(row:Record<string,unknown>)=>row.type==='screenshot'&&['image/png','image/jpeg','image/webp'].includes(String(row.mime_type))&&isHash(row.sha256);
function validateRelationships(maps:RowMaps,documentHash:(id:unknown)=>unknown):Set<string>{
  const linkedImages=new Set<string>();
  const requireRef=(table:string,id:unknown)=>{const row=id===null||id===undefined?undefined:maps.get(table)?.get(String(id));if(!row)problem('invalid reference to '+table);return row!;};
  const same=(left:unknown,right:unknown)=>String(left)===String(right);
  const checkDocument=(row:Record<string,unknown>)=>{
    if(row.document_id===null||row.document_id===undefined)return;
    const hash=documentHash(row.document_id);if(!isHash(row.sha256)||!isHash(hash)||hash.toLowerCase()!==row.sha256.toLowerCase())problem('document link or original hash disagrees');
  };
  for(const row of maps.get('invoice_bot_runs')?.values()??[])requireRef('invoice_bot_portals',row.portal_id);
  for(const row of maps.get('invoice_bot_files')?.values()??[]){const run=requireRef('invoice_bot_runs',row.run_id);requireRef('invoice_bot_portals',row.portal_id);if(!same(run.portal_id,row.portal_id))problem('run and portal disagree');if(!isHash(row.sha256))problem('file original hash unavailable');checkDocument(row);}
  for(const row of maps.get('invoice_bot_events')?.values()??[])requireRef('invoice_bot_runs',row.run_id);
  for(const row of maps.get('invoice_bot_artifacts')?.values()??[])requireRef('invoice_bot_runs',row.run_id);
  for(const row of maps.get('invoice_bot_extracted_invoices')?.values()??[]){
    const run=requireRef('invoice_bot_runs',row.run_id);requireRef('invoice_bot_portals',row.portal_id);if(!same(run.portal_id,row.portal_id))problem('extracted run and portal disagree');checkDocument(row);
    if((row.document_id!==null&&row.document_id!==undefined||row.import_status==='imported')&&!isHash(row.sha256))problem('imported original hash unavailable');
    for(const key of ['artifact_id','evidence_artifact_id'])if(row[key]!==null&&row[key]!==undefined){const artifact=requireRef('invoice_bot_artifacts',row[key]);if(!same(artifact.run_id,row.run_id))problem('artifact run disagrees');if(key==='artifact_id'&&isHash(row.sha256)&&isHash(artifact.sha256)&&row.sha256.toLowerCase()!==artifact.sha256.toLowerCase())problem('extracted artifact hash disagrees');if(key==='evidence_artifact_id'&&artifact.type!=='download'){if(!financialImage(artifact)||!isHash(row.sha256)||!(typeof row.gross_total_minor==='bigint'||Number.isSafeInteger(row.gross_total_minor))||typeof row.currency!=='string'||!/^[A-Z]{3}$/.test(row.currency))problem('unsupported financial image evidence');linkedImages.add(String(artifact.id));}}
  }
  for(const row of maps.get('ai_cost_entries')?.values()??[])requireRef('ai_cost_sessions',row.session_id);
  return linkedImages;
}

function valueOf(value:unknown,kind:Kind,key:string):unknown{
  if(value===null)return null;
  if(typeof value==='bigint'){if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<BigInt(Number.MIN_SAFE_INTEGER))problem('integer exceeds exact range');value=Number(value);}
  if(kind==='integer'||kind==='boolean'){
    if(typeof value!=='number'||!Number.isSafeInteger(value)||kind==='boolean'&&value!==0&&value!==1||kind==='integer'&&key!=='gross_total_minor'&&value<0)problem('invalid integer '+key);return value;
  }
  if(kind==='real'){if(typeof value!=='number'||!Number.isFinite(value)||value<0)problem('invalid real '+key);return value;}
  if(typeof value!=='string'||Buffer.byteLength(value)>2000||(kind==='stats'?/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/:/[\u0000-\u001f]/).test(value))problem('invalid text '+key);
  const text=value as string;
  if(kind==='id'&&!isId(text)||kind==='date'&&(!text||text.length>40||!validDate(text))||kind==='label'&&(!text||text.length>200||!/^[-\w./:+ ]+$/.test(text))||kind==='filename'&&(!text||text.length>200||/[\\/]/.test(text)||text==='.'||text==='..')||kind==='hash'&&text!==''&&!isHash(text)||kind==='currency'&&!/^[A-Z]{3}$/.test(text))problem('invalid '+kind+' '+key);
  if(kind==='stats'){
    let parsed:unknown;try{parsed=JSON.parse(text);}catch{problem('invalid run statistics');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.entries(parsed).some(([name,n])=>!['found','downloaded','imported','duplicates','failed'].includes(name)||!Number.isSafeInteger(n)||Number(n)<0))problem('unsupported run statistics');
    // Preserve the exact original JSON text, including its numeric spelling.
  }
  return text;
}
function projected(row:Record<string,unknown>,table:string,unknownNull:string[]):LegacyOperationalRow{
  const spec=specs[table]!,fields:Record<string,unknown>={},bits:Record<string,string>={},omitted:LegacyOperationalOmission[]=[];
  for(const [key,value]of Object.entries(row)){
    if(Object.hasOwn(spec.fields,key)){fields[key]=valueOf(value,spec.fields[key],key);if(spec.fields[key]==='real'&&typeof value==='number')bits[key]=realBits(value);}
    else omitted.push({field:key,sha256:rawDigest({value}),reason:Object.hasOwn(spec.excluded,key)?spec.excluded[key]!:unknownNull.includes(key)?'unmapped-empty-column':'unmapped'});
  }
  if(Object.keys(bits).length)fields.source_real_bits=bits;
  if(spec.integerId?!Number.isSafeInteger(fields.id):!isId(fields.id))problem('invalid row identity');
  const timestamp=fields[spec.timestamp];if(typeof timestamp!=='string')problem('missing source timestamp');
  return{table,id:String(fields.id),timestamp:timestamp as string,source_sha256:rawDigest(row),fields,omitted};
}

/** Read-only extraction from the caller's isolated source snapshot; no files read. */
export function extractLegacyOperationalHistory(db:Database.Database):LegacyOperationalExtraction{
  const existing=new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{name:string}>).map(row=>row.name));
  const raw=new Map<string,Array<Record<string,unknown>>>(),rows:LegacyOperationalRow[]=[];let count=0,inputBytes=0;
  for(const table of tableNames){
    if(!existing.has(table))continue;
    const columns=(db.pragma(`table_info("${table}")`) as Array<{name:string}>).map(column=>column.name);
    if(columns.some(name=>!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name)||['__proto__','constructor','prototype'].includes(name))||!columns.includes('id'))problem('unsupported source columns');
    const unknown=columns.filter(name=>!Object.hasOwn(specs[table]!.fields,name)&&!Object.hasOwn(specs[table]!.excluded,name));
    for(const name of unknown)if(db.prepare(`SELECT 1 FROM "${table}" WHERE "${name}" IS NOT NULL LIMIT 1`).get())problem('unmapped populated column '+table+'.'+name);
    const n=Number((db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as {n:number}).n);count+=n;if(count>MAX_ROWS)problem('row limit exceeded');
    const lengths=columns.map(name=>`coalesce(length(CAST("${name}" AS BLOB)),0)`);
    const size=db.prepare(`SELECT coalesce(sum(${lengths.join('+')}),0) AS bytes,coalesce(max(max(${[...lengths,'0'].join(',')})),0) AS largest FROM "${table}"`).get() as {bytes:number;largest:number};
    inputBytes+=Number(size.bytes);if(inputBytes>MAX_INPUT_BYTES||Number(size.largest)>MAX_VALUE_BYTES)problem('source byte limit exceeded');
    const values=db.prepare(`SELECT * FROM "${table}" ORDER BY id`).safeIntegers(true).all() as Array<Record<string,unknown>>;raw.set(table,values);
    for(const row of values)rows.push(projected(row,table,unknown));
  }
  const maps=new Map([...raw].map(([table,values])=>[table,new Map(values.map(row=>[String(row.id),row]))]));
  for(const [table,values]of raw)if(maps.get(table)!.size!==values.length)problem('duplicate source row identity');
  const find=(table:string,id:unknown)=>id===null||id===undefined?undefined:maps.get(table)?.get(String(id));
  const same=(left:unknown,right:unknown)=>String(left)===String(right);
  const document=existing.has('documents')?db.prepare('SELECT file_hash FROM documents WHERE document_id=?'):undefined;
  const linkedImages=validateRelationships(maps,id=>(document?.get(id) as {file_hash:unknown}|undefined)?.file_hash);
  const evidence:LegacyOperationalEvidenceRequirement[]=[];
  const add=(table:string,row:Record<string,unknown>,path:unknown,documentId?:unknown)=>{
    if(!isHash(row.sha256))return; // Unverified pending artifacts stay metadata only.
    if(typeof path!=='string'||!path||path.length>4096||/[\u0000-\u001f]/.test(path))problem('invalid original evidence path');
    evidence.push({table,id:String(row.id),source_path:path as string,sha256:row.sha256.toLowerCase(),...(typeof documentId==='string'?{document_id:documentId}:{}),...(typeof row.mime_type==='string'?{mime_type:row.mime_type}:{}),...(typeof row.size_bytes==='bigint'||typeof row.size_bytes==='number'?{bytes:Number(row.size_bytes)}:{})});
  };
  for(const row of raw.get('invoice_bot_files')??[])add('invoice_bot_files',row,row.stored_path,row.document_id);
  for(const row of raw.get('invoice_bot_artifacts')??[])if(row.type==='download'||linkedImages.has(String(row.id)))add('invoice_bot_artifacts',row,row.local_path);
  for(const row of raw.get('invoice_bot_extracted_invoices')??[]){
    if(!isHash(row.sha256))continue;
    const artifact=find('invoice_bot_artifacts',row.artifact_id),files=(raw.get('invoice_bot_files')??[]).filter(file=>same(file.run_id,row.run_id)&&isHash(file.sha256)&&file.sha256.toLowerCase()===(row.sha256 as string).toLowerCase());
    const path=artifact?.local_path??files[0]?.stored_path??row.downloaded_filename;
    add('invoice_bot_extracted_invoices',row,path,row.document_id);
  }
  for(const item of evidence)if(item.bytes!==undefined&&(!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>MAX_EVIDENCE_BYTES))problem('invalid evidence size');
  if(Buffer.byteLength(JSON.stringify({rows,evidence}))>MAX_OUTPUT_BYTES)problem('projection byte limit exceeded');
  return{rows,evidence};
}

function exactKeys(value:unknown,allowed:string[],required:string[]):value is Record<string,unknown>{return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key)));}
/** Validate canonical archive projections before backup/restore follows any path. */
export function legacyOperationalEvidenceReferences(state:MatchingState):LegacyOperationalEvidenceReference[]{
  const refs=new Map<string,LegacyOperationalEvidenceReference>(),ids=new Set<string>(),maps:RowMaps=new Map(),imageEvidence=new Map<string,number>();let count=0,bytes=0;
  for(const event of state.audit_events){
    const after=event.after;if(after?.legacy_operational_history_version===undefined)continue;
    if(++count>MAX_ROWS||!exactKeys(after,['legacy_operational_history_version','table','id','timestamp','source_sha256','fields','omitted','evidence'],['legacy_operational_history_version','table','id','timestamp','source_sha256','fields','omitted'])||after.legacy_operational_history_version!==1||event.entity_type!=='Run'||event.action!=='STATE_COMMITTED'||event.actor_type!=='system'||typeof after.table!=='string'||!Object.hasOwn(specs,after.table)||!isId(after.id)||!isHash(after.source_sha256)||typeof after.timestamp!=='string'||after.timestamp.length>40||!Number.isFinite(Date.parse(after.timestamp)))problem('invalid archived operation');
    const envelopeId='LEGACY-OPERATIONAL-'+digest(JSON.stringify([after.table,after.id,after.source_sha256]));
    if(event.audit_id!==envelopeId||event.entity_id!==envelopeId||event.actor_id!=='legacy-migration'||event.timestamp!==after.timestamp||event.before!==undefined||!isId(event.run_id))problem('archived audit envelope disagrees');
    const table=after.table as string,spec=specs[table]!;
    if(!exactKeys(after.fields,[...Object.keys(spec.fields),'source_real_bits'],['id',spec.timestamp])||String(after.fields.id)!==after.id||(spec.integerId?!Number.isSafeInteger(after.fields.id):!isId(after.fields.id))||after.fields[spec.timestamp]!==after.timestamp||!Array.isArray(after.omitted)||after.omitted.length>100)problem('invalid archived fields');
    for(const [key,value]of Object.entries(after.fields)){if(key==='source_real_bits')continue;valueOf(value,spec.fields[key]!,key);}
    const fields=after.fields,real=fields.source_real_bits,realKeys=Object.keys(spec.fields).filter(key=>spec.fields[key]==='real'&&typeof fields[key]==='number');
    if(realKeys.length&&real===undefined)problem('missing archived real bits');
    if(real!==undefined){
      if(!exactKeys(real,Object.keys(spec.fields).filter(key=>spec.fields[key]==='real'),[]))problem('invalid archived real values');
      if(Object.keys(real).length!==realKeys.length||realKeys.some(key=>!Object.hasOwn(real,key)))problem('incomplete archived real values');
      for(const [key,bits]of Object.entries(real)){if(typeof bits!=='string'||!/^[a-f0-9]{16}$/.test(bits)||typeof after.fields[key]!=='number')problem('invalid archived real bits');const decoded=Buffer.from(bits as string,'hex').readDoubleLE();if(!Object.is(decoded,after.fields[key])&&!(decoded===0&&after.fields[key]===0))problem('archived real value changed');}
    }
    const omitted=new Set<string>();for(const omission of after.omitted){if(!exactKeys(omission,['field','sha256','reason'],['field','sha256','reason'])||typeof omission.field!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(omission.field)||Object.hasOwn(spec.fields,omission.field)||omitted.has(omission.field)||!isHash(omission.sha256)||typeof omission.reason!=='string'||omission.reason!==(Object.hasOwn(spec.excluded,omission.field)?spec.excluded[omission.field]:'unmapped-empty-column'))problem('invalid archived omission');omitted.add(omission.field);}
    const identity=table+':'+after.id;if(ids.has(identity))problem('duplicate archived source identity');ids.add(identity);
    const tableRows=maps.get(table)??new Map<string,Record<string,unknown>>();tableRows.set(after.id,after.fields);maps.set(table,tableRows);
    if(after.evidence!==undefined&&(!Array.isArray(after.evidence)||after.evidence.length>1))problem('invalid archived evidence');
    if(table==='invoice_bot_artifacts'&&after.fields.type!=='download'&&Array.isArray(after.evidence)&&after.evidence.length)imageEvidence.set(after.id,after.evidence.length);
    const originalRequired=isHash(after.fields.sha256)&&(table==='invoice_bot_files'||table==='invoice_bot_extracted_invoices'||table==='invoice_bot_artifacts'&&after.fields.type==='download');
    if(originalRequired&&(!Array.isArray(after.evidence)||after.evidence.length!==1))problem('missing archived original reference');
    for(const value of (after.evidence??[]) as unknown[]){
      if(!exactKeys(value,['path','sha256','bytes','mime_type'],['path','sha256','bytes'])||!isHash(value.sha256)||typeof value.path!=='string'||value.path!=='legacy-evidence/'+value.sha256.toLowerCase()||!Number.isSafeInteger(value.bytes)||Number(value.bytes)<1||Number(value.bytes)>MAX_EVIDENCE_BYTES||value.mime_type!==undefined&&(typeof value.mime_type!=='string'||value.mime_type.length>100||!/^[-\w.+]+\/[-\w.+]+$/.test(value.mime_type))||!['invoice_bot_files','invoice_bot_artifacts','invoice_bot_extracted_invoices'].includes(table)||typeof after.fields.sha256!=='string'||after.fields.sha256.toLowerCase()!==value.sha256.toLowerCase()||table==='invoice_bot_artifacts'&&after.fields.type!=='download'&&!financialImage(after.fields))problem('invalid archived original reference');
      const ref=value as unknown as ArchivedEvidence,previous=refs.get(ref.path);if(table==='invoice_bot_artifacts'&&(after.fields.mime_type??undefined)!==ref.mime_type)problem('archived original MIME disagrees');if(typeof after.fields.size_bytes==='number'&&after.fields.size_bytes!==ref.bytes)problem('archived original size disagrees');if(previous&&(previous.sha256!==ref.sha256||previous.bytes!==ref.bytes))problem('conflicting archived original');refs.set(ref.path,{path:ref.path,sha256:ref.sha256,bytes:ref.bytes});
    }
    bytes+=Buffer.byteLength(JSON.stringify(after));if(bytes>MAX_OUTPUT_BYTES)problem('archived history exceeds size limit');
  }
  const linkedImages=validateRelationships(maps,id=>typeof id==='string'?state.documents.get(id)?.file_hash:undefined);
  for(const id of linkedImages)if(imageEvidence.get(id)!==1)problem('missing archived financial image reference');
  for(const id of imageEvidence.keys())if(!linkedImages.has(id))problem('unlinked archived image reference');
  return[...refs.values()].sort((a,b)=>a.path.localeCompare(b.path));
}
