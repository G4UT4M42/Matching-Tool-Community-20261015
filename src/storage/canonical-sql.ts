import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import type { MatchingState } from '../core/types.js';

type Row=Record<string,string|number|null>;
interface Projection { table:string;keys:string[];columns:string[];jsonColumns:string[];rows:Row[] }
const nullable=(value:unknown):string|number|null=>value===undefined||value===null?null:value as string|number;
const json=(value:unknown,fallback:unknown=null)=>JSON.stringify(value===undefined?fallback:value);
function projection(table:string,keys:string[],columns:string[],jsonColumns:string[],rows:Row[]):Projection{return{table,keys,columns,jsonColumns,rows};}
const fields=(names:string[],source:Record<string,unknown>):Row=>Object.fromEntries(names.map(name=>[name,nullable(source[name])]));

/** Explicit physical projection; no caller-controlled table or column names. */
export function canonicalProjections(state:MatchingState):Projection[]{
  const txColumns=['transaction_id','source_system','source_account_id','source_row_ref','posting_at','value_at','amount_minor','currency_code','description_raw','counterparty_name','counterparty_iban','booking_reference','payment_reference','tags','meta','fx_original_amount_minor','fx_original_currency_code','fx_rate','fx_rate_source','fx_fee_minor'];
  const docColumns=['document_id','source_system','source_document_ref','captured_at','document_date','total_amount_minor','currency_code','supplier_name','vat_amount_minor','vat_rate','file_hash','filename','meta'];
  const groupColumns=['match_group_id','status','created_at','created_by','rule_id','amount_total_minor','currency_code','evidence','reason_codes','correlation_id'];
  const exclusionColumns=['exclusion_id','created_at','created_by','field','operator','value','source_system','enabled','description'];
  const auditColumns=['audit_id','timestamp','actor_type','actor_id','action','entity_type','entity_id','before_data','after_data','reason','run_id','correlation_id'];
  return[
    projection('transactions',['transaction_id'],txColumns,['tags','meta'],[...state.transactions.values()].map(tx=>fields(txColumns,{...tx,tags:json(tx.tags,[]),meta:json(tx.meta,{}),fx_original_amount_minor:tx.fx?.original_amount_minor,fx_original_currency_code:tx.fx?.original_currency_code,fx_rate:tx.fx?.rate,fx_rate_source:tx.fx?.rate_source,fx_fee_minor:tx.fx?.fx_fee_minor}))),
    projection('documents',['document_id'],docColumns,['meta'],[...state.documents.values()].map(doc=>fields(docColumns,{...doc,meta:json(doc.meta,{})}))),
    projection('match_groups',['match_group_id'],groupColumns,['evidence','reason_codes'],[...state.match_groups.values()].map(group=>fields(groupColumns,{...group,evidence:group.evidence?json(group.evidence):null,reason_codes:json(group.reason_codes,[])}))),
    projection('match_group_transactions',['match_group_id','transaction_id'],['match_group_id','transaction_id'],[],[...state.match_groups.values()].flatMap(group=>group.transaction_ids.map(id=>({match_group_id:group.match_group_id,transaction_id:id})))),
    projection('match_group_documents',['match_group_id','document_id'],['match_group_id','document_id'],[],[...state.match_groups.values()].flatMap(group=>group.document_ids.map(id=>({match_group_id:group.match_group_id,document_id:id})))),
    projection('exclusion_rules',['exclusion_id'],exclusionColumns,[],state.exclusion_rules.map(rule=>fields(exclusionColumns,{...rule,enabled:rule.enabled?1:0}))),
    projection('audit_events',['audit_id'],auditColumns,['before_data','after_data'],state.audit_events.map(event=>fields(auditColumns,{...event,before_data:event.before===undefined?null:json(event.before),after_data:event.after===undefined?null:json(event.after)}))),
  ];
}
function rowKey(row:Row,keys:string[]):string{return JSON.stringify(keys.map(key=>row[key]));}
function normalized(row:Row,plan:Projection):Record<string,unknown>{
  const output:Record<string,unknown>={};
  for(const column of plan.columns){
    const value=row[column]??null;
    if(plan.jsonColumns.includes(column)&&typeof value==='string'){
      try{output[column]=JSON.parse(value);}catch{throw new Error('Invalid persisted JSON in canonical '+plan.table);}
    }else output[column]=value;
  }
  return output;
}
function actualRows(db:Database.Database,plan:Projection):Map<string,Row>{
  const rows=db.prepare(`SELECT ${plan.columns.join(',')} FROM ${plan.table}`).all() as Row[];
  return new Map(rows.map(row=>[rowKey(row,plan.keys),row]));
}
function verifyLineItems(db:Database.Database,state:MatchingState,allowMissing:boolean):void{
  const all=db.prepare('SELECT document_id,description,amount_minor,quantity FROM line_items ORDER BY id').all() as Array<{document_id:string;description:string;amount_minor:number;quantity:number|null}>;
  const actual=new Map<string,unknown[]>();
  for(const line of all){if(!state.documents.has(line.document_id))throw new Error('Orphan SQL invoice line item');const entries=actual.get(line.document_id)??[];entries.push({description:line.description,amount_minor:line.amount_minor,quantity:line.quantity});actual.set(line.document_id,entries);}
  for(const doc of state.documents.values()){
    const expected=(doc.line_items??[]).map(line=>({description:line.description,amount_minor:line.amount_minor,quantity:line.quantity??null}));
    const found=actual.get(doc.document_id)??[];
    if(allowMissing&&!found.length)continue;
    if(!isDeepStrictEqual(found,expected))throw new Error('SQL and JSON invoice line items disagree');
  }
}

