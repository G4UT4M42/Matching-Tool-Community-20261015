import { createHash } from 'node:crypto';
import { asObject, currencyCode, decimalMinor, type CanonicalTransaction, type Environment, type HttpRequest, type Transport } from './types.js';
import { requestJson } from './http.js';
import {providerAccountIdentity} from './provider-account.js';

export class PayPalClient {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private credentials: {clientId: string; clientSecret: string}, private environment: Environment, private transport: Transport) {
    if (environment !== 'sandbox' && environment !== 'live') throw new Error('INVALID_ENVIRONMENT');
  }
  private get base(): string { return this.environment === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com'; }
  invalidate(): void { this.token = null; }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60000) return this.token.value;
    const json = asObject(await requestJson(this.transport, { method: 'POST', url: `${this.base}/v1/oauth2/token`, headers: { Authorization: `Basic ${Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: 'grant_type=client_credentials' }));
    if (typeof json.access_token !== 'string' || !Number.isFinite(json.expires_in) || Number(json.expires_in) < 1) throw new Error('INVALID_PROVIDER_RESPONSE');
    this.token = { value: json.access_token, expiresAt: Date.now() + Math.min(Number(json.expires_in), 86400) * 1000 };
    return this.token.value;
  }
  async *pages(start: Date, end: Date, _localSubject?: string): AsyncGenerator<{transactions: CanonicalTransaction[]; checkpoint: string}> {
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end || end.getTime() - start.getTime() > 31 * 86400000) throw new Error('INVALID_DATE_WINDOW');
    let token = await this.accessToken();
    let totalPages = 1;
    const fingerprints = new Set<string>();
    let account:string|undefined;
    for (let page = 1; page <= totalPages; page++) {
      if (page > 1000) throw new Error('PROVIDER_PAGINATION_LIMIT');
      const url = new URL(`${this.base}/v1/reporting/transactions`);
      url.searchParams.set('start_date', start.toISOString()); url.searchParams.set('end_date', end.toISOString());
      url.searchParams.set('fields', 'all'); url.searchParams.set('page_size', '100'); url.searchParams.set('page', String(page));
      let body: unknown;
      try { body = await requestJson(this.transport, { method: 'GET', url: url.href, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'PROVIDER_UNAUTHORIZED') throw error;
        this.invalidate(); token = await this.accessToken();
        body = await requestJson(this.transport, { method: 'GET', url: url.href, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      }
      const json = asObject(body);
      const observedAccount=providerAccountIdentity('paypal',this.environment,json.account_number);
      if(account!==undefined&&observedAccount!==account)throw new Error('PROVIDER_ACCOUNT_CHANGED');
      account=observedAccount;
      const rows = json.transaction_details ?? (json.total_pages === 0 ? [] : undefined);
      if (!Array.isArray(rows) || !Number.isSafeInteger(json.total_pages) || Number(json.total_pages) < 0 || Number(json.total_pages) > 1000 || (Number(json.total_pages) < page && !(page === 1 && json.total_pages === 0))) throw new Error('INVALID_PROVIDER_RESPONSE');
      const fingerprint = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      if (fingerprints.has(fingerprint) && rows.length > 0) throw new Error('PROVIDER_PAGINATION_LOOP');
      fingerprints.add(fingerprint);
      totalPages = Number(json.total_pages);
      yield { transactions: rows.flatMap(row => normalizePayPal(row, this.environment, observedAccount)), checkpoint: end.toISOString() };
    }
  }
  async testConnection(): Promise<void> {
    const end = new Date(), start = new Date(end.getTime() - 86400000);
    await this.pages(start, end).next();
  }
}

export function normalizePayPal(value: unknown, environment: Environment, account: string): CanonicalTransaction[] {
  const detail = asObject(value), info = asObject(detail.transaction_info);
  if (typeof info.transaction_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(info.transaction_id)) throw new Error('INVALID_PROVIDER_RESPONSE');
  const amount = asObject(info.transaction_amount), currency = currencyCode(amount.currency_code);
  const amountMinor = decimalMinor(amount.value, currency);
  const fee = info.fee_amount ? asObject(info.fee_amount) : null;
  let feeMinor = 0;
  const extra: CanonicalTransaction[] = [];
  const reference = info.transaction_id;
  const eventCode = String(info.transaction_event_code ?? '');
  const classification = amountMinor < 0 || /^T11|^T12/.test(eventCode) ? 'refund' : 'payment';
  const occurredAt = String(info.transaction_initiation_date ?? info.transaction_updated_date ?? '');
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error('INVALID_PROVIDER_RESPONSE');
  if (fee) {
    const feeCurrency = currencyCode(fee.currency_code), rawFee = decimalMinor(fee.value, feeCurrency);
    if (feeCurrency === currency) feeMinor = rawFee;
    else extra.push({ provider: 'paypal', environment, account, reference: `${reference}:fee:${feeCurrency}`, relatedReference: reference, occurredAt, currency: feeCurrency, amountMinor: rawFee, feeMinor: 0, netMinor: rawFee, classification: 'fee', revenue: false });
  }
  const netMinor = amountMinor + feeMinor;
  if (!Number.isSafeInteger(netMinor)) throw new Error('INVALID_PROVIDER_AMOUNT');
  const sourceEventKey = `${reference}:${eventCode}:${occurredAt}:${currency}:${amountMinor}:${feeMinor}`;
  return [{ provider: 'paypal', environment, account, reference, sourceEventKey, relatedReference: typeof info.paypal_reference_id === 'string' ? info.paypal_reference_id : undefined, occurredAt, currency, amountMinor, feeMinor, netMinor, classification, revenue: info.transaction_status === undefined || info.transaction_status === 'S' }, ...extra];
}
