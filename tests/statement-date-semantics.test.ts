import {describe,it,expect} from 'vitest';
import XLSX from 'xlsx';
import {parseStatementBuffer} from '../src/import/statement-parser.js';

function statement(extension:string,headers:string[],values:unknown[]){
  if(extension==='.csv')return Buffer.from(headers.join(';')+'\n'+values.join(';')+'\n');
  const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([headers,values]),'Synthetic');
  return XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}) as Buffer;
}
describe.each(['.csv','.xlsx'])('separate statement date semantics %s',extension=>{
  it.each(['sparkasse','visa'] as const)('preserves booking, value and transaction dates for %s',source=>{
    const bytes=statement(extension,['Buchungstag','Valutadatum','Transaktionsdatum','Betrag','Waehrung','Referenz'],['12.01.2026','13.01.2026','11.01.2026','-1.23','EUR','SYN-DATES']);
    const [row]=parseStatementBuffer(bytes,extension,source,{accountId:'SYNTHETIC'});
    expect(row).toMatchObject({posting_at:'2026-01-12',value_at:'2026-01-13',amount_minor:-123,source_row_ref:'SYN-DATES',source_account_id:'SYNTHETIC'});
    expect(row.meta.statement_transaction_at).toBe('2026-01-11');
  });
  it('uses Visa transaction date before a generic date when no booking date exists',()=>{
    const bytes=statement(extension,['Datum','Transaktionsdatum','Valutadatum','Betrag'],['10.01.2026','11.01.2026','13.01.2026','-1.23']);
    expect(parseStatementBuffer(bytes,extension,'visa')[0]).toMatchObject({posting_at:'2026-01-11',value_at:'2026-01-13'});
    expect(parseStatementBuffer(bytes,extension,'sparkasse')[0].posting_at).toBe('2026-01-10');
  });
  it('retains the value-date-only fallback without inventing a transaction date',()=>{
    const bytes=statement(extension,['Wertstellungsdatum','Betrag'],['13.01.2026','-1.23']);
    const [row]=parseStatementBuffer(bytes,extension,'sparkasse');
    expect(row).toMatchObject({posting_at:'2026-01-13',value_at:'2026-01-13'});expect(row.meta).not.toHaveProperty('statement_transaction_at');
  });
  it('still rejects duplicate normalized headers and competing aliases of the same field',()=>{
    for(const headers of [['Buchungstag','buchungstag','Betrag'],['Buchungstag','Buchungsdatum','Betrag'],['Valutadatum','Wertstellungsdatum','Betrag']]){
      expect(()=>parseStatementBuffer(statement(extension,headers,['12.01.2026','13.01.2026','-1.23']),extension,'sparkasse')).toThrow();
    }
  });
  it('rejects malformed secondary source dates instead of silently dropping them',()=>{
    const bytes=statement(extension,['Buchungstag','Valutadatum','Betrag'],['12.01.2026','31.02.2026','-1.23']);
    expect(()=>parseStatementBuffer(bytes,extension,'sparkasse')).toThrow();
  });
});
