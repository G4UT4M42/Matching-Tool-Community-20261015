import { randomUUID } from 'node:crypto';
import type { CommunityAccounting, CommunityAllocation, DocumentTaxClassification, ExclusionRule, MatchingState, TransactionClassification } from '../../core/types.js';
import { recordAudit } from '../../observability/audit.js';
import { documentSettlementMinor } from './document-settlement.js';

export class AccountingError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const bad = (code: string, message: string, status = 400): never => { throw new AccountingError(status, code, message); };
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f]/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v);
const money = (v: unknown): v is number => integer(v) && v !== 0;
const currency = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]{3}$/.test(v);
/** Round one source document value only; never round a currency aggregate. */
export function roundRationalHalfAwayFromZero(amount: number, numerator: number, denominator: number): number {
  if (!integer(amount) || !integer(numerator) || numerator < 0 || !integer(denominator) || denominator <= 0) bad('INVALID_RATIO', 'Expected a positive exact denominator and safe integers');
  const sign = amount < 0 ? -1n : 1n;
  const n = BigInt(Math.abs(amount)) * BigInt(numerator);
  const d = BigInt(denominator);
  const rounded = sign * ((n * 2n + d) / (d * 2n));
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER) || rounded < BigInt(Number.MIN_SAFE_INTEGER)) bad('AMOUNT_OVERFLOW', 'Rounded amount exceeds the safe integer range');
  return Number(rounded);
}
export const accountingOf = (state: MatchingState): CommunityAccounting => state.accounting ?? {
  capability: 'exact-accounting-v1', revision: 0, allocations: [], classifications: [], document_taxes: [],
};
function rebuildLinkedIds(state: MatchingState): void {
  state.matched_transaction_ids.clear(); state.matched_document_ids.clear();
  for (const group of state.match_groups.values()) if (group.status !== 'rejected') {
    for (const key of group.transaction_ids) state.matched_transaction_ids.add(key);
    for (const key of group.document_ids) state.matched_document_ids.add(key);
  }
  for (const a of accountingOf(state).allocations) if (a.status === 'accepted') {
    state.matched_transaction_ids.add(a.transaction_id);
    if (a.document_id) state.matched_document_ids.add(a.document_id);
  }
}
export function remainingBalances(state: MatchingState) {
  const transaction = new Map([...state.transactions].map(([key, value]) => [key, BigInt(value.amount_minor)]));
  const document = new Map([...state.documents].map(([key, value]) => [key, BigInt(value.total_amount_minor)]));
  for (const group of state.match_groups.values()) {
    if (!['accepted', 'confirmed', 'manual'].includes(group.status)) continue;
    for (const key of group.transaction_ids) transaction.set(key, (transaction.get(key) ?? 0n) - BigInt(state.transactions.get(key)?.amount_minor ?? 0));
    for (const key of group.document_ids) document.set(key, (document.get(key) ?? 0n) - BigInt(state.documents.get(key)?.total_amount_minor ?? 0));
  }
  for (const allocation of accountingOf(state).allocations) {
    if (allocation.status !== 'accepted') continue;
    transaction.set(allocation.transaction_id, (transaction.get(allocation.transaction_id) ?? 0n) - BigInt(allocation.transaction_amount_minor));
    if (allocation.document_id) document.set(allocation.document_id, (document.get(allocation.document_id) ?? 0n) - BigInt(allocation.document_amount_minor ?? 0));
  }
  return { transaction, document };
}
function checkBalance(original: number, remaining: bigint, name: string) {
  if (original > 0 ? remaining < 0n || remaining > BigInt(original) : remaining > 0n || remaining < BigInt(original)) {
    bad('OVER_ALLOCATED', `${name} allocations exceed its source amount`, 409);
  }
}
/** Validate both old full-record decisions and the optional accounting capability on every reload. */
export function validateAccountingState(state: MatchingState): void {
  const account = state.accounting;
  if (account) {
    if (account.capability !== 'exact-accounting-v1' || !integer(account.revision) || account.revision < 0 ||
      !Array.isArray(account.allocations) || !Array.isArray(account.classifications) || !Array.isArray(account.document_taxes)) bad('INVALID_ACCOUNTING_STATE', 'Invalid accounting capability or revision');
    const seen = new Set<string>();
    for (const a of account.allocations) {
      if (!obj(a) || !id(a.allocation_id) || seen.has(a.allocation_id) || !id(a.batch_id) || !id(a.evidence_ref) ||
          !id(a.created_by) || !Number.isFinite(Date.parse(a.created_at)) || !['accepted', 'rejected'].includes(a.status) ||
          !['payment', 'refund', 'credit_note', 'fee', 'transfer'].includes(a.kind) || !money(a.transaction_amount_minor)) bad('INVALID_ALLOCATION', 'Invalid allocation metadata');
      seen.add(a.allocation_id);
      const tx = state.transactions.get(a.transaction_id);
      if (!tx || !currency(tx.currency_code)) bad('ORPHAN_ALLOCATION', 'Allocation transaction is missing');
      if (a.status === 'accepted' && tx!.meta?.accounting_status === 'cancelled') bad('CANCELLED_ALLOCATION', 'Cancelled transaction cannot be allocated');
      if (state.excluded_transaction_ids.has(a.transaction_id) && a.status === 'accepted') bad('EXCLUDED_ALLOCATION', 'Accepted allocation uses an excluded transaction');
      if ((tx!.amount_minor > 0) !== (a.transaction_amount_minor > 0)) bad('ALLOCATION_DIRECTION', 'Allocation direction differs from transaction');
      if (a.kind === 'fee' || a.kind === 'transfer') {
        if (a.document_id !== undefined || a.document_amount_minor !== undefined || a.conversion !== undefined) bad('INVALID_ALLOCATION', 'Fee and transfer legs cannot allocate a document');
        if (a.kind === 'fee' && a.transaction_amount_minor >= 0) bad('FEE_DIRECTION', 'A fee must be a signed expense');
      } else {
        const doc = a.document_id ? state.documents.get(a.document_id) : undefined;
        if (!doc || !currency(doc.currency_code) || !money(a.document_amount_minor)) bad('ORPHAN_ALLOCATION', 'Allocation document is missing or invalid');
        if (a.status === 'accepted' && doc!.meta?.accounting_status === 'cancelled') bad('CANCELLED_ALLOCATION', 'Cancelled document cannot be allocated');
        if ((doc!.total_amount_minor > 0) !== (a.document_amount_minor! > 0) || (a.transaction_amount_minor > 0) !== (documentSettlementMinor(doc!, a.document_amount_minor!) > 0)) bad('ALLOCATION_DIRECTION', 'Document and transaction directions differ');
        if (tx!.currency_code === doc!.currency_code) {
          if (a.conversion !== undefined || a.transaction_amount_minor !== documentSettlementMinor(doc!, a.document_amount_minor!)) bad('ALLOCATION_CURRENCY', 'Same-currency allocations must settle to identical exact cashflow amounts');
        } else {
          const fx = a.conversion;
          if (!fx || !integer(fx.numerator) || fx.numerator <= 0 || !integer(fx.denominator) || fx.denominator <= 0 || !id(fx.source) || !id(fx.evidence_ref) ||
              BigInt(Math.abs(a.transaction_amount_minor)) * BigInt(fx.numerator) !== BigInt(Math.abs(a.document_amount_minor!)) * BigInt(fx.denominator)) bad('ALLOCATION_CURRENCY', 'Cross-currency allocation needs an exact evidenced conversion');
        }
      }
    }
    const unique = (items: object[], field: string, exists: (key: string) => boolean) => {
      const ids = new Set<string>();
      for (const raw of items) {
        const item = raw as Record<string, unknown>;
        const key = item[field];
        if (!obj(item) || !id(key) || ids.has(String(key)) || !exists(String(key)) || !id(item.evidence_ref) || !id(item.set_by) || !Number.isFinite(Date.parse(String(item.set_at)))) bad('INVALID_ACCOUNTING_CLASSIFICATION', 'Invalid or orphan accounting classification');
        ids.add(String(key));
      }
    };
    unique(account.classifications, 'transaction_id', key => state.transactions.has(key));
    unique(account.document_taxes, 'document_id', key => state.documents.has(key));
    for (const c of account.classifications) {
      if (!['income', 'expense', 'fee', 'refund', 'transfer', 'private', 'unclassified'].includes(c.category)) bad('INVALID_ACCOUNTING_CLASSIFICATION', 'Invalid financial category');
      if (c.category === 'private' && account.allocations.some(a => a.status === 'accepted' && a.transaction_id === c.transaction_id)) bad('PRIVATE_ALLOCATION', 'Private transactions cannot retain accepted allocations');
      const kinds = new Set(account.allocations.filter(a => a.status === 'accepted' && a.transaction_id === c.transaction_id).map(a => a.kind));
      if (kinds.has('transfer') && c.category !== 'transfer' && c.category !== 'unclassified') bad('CLASSIFICATION_CONFLICT', 'Transfer legs cannot be reported as revenue or expense');
      if (kinds.has('fee') && c.category !== 'fee' && c.category !== 'unclassified') bad('CLASSIFICATION_CONFLICT', 'Fee legs require fee classification');
      const sourceKind = state.transactions.get(c.transaction_id)!.meta?.accounting_event_kind;
      if (['provider_payout', 'provider_transfer', 'internal_transfer'].includes(String(sourceKind)) && c.category !== 'transfer' && c.category !== 'unclassified') bad('CLASSIFICATION_CONFLICT', 'Payouts and internal transfers cannot be new revenue');
    }
    for (const tax of account.document_taxes) {
      if (!['output', 'input', 'exempt', 'outside_scope', 'unclassified'].includes(tax.tax_category) || !integer(tax.rate_numerator) || tax.rate_numerator < 0 || !integer(tax.rate_denominator) || tax.rate_denominator <= 0 || !integer(tax.vat_minor) || typeof tax.input_tax_eligible !== 'boolean') bad('INVALID_TAX_CLASSIFICATION', 'Invalid exact tax classification');
      const doc = state.documents.get(tax.document_id)!;
      if (BigInt(Math.abs(tax.vat_minor)) > BigInt(Math.abs(doc.total_amount_minor)) || (tax.vat_minor !== 0 && (tax.vat_minor > 0) !== (doc.total_amount_minor > 0)) ||
          (tax.input_tax_eligible && tax.tax_category !== 'input') || (tax.tax_category === 'unclassified' && (tax.vat_minor !== 0 || tax.input_tax_eligible))) bad('INVALID_TAX_CLASSIFICATION', 'Tax amount or eligibility contradicts the document');
    }
    const transfers = new Map<string, { sum: bigint; count: number; currency: string }>();
    for (const a of account.allocations.filter(a => a.status === 'accepted' && a.kind === 'transfer')) {
      const code = state.transactions.get(a.transaction_id)!.currency_code;
      const item = transfers.get(a.batch_id) ?? { sum: 0n, count: 0, currency: code };
      if (item.currency !== code) bad('TRANSFER_CURRENCY', 'Transfer legs require one currency');
      item.sum += BigInt(a.transaction_amount_minor); item.count++; transfers.set(a.batch_id, item);
    }
    for (const item of transfers.values()) if (item.count < 2 || item.sum !== 0n) bad('UNBALANCED_TRANSFER', 'Transfer legs must balance exactly');
  }
  const activeTx = new Set<string>(); const activeDoc = new Set<string>();
  const recognizedSourceEvents = new Set<string>();
  for (const group of state.match_groups.values()) {
    if (!['accepted', 'confirmed', 'manual'].includes(group.status)) continue;
    const tx = group.transaction_ids.map(key => state.transactions.get(key));
    const docs = group.document_ids.map(key => state.documents.get(key));
    if (tx.some(value => !value) || docs.some(value => !value)) bad('ORPHAN_MATCH', 'Accepted full match has missing source evidence');
    if (tx.some(value => value!.meta?.accounting_status === 'cancelled') || docs.some(value => value!.meta?.accounting_status === 'cancelled')) bad('CANCELLED_ALLOCATION', 'Accepted full match uses a cancelled source record');
    const currencies = new Set([...tx, ...docs].map(value => value!.currency_code));
    const txTotal = tx.reduce((sum, value) => sum + BigInt(value!.amount_minor), 0n);
    const docTotal = docs.reduce((sum, value) => sum + BigInt(documentSettlementMinor(value!)), 0n);
    if (currencies.size !== 1 || !currencies.has(group.currency_code) || txTotal !== BigInt(group.amount_total_minor) ||
        (docs.length ? txTotal !== docTotal : txTotal !== 0n)) bad('INVALID_FULL_MATCH', 'Accepted full match totals or currencies differ from source records');
    for (const key of group.transaction_ids) { if (activeTx.has(key)) bad('OVER_ALLOCATED', 'Transaction belongs to multiple accepted full matches'); activeTx.add(key); }
    for (const key of group.document_ids) { if (activeDoc.has(key)) bad('OVER_ALLOCATED', 'Document belongs to multiple accepted full matches'); activeDoc.add(key); }
  }
  for (const c of accountingOf(state).classifications) if (c.category === 'private' && activeTx.has(c.transaction_id)) bad('PRIVATE_ALLOCATION', 'Private transactions cannot retain accepted full matches');
  const balances = remainingBalances(state);
  for (const [key, amount] of balances.transaction) checkBalance(state.transactions.get(key)!.amount_minor, amount, 'Transaction');
  for (const [key, amount] of balances.document) checkBalance(state.documents.get(key)!.total_amount_minor, amount, 'Document');
  const recognized = new Set([...activeTx, ...accountingOf(state).allocations.filter(a => a.status === 'accepted').map(a => a.transaction_id),
    ...accountingOf(state).classifications.filter(c => c.category !== 'unclassified').map(c => c.transaction_id)]);
  for (const key of recognized) {
    const tx = state.transactions.get(key)!;
    const sourceKey = JSON.stringify([tx.source_system, tx.source_account_id, tx.source_row_ref]);
    if (recognizedSourceEvents.has(sourceKey)) bad('DUPLICATE_ECONOMIC_EVENT', 'The same source event has multiple recognized transactions');
    recognizedSourceEvents.add(sourceKey);
  }
}

