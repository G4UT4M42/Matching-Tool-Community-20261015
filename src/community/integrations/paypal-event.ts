import type {CanonicalTransaction} from './types.js';

/** Provider event evidence, independent of debit/credit sign. Unknown events need review. */
export function paypalEventClassification(code:unknown):CanonicalTransaction['classification']|'informational'{
 if(typeof code!=='string'||!/^T\d{4}$/.test(code))throw Error('INVALID_PROVIDER_RESPONSE');
 if(code==='T9800'||/^T13/.test(code)||code==='T0505')return 'informational';
 if(/^T01/.test(code)||['T1108','T1109'].includes(code))return 'fee';
 if(/^T04|^T17/.test(code))return 'payout';
 if(/^T02|^T03|^T20/.test(code)||['T0502','T0504','T0701','T1101','T1104','T1112','T1601','T1603','T1801'].includes(code))return 'transfer';
 if(['T1106','T1201','T1202','T1205','T1207','T1208'].includes(code))return 'dispute';
 if(['T1102','T1107','T1114','T1115','T1118','T1119','T1120'].includes(code))return 'refund';
 if(/^T00/.test(code)&&!['T0020','T0021'].includes(code)||['T0500','T0501','T0503','T1000','T1113'].includes(code))return 'payment';
 return 'other';
}
