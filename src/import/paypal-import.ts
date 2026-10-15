/**
 * PayPal import service: fetches from PayPal API and upserts into SQLite.
 * Same pattern as stripe-import.ts, including monthly fee summaries.
 */

import { getDb } from '../storage/db.js';
import {
  getPayPalAccessToken,
  fetchPayPalTransactions,
  normalizePayPalTransaction,
} from './paypal-api.js';
import { documentId } from '../core/ids.js';
import type { Transaction } from '../core/types.js';

export interface PayPalImportResult {
  fetched: number;
  imported: number;
  skipped: number;
  date_range: { start: string; end: string };
  transactions: Array<{
    id: string;
    type: string;
    amount_minor: number;
    currency: string;
    date: string;
    description: string;
    counterparty: string;
    fee_minor: number;
    is_new: boolean;
  }>;
  fee_summaries: Array<{
    month: string;
    total_fee_minor: number;
    txn_count: number;
    is_new: boolean;
  }>;
}

export async function importPayPalTransactions(
  clientId: string,
  clientSecret: string,
  startDate: string,
  endDate: string,
  sandbox: boolean = false,
): Promise<PayPalImportResult> {
  // 1. Get access token
  const accessToken = await getPayPalAccessToken(clientId, clientSecret, sandbox);

  // 2. Fetch transactions
  const details = await fetchPayPalTransactions(accessToken, startDate, endDate, sandbox);

  // 3. Normalize
  const rawNormalized: Transaction[] = details
    .filter(d => d.transaction_info.transaction_status === 'S') // only successful
    .map(normalizePayPalTransaction);

  // 3b. Merge FX (foreign currency) transaction triplets into single rows
  const normalized = mergeFxTransactions(rawNormalized);

  // 4. Upsert into SQLite
  const db = getDb();
  let imported = 0;
  let skipped = 0;

  const checkStmt = db.prepare('SELECT 1 FROM transactions WHERE transaction_id = ?');
  const checkRefStmt = db.prepare(`SELECT 1 FROM transactions WHERE source_system = 'paypal' AND source_row_ref = ?`);
  const checkDupStmt = db.prepare(`
    SELECT 1 FROM transactions
    WHERE source_system = ? AND amount_minor = ? AND description_raw = ?
      AND abs(julianday(posting_at) - julianday(?)) <= 3
    LIMIT 1
  `);
  const insertTxn = db.prepare(`
    INSERT INTO transactions (
      transaction_id, source_system, source_account_id, source_row_ref,
      posting_at, value_at, amount_minor, currency_code,
      description_raw, counterparty_name, counterparty_iban,
      booking_reference, payment_reference, tags, meta,
      fx_original_amount_minor, fx_original_currency_code, fx_rate, fx_rate_source, fx_fee_minor
    ) VALUES (
      @transaction_id, @source_system, @source_account_id, @source_row_ref,
      @posting_at, @value_at, @amount_minor, @currency_code,
      @description_raw, @counterparty_name, @counterparty_iban,
      @booking_reference, @payment_reference, @tags, @meta,
      @fx_original_amount_minor, @fx_original_currency_code, @fx_rate, @fx_rate_source, @fx_fee_minor
    )
  `);
  const insertDisp = db.prepare(`
    INSERT OR IGNORE INTO transaction_dispositions (transaction_id, disposition, set_by)
    VALUES (?, 'open', 'system')
  `);

  const resultTxns: PayPalImportResult['transactions'] = [];

  const run = db.transaction(() => {
    for (const t of normalized) {
      const exists = checkStmt.get(t.transaction_id);
      const txnResult = {
        id: t.source_row_ref,
        type: (t.meta.paypal_type as string) ?? t.tags[0] ?? '',
        amount_minor: t.amount_minor,
        currency: t.currency_code,
        date: t.posting_at.slice(0, 10),
        description: t.description_raw,
        counterparty: t.counterparty_name ?? '',
        fee_minor: (t.meta.fee_minor as number) ?? 0,
        is_new: false,
      };

      if (exists) {
        skipped++;
        resultTxns.push(txnResult);
        continue;
      }

      // Deduplicate by PayPal transaction reference (unique per transaction)
      if (t.source_row_ref && checkRefStmt.get(t.source_row_ref)) {
        skipped++;
        resultTxns.push(txnResult);
        continue;
      }

      insertTxn.run({
        transaction_id: t.transaction_id,
        source_system: t.source_system,
        source_account_id: t.source_account_id,
        source_row_ref: t.source_row_ref,
        posting_at: t.posting_at,
        value_at: t.value_at ?? null,
        amount_minor: t.amount_minor,
        currency_code: t.currency_code,
        description_raw: t.description_raw,
        counterparty_name: t.counterparty_name ?? null,
        counterparty_iban: t.counterparty_iban ?? null,
        booking_reference: t.booking_reference ?? null,
        payment_reference: t.payment_reference ?? null,
        tags: JSON.stringify(t.tags),
        meta: JSON.stringify(t.meta),
        fx_original_amount_minor: t.fx?.original_amount_minor ?? null,
        fx_original_currency_code: t.fx?.original_currency_code ?? null,
        fx_rate: t.fx?.rate ?? null,
        fx_rate_source: t.fx?.rate_source ?? null,
        fx_fee_minor: t.fx?.fx_fee_minor ?? null,
      });

      insertDisp.run(t.transaction_id);
      imported++;

      txnResult.is_new = true;
      resultTxns.push(txnResult);
    }
  });

  run();

  // 5. Generate monthly fee summary documents
  const feeSummaries = generateMonthlyFeeSummaries(normalized);

  return {
    fetched: details.length,
    imported,
    skipped,
    date_range: { start: startDate, end: endDate },
    transactions: resultTxns,
    fee_summaries: feeSummaries,
  };
}

