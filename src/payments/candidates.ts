import type { ExtractedFields, InvoiceScan } from '../invoicerec/types.js';
import * as invoiceStore from '../invoicerec/store.js';
import { classifyPaymentEligibility } from './eligibility.js';
import {
  PaymentRepository,
  type PaymentBatchStatus,
  type PaymentCandidate,
  type PaymentCandidateWriteInput,
} from './repository.js';
import { FIXED_DEBTOR } from './types.js';
import { isValidIban, normalizeIban } from './validation.js';

const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22,
  BH: 22, BI: 16, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24,
  DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18,
  FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27,
  GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27,
  JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
  LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27,
  MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28,
  PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31,
  SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28,
  TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
});

const DEBTOR_CONTEXT = /(?:\bihre\s+iban\b|\beigene\s+iban\b|rechnungsempfänger|rechnungsempfaenger|invoice\s+recipient|bill\s+to|käufer|kaeufer|buyer|debtor|schuldner|zahlungspflichtig)/i;
const ACCOUNT_HOLDER_CONTEXT = /(?:kontoinhaber|account\s+holder)/i;
const CREDITOR_CONTEXT = /(?:zahlungsempfänger|zahlungsempfaenger|\bempfänger|\bempfaenger|gläubiger|glaeubiger|begünstigter|beguenstigter|beneficiary|creditor|lieferant|vendor|seller|bankverbindung|bank\s+details|payment\s+details)/i;

export interface PaymentSummary {
  candidate_id: string;
  document_id: string;
  classification: PaymentCandidate['classification'];
  eligible: boolean;
  reason_code: string | null;
  batch_status: PaymentBatchStatus | null;
}

function groupedIbanPattern(length: number): RegExp {
  const remaining = length - 4;
  const fullGroups = Math.floor(remaining / 4);
  const finalLength = remaining % 4;
  const groups = '(?:[ \\t-][A-Z0-9]{4})'.repeat(fullGroups)
    + (finalLength > 0 ? `[ \\t-][A-Z0-9]{${finalLength}}` : '');
  return new RegExp(`^[A-Z]{2}[ \\t]*[A-Z0-9]{2}${groups}(?![A-Z0-9])`);
}

function repairIbanCheckDigits(value: string): string {
  const replacements: Readonly<Record<string, string>> = Object.freeze({
    O: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6',
  });
  return value.length < 4
    ? value
    : `${value.slice(0, 2)}${[...value.slice(2, 4)].map(character => replacements[character] ?? character).join('')}${value.slice(4)}`;
}

function extractValidIbans(rawText: string): Array<{ iban: string; lineIndex: number }> {
  const found: Array<{ iban: string; lineIndex: number }> = [];
  const lines = rawText.split(/\r?\n/);
  lines.forEach((line, lineIndex) => {
    const upper = line.toUpperCase();
    const starts = upper.matchAll(/\b([A-Z]{2})[ \t]*[A-Z0-9]{2}/g);
    for (const match of starts) {
      const country = match[1];
      const length = IBAN_LENGTHS[country];
      if (!length || match.index == null) continue;
      const tail = upper.slice(match.index);
      const compact = tail.match(new RegExp(`^[A-Z]{2}[A-Z0-9]{${length - 2}}(?![A-Z0-9])`))?.[0];
      const token = compact ?? tail.match(groupedIbanPattern(length))?.[0];
      if (!token) continue;
      const iban = repairIbanCheckDigits(normalizeIban(token.replace(/-/g, '')));
      if (isValidIban(iban)) found.push({ iban, lineIndex });
    }
  });
  return found;
}

function normalizedPartyName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function isDebtorBlock(lines: string[], lineIndex: number, buyerName: string | null): boolean {
  const debtorNames = [buyerName, FIXED_DEBTOR.accountHolder]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalizedPartyName);

  for (let index = lineIndex; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line) continue;
    if (CREDITOR_CONTEXT.test(line)) return false;
    if (DEBTOR_CONTEXT.test(line)) return true;
    if (ACCOUNT_HOLDER_CONTEXT.test(line)) {
      const accountHolderBlock = normalizedPartyName(lines.slice(index, lineIndex + 1).join(' '));
      return debtorNames.some(name => accountHolderBlock.includes(name));
    }
  }
  return false;
}

