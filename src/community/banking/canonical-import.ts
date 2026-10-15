import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { MatchingState, Transaction } from '../../core/types.js';
import { recordAudit } from '../../observability/audit.js';
import type { BankTransactionRow } from './service.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Stable account identification survives consent/session renewal. No source overwrite. */
export function prepareBankImport(input:MatchingState,rows:BankTransactionRow[],actor:string){
 if(!Array.isArray(rows)||rows.length>10000)throw new Error('BANK_DATA_INVALID');
 const state=structuredClone(input);let imported=0,skipped=0;
 for(const row of rows){
   if(typeof row.accountIdentity!=='string'||!row.accountIdentity||row.accountIdentity.length>1024||typeof row.providerId!=='string'||!row.providerId||row.providerId.length>256||!Number.isSafeInteger(row.amountMinor)||row.currency!=='EUR'||!/^\d{4}-\d{2}-\d{2}$/.test(row.bookedAt)||!Number.isFinite(Date.parse(row.bookedAt))||new Date(row.bookedAt).toISOString().slice(0,10)!==row.bookedAt||typeof row.description!=='string'||row.description.length>500)throw new Error('BANK_DATA_INVALID');
   const account=hash(['enablebanking-ais',row.accountIdentity]);
   const id='BANK-'+hash([account,row.providerId]);
   const next:Transaction={transaction_id:id,source_system:'enablebanking',source_account_id:account,source_row_ref:row.providerId,posting_at:row.bookedAt,amount_minor:row.amountMinor,currency_code:row.currency,description_raw:row.description,tags:['bank-import'],meta:{provider_environment:'live',source_identity_scheme:'enablebanking-identification-hash-v1'}};
   const old=state.transactions.get(id);
   if(old){if(!isDeepStrictEqual(old,next))throw new Error('BANK_SOURCE_CONFLICT');skipped++;continue;}
   for(const old of state.transactions.values())if(old.source_system===next.source_system&&old.source_account_id===account&&old.source_row_ref===row.providerId)throw new Error('BANK_SOURCE_COLLISION');
   state.transactions.set(id,next);imported++;
 }
 if(imported)recordAudit(state,'TRANSACTIONS_IMPORTED','Run','BANK-'+randomUUID(),{actor_type:'user',actor_id:actor,reason:'User-requested read-only bank synchronization',after:{provider:'enablebanking-ais',imported,skipped}});
 return{state,imported,skipped};
}