// --- Merge FX (foreign currency) transaction triplets ---
//
// PayPal creates 3 rows for a foreign-currency payment:
//   1. Payment (T00xx):        -$394.80 USD  → counterparty = actual recipient
//   2. Währungsankauf (T0200): +$394.80 USD  → counterparty = PayPal
//   3. Währungsverkauf (T0200): -€351.40 EUR → counterparty = PayPal
//
// We merge these into a single transaction:
//   amount_minor = EUR amount (actual debit), fx = original USD amount
//   counterparty/description from the payment row

function mergeFxTransactions(transactions: Transaction[]): Transaction[] {
  const consumed = new Set<string>();
  const merged: Transaction[] = [];

  // Group by posting_at (to the minute)
  const byTime = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const key = t.posting_at.slice(0, 16); // YYYY-MM-DDTHH:MM
    const group = byTime.get(key) || [];
    group.push(t);
    byTime.set(key, group);
  }

  for (const [, group] of byTime) {
    // Find T0200 currency conversion pairs
    const t0200s = group.filter(t => t.meta.paypal_event_code === 'T0200' && !consumed.has(t.transaction_id));

    for (const eurTxn of t0200s.filter(t => t.currency_code === 'EUR')) {
      if (consumed.has(eurTxn.transaction_id)) continue;

      const fxTxn = t0200s.find(t =>
        t.currency_code !== 'EUR' && !consumed.has(t.transaction_id)
      );
      if (!fxTxn) continue;

      // Find matching payment: same foreign currency, same absolute amount
      const payment = group.find(t =>
        !consumed.has(t.transaction_id) &&
        t.meta.paypal_event_code !== 'T0200' &&
        t.currency_code === fxTxn.currency_code &&
        Math.abs(t.amount_minor) === Math.abs(fxTxn.amount_minor)
      );
      if (!payment) continue;

      // Merge into single EUR transaction with FX info
      const rate = Math.abs(eurTxn.amount_minor) / Math.abs(fxTxn.amount_minor);
      merged.push({
        ...payment,
        amount_minor: eurTxn.amount_minor,
        currency_code: 'EUR',
        fx: {
          original_amount_minor: payment.amount_minor,
          original_currency_code: fxTxn.currency_code,
          rate,
          rate_source: 'paypal',
        },
      });

      consumed.add(eurTxn.transaction_id);
      consumed.add(fxTxn.transaction_id);
      consumed.add(payment.transaction_id);
    }
  }

  // Add all non-consumed transactions
  for (const t of transactions) {
    if (!consumed.has(t.transaction_id)) {
      merged.push(t);
    }
  }

  return merged;
}

