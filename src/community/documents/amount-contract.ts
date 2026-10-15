import {DocumentInputError} from './recognition.js';
export type InvoiceDocumentType='invoice'|'credit_note';
/** A credit note is explicit reviewed evidence; a cashflow never chooses its sign. */
export function checkedDocumentAmounts(type:unknown,total:number,net?:number,vat?:number):InvoiceDocumentType{
  const kind=type??'invoice';
  if(kind!=='invoice'&&kind!=='credit_note')throw new DocumentInputError('INVALID_FIELDS','Select invoice or credit note');
  const direction=kind==='credit_note'?-1:1;
  if(!Number.isSafeInteger(total)||total*direction<=0||net!==undefined&&(!Number.isSafeInteger(net)||net*direction<0||Math.abs(net)>Math.abs(total))||vat!==undefined&&(!Number.isSafeInteger(vat)||vat*direction<0||Math.abs(vat)>Math.abs(total))||net!==undefined&&vat!==undefined&&(!Number.isSafeInteger(net+vat)||net+vat!==total))throw new DocumentInputError('INVALID_AMOUNT','Document type, signed totals and net plus VAT must agree');
  return kind;
}
