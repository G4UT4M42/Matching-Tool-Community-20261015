import { expect,it } from 'vitest';
import { prepareBankImport } from '../src/community/banking/canonical-import.js';
import { createEmptyState } from '../src/storage/json-store.js';
const row={providerId:'SYN-BOOK-001',accountRef:'session-specific-account',accountIdentity:'synthetic-stable-identification-hash',bookedAt:'2026-10-15',amountMinor:-1234,currency:'EUR',description:'Synthetic supplier'};
it('keeps bank identity after session renewal, prevents duplicate and changed economic events',()=>{
 const before=createEmptyState('SYNTHETIC_BANK');const first=prepareBankImport(before,[row],'USR-test');
 expect(before.transactions.size).toBe(0);expect(first.imported).toBe(1);
 const renewed=prepareBankImport(first.state,[{...row,accountRef:'new-session-account'}],'USR-test');
 expect(renewed.imported).toBe(0);expect(renewed.skipped).toBe(1);expect(renewed.state.transactions).toEqual(first.state.transactions);
 expect(()=>prepareBankImport(first.state,[{...row,amountMinor:-1235}],'USR-test')).toThrow('BANK_SOURCE_CONFLICT');
 expect(first.state.audit_events).toHaveLength(1);expect(renewed.state.audit_events).toEqual(first.state.audit_events);
 expect([...first.state.transactions.values()][0].amount_minor).toBe(-1234);
});
it('rejects missing stable identity, fractional amounts, unsupported currency and impossible dates',()=>{
 const before=createEmptyState('SYNTHETIC_BANK_INVALID');
 for(const invalid of [{accountIdentity:undefined},{amountMinor:1.2},{currency:'USD'},{bookedAt:'2026-02-30'}])expect(()=>prepareBankImport(before,[{...row,...invalid}],'USR-test')).toThrow();
 expect(before.transactions.size).toBe(0);
});
