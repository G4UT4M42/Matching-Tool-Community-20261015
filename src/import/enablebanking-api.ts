/**
 * Enable Banking API client — PSD2 bank account access.
 * Uses JWT (RS256) authentication with a private key.
 * Docs: https://enablebanking.com/docs/api/reference/
 */

import type { Transaction } from '../core/types.js';
import { transactionId } from '../core/ids.js';
import { getSetting } from '../storage/settings.js';
import { createSign, createPrivateKey } from 'crypto';
import { readFileSync } from 'fs';

const API_BASE = 'https://api.enablebanking.com';

// --- JWT generation ---

function generateJwt(applicationId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    typ: 'JWT',
    alg: 'RS256',
    kid: applicationId,
  };

  const payload = {
    iss: 'enablebanking.com',
    aud: 'api.enablebanking.com',
    iat: now,
    exp: now + 3600,
  };

  const b64url = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');

  const headerB64 = b64url(header);
  const payloadB64 = b64url(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = createPrivateKey(privateKeyPem);
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(key, 'base64url');

  return `${signingInput}.${signature}`;
}

// --- Token cache ---

let cachedJwt: { token: string; expiresAt: number } | null = null;

export function getAuthToken(): string {
  if (cachedJwt && Date.now() < cachedJwt.expiresAt) {
    return cachedJwt.token;
  }

  const appId = getSetting('eb_application_id');
  const keyPath = getSetting('eb_private_key_path');
  const keyPem = getSetting('eb_private_key_pem');

  if (!appId) throw new Error('Enable Banking Application ID nicht konfiguriert');

  let privateKey: string;
  if (keyPem) {
    privateKey = keyPem;
  } else if (keyPath) {
    privateKey = readFileSync(keyPath, 'utf-8');
  } else {
    throw new Error('Enable Banking Private Key nicht konfiguriert (eb_private_key_pem oder eb_private_key_path)');
  }

  const token = generateJwt(appId, privateKey);
  cachedJwt = { token, expiresAt: Date.now() + 3500 * 1000 };  // ~58 min
  return token;
}

// --- Generic fetch ---

async function ebFetch<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
  const token = getAuthToken();
  const url = `${API_BASE}${path}`;

  const init: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) init.body = JSON.stringify(body);

  const res = await fetch(url, init);

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText })) as any;
    throw new Error(`Enable Banking ${res.status}: ${err.message ?? err.detail ?? res.statusText}`);
  }

  if (res.status === 204) return {} as T;
  return await res.json() as T;
}

// --- Types ---

export interface EbAspsp {
  name: string;
  country: string;
  logo?: string;
  auth_methods?: string[];
}

export interface EbAccount {
  uid: string;
  account_id: { iban?: string };
  name?: string;
  currency?: string;
}

export interface EbSession {
  session_id: string;
  accounts: EbAccount[];
  aspsp: { name: string; country: string };
  status?: string;
}

export interface EbBalance {
  name: string;
  balance_amount: { currency: string; amount: string };
  balance_type: string;
  reference_date?: string;
}

export interface EbTransaction {
  transaction_id?: string;
  booking_date?: string;
  value_date?: string;
  transaction_amount: { currency: string; amount: string };
  creditor_name?: string;
  creditor_account?: { iban?: string };
  debtor_name?: string;
  debtor_account?: { iban?: string };
  remittance_information?: string[];
  end_to_end_id?: string;
  entry_reference?: string;
  bank_transaction_code?: string;
  additional_information?: string;
}

// --- API functions ---

/** List available banks for a country */
export async function listAspsps(country: string): Promise<EbAspsp[]> {
  const data = await ebFetch<{ aspsps: EbAspsp[] }>('GET', `/aspsps?country=${country}`);
  return data.aspsps ?? [];
}

