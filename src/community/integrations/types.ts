export type Provider = 'paypal' | 'stripe';
export type Environment = 'sandbox' | 'test' | 'live';
export type Permission = 'integrations:read' | 'integrations:configure' | 'integrations:sync';
export interface Principal { subject: string }
export interface CanonicalTransaction {
  provider: Provider;
  environment: Environment;
  account: string;
  reference: string;
  sourceEventKey?: string;
  relatedReference?: string;
  occurredAt: string;
  currency: string;
  amountMinor: number;
  feeMinor: number;
  netMinor: number;
  classification: 'payment' | 'refund' | 'dispute' | 'fee' | 'payout' | 'transfer' | 'other';
  revenue: boolean;
  providerStatus?: 'S'|'V';
  providerEventCode?: string;
  providerUpdatedAt?: string;
}
export interface Checkpoint { cursor: string | null; seen: string[] }
export interface StripePayoutComponent {reference:string;providerType:string;reportingCategory:string;classification:CanonicalTransaction['classification'];sourceReference:string|null;occurredAt:string;amountMinor:number;feeMinor:number;netMinor:number}
export interface StripePayoutEvidence {
  payoutId:string;account:string;environment:'test'|'live';status:'pending'|'reconciled'|'unsupported'|'unreconciled';
  reason?:'PAYOUT_MANUAL_UNSUPPORTED'|'PAYOUT_INSTANT_UNSUPPORTED'|'PAYOUT_MEMBERSHIP_UNAVAILABLE'|'PAYOUT_NOT_PAID'|'PAYOUT_RECONCILIATION_PENDING'|'PAYOUT_TOTAL_MISMATCH';
  currency:string;amountMinor:number;automatic:boolean;method:'standard'|'instant';providerStatus:'paid'|'pending'|'in_transit'|'canceled'|'failed';reconciliationStatus:'completed'|'in_progress'|'not_applicable';
  payoutBalanceTransaction:string|null;componentCount:number;totals:{grossMinor:number;feeMinor:number;netMinor:number};components:StripePayoutComponent[];
  requiredFundingMinor:number|null;settlementFeeMinor:number|null;residualMinor:number|null;
  payoutLeg:(StripePayoutComponent&{includedInListing:boolean})|null;
}
export interface StripePayoutReport extends StripePayoutEvidence {observationId:string;observedAt:string}
export interface CommitBatch {
  (input: {principal: Principal; provider: Provider; environment: Environment; transactions: CanonicalTransaction[]; checkpoint: Checkpoint}): Promise<void | number>
}
export interface HttpRequest { method: 'GET' | 'POST'; url: string; headers: Record<string,string>; body?: string }
export interface HttpResponse { status: number; json: unknown }
export interface Transport { (request: HttpRequest): Promise<HttpResponse> }
export function assertPrincipal(value: unknown): Principal {
  if (!value || typeof value !== 'object' || typeof (value as Principal).subject !== 'string' || !/^[^\x00-\x1F\x7F]{1,256}$/u.test((value as Principal).subject)) throw new Error('UNAUTHENTICATED');
  return { subject: (value as Principal).subject };
}
export function assertProvider(value: unknown): Provider { if (value !== 'paypal' && value !== 'stripe') throw new Error('INVALID_PROVIDER'); return value; }
export function assertEnvironment(provider: Provider, value: unknown): Environment {
  if (provider === 'paypal' ? value !== 'sandbox' && value !== 'live' : value !== 'test' && value !== 'live') throw new Error('INVALID_ENVIRONMENT');
  return value as Environment;
}
export function asObject(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PROVIDER_RESPONSE'); return value as Record<string, unknown>; }
export function safeInteger(value: unknown): number { if (!Number.isSafeInteger(value)) throw new Error('INVALID_PROVIDER_AMOUNT'); return value as number; }
export function decimalMinor(value: unknown, currency: string): number {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,3})?$/.test(value)) throw new Error('INVALID_PROVIDER_AMOUNT');
  const digits = new Intl.NumberFormat('en', {style:'currency', currency}).resolvedOptions().maximumFractionDigits;
  if (digits === undefined || !Number.isInteger(digits) || digits < 0 || digits > 3) throw new Error('INVALID_CURRENCY');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  if (fraction.length > digits) throw new Error('INVALID_PROVIDER_AMOUNT');
  const minor = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0');
  const signed = value.startsWith('-') ? -minor : minor;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('INVALID_PROVIDER_AMOUNT');
  return Number(signed);
}
const knownCurrencies = new Set(Intl.supportedValuesOf('currency'));
export function currencyCode(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value) || !knownCurrencies.has(value.toUpperCase())) throw new Error('INVALID_CURRENCY'); return value.toUpperCase(); }
const publicErrors = new Set([
  'INVALID_PROVIDER', 'INVALID_ENVIRONMENT', 'INVALID_CREDENTIALS', 'INVALID_DATE_WINDOW', 'INVALID_PROVIDER_RESPONSE', 'INVALID_PROVIDER_AMOUNT', 'INVALID_CURRENCY',
  'NOT_CONFIGURED', 'INTEGRATION_BUSY', 'PROVIDER_UNAUTHORIZED', 'PROVIDER_PERMISSION_DENIED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE',
  'PROVIDER_PAGINATION_LOOP', 'PROVIDER_PAGINATION_LIMIT', 'CHECKPOINT_UNAVAILABLE', 'CHECKPOINT_CAPACITY', 'CREDENTIAL_UNAVAILABLE', 'PROTECTION_UNAVAILABLE',
  'PROVIDER_ACCOUNT_UNAVAILABLE', 'PROVIDER_ACCOUNT_CHANGED', 'PROVIDER_ACCOUNT_BINDING_REQUIRED',
  'CHECKPOINT_BACKFILL_REQUIRED', 'PROVIDER_TRANSACTION_PENDING', 'PROVIDER_TRANSACTION_INCOMPLETE', 'PROVIDER_SOURCE_CONFLICT', 'PROVIDER_SOURCE_COLLISION',
  'INVALID_PAYOUT_ID','PAYOUT_NOT_FOUND','PAYOUT_EVIDENCE_UNAVAILABLE','PAYOUT_SOURCE_CONFLICT','PAYOUT_CURRENCY_MISMATCH','PAYOUT_ACCOUNT_BINDING_REQUIRED',
]);
export function publicErrorCode(error: unknown): string { const message = error instanceof Error ? error.message : ''; return publicErrors.has(message) ? message : 'INTEGRATION_FAILED'; }
