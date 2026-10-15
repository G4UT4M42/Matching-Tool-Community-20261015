import { createHash } from 'node:crypto';
import type { PaymentBatch } from './types.js';
import { validIban, validText, validReference } from './validation.js';

const esc = (s:string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const euros=(minor:number)=>`${Math.floor(minor/100)}.${String(minor%100).padStart(2,'0')}`;
export function sepaExport(batch: PaymentBatch): { xml:string; sha256:string; count:number; controlSumMinor:number } {
  if (!['validated','reviewed','approved'].includes(batch.status)) throw new Error('BATCH_NOT_VALIDATED');
  if (!validIban(batch.debtorIban) || !validText(batch.debtorName,70) || batch.items.length===0) throw new Error('INVALID_DEBTOR_OR_ITEMS');
  let sum=0;
  const tx = batch.items.map((i,index) => {
    if (!Number.isSafeInteger(i.amountMinor) || i.amountMinor<=0 || i.currency!=='EUR' || !validIban(i.creditorIban) || !validText(i.creditorName,70) || !validReference(i.reference)) throw new Error('INVALID_PAYMENT_ITEM');
    sum+=i.amountMinor;
    if (!Number.isSafeInteger(sum)) throw new Error('CONTROL_SUM_OVERFLOW');
    const amount=euros(i.amountMinor);
    return `<CdtTrfTxInf><PmtId><EndToEndId>${esc(i.id.slice(0,35))}</EndToEndId></PmtId><Amt><InstdAmt Ccy="EUR">${amount}</InstdAmt></Amt><Cdtr><Nm>${esc(i.creditorName)}</Nm></Cdtr><CdtrAcct><Id><IBAN>${esc(i.creditorIban)}</IBAN></Id></CdtrAcct><RmtInf><Ustrd>${esc(i.reference)}</Ustrd></RmtInf></CdtTrfTxInf>`;
  });
  const created=new Date(batch.createdAt);
  if(Number.isNaN(created.valueOf())) throw new Error('INVALID_BATCH_DATE');
  const date = batch.items.reduce((a,i) => i.dueDate>a ? i.dueDate : a,created.toISOString().slice(0,10));
  const total=euros(sum);
  const messageId=`MC-${batch.id}-${batch.revision}`.slice(0,35);
  const xml=`<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"><CstmrCdtTrfInitn><GrpHdr><MsgId>${esc(messageId)}</MsgId><CreDtTm>${created.toISOString().slice(0,19)}</CreDtTm><NbOfTxs>${batch.items.length}</NbOfTxs><CtrlSum>${total}</CtrlSum><InitgPty><Nm>${esc(batch.debtorName)}</Nm></InitgPty></GrpHdr><PmtInf><PmtInfId>${esc(messageId)}</PmtInfId><PmtMtd>TRF</PmtMtd><BtchBookg>true</BtchBookg><NbOfTxs>${batch.items.length}</NbOfTxs><CtrlSum>${total}</CtrlSum><PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf><ReqdExctnDt><Dt>${date}</Dt></ReqdExctnDt><Dbtr><Nm>${esc(batch.debtorName)}</Nm></Dbtr><DbtrAcct><Id><IBAN>${esc(batch.debtorIban)}</IBAN></Id></DbtrAcct><DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt><ChrgBr>SLEV</ChrgBr>${tx.join('')}</PmtInf></CstmrCdtTrfInitn></Document>`;
  return {xml,sha256:createHash('sha256').update(xml).digest('hex'),count:batch.items.length,controlSumMinor:sum};
}
