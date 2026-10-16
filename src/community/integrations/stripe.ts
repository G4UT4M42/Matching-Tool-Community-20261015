import { asObject, currencyCode, safeInteger, type CanonicalTransaction, type Environment, type Transport } from './types.js';
import { requestJson } from './http.js';
import {providerAccountIdentity} from './provider-account.js';
import {readStripePayout,validPayoutId} from './stripe-payout.js';

export class StripeClient {
  constructor(private key: string, private environment: Environment, private transport: Transport) {
    if (environment !== 'test' && environment !== 'live' || !new RegExp(`^rk_${environment}_[A-Za-z0-9]{8,}$`).test(key)) throw new Error('INVALID_CREDENTIALS');
  }
  private async accountIdentity(transport=this.transport):Promise<string>{
    const account=asObject(await requestJson(transport,{method:'GET',url:'https://api.stripe.com/v1/account',headers:{Authorization:`Bearer ${this.key}`,Accept:'application/json'}}));
    if(account.object!=='account')throw new Error('PROVIDER_ACCOUNT_UNAVAILABLE');
    return providerAccountIdentity('stripe',this.environment,account.id);
  }
  async identifyAccount():Promise<string>{return this.accountIdentity();}
  async reconcilePayout(payoutId:string,guard:()=>void=()=>{}){if(!validPayoutId(payoutId))throw new Error('INVALID_PAYOUT_ID');const transport:Transport=async request=>{guard();const response=await this.transport(request);guard();return response;};guard();const account=await this.accountIdentity(transport);guard();return readStripePayout(this.key,this.environment,account,payoutId,transport,guard);}
  async *pages(start: Date, end: Date, _localSubject?: string): AsyncGenerator<{transactions: CanonicalTransaction[]; checkpoint: string}> {
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error('INVALID_DATE_WINDOW');
    const account=await this.accountIdentity();
    let after: string | null = null;
    const seenPages = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const url = new URL('https://api.stripe.com/v1/balance_transactions');
      url.searchParams.set('limit', '100');
      url.searchParams.set('created[gte]', String(Math.floor(start.getTime() / 1000)));
      url.searchParams.set('created[lte]', String(Math.floor(end.getTime() / 1000)));
      if (after) url.searchParams.set('starting_after', after);
      const json = asObject(await requestJson(this.transport, { method: 'GET', url: url.href, headers: { Authorization: `Bearer ${this.key}`, Accept: 'application/json' } }));
      if (!Array.isArray(json.data) || typeof json.has_more !== 'boolean') throw new Error('INVALID_PROVIDER_RESPONSE');
      const transactions = json.data.map(row => normalizeStripe(row, this.environment, account));
      yield { transactions, checkpoint: end.toISOString() };
      if (!json.has_more) return;
      const last = json.data.at(-1);
      if (!last || typeof last !== 'object' || typeof last.id !== 'string' || seenPages.has(last.id)) throw new Error('PROVIDER_PAGINATION_LOOP');
      after = last.id; seenPages.add(last.id);
    }
    throw new Error('PROVIDER_PAGINATION_LIMIT');
  }
  async testConnection(): Promise<void> { const iterator = this.pages(new Date(Date.now() - 86400000), new Date()); await iterator.next(); }
}

export function normalizeStripe(value: unknown, environment: Environment, account: string): CanonicalTransaction {
  const row = asObject(value);
  if (typeof row.id !== 'string' || !/^[A-Za-z0-9_]{1,128}$/.test(row.id) || typeof row.type !== 'string') throw new Error('INVALID_PROVIDER_RESPONSE');
  const amountMinor = safeInteger(row.amount), fee = safeInteger(row.fee), netMinor = safeInteger(row.net);
  if (fee < 0 || amountMinor - fee !== netMinor) throw new Error('INVALID_PROVIDER_AMOUNT');
  const currency = currencyCode(row.currency), occurredAt = new Date(safeInteger(row.created) * 1000).toISOString();
  const type = row.type, category = typeof row.reporting_category === 'string' ? row.reporting_category : type;
  const labels = `${type} ${category}`;
  const classification: CanonicalTransaction['classification'] = type === 'payout' || type.startsWith('payout_') ? 'payout' : labels.includes('refund') || type === 'payment_reversal' ? 'refund' : labels.includes('dispute') ? 'dispute' : labels.includes('fee') ? 'fee' : ['charge', 'payment'].includes(type) ? 'payment' : 'other';
  return { provider: 'stripe', environment, account, reference: row.id, relatedReference: typeof row.source === 'string' ? row.source : undefined, occurredAt, currency, amountMinor, feeMinor: -fee, netMinor, classification, revenue: classification === 'payment' || classification === 'refund' || classification === 'dispute' };
}
