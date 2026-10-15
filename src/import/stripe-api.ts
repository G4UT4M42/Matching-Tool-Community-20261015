/**
 * Stripe API client — fetches charges, payouts, and refunds.
 * Uses the Stripe REST API directly (no SDK dependency).
 */

import type { Transaction } from '../core/types.js';
import { transactionId } from '../core/ids.js';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/** Convert any date to normalized CET date string YYYY-MM-DDT00:00:00+01:00 */
function toCetDate(d: Date): string {
  return d.toISOString().slice(0, 10) + 'T00:00:00+01:00';
}

// --- Stripe API types ---

export interface StripeBalanceTransaction {
  id: string;
  object: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  type: string;
  created: number;
  available_on: number;
  status: string;
}

export interface StripeCharge {
  id: string;
  object: 'charge';
  amount: number;          // gross amount in cents
  currency: string;
  created: number;         // unix timestamp
  description: string | null;  // e.g. "Community Demo Virtual Pinball - Order 17318"
  status: string;          // succeeded, pending, failed
  paid: boolean;
  refunded: boolean;
  amount_refunded: number;
  balance_transaction: StripeBalanceTransaction | string | null;
  metadata: Record<string, string>;
  receipt_email: string | null;
  customer: string | null;
  payment_intent: string | null;
}

export interface StripePayout {
  id: string;
  object: 'payout';
  amount: number;
  currency: string;
  created: number;
  arrival_date: number;
  description: string | null;
  status: string;
  type: string;            // bank_account, card
}

export interface StripeRefund {
  id: string;
  object: 'refund';
  amount: number;
  currency: string;
  created: number;
  charge: string;
  reason: string | null;
  status: string;
  balance_transaction: StripeBalanceTransaction | string | null;
}

interface StripeListResponse<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
}

// --- Generic paginated fetch ---

