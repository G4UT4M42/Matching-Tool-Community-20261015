import { describe, expect, it } from 'vitest';
import XLSX from 'xlsx';
import { parseDocumentTable } from '../src/community/documents/tabular.js';
import { minorUnitDecimal, formatMinorUnits } from '../web/src/format/money.js';
const header='source_id;invoice_number;supplier_name;document_date;total_amount;currency_code';
const row='SYN-ID;SYN-INVOICE;Fictional supplier;2026-01-12;12.50;EUR';
function book(rows:unknown[][]){const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(rows),'Synthetic');return XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}) as Buffer;}

describe('document table and exact editable minor-unit boundaries',()=>{
  it('accepts absent optional net and tax columns without inventing zero values',()=>{
    const result=parseDocumentTable(Buffer.from(header+'\n'+row),'.csv','invoice')[0];
    expect(result.total_amount_minor).toBe(1250);expect(result.net_amount_minor).toBeUndefined();expect(result.vat_amount_minor).toBeUndefined();
  });
  it('rejects duplicate CSV headers before an amount can be overwritten',()=>{
    expect(()=>parseDocumentTable(Buffer.from(header+';total_amount\n'+row+';1.00'),'.csv','invoice')).toThrow(/Duplicate/);
    expect(()=>parseDocumentTable(Buffer.from(header+'; TOTAL_AMOUNT \n'+row+';1.00'),'.csv','invoice')).toThrow(/Duplicate/);
  });
  it('accepts a bounded ordinary XLSX table with the same optional columns',()=>{
    const result=parseDocumentTable(book([header.split(';'),row.split(';')]),'.xlsx','invoice');expect(result[0].total_amount_minor).toBe(1250);
  });
  it('rejects duplicate worksheet headers and dishonest archive size declarations',()=>{
    expect(()=>parseDocumentTable(book([[...header.split(';'),'total_amount'],[...row.split(';'),'99.99']]),'.xlsx','invoice')).toThrow(/Duplicate/);
    const bytes=book([header.split(';'),row.split(';')]);const directory=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE(100*1024*1024,directory+24);
    expect(()=>parseDocumentTable(bytes,'.xlsx','invoice')).toThrow(/decompression/);
  });
  it('preserves exact editable decimal values for zero-, two-, three- and four-decimal currencies',()=>{
    expect(minorUnitDecimal(1234,'JPY')).toBe('1234');expect(minorUnitDecimal(-1,'EUR')).toBe('-0.01');
    expect(minorUnitDecimal(1234,'BHD')).toBe('1.234');expect(minorUnitDecimal(29,'USD')).toBe('0.29');
    expect(minorUnitDecimal(Number.MAX_SAFE_INTEGER,'EUR')).toBe('90071992547409.91');
    expect(minorUnitDecimal(-Number.MAX_SAFE_INTEGER,'BHD')).toBe('-9007199254740.991');
  });
  it('rejects unsafe fractions or fake currencies instead of silently rounding',()=>{
    for(const value of [NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1])expect(()=>minorUnitDecimal(value,'EUR')).toThrow();
    expect(()=>minorUnitDecimal(1250,'ZZZ')).toThrow();
    expect(formatMinorUnits(-1,'EUR','de')).toContain('-0,01');expect(formatMinorUnits(1234,'BHD','en')).toContain('1.234');
  });
});