function next(input: MatchingState, revision: unknown): MatchingState {
  if (!integer(revision) || revision !== accountingOf(input).revision) bad('STALE_REVISION', 'Accounting state changed; reload before saving', 409);
  const state = structuredClone(input);
  state.accounting = structuredClone(accountingOf(input));
  state.accounting.revision++;
  return state;
}
export function acceptAllocations(input: MatchingState, body: any, actor: string): MatchingState {
  if (!obj(body) || Object.keys(body).some(key => !['revision', 'allocations', 'evidence_ref'].includes(key)) || !id(body.evidence_ref) || !Array.isArray(body.allocations) || !body.allocations.length || body.allocations.length > 100) bad('INVALID_REQUEST', 'Provide allocation legs and an evidence reference');
  const state = next(input, body.revision); const batch = randomUUID();
  for (const item of body.allocations) {
    if (!obj(item) || Object.keys(item).some(key => !['kind', 'transaction_id', 'document_id', 'transaction_amount_minor', 'document_amount_minor', 'conversion'].includes(key))) bad('INVALID_REQUEST', 'Invalid allocation leg');
    state.accounting!.allocations.push({ ...item, allocation_id: randomUUID(), batch_id: batch, status: 'accepted', created_at: new Date().toISOString(), created_by: actor, evidence_ref: body.evidence_ref } as CommunityAllocation);
  }
  validateAccountingState(state);
  rebuildLinkedIds(state);
  recordAudit(state, 'ACCOUNTING_ALLOCATED', 'Run', batch, { actor_type: 'user', actor_id: actor,before:{allocations:[]}, after: { allocations: state.accounting!.allocations.filter(a => a.batch_id === batch) }, reason: body.evidence_ref });
  return state;
}
export function undoAllocation(input: MatchingState, allocationId: string, revision: unknown, actor: string): MatchingState {
  const state = next(input, revision); const a = state.accounting!.allocations.find(a => a.allocation_id === allocationId);
  if (!a || a.status !== 'accepted') bad('ALLOCATION_NOT_FOUND', 'Active allocation not found', 404);
  const affected = a!.kind === 'transfer' ? state.accounting!.allocations.filter(item => item.batch_id === a!.batch_id && item.kind === 'transfer' && item.status === 'accepted') : [a!];
  const before = structuredClone(affected);
  for (const item of affected) item.status = 'rejected';
  validateAccountingState(state);
  rebuildLinkedIds(state);
  recordAudit(state, 'ACCOUNTING_ALLOCATION_UNDONE', 'Run', allocationId, { actor_type: 'user', actor_id: actor,
    before: { allocations: before }, after: { allocations: structuredClone(affected) } });
  return state;
}
export function classifyTransaction(input: MatchingState, body: any, actor: string): MatchingState {
  if (!obj(body) || Object.keys(body).some(key => !['revision', 'transaction_id', 'category', 'evidence_ref'].includes(key)) || !id(body.transaction_id) || !id(body.evidence_ref)) bad('INVALID_REQUEST', 'Invalid transaction classification');
  const state = next(input, body.revision); const before = state.accounting!.classifications.find(c => c.transaction_id === body.transaction_id);
  const entry: TransactionClassification = { transaction_id: body.transaction_id, category: body.category as TransactionClassification['category'], evidence_ref: body.evidence_ref, set_at: new Date().toISOString(), set_by: actor };
  state.accounting!.classifications = state.accounting!.classifications.filter(c => c.transaction_id !== body.transaction_id).concat(entry);
  validateAccountingState(state);
  recordAudit(state, 'ACCOUNTING_CLASSIFIED', 'Transaction', body.transaction_id, { actor_type: 'user', actor_id: actor, before:{classification:before??null}, after:{classification:entry} });
  return state;
}
export function classifyTax(input: MatchingState, body: any, actor: string): MatchingState {
  if (!obj(body) || Object.keys(body).some(key => !['revision', 'document_id', 'tax_category', 'rate_numerator', 'rate_denominator', 'vat_minor', 'input_tax_eligible', 'evidence_ref'].includes(key)) || !id(body.document_id) || !id(body.evidence_ref)) bad('INVALID_REQUEST', 'Invalid tax classification');
  const state = next(input, body.revision); const before = state.accounting!.document_taxes.find(c => c.document_id === body.document_id);
  const entry: DocumentTaxClassification = { document_id: body.document_id, tax_category: body.tax_category as DocumentTaxClassification['tax_category'], rate_numerator: body.rate_numerator as number, rate_denominator: body.rate_denominator as number, vat_minor: body.vat_minor as number, input_tax_eligible: body.input_tax_eligible as boolean, evidence_ref: body.evidence_ref, set_at: new Date().toISOString(), set_by: actor };
  state.accounting!.document_taxes = state.accounting!.document_taxes.filter(c => c.document_id !== body.document_id).concat(entry);
  validateAccountingState(state);
  recordAudit(state, 'ACCOUNTING_TAX_CLASSIFIED', 'Document', body.document_id, { actor_type: 'user', actor_id: actor, before:{tax:before??null}, after:{tax:entry} });
  return state;
}
export function setPrivateOrExcluded(input: MatchingState, body: any, actor: string): MatchingState {
  if (!obj(body) || Object.keys(body).some(key => !['revision', 'transaction_id', 'disposition', 'evidence_ref'].includes(key)) || !id(body.transaction_id) || !id(body.evidence_ref) || !['excluded', 'private', 'restore'].includes(String(body.disposition))) bad('INVALID_REQUEST', 'Invalid transaction disposition');
  const state = next(input, body.revision); const key = body.transaction_id;
  if (!state.transactions.has(key)) bad('TRANSACTION_NOT_FOUND', 'Transaction not found', 404);
  if (body.disposition !== 'restore' && (state.accounting!.allocations.some(a => a.status === 'accepted' && a.transaction_id === key) || [...state.match_groups.values()].some(g => ['accepted', 'confirmed', 'manual'].includes(g.status) && g.transaction_ids.includes(key)))) bad('ALLOCATION_CONFLICT', 'Undo accepted allocations before excluding a transaction', 409);
  const ownership=exclusionOwnership(input);
  const ruleOwned=[...ownership.owners.values()].some(ids=>ids.has(key))||input.exclusion_rules.some(rule=>rule.enabled&&(!safeRule(rule)||ruleMatches(input,rule).includes(key)));
  if (body.disposition === 'excluded'||ruleOwned) state.excluded_transaction_ids.add(key); else state.excluded_transaction_ids.delete(key);
  state.accounting!.classifications = state.accounting!.classifications.filter(c => c.transaction_id !== key);
  if (body.disposition === 'private') state.accounting!.classifications.push({ transaction_id: key, category: 'private', evidence_ref: body.evidence_ref, set_at: new Date().toISOString(), set_by: actor });
  validateAccountingState(state);
  recordAudit(state, 'ACCOUNTING_DISPOSITION_SET', 'Transaction', key, { actor_type: 'user', actor_id: actor,before:{excluded:input.excluded_transaction_ids.has(key),classification:accountingOf(input).classifications.find(c=>c.transaction_id===key)??null}, after: { disposition: body.disposition, evidence_ref: body.evidence_ref, excluded:state.excluded_transaction_ids.has(key),retained_by_rule:ruleOwned,classification:state.accounting!.classifications.find(c=>c.transaction_id===key)??null } });
  return state;
}

