/**
 * Stripe import service: fetches from Stripe API and upserts into SQLite.
 * After importing transactions, generates monthly fee summary documents.
 */

import { getDb } from '../storage/db.js';
import {
  fetchStripeCharges, fetchStripePayouts, fetchStripeRefunds, fetchStripeFees,
  normalizeStripeCharge, normalizeStripePayout, normalizeStripeRefund, normalizeStripeFee,
} from './stripe-api.js';
import { documentId } from '../core/ids.js';
import type { Transaction } from '../core/types.js';

export interface StripeImportResult {
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
    fee_minor: number | null;
    order_id: string | null;
    is_new: boolean;
  }>;
  fee_summaries: Array<{
    month: string;
    total_fee_minor: number;
    charge_count: number;
    is_new: boolean;
  }>;
}

export async function importStripeTransactions(
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<StripeImportResult> {
  // 1. Fetch all four types from Stripe API
  const [charges, payouts, refunds, standaloneFees] = await Promise.all([
    fetchStripeCharges(apiKey, startDate, endDate),
    fetchStripePayouts(apiKey, startDate, endDate),
    fetchStripeRefunds(apiKey, startDate, endDate),
    fetchStripeFees(apiKey, startDate, endDate),
  ]);

  // 2. Filter: only successful charges (skip failed/pending)
  const successfulCharges = charges.filter(ch => ch.status === 'succeeded' && ch.paid);

  // 3. Normalize all
  const normalized: Transaction[] = [
    ...successfulCharges.map(normalizeStripeCharge),
    ...payouts.map(normalizeStripePayout),
    ...refunds.map(normalizeStripeRefund),
    ...standaloneFees.map(normalizeStripeFee),
  ];

  // 4. Upsert transactions into SQLite
  const db = getDb();
  let imported = 0;
  let skipped = 0;

  const checkStmt = db.prepare('SELECT 1 FROM transactions WHERE transaction_id = ?');
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

  const resultTxns: StripeImportResult['transactions'] = [];

  const run = db.transaction(() => {
    for (const t of normalized) {
      const exists = checkStmt.get(t.transaction_id);
      const txnResult = {
        id: t.source_row_ref,
        type: (t.meta.stripe_type as string) ?? t.tags[0] ?? '',
        amount_minor: t.amount_minor,
        currency: t.currency_code,
        date: t.posting_at.slice(0, 10),
        description: t.description_raw,
        fee_minor: (t.meta.fee_minor as number) ?? null,
        order_id: (t.meta.order_id as string) ?? null,
        is_new: false,
      };

      if (exists) {
        skipped++;
        resultTxns.push(txnResult);
        continue;
      }

      const bizDup = checkDupStmt.get(t.source_system, t.amount_minor, t.description_raw, t.posting_at);
      if (bizDup) {
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
        fx_original_amount_minor: null,
        fx_original_currency_code: null,
        fx_rate: null,
        fx_rate_source: null,
        fx_fee_minor: null,
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

  const totalFetched = successfulCharges.length + payouts.length + refunds.length + standaloneFees.length;

  return {
    fetched: totalFetched,
    imported,
    skipped,
    date_range: { start: startDate, end: endDate },
    transactions: resultTxns,
    fee_summaries: feeSummaries,
  };
}

// --- Monthly fee summary generation ---

interface MonthlyFeeGroup {
  month: string;          // "2025-01"
  totalFee: number;       // sum of fees in minor units
  charges: Array<{
    charge_id: string;
    description: string;
    amount_minor: number;
    fee_minor: number;
    date: string;
  }>;
}

export function generateMonthlyFeeSummaries(
  transactions: Transaction[],
): StripeImportResult['fee_summaries'] {
  // Group charges by month
  const byMonth = new Map<string, MonthlyFeeGroup>();

  for (const t of transactions) {
    const stripeType = t.meta.stripe_type as string;

    if (stripeType === 'charge') {
      const fee = (t.meta.fee_minor as number) ?? 0;
      if (fee === 0) continue;

      const month = t.posting_at.slice(0, 7);
      let group = byMonth.get(month);
      if (!group) {
        group = { month, totalFee: 0, charges: [] };
        byMonth.set(month, group);
      }
      group.totalFee += fee;
      group.charges.push({
        charge_id: t.source_row_ref,
        description: t.description_raw,
        amount_minor: t.amount_minor,
        fee_minor: fee,
        date: t.posting_at.slice(0, 10),
      });
    } else if (stripeType === 'standalone_fee') {
      // Standalone fees (Radar, monthly Stripe fees, dispute fees, etc.)
      const fee = Math.abs(t.amount_minor);
      if (fee === 0) continue;

      const month = t.posting_at.slice(0, 7);
      let group = byMonth.get(month);
      if (!group) {
        group = { month, totalFee: 0, charges: [] };
        byMonth.set(month, group);
      }
      group.totalFee += fee;
      group.charges.push({
        charge_id: t.source_row_ref,
        description: `Stripe Fee: ${t.description_raw}`,
        amount_minor: t.amount_minor,
        fee_minor: fee,
        date: t.posting_at.slice(0, 10),
      });
    }
  }

  // Upsert fee summary documents into SQLite
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

  const results: StripeImportResult['fee_summaries'] = [];

  const run = db.transaction(() => {
    for (const [month, group] of byMonth) {
      const docId = documentId('stripe_fee', `stripe-fees-${month}`);
      const [year, mon] = month.split('-');
      // Last day of month as document date
      const lastDay = new Date(Number(year), Number(mon), 0).getDate();
      const docDate = `${month}-${String(lastDay).padStart(2, '0')}`;

      const exists = checkDoc.get(docId);
      const docData = {
        document_id: docId,
        source_system: 'stripe_fee',
        source_document_ref: `stripe-fees-${month}`,
        captured_at: new Date().toISOString().slice(0, 10) + 'T00:00:00+01:00',
        document_date: docDate + 'T00:00:00+01:00',
        total_amount_minor: -group.totalFee,  // negative = expense
        currency_code: 'EUR',
        supplier_name: 'Stripe',
        filename: `Stripe Gebühren ${mon}/${year}`,
        meta: JSON.stringify({
          type: 'monthly_fee_summary',
          month,
          charge_count: group.charges.length,
          invoice_country: 'IE',
          charges: group.charges.map(c => ({
            date: c.date,
            description: c.description?.slice(0, 60),
            amount: c.amount_minor,
            fee: c.fee_minor,
          })),
        }),
      };

      if (exists) {
        // Update existing summary (fees might have changed)
        upsertDoc.run(docData);
      } else {
        insertDoc.run(docData);
        insertDocDisp.run(docId);
      }

      // Recreate line items (individual fees per charge)
      deleteLineItems.run(docId);
      for (const ch of group.charges) {
        insertLineItem.run({
          document_id: docId,
          description: `${ch.date} | ${ch.charge_id} | ${ch.description}`,
          amount_minor: -ch.fee_minor,
          quantity: 1,
        });
      }

      results.push({
        month,
        total_fee_minor: group.totalFee,
        charge_count: group.charges.length,
        is_new: !exists,
      });
    }
  });

  run();

  return results.sort((a, b) => a.month.localeCompare(b.month));
}