/** Compare complete canonical row values and relationships, not merely totals. */
export function verifyCanonicalSql(db:Database.Database,state:MatchingState,allowMissing=false):void{
  for(const plan of canonicalProjections(state)){
    const actual=actualRows(db,plan);
    const expected=new Map(plan.rows.map(row=>[rowKey(row,plan.keys),row]));
    if(expected.size!==plan.rows.length)throw new Error('Duplicate canonical identity in '+plan.table);
    for(const [key,row] of actual){const target=expected.get(key);if(!target||!isDeepStrictEqual(normalized(row,plan),normalized(target,plan)))throw new Error('SQL and JSON canonical '+plan.table+' disagree');}
    if(!allowMissing&&actual.size!==expected.size)throw new Error('SQL and JSON canonical '+plan.table+' counts disagree');
  }
  verifyLineItems(db,state,allowMissing);
  if((db.pragma('foreign_key_check') as unknown[]).length)throw new Error('Canonical SQL relationships are invalid');
}

/** Fill verified historical missing rows once, or write a validated state transition. */
export function synchronizeCanonicalSql(db:Database.Database,state:MatchingState):void{
  for(const plan of canonicalProjections(state)){
    const actual=actualRows(db,plan);
    const expected=new Map(plan.rows.map(row=>[rowKey(row,plan.keys),row]));
    if(expected.size!==plan.rows.length)throw new Error('Duplicate canonical row identity');
    const where=plan.keys.map(key=>key+' = ?').join(' AND ');
    const insert=db.prepare(`INSERT INTO ${plan.table} (${plan.columns.join(',')}) VALUES (${plan.columns.map(()=>'?').join(',')})`);
    const update=plan.table==='audit_events'?null:db.prepare(`UPDATE ${plan.table} SET ${plan.columns.map(column=>column+' = ?').join(',')} WHERE ${where}`);
    const remove=plan.table==='audit_events'?null:db.prepare(`DELETE FROM ${plan.table} WHERE ${where}`);
    for(const [key,row] of actual){
      if(!expected.has(key)){
        if(!['match_group_transactions','match_group_documents','exclusion_rules'].includes(plan.table))throw new Error('Canonical source or audit deletion is not authorized');
        remove!.run(...plan.keys.map(column=>row[column]));
      }
    }
    for(const [key,row] of expected){
      const prior=actual.get(key);
      if(!prior)insert.run(...plan.columns.map(column=>row[column]));
      else if(!isDeepStrictEqual(normalized(prior,plan),normalized(row,plan))){
        if(!update)throw new Error('Accounting audit event replacement is not authorized');
        update.run(...plan.columns.map(column=>row[column]),...plan.keys.map(column=>row[column]));
      }
    }
  }
  const insertLine=db.prepare('INSERT INTO line_items(document_id,description,amount_minor,quantity) VALUES (?,?,?,?)');
  for(const doc of state.documents.values()){
    const existing=db.prepare('SELECT count(*) FROM line_items WHERE document_id=?').pluck().get(doc.document_id);
    if(Number(existing)===0)for(const line of doc.line_items??[])insertLine.run(doc.document_id,line.description,line.amount_minor,line.quantity??null);
  }
  verifyCanonicalSql(db,state);
}

/** Preserve imported evidence and append-only history across all normal mutations. */
export function verifyCanonicalTransition(before:MatchingState,after:MatchingState):void{
  if(before.run_id!==after.run_id)throw new Error('Dataset replacement requires a separately confirmed migration or restore');
  const immutable=(first:Record<string,unknown>,second:Record<string,unknown>,ignored:string[])=>{
    const left=Object.fromEntries(Object.entries(first).filter(([key,value])=>!ignored.includes(key)&&value!==undefined));
    const right=Object.fromEntries(Object.entries(second).filter(([key,value])=>!ignored.includes(key)&&value!==undefined));
    if(!isDeepStrictEqual(left,right))throw new Error('Immutable imported source evidence cannot be replaced');
  };
  for(const [id,tx] of before.transactions){const next=after.transactions.get(id);if(!next)throw new Error('Source transaction deletion requires explicit archival');immutable(tx as unknown as Record<string,unknown>,next as unknown as Record<string,unknown>,['meta','tags']);}
  for(const [id,doc] of before.documents){const next=after.documents.get(id);if(!next)throw new Error('Source document deletion requires explicit archival');immutable(doc as unknown as Record<string,unknown>,next as unknown as Record<string,unknown>,['meta']);}
  for(const id of before.match_groups.keys())if(!after.match_groups.has(id))throw new Error('Matching history must be retained on unmatch');
  if(after.audit_events.length<before.audit_events.length||before.audit_events.some((event,index)=>!isDeepStrictEqual(event,after.audit_events[index])))throw new Error('Accounting audit history is append only');
  const identities=new Set<string>();for(const event of after.audit_events){if(identities.has(event.audit_id))throw new Error('Duplicate audit event identity');identities.add(event.audit_id);}
}