const safeRule=(rule:Pick<ExclusionRule,'field'|'operator'|'value'|'source_system'>):boolean=>
  ['counterparty_name','description_raw','booking_reference','payment_reference'].includes(rule.field)&&
  ['contains','equals','starts_with'].includes(rule.operator)&&id(rule.value)&&rule.value.length<=200&&
  (rule.source_system===undefined||['sparkasse','visa','paypal','stripe','enablebanking'].includes(rule.source_system));
function ruleMatches(state:MatchingState,rule:ExclusionRule,only?:ReadonlySet<string>):string[]{
  if(!safeRule(rule))bad('UNSUPPORTED_EXCLUSION_RULE','Only reviewed bounded literal rules can be enabled');
  const field=rule.field as 'counterparty_name'|'description_raw'|'booking_reference'|'payment_reference';
  const matches=[...state.transactions.values()].filter(tx=>{
    if(only&&!only.has(tx.transaction_id))return false;
    if(rule.source_system&&tx.source_system!==rule.source_system)return false;
    const raw=tx[field]??'';
    return rule.operator==='equals'?raw===rule.value:rule.operator==='starts_with'?raw.startsWith(rule.value):raw.includes(rule.value);
  }).map(tx=>tx.transaction_id);
  if(matches.length>100000)bad('EXCLUSION_RULE_LIMIT','Rule matches exceed the supported review limit');
  return matches;
}
function exclusionOwnership(state:MatchingState):{manual:Map<string,boolean>;owners:Map<string,Set<string>>}{
  const manual=new Map<string,boolean>(),recorded=new Map<string,Set<string>>();
  for(const event of state.audit_events){
    if(event.action==='ACCOUNTING_DISPOSITION_SET'&&event.entity_type==='Transaction'&&['excluded','private','restore'].includes(String(event.after?.disposition)))manual.set(event.entity_id,event.after!.disposition==='excluded');
    if(event.entity_type!=='ExclusionRule'||event.after?.rule_ownership_version===undefined)continue;
    const after=event.after,matched=after.matched_transaction_ids,kept=after.manual_transaction_ids;
    if(after.rule_ownership_version!==1||!Array.isArray(matched)||matched.length>100000||!Array.isArray(kept)||kept.length>100000||!obj(after.rule)||after.rule.exclusion_id!==event.entity_id||typeof after.rule.enabled!=='boolean')bad('EXCLUSION_OWNERSHIP_CONFLICT','Rule ownership evidence is invalid',409);
    const matching=new Set(matched as string[]);
    if((matched as unknown[]).some(value=>!id(value))||matching.size!==(matched as string[]).length||(kept as unknown[]).some(value=>!id(value)||!matching.has(value as string))||new Set(kept as string[]).size!==(kept as string[]).length)bad('EXCLUSION_OWNERSHIP_CONFLICT','Rule affected IDs are invalid',409);
    const preserved=new Set(kept as string[]);
    for(const key of matched as string[])manual.set(key,preserved.has(key));
    recorded.set(event.entity_id,new Set(matched as string[]));
  }
  const owners=new Map<string,Set<string>>();
  for(const rule of state.exclusion_rules)if(rule.enabled&&recorded.has(rule.exclusion_id))owners.set(rule.exclusion_id,recorded.get(rule.exclusion_id)!);
  return{manual,owners};
}
/** Apply supported rules to genuinely new imports, with durable ownership for undo. */
export function applyActiveExclusionsForNewTransactions(before:MatchingState,nextState:MatchingState,actor:string):MatchingState{
  const newIds=new Set([...nextState.transactions.keys()].filter(key=>!before.transactions.has(key)));
  if(!newIds.size)return nextState;
  let state=nextState;
  for(const originalRule of nextState.exclusion_rules){
    if(!originalRule.enabled||!safeRule(originalRule))continue;
    const ownership=exclusionOwnership(state),previous=ownership.owners.get(originalRule.exclusion_id)??new Set<string>();
    const additions=ruleMatches(state,originalRule,newIds).filter(key=>!previous.has(key));
    if(!additions.length)continue;
    allocationGuard(state,additions);
    if(state===nextState){state=structuredClone(nextState);state.accounting=structuredClone(accountingOf(nextState));state.accounting.revision++;}
    const matched=[...new Set([...previous,...additions])];if(matched.length>100000)bad('EXCLUSION_RULE_LIMIT','Rule matches exceed the supported review limit');
    const manual=matched.filter(key=>manuallyExcluded(state,ownership,key)),added=additions.filter(key=>!state.excluded_transaction_ids.has(key)),excludedBefore=matched.filter(key=>state.excluded_transaction_ids.has(key));
    for(const key of additions)state.excluded_transaction_ids.add(key);
    recordAudit(state,'STATE_COMMITTED','ExclusionRule',originalRule.exclusion_id,{actor_type:'user',actor_id:actor,correlation_id:randomUUID(),reason:'Exclusion rule applied to newly imported transactions',before:{rule:structuredClone(originalRule),matched_transaction_ids:[...previous],excluded_transaction_ids:excludedBefore},after:{rule:structuredClone(originalRule),rule_ownership_version:1,matched_transaction_ids:matched,manual_transaction_ids:manual,added_transaction_ids:added,released_transaction_ids:[],applied_transaction_ids:additions,excluded_transaction_ids:matched.filter(key=>state.excluded_transaction_ids.has(key))}});
  }
  if(state!==nextState)validateAccountingState(state);
  return state;
}
const manuallyExcluded=(state:MatchingState,ownership:ReturnType<typeof exclusionOwnership>,key:string):boolean=>
  ownership.manual.get(key)??state.excluded_transaction_ids.has(key);
