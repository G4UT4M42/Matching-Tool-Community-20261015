/**
 * PayPal API client — fetches transactions via Transaction Search API.
 * Uses PayPal REST API directly (no SDK dependency).
 *
 * Auth: OAuth2 client_credentials → access_token
 * Endpoint: GET /v1/reporting/transactions
 */

import type { Transaction } from '../core/types.js';
import { transactionId } from '../core/ids.js';

const PAYPAL_SANDBOX = 'https://api-m.sandbox.paypal.com';
const PAYPAL_LIVE = 'https://api-m.paypal.com';

// --- PayPal API types ---

export interface PayPalTransactionInfo {
  transaction_id: string;
  transaction_event_code: string;   // T0006=payment, T1107=payout, T0400=refund, T1201=chargeback, etc.
  transaction_initiation_date: string; // ISO-8601
  transaction_updated_date: string;
  transaction_amount: { currency_code: string; value: string };
  fee_amount?: { currency_code: string; value: string };
  transaction_status: string;       // S=success, P=pending, V=reversed, D=denied
  transaction_subject?: string;
  transaction_note?: string;
  payer_name?: { given_name?: string; surname?: string; alternate_full_name?: string };
  payer_email?: string;
  invoice_id?: string;
}

export interface PayPalTransactionDetail {
  transaction_info: PayPalTransactionInfo;
  payer_info?: {
    account_id?: string;
    email_address?: string;
    payer_name?: { given_name?: string; surname?: string; alternate_full_name?: string };
  };
  cart_info?: {
    item_details?: Array<{
      item_name?: string;
      item_quantity?: string;
      item_unit_price?: { currency_code: string; value: string };
    }>;
  };
}

interface PayPalTransactionResponse {
  transaction_details: PayPalTransactionDetail[];
  total_items: number;
  total_pages: number;
  page: number;
  links: Array<{ href: string; rel: string }>;
}

// --- OAuth2 ---

export async function getPayPalAccessToken(
  clientId: string,
  clientSecret: string,
  sandbox: boolean = false,
): Promise<string> {
  const base = sandbox ? PAYPAL_SANDBOX : PAYPAL_LIVE;
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https://uri.paypal.com/services/reporting/search/read',
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error_description: res.statusText })) as any;
    throw new Error(`PayPal Auth ${res.status}: ${err.error_description ?? res.statusText}`);
  }

  const body = await res.json() as { access_token: string };
  return body.access_token;
}

// --- Fetch transactions (paginated) ---

export async function fetchPayPalTransactions(
  accessToken: string,
  startDate: string,
  endDate: string,
  sandbox: boolean = false,
): Promise<PayPalTransactionDetail[]> {
  const base = sandbox ? PAYPAL_SANDBOX : PAYPAL_LIVE;
  const all: PayPalTransactionDetail[] = [];

  // PayPal limits to 31-day windows — chunk if needed
  const chunks = chunkDateRange(startDate, endDate, 31);

  for (const [chunkStart, chunkEnd] of chunks) {
    let page = 1;
    const startDateTime = `${chunkStart}T00:00:00Z`;
    const endDateTime = `${chunkEnd}T23:59:59Z`;

    while (true) {
      const qs = new URLSearchParams({
        start_date: startDateTime,
        end_date: endDateTime,
        fields: 'transaction_info,payer_info,cart_info',
        page_size: '100',
        page: String(page),
      });

      const url = `${base}/v1/reporting/transactions?${qs}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        let msg = res.statusText;
        try {
          const err = JSON.parse(errText);
          msg = err.message ?? err.details?.[0]?.description ?? err.error_description ?? errText;
        } catch { msg = errText; }
        console.error(`PayPal API error: ${res.status} URL: ${url}`);
        console.error(`Response: ${errText}`);
        throw new Error(`PayPal API ${res.status}: ${msg}`);
      }

      const body = await res.json() as PayPalTransactionResponse;
      all.push(...body.transaction_details);

      if (page >= body.total_pages) break;
      page++;
    }
  }

  return all;
}

// --- Normalize to Transaction ---

export function normalizePayPalTransaction(detail: PayPalTransactionDetail): Transaction {
  const info = detail.transaction_info;
  const postingAt = new Date(info.transaction_initiation_date).toISOString().slice(0, 10) + 'T00:00:00+01:00';
  const currency = info.transaction_amount.currency_code;
  const amountMinor = Math.round(parseFloat(info.transaction_amount.value) * 100);

  const payerName = detail.payer_info?.payer_name?.alternate_full_name
    ?? (detail.payer_info?.payer_name
      ? `${detail.payer_info.payer_name.given_name ?? ''} ${detail.payer_info.payer_name.surname ?? ''}`.trim()
      : undefined)
    ?? info.payer_name?.alternate_full_name
    ?? (info.payer_name
      ? `${info.payer_name.given_name ?? ''} ${info.payer_name.surname ?? ''}`.trim()
      : undefined);

  const feeMinor = info.fee_amount
    ? Math.round(parseFloat(info.fee_amount.value) * 100)
    : 0;

  const eventCode = info.transaction_event_code;
  const typ = mapEventCodeToType(eventCode);

  const description = [
    typ,
    info.transaction_subject,
    info.transaction_note,
  ].filter(Boolean).join(' - ') || `${eventCode} ${payerName ?? ''}`.trim();

  return {
    transaction_id: transactionId('paypal', 'main', info.transaction_id, postingAt, amountMinor, currency),
    source_system: 'paypal',
    source_account_id: 'main',
    source_row_ref: info.transaction_id,
    posting_at: postingAt,
    amount_minor: amountMinor,
    currency_code: currency,
    description_raw: description,
    counterparty_name: payerName || undefined,
    tags: [typ],
    meta: {
      paypal_event_code: eventCode,
      paypal_type: typ,
      paypal_status: info.transaction_status,
      fee_minor: feeMinor,
      invoice_id: info.invoice_id,
      payer_email: detail.payer_info?.email_address ?? info.payer_email,
      cart_items: detail.cart_info?.item_details?.map(i => i.item_name).filter(Boolean),
    },
  };
}

/** Split a date range into chunks of maxDays (PayPal max 31 days per request) */
function chunkDateRange(start: string, end: string, maxDays: number): [string, string][] {
  const chunks: [string, string][] = [];
  let cur = new Date(start + 'T00:00:00Z');
  const endDate = new Date(end + 'T00:00:00Z');

  while (cur <= endDate) {
    const chunkEnd = new Date(cur);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());

    chunks.push([
      cur.toISOString().slice(0, 10),
      chunkEnd.toISOString().slice(0, 10),
    ]);

    cur = new Date(chunkEnd);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return chunks;
}

function mapEventCodeToType(code: string): string {
  // https://developer.paypal.com/docs/transaction-search/transaction-event-codes/
  if (code.startsWith('T00')) return 'payment';       // T0006, T0007, etc.
  if (code.startsWith('T03')) return 'payment';       // T0300=conversion
  if (code === 'T0400') return 'refund';
  if (code.startsWith('T04')) return 'refund';
  if (code.startsWith('T05')) return 'payout';        // T0500=withdrawal
  if (code.startsWith('T11')) return 'payout';        // T1107=payout
  if (code.startsWith('T12')) return 'chargeback';
  if (code.startsWith('T09')) return 'fee';           // T0900=fee
  if (code.startsWith('T22')) return 'currency_conversion';
  return code;
}