async function fetchAllPages<T>(
  apiKey: string,
  endpoint: string,
  params: Record<string, string>,
): Promise<T[]> {
  const all: T[] = [];
  let startingAfter: string | undefined;

  while (true) {
    const qs = new URLSearchParams(params);
    if (startingAfter) qs.set('starting_after', startingAfter);

    const url = `${STRIPE_API_BASE}${endpoint}?${qs}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: { message: res.statusText } })) as any;
      throw new Error(`Stripe API ${res.status}: ${errBody.error?.message ?? res.statusText}`);
    }

    const body = await res.json() as StripeListResponse<T>;
    all.push(...body.data);

    if (!body.has_more || body.data.length === 0) break;
    startingAfter = (body.data[body.data.length - 1] as any).id;
  }

  return all;
}

// --- Fetch functions ---

function dateRangeParams(startDate: string, endDate: string): Record<string, string> {
  return {
    'created[gte]': String(Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000)),
    'created[lte]': String(Math.floor(new Date(endDate + 'T23:59:59Z').getTime() / 1000)),
    'limit': '100',
  };
}

export async function fetchStripeCharges(
  apiKey: string, startDate: string, endDate: string,
): Promise<StripeCharge[]> {
  return fetchAllPages<StripeCharge>(apiKey, '/charges', {
    ...dateRangeParams(startDate, endDate),
    'expand[]': 'data.balance_transaction',
  });
}

export async function fetchStripePayouts(
  apiKey: string, startDate: string, endDate: string,
): Promise<StripePayout[]> {
  return fetchAllPages<StripePayout>(apiKey, '/payouts', dateRangeParams(startDate, endDate));
}

/** Fetch standalone fees (Radar, monthly fees, dispute fees, etc.) — not tied to charges */
export async function fetchStripeFees(
  apiKey: string, startDate: string, endDate: string,
): Promise<StripeBalanceTransaction[]> {
  return fetchAllPages<StripeBalanceTransaction>(apiKey, '/balance_transactions', {
    ...dateRangeParams(startDate, endDate),
    type: 'stripe_fee',
  });
}

export async function fetchStripeRefunds(
  apiKey: string, startDate: string, endDate: string,
): Promise<StripeRefund[]> {
  return fetchAllPages<StripeRefund>(apiKey, '/refunds', {
    ...dateRangeParams(startDate, endDate),
    'expand[]': 'data.balance_transaction',
  });
}

// --- Normalize to Transaction ---

export function normalizeStripeCharge(ch: StripeCharge): Transaction {
  const postingAt = toCetDate(new Date(ch.created * 1000));
  const currency = ch.currency.toUpperCase();
  const bt = typeof ch.balance_transaction === 'object' ? ch.balance_transaction : null;

  return {
    transaction_id: transactionId('stripe', 'main', ch.id, postingAt, ch.amount, currency),
    source_system: 'stripe',
    source_account_id: 'main',
    source_row_ref: ch.id,
    posting_at: postingAt,
    value_at: bt ? toCetDate(new Date(bt.available_on * 1000)) : undefined,
    amount_minor: ch.amount,
    currency_code: currency,
    description_raw: ch.description ?? '',
    tags: ['charge'],
    meta: {
      stripe_type: 'charge',
      stripe_source: ch.id,
      stripe_status: ch.status,
      description: ch.description,
      fee_minor: bt?.fee ?? 0,
      net_minor: bt?.net ?? ch.amount,
      order_id: ch.metadata?.order_id ?? extractOrderNumber(ch.description),
      receipt_email: ch.receipt_email,
      payment_intent: ch.payment_intent,
      refunded: ch.refunded,
      amount_refunded: ch.amount_refunded,
    },
  };
}

export function normalizeStripePayout(po: StripePayout): Transaction {
  const postingAt = toCetDate(new Date(po.created * 1000));
  const currency = po.currency.toUpperCase();

  return {
    transaction_id: transactionId('stripe', 'main', po.id, postingAt, -po.amount, currency),
    source_system: 'stripe',
    source_account_id: 'main',
    source_row_ref: po.id,
    posting_at: postingAt,
    value_at: toCetDate(new Date(po.arrival_date * 1000)),
    amount_minor: -po.amount,  // payout = money leaving Stripe → negative
    currency_code: currency,
    description_raw: po.description ?? 'payout',
    tags: ['payout'],
    meta: {
      stripe_type: 'payout',
      stripe_status: po.status,
      description: po.description,
      payout_type: po.type,
    },
  };
}

export function normalizeStripeRefund(rf: StripeRefund): Transaction {
  const postingAt = toCetDate(new Date(rf.created * 1000));
  const currency = rf.currency.toUpperCase();
  const bt = typeof rf.balance_transaction === 'object' ? rf.balance_transaction : null;

  return {
    transaction_id: transactionId('stripe', 'main', rf.id, postingAt, -rf.amount, currency),
    source_system: 'stripe',
    source_account_id: 'main',
    source_row_ref: rf.id,
    posting_at: postingAt,
    amount_minor: -rf.amount,  // refund = money back → negative
    currency_code: currency,
    description_raw: `refund ${rf.charge} ${rf.reason ?? ''}`.trim(),
    tags: ['refund'],
    meta: {
      stripe_type: 'refund',
      stripe_source: rf.charge,
      stripe_status: rf.status,
      reason: rf.reason,
      fee_minor: bt?.fee ?? 0,
    },
  };
}

export function normalizeStripeFee(bt: StripeBalanceTransaction): Transaction {
  const postingAt = toCetDate(new Date(bt.created * 1000));
  const currency = bt.currency.toUpperCase();

  return {
    transaction_id: transactionId('stripe', 'main', bt.id, postingAt, bt.amount, currency),
    source_system: 'stripe',
    source_account_id: 'main',
    source_row_ref: bt.id,
    posting_at: postingAt,
    value_at: toCetDate(new Date(bt.available_on * 1000)),
    amount_minor: bt.amount,  // already negative from Stripe
    currency_code: currency,
    description_raw: bt.type,
    tags: ['standalone_fee'],
    meta: {
      stripe_type: 'standalone_fee',
      stripe_status: bt.status,
      fee_minor: Math.abs(bt.amount),
    },
  };
}

/** Extract order number from description like "Community Demo Virtual Pinball - Order 17318" */
function extractOrderNumber(description: string | null): string | null {
  if (!description) return null;
  const match = description.match(/Order\s+(\d+)/i);
  return match ? match[1] : null;
}
