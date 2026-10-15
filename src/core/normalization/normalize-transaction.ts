import type { Transaction } from '../types.js';
import { transactionId } from '../ids.js';
import { sparkasseAmount, visaAmount, toMinor, toCents } from './amount.js';
import { normalizeDate, excelSerialToIsoDateTime } from './dates.js';
import { parseFxFromVisaDescription, computeOriginalAmount } from './fx.js';
import type { SparkasseRawRow } from '../ingestion/sparkasse.js';
import type { VisaRawRow } from '../ingestion/visa.js';
import type { PaypalRawRow } from '../ingestion/paypal.js';
import type { StripeRawRow } from '../ingestion/stripe.js';

export function normalizeSparkasse(row: SparkasseRawRow): Transaction {
  const amount = sparkasseAmount(row.eingehender_betrag, row.ausgehender_betrag);
  const postingAt = normalizeDate(row.buchungsdatum);

  return {
    transaction_id: transactionId('sparkasse', 'main', row.buchungsreferenz, postingAt, amount, 'EUR'),
    source_system: 'sparkasse',
    source_account_id: 'main',
    source_row_ref: row.buchungsreferenz,
    posting_at: postingAt,
    amount_minor: amount,
    currency_code: 'EUR',
    description_raw: [row.zahlungsreferenz, row.buchungs_details].filter(Boolean).map(s => String(s).trim()).filter(Boolean).join(' | ') || '',
    counterparty_name: row.partnername != null ? String(row.partnername) : undefined,
    counterparty_iban: row.partner_iban != null ? String(row.partner_iban) : undefined,
    booking_reference: row.buchungsreferenz,
    payment_reference: row.zahlungsreferenz != null ? String(row.zahlungsreferenz) : undefined,
    tags: [],
    meta: {
      row_index: row.row_index,
      file_match: row.file_match,
      legacy_type: row.type,
      legacy_source: row.source,
    },
  };
}

export function normalizeVisa(row: VisaRawRow): Transaction {
  const amount = visaAmount(row.eingehender_betrag, row.ausgehender_betrag);
  const postingAt = normalizeDate(row.buchungsdatum);

  // Parse FX info from description
  const fxInfo = parseFxFromVisaDescription(row.buchungs_details);
  if (fxInfo && amount !== 0) {
    // Compute original USD amount: the Visa column sometimes has the USD amount directly
    // Otherwise compute from EUR amount and rate
    fxInfo.original_amount_minor = computeOriginalAmount(Math.abs(amount), fxInfo);
    if (amount < 0) fxInfo.original_amount_minor = -fxInfo.original_amount_minor;
  }

  return {
    transaction_id: transactionId('visa', 'business_gold', row.buchungsreferenz, postingAt, amount, 'EUR'),
    source_system: 'visa',
    source_account_id: 'business_gold',
    source_row_ref: row.buchungsreferenz,
    posting_at: postingAt,
    amount_minor: amount,
    currency_code: 'EUR',
    description_raw: String(row.buchungs_details ?? ''),
    fx: fxInfo ?? undefined,
    tags: fxInfo ? ['fx'] : [],
    meta: {
      row_index: row.row_index,
      file_match: row.file_match,
      legacy_type: row.type,
      legacy_source: row.source,
    },
  };
}

export function normalizePaypal(row: PaypalRawRow): Transaction {
  const postingAt = normalizeDate(row.datum);
  const amount = toMinor(row.brutto);

  return {
    transaction_id: transactionId('paypal', 'main', row.transaktionscode, postingAt, amount, 'EUR'),
    source_system: 'paypal',
    source_account_id: 'main',
    source_row_ref: row.transaktionscode,
    posting_at: postingAt,
    amount_minor: amount,
    currency_code: 'EUR',
    description_raw: `${String(row.typ ?? '')} - ${String(row.name ?? 'N/A')}`,
    counterparty_name: row.name != null ? String(row.name) : undefined,
    tags: [],
    meta: {
      row_index: row.row_index,
      typ: row.typ,
      rechnungsnummer: row.rechnungsnummer,
      file_match: row.file_match,
      legacy_type: row.type,
      legacy_source: row.source,
    },
  };
}

export function normalizeStripe(row: StripeRawRow): Transaction {
  const postingAt = typeof row.created_utc === 'number'
    ? excelSerialToIsoDateTime(row.created_utc)
    : normalizeDate(row.created_utc);
  const amount = toMinor(row.amount);

  return {
    transaction_id: transactionId('stripe', 'main', row.id, postingAt, amount, 'EUR'),
    source_system: 'stripe',
    source_account_id: 'main',
    source_row_ref: row.id,
    posting_at: postingAt,
    amount_minor: amount,
    currency_code: row.currency === 'EUR' ? 'EUR' : row.currency,
    description_raw: `${row.type} ${row.source ?? ''} ${row.order_id ?? ''}`.trim(),
    tags: [row.type],
    meta: {
      row_index: row.row_index,
      stripe_type: row.type,
      stripe_source: row.source,
      order_id: row.order_id,
      fee: row.fee,
      fee_minor: toMinor(row.fee),
      file_match: row.file_match,
      legacy_type2: row.type2,
      legacy_source2: row.source2,
    },
  };
}