function allocationGuard(state:MatchingState,keys:string[]):void{
  const wanted=new Set(keys);
  if(accountingOf(state).allocations.some(a=>a.status==='accepted'&&wanted.has(a.transaction_id))||[...state.match_groups.values()].some(g=>['accepted','confirmed','manual'].includes(g.status)&&g.transaction_ids.some(key=>wanted.has(key))))bad('ALLOCATION_CONFLICT','Exclusion rule intersects an accepted financial allocation',409);
}
export function exclusionRuleView(state:MatchingState){
  const managed=new Set(state.audit_events.filter(event=>event.action==='ACCOUNTING_EXCLUSION_RULE_CREATED'&&event.entity_type==='ExclusionRule'&&event.after?.rule_ownership_version===1).map(event=>event.entity_id));
  return state.exclusion_rules.map(rule=>({...rule,can_enable:safeRule(rule),ownership_known:managed.has(rule.exclusion_id)}));
}
/** Disable only exclusions with immutable ownership evidence; retain unknown legacy exclusions. */
export function setExclusionRuleEnabled(input:MatchingState,ruleId:string,body:unknown,actor:string):MatchingState{
  if(!obj(body)||Object.keys(body).some(key=>!['revision','enabled'].includes(key))||typeof body.enabled!=='boolean')bad('INVALID_REQUEST','Provide a revision and an enabled boolean');
  const request=body as {revision:unknown;enabled:boolean};
  const state=next(input,request.revision),rules=state.exclusion_rules.filter(rule=>rule.exclusion_id===ruleId);
  if(rules.length!==1)bad('EXCLUSION_RULE_NOT_FOUND','Exclusion rule not found',404);
  const rule=rules[0];
  if(request.enabled&&!safeRule(rule))bad('UNSUPPORTED_EXCLUSION_RULE','Only reviewed bounded literal rules can be enabled');
  if(rule.enabled===request.enabled)return input;
  const before=structuredClone(rule),ownership=exclusionOwnership(input),previous=ownership.owners.get(ruleId)??new Set<string>();
  const matched=request.enabled?ruleMatches(state,rule):[];
  if(request.enabled)allocationGuard(state,matched);
  const manual=matched.filter(key=>manuallyExcluded(input,ownership,key)),added=matched.filter(key=>!input.excluded_transaction_ids.has(key)),released:string[]=[];
  rule.enabled=request.enabled;
  for(const key of matched)state.excluded_transaction_ids.add(key);
  const others=input.exclusion_rules.filter(other=>other.exclusion_id!==ruleId&&other.enabled),unknownOther=others.some(other=>!safeRule(other));
  const otherMatches=new Set(others.filter(safeRule).flatMap(other=>ruleMatches(input,other)));
  if(!request.enabled)for(const key of previous){
    if(manuallyExcluded(input,ownership,key)||unknownOther||otherMatches.has(key))continue;
    if(state.excluded_transaction_ids.delete(key))released.push(key);
  }
  validateAccountingState(state);
  const affected=new Set([...previous,...matched]);
  recordAudit(state,'EXCLUSION_TOGGLED','ExclusionRule',ruleId,{actor_type:'user',actor_id:actor,correlation_id:randomUUID(),before:{rule:before,matched_transaction_ids:[...previous],excluded_transaction_ids:[...affected].filter(key=>input.excluded_transaction_ids.has(key))},after:{rule:structuredClone(rule),rule_ownership_version:1,matched_transaction_ids:matched,manual_transaction_ids:manual,added_transaction_ids:added,released_transaction_ids:released,excluded_transaction_ids:[...affected].filter(key=>state.excluded_transaction_ids.has(key)),legacy_exclusions_preserved:!ownership.owners.has(ruleId)&&!request.enabled}});
  return state;
}

