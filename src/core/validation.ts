import type { Transaction, Document, MatchGroup } from './types.js';

const VALID_CURRENCIES = new Set(['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'AUD', 'CAD', 'JPY', 'CNY']);

export interface ValidationError {
  field: string;
  message: string;
  code: string; // E-CONTRACT-NNN
}

export function validateTransaction(t: Transaction): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!t.transaction_id) errors.push({ field: 'transaction_id', message: 'Missing transaction_id', code: 'E-CONTRACT-001' });
  if (!t.source_system) errors.push({ field: 'source_system', message: 'Missing source_system', code: 'E-CONTRACT-001' });
  if (!t.posting_at) errors.push({ field: 'posting_at', message: 'Missing posting_at', code: 'E-CONTRACT-001' });
  if (typeof t.amount_minor !== 'number' || !Number.isInteger(t.amount_minor)) {
    errors.push({ field: 'amount_minor', message: 'amount_minor must be an integer', code: 'E-CONTRACT-002' });
  }
  if (!t.currency_code || !VALID_CURRENCIES.has(t.currency_code)) {
    errors.push({ field: 'currency_code', message: `Unsupported currency: ${t.currency_code}`, code: 'E-CONTRACT-003' });
  }

  return errors;
}

export function validateDocument(d: Document): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!d.document_id) errors.push({ field: 'document_id', message: 'Missing document_id', code: 'E-CONTRACT-001' });
  if (!d.source_system) errors.push({ field: 'source_system', message: 'Missing source_system', code: 'E-CONTRACT-001' });
  if (!d.document_date) errors.push({ field: 'document_date', message: 'Missing document_date', code: 'E-CONTRACT-001' });
  if (typeof d.total_amount_minor !== 'number' || !Number.isInteger(d.total_amount_minor)) {
    errors.push({ field: 'total_amount_minor', message: 'total_amount_minor must be an integer', code: 'E-CONTRACT-002' });
  }
  if (!d.currency_code || !VALID_CURRENCIES.has(d.currency_code)) {
    errors.push({ field: 'currency_code', message: `Unsupported currency: ${d.currency_code}`, code: 'E-CONTRACT-003' });
  }

  return errors;
}

export function validateMatchGroup(mg: MatchGroup): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!mg.match_group_id) errors.push({ field: 'match_group_id', message: 'Missing match_group_id', code: 'E-CONTRACT-001' });
  if (!['proposed', 'accepted', 'rejected', 'manual'].includes(mg.status)) {
    errors.push({ field: 'status', message: `Invalid status: ${mg.status}`, code: 'E-CONTRACT-002' });
  }
  if (!mg.rule_id) errors.push({ field: 'rule_id', message: 'Missing rule_id', code: 'E-CONTRACT-001' });
  if (!mg.transaction_ids || mg.transaction_ids.length === 0) {
    errors.push({ field: 'transaction_ids', message: 'Must have at least one transaction', code: 'E-CONTRACT-001' });
  }
  if (mg.status === 'manual' && mg.created_by === 'system') {
    errors.push({ field: 'created_by', message: 'Manual matches must not be created by system', code: 'E-CONTRACT-002' });
  }

  return errors;
}

/** Convert EUR float to integer minor units (cents) */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

/** Convert integer minor units back to float */
export function fromMinorUnits(minor: number): number {
  return minor / 100;
}