function extractCreditorIbans(rawText: string, buyerName: string | null, currencyCode: string | null): string[] {
  const candidates: Array<{ iban: string; line: string }> = [];
  const lines = rawText.split(/\r?\n/);
  for (const value of extractValidIbans(rawText)) {
    if (value.iban === FIXED_DEBTOR.iban || isDebtorBlock(lines, value.lineIndex, buyerName)) continue;
    candidates.push({ iban: value.iban, line: lines[value.lineIndex] ?? '' });
  }
  const unique = (values: typeof candidates) => [...new Set(values.map(value => value.iban))];
  const all = unique(candidates);
  if (all.length <= 1 || !currencyCode) return all;

  // Some vendors print one bank account per currency on the same invoice. Prefer
  // the account whose own line explicitly labels the invoice currency; without
  // that local evidence the existing fail-closed ambiguity remains intact.
  const escapedCurrency = currencyCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labelledCurrency = new RegExp(`(?:währung|waehrung|currency)\\s*:?\\s*${escapedCurrency}\\b`, 'i');
  const currencyMatches = unique(candidates.filter(candidate => labelledCurrency.test(candidate.line)));
  return currencyMatches.length === 1 ? currencyMatches : all;
}

function isoDate(year: string, month: string, day: string): string | null {
  const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
}

function extractDueDate(rawText: string): string | null {
  const label = '(?:zahlbar\\s+bis|fällig(?:keit)?(?:sdatum)?|faellig(?:keit)?(?:sdatum)?|zahlung\\s+fällig(?:\\s+am)?|zahlung\\s+faellig(?:\\s+am)?|payment\\s+due|due\\s+date)';
  const labelled = rawText.match(new RegExp(`${label}\\s*:?\\s*(\\d{1,2})[.\\/-](\\d{1,2})[.\\/-](\\d{4})`, 'i'));
  if (labelled) return isoDate(labelled[3], labelled[2], labelled[1]);
  const iso = rawText.match(new RegExp(`${label}\\s*:?\\s*(\\d{4})-(\\d{2})-(\\d{2})`, 'i'));
  if (iso) return isoDate(iso[1], iso[2], iso[3]);
  const reversedIso = rawText.match(new RegExp(`(\\d{4})-(\\d{2})-(\\d{2})\\s+${label}`, 'i'));
  return reversedIso ? isoDate(reversedIso[1], reversedIso[2], reversedIso[3]) : null;
}