// --- Monthly fee summary generation (same pattern as Stripe) ---

export function generateMonthlyFeeSummaries(
  transactions: Transaction[],
): PayPalImportResult['fee_summaries'] {
  const byMonth = new Map<string, {
    month: string;
    totalFee: number;
    entries: Array<{ txn_id: string; description: string; amount_minor: number; fee_minor: number; date: string }>;
  }>();

  for (const t of transactions) {
    const fee = Math.abs((t.meta.fee_minor as number) ?? 0);
    if (fee === 0) continue;

    const month = t.posting_at.slice(0, 7);
    let group = byMonth.get(month);
    if (!group) {
      group = { month, totalFee: 0, entries: [] };
      byMonth.set(month, group);
    }
    group.totalFee += fee;
    group.entries.push({
      txn_id: t.source_row_ref,
      description: t.description_raw,
      amount_minor: t.amount_minor,
      fee_minor: fee,
      date: t.posting_at.slice(0, 10),
    });
  }

  const db = getDb();
  const checkDoc = db.prepare('SELECT 1 FROM documents WHERE document_id = ?');
  const insertDoc = db.prepare(`
    INSERT INTO documents (
      document_id, source_system, source_document_ref, captured_at,
      document_date, total_amount_minor, currency_code,
      supplier_name, filename, meta
    ) VALUES (
      @document_id, @source_system, @source_document_ref, @captured_at,
      @document_date, @total_amount_minor, @currency_code,
      @supplier_name, @filename, @meta
    )
  `);
  const upsertDoc = db.prepare(`
    UPDATE documents SET
      total_amount_minor = @total_amount_minor,
      meta = @meta,
      captured_at = @captured_at
    WHERE document_id = @document_id
  `);
  const deleteLineItems = db.prepare('DELETE FROM line_items WHERE document_id = ?');
  const insertLineItem = db.prepare(`
    INSERT INTO line_items (document_id, description, amount_minor, quantity)
    VALUES (@document_id, @description, @amount_minor, @quantity)
  `);
  const insertDocDisp = db.prepare(`
    INSERT OR IGNORE INTO document_dispositions (document_id, disposition, set_by)
    VALUES (?, 'open', 'system')
  `);

  const results: PayPalImportResult['fee_summaries'] = [];

  const run = db.transaction(() => {
    for (const [month, group] of byMonth) {
      const docId = documentId('paypal_fee', `paypal-fees-${month}`);
      const [year, mon] = month.split('-');
      const lastDay = new Date(Number(year), Number(mon), 0).getDate();
      const docDate = `${month}-${String(lastDay).padStart(2, '0')}`;

      const exists = checkDoc.get(docId);
      const docData = {
        document_id: docId,
        source_system: 'bank_fee',
        source_document_ref: `paypal-fees-${month}`,
        captured_at: new Date().toISOString().slice(0, 10) + 'T00:00:00+01:00',
        document_date: docDate + 'T00:00:00+01:00',
        total_amount_minor: -group.totalFee, // negative = expense
        currency_code: 'EUR',
        supplier_name: 'PayPal',
        filename: `PayPal Gebühren ${mon}/${year}`,
        meta: JSON.stringify({
          type: 'monthly_fee_summary',
          provider: 'paypal',
          month,
          txn_count: group.entries.length,
          invoice_country: 'LU',
        }),
      };

      if (exists) {
        upsertDoc.run(docData);
      } else {
        insertDoc.run(docData);
        insertDocDisp.run(docId);
      }

      deleteLineItems.run(docId);
      for (const e of group.entries) {
        insertLineItem.run({
          document_id: docId,
          description: `${e.date} | ${e.txn_id} | ${e.description}`,
          amount_minor: -e.fee_minor,
          quantity: 1,
        });
      }

      results.push({
        month,
        total_fee_minor: group.totalFee,
        txn_count: group.entries.length,
        is_new: !exists,
      });
    }
  });

  run();

  return results.sort((a, b) => a.month.localeCompare(b.month));
}
