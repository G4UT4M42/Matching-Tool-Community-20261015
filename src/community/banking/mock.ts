import type { PaymentAdapter } from '../payments/types.js';
import type { BankAccountRow, BankTransactionRow, ReadOnlyBankAdapter } from './service.js';

/** Local fake portal for synthetic tests. Constructor requires an injected marker that deployment wiring never exposes to HTTP. */
export function localFakeAdapters(marker:symbol) {
  if(marker!==LOCAL_FAKE_BANK_MARKER) throw new Error('LOCAL_FAKE_BANK_ONLY');
  const calls:{submit:number;status:number}={submit:0,status:0};
  let outcome:'acknowledged'|'unknown'|'failed'='acknowledged';
  const payment:PaymentAdapter={provider:'local-fake-bank',environment:'mock',async submit({claimId}){calls.submit++;return {outcome,reference:outcome==='acknowledged'?`FAKE-${claimId}`:undefined}},async readStatus({claimId}){calls.status++;return {outcome,reference:outcome==='acknowledged'?`FAKE-${claimId}`:undefined}}};
  const read:ReadOnlyBankAdapter={provider:'enablebanking-ais',environment:'mock',capabilities:['accounts','transactions'],async accounts(_secret,_accountRef):Promise<BankAccountRow[]>{return []},async transactions(_secret,_accountRef,_from,_to):Promise<BankTransactionRow[]>{return []}};
  return {payment,read,calls,setOutcome(value:typeof outcome){outcome=value}};
}
export const LOCAL_FAKE_BANK_MARKER=Symbol('local fake bank test fixture');
