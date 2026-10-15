import { createHash } from 'node:crypto';
import type { InvoiceEvidence, Candidate, PaymentItem } from './types.js';

const lengths: Record<string,number> = { AT:20, BE:16, CH:21, CY:28, CZ:24, DE:22, DK:18, EE:20, ES:24, FI:18, FR:27, GB:22, GR:27, HR:21, HU:28, IE:22, IS:26, IT:27, LI:21, LT:20, LU:20, LV:21, MC:27, MT:31, NL:18, NO:15, PL:28, PT:25, RO:24, SE:24, SI:19, SK:24, SM:27, VA:22 };
export function normalizeIban(raw: string): string { return raw.replace(/\s/g,'').toUpperCase(); }
export function validIban(raw: string): boolean {
  const value = normalizeIban(raw);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(value) || lengths[value.slice(0,2)] !== value.length) return false;
  let rem = 0;
  for (const char of value.slice(4)+value.slice(0,4)) {
    const part = /[A-Z]/.test(char) ? String(char.charCodeAt(0)-55) : char;
    for (const digit of part) rem = (rem*10+Number(digit))%97;
  }
  return rem === 1;
}
export function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value; }
export function validText(value: string, max: number): boolean { return value.length > 0 && value.length <= max && /^[A-Za-z0-9 äöüÄÖÜßÀ-ÿ&/?:().,'+\-]+$/.test(value); }
export function validReference(value:string):boolean {
  if(!validText(value,140))return false;
  const compact=value.replace(/\s/g,'').toUpperCase();
  if(!/^RF\d{2}/.test(compact))return true;
  if(!/^RF\d{2}[A-Z0-9]{1,21}$/.test(compact))return false;
  let rem=0;for(const char of compact.slice(4)+compact.slice(0,4)){const part=/[A-Z]/.test(char)?String(char.charCodeAt(0)-55):char;for(const digit of part)rem=(rem*10+Number(digit))%97}return rem===1;
}
export function candidate(e: InvoiceEvidence): Candidate {
  const issues: string[] = [];
  if (!e.confirmed) issues.push('INVOICE_UNCONFIRMED');
  if (e.archived || e.rejected) issues.push('DOCUMENT_EXCLUDED');
  if (!Number.isSafeInteger(e.totalMinor) || e.totalMinor <= 0 || !Number.isSafeInteger(e.allocatedMinor) || e.allocatedMinor < 0 || e.allocatedMinor > e.totalMinor) issues.push('INVALID_BALANCE');
  const outstandingMinor = e.totalMinor-e.allocatedMinor;
  if (outstandingMinor <= 0) issues.push('ALREADY_PAID');
  if (e.currency !== 'EUR') issues.push('UNSUPPORTED_CURRENCY');
  if (!e.creditorName || !validText(e.creditorName,70)) issues.push('CREDITOR_REVIEW_REQUIRED');
  if (!e.creditorIban || !validIban(e.creditorIban)) issues.push('IBAN_REVIEW_REQUIRED');
  if (!e.reference || !validReference(e.reference)) issues.push('REFERENCE_REVIEW_REQUIRED');
  if (!e.dueDate || !validDate(e.dueDate)) issues.push('DUE_DATE_REVIEW_REQUIRED');
  if (!e.documentId || !e.invoiceId || !/^[a-f0-9]{64}$/i.test(e.sourceHash)) issues.push('SOURCE_IDENTITY_REQUIRED');
  return { evidence:e, outstandingMinor, issues, eligible:issues.length===0 };
}
export function itemFromCandidate(c: Candidate): PaymentItem {
  if (!c.eligible) throw new Error('CANDIDATE_REVIEW_REQUIRED');
  const e=c.evidence;
  return { id:`P${createHash('sha256').update(e.documentId).digest('hex').slice(0,32).toUpperCase()}`, documentId:e.documentId, invoiceId:e.invoiceId, sourceHash:e.sourceHash, creditorName:e.creditorName!, creditorIban:normalizeIban(e.creditorIban!), amountMinor:c.outstandingMinor, currency:'EUR', reference:e.reference!, dueDate:e.dueDate!, matchIds:[...e.matchIds] };
}