/** Start authorization — returns URL to redirect user to */
export async function startAuth(
  aspspName: string,
  aspspCountry: string,
  redirectUrl: string,
  state: string,
): Promise<{ url: string; authorization_id?: string }> {
  const validUntil = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

  return ebFetch<{ url: string; authorization_id?: string }>('POST', '/auth', {
    access: { valid_until: validUntil },
    aspsp: { name: aspspName, country: aspspCountry },
    state,
    redirect_url: redirectUrl,
    psu_type: 'personal',
  });
}

/** Complete authorization after redirect — creates session with accounts */
export async function createSession(code: string): Promise<EbSession> {
  return ebFetch<EbSession>('POST', '/sessions', { code });
}

/** Get existing session status */
export async function getSession(sessionId: string): Promise<EbSession> {
  return ebFetch<EbSession>('GET', `/sessions/${sessionId}`);
}

/** Delete session */
export async function deleteSession(sessionId: string): Promise<void> {
  await ebFetch<any>('DELETE', `/sessions/${sessionId}`);
}

/** Get account balances */
export async function getBalances(accountUid: string): Promise<EbBalance[]> {
  const data = await ebFetch<{ balances: EbBalance[] }>('GET', `/accounts/${accountUid}/balances`);
  return data.balances ?? [];
}

/** Fetch transactions for an account with date range */
export async function fetchTransactions(
  accountUid: string,
  dateFrom: string,
  dateTo: string,
): Promise<EbTransaction[]> {
  const all: EbTransaction[] = [];
  let continuationKey: string | undefined;

  while (true) {
    const params = new URLSearchParams({
      date_from: dateFrom,
      date_to: dateTo,
    });
    if (continuationKey) params.set('continuation_key', continuationKey);

    const data = await ebFetch<{ transactions: EbTransaction[]; continuation_key?: string }>(
      'GET', `/accounts/${accountUid}/transactions?${params}`,
    );

    all.push(...(data.transactions ?? []));

    if (!data.continuation_key) break;
    continuationKey = data.continuation_key;
  }

  return all;
}

// --- Normalize ---

export function normalizeEbTransaction(t: EbTransaction, accountUid: string): Transaction {
  const bookingDate = t.booking_date ?? t.value_date ?? '';
  const postingAt = bookingDate ? `${bookingDate}T00:00:00+01:00` : new Date().toISOString();
  const currency = (t.transaction_amount.currency ?? 'EUR').toUpperCase();
  const amountMinor = Math.round(parseFloat(t.transaction_amount.amount) * 100);

  // Determine counterparty: if amount positive → debtor sent money, if negative → we paid creditor
  const counterpartyName = amountMinor >= 0 ? t.debtor_name : t.creditor_name;
  const counterpartyIban = amountMinor >= 0
    ? t.debtor_account?.iban
    : t.creditor_account?.iban;

  const description = [
    ...(t.remittance_information ?? []),
    t.additional_information,
  ].filter(Boolean).join(' | ') || '';

  const srcRef = t.transaction_id ?? t.entry_reference ?? `${bookingDate}-${amountMinor}`;

  return {
    transaction_id: transactionId('enablebanking', accountUid, srcRef, postingAt, amountMinor, currency),
    source_system: 'enablebanking',
    source_account_id: accountUid,
    source_row_ref: srcRef,
    posting_at: postingAt,
    value_at: t.value_date ? `${t.value_date}T00:00:00+01:00` : undefined,
    amount_minor: amountMinor,
    currency_code: currency,
    description_raw: description,
    counterparty_name: counterpartyName ?? undefined,
    counterparty_iban: counterpartyIban ?? undefined,
    payment_reference: t.end_to_end_id ?? undefined,
    tags: t.bank_transaction_code ? [t.bank_transaction_code] : [],
    meta: {
      eb_transaction_id: t.transaction_id,
      entry_reference: t.entry_reference,
      creditor_name: t.creditor_name,
      creditor_iban: t.creditor_account?.iban,
      debtor_name: t.debtor_name,
      debtor_iban: t.debtor_account?.iban,
      bank_transaction_code: t.bank_transaction_code,
    },
  };
}