function isValidCreditorReference(value: string): boolean {
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(value)) return false;
  const rearranged = `${value.slice(4)}${value.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const numeric = character >= 'A'
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function extractCreditorReference(rawText: string): string | null {
  for (const line of rawText.split(/\r?\n/)) {
    const matches = [
      ...line.matchAll(/\bRF\d{2}[A-Z0-9]{1,21}(?![A-Z0-9])/gi),
      ...line.matchAll(/\bRF\d{2}(?:[ \t-][A-Z0-9]{4}){1,5}(?:[ \t-][A-Z0-9]{1,3})?(?![A-Z0-9])/gi),
    ];
    for (const match of matches) {
      const normalized = match[0].replace(/[ \t-]/g, '').toUpperCase();
      if (isValidCreditorReference(normalized)) return normalized;
    }
  }
  return null;
}

export function buildPaymentCandidate(
  scan: InvoiceScan,
  fields: ExtractedFields,
  rawText = scan.raw_text ?? '',
): PaymentCandidateWriteInput {
  if (!scan.document_id) throw new Error('PAYMENT_DOCUMENT_NOT_CONFIRMED');

  const creditorIbans = extractCreditorIbans(rawText, fields.buyer_name, fields.currency_code);
  const ambiguousIban = creditorIbans.length > 1;
  const payableAmount = Number.isSafeInteger(fields.meta?.payable_amount_minor)
    ? fields.meta.payable_amount_minor as number
    : fields.gross_amount_minor;
  const amountMinor = fields.currency_code === 'EUR' && payableAmount !== null
    ? Math.abs(payableAmount)
    : null;
  const dueDate = extractDueDate(rawText);
  const structuredCreditorReference = extractCreditorReference(rawText);
  const remittanceInformation = fields.invoice_number
    ? `Rechnung ${fields.invoice_number}`
    : structuredCreditorReference;
  const eligibility = classifyPaymentEligibility({
    status: scan.status,
    currencyCode: fields.currency_code,
    amountMinor,
    rawText,
    meta: scan.meta,
  });

  return {
    documentId: scan.document_id,
    scanId: scan.scan_id,
    creditorName: fields.seller_name,
    creditorIban: ambiguousIban ? null : creditorIbans[0] ?? null,
    amountMinor,
    currencyCode: fields.currency_code,
    remittanceInformation,
    structuredCreditorReference,
    requestedExecutionDate: dueDate,
    invoiceNumber: fields.invoice_number,
    dueDate,
    classification: ambiguousIban ? 'unclear' : eligibility.classification,
    reasonCode: ambiguousIban ? 'AMBIGUOUS_CREDITOR_IBAN' : eligibility.reasonCode,
    sourceMeta: {
      strategy: 'deterministic_rules',
      confidence: {
        creditorName: fields.confidence.seller_name?.value ?? null,
        invoiceNumber: fields.confidence.invoice_number?.value ?? null,
        creditorIban: creditorIbans.length === 1 ? 1 : 0,
        dueDate: dueDate ? 1 : 0,
        amountMinor: amountMinor === null ? 0 : 1,
        currencyCode: fields.currency_code ? 1 : 0,
        remittanceInformation: remittanceInformation ? 1 : 0,
        structuredCreditorReference: structuredCreditorReference ? 1 : 0,
        requestedExecutionDate: dueDate ? 1 : 0,
      },
      sources: {
        creditorName: fields.confidence.seller_name?.source ?? 'extracted_fields',
        invoiceNumber: fields.confidence.invoice_number?.source ?? 'extracted_fields',
        creditorIban: 'raw_text_rule',
        dueDate: 'raw_text_rule',
        amountMinor: Number.isSafeInteger(fields.meta?.payable_amount_minor)
          ? 'extracted_fields:meta.payable_amount_minor'
          : 'extracted_fields:gross_amount_minor',
        currencyCode: 'extracted_fields:currency_code',
        remittanceInformation: fields.invoice_number ? 'extracted_fields:invoice_number' : 'raw_text_rule',
        structuredCreditorReference: 'raw_text_rule',
        requestedExecutionDate: 'raw_text_rule:due_date',
      },
      creditorIbanCandidates: creditorIbans,
    },
  };
}

export function refreshPaymentCandidate(scanId: string): PaymentCandidate {
  const scan = invoiceStore.getScan(scanId);
  if (!scan) throw new Error('PAYMENT_SCAN_NOT_FOUND');
  const fields = invoiceStore.getFields(scanId);
  if (!fields) throw new Error('PAYMENT_FIELDS_NOT_FOUND');
  return new PaymentRepository().replaceCandidateForScan(buildPaymentCandidate(scan, fields));
}

export function paymentSummary(
  candidate: PaymentCandidate | null,
  batchStatus: PaymentBatchStatus | null,
): PaymentSummary | null {
  return candidate ? {
    candidate_id: candidate.candidateId,
    document_id: candidate.documentId,
    classification: candidate.classification,
    eligible: candidate.classification === 'unpaid' && candidate.validationErrors.length === 0,
    reason_code: candidate.reasonCode,
    batch_status: batchStatus,
  } : null;
}