/** New Community rules use only bounded literal string operations; legacy regex rules are never executed here. */
export function createSafeExclusionRule(input: MatchingState, body: any, actor: string): MatchingState {
  if (!obj(body) || Object.keys(body).some(key => !['revision', 'field', 'operator', 'value', 'source_system', 'description'].includes(key)) ||
      !['counterparty_name', 'description_raw', 'booking_reference', 'payment_reference'].includes(String(body.field)) ||
      !['contains', 'equals', 'starts_with'].includes(String(body.operator)) || !id(body.value) || body.value.length > 200 ||
      (body.source_system !== undefined && !['sparkasse', 'visa', 'paypal', 'stripe', 'enablebanking'].includes(String(body.source_system))) ||
      (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 500))) bad('INVALID_EXCLUSION_RULE', 'Use a bounded literal exclusion rule');
  const state = next(input, body.revision);
  const field = body.field as ExclusionRule['field'];
  const value = body.value as string;
  const rule: ExclusionRule = { exclusion_id: randomUUID(), created_at: new Date().toISOString(), created_by: actor,
    field, operator: body.operator as ExclusionRule['operator'], value, enabled: true,
    ...(body.source_system ? { source_system: body.source_system as ExclusionRule['source_system'] } : {}),
    ...(body.description ? { description: body.description as string } : {}) };
  state.exclusion_rules.push(rule);
  const matched=ruleMatches(state,rule),ownership=exclusionOwnership(input),manual=matched.filter(key=>manuallyExcluded(input,ownership,key)),added=matched.filter(key=>!input.excluded_transaction_ids.has(key));
  allocationGuard(state,matched);
  for (const key of matched) state.excluded_transaction_ids.add(key);
  validateAccountingState(state);
  recordAudit(state, 'ACCOUNTING_EXCLUSION_RULE_CREATED', 'ExclusionRule', rule.exclusion_id,
    { actor_type: 'user', actor_id: actor,correlation_id:randomUUID(),before:{rule:null,excluded_transaction_ids:matched.filter(key=>input.excluded_transaction_ids.has(key))}, after: { rule:structuredClone(rule),rule_ownership_version:1,matched_transaction_ids:matched,manual_transaction_ids:manual,added_transaction_ids:added,released_transaction_ids:[],excluded_transaction_ids:matched } });
  return state;
}
