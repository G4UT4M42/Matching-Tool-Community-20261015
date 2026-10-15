/**
 * Bank import service (Enable Banking): fetches transactions and upserts into SQLite.
 */

import { getDb } from '../storage/db.js';
import { fetchTransactions, normalizeEbTransaction } from './enablebanking-api.js';
import type { Transaction } from '../core/types.js';

export interface BankImportResult {
  fetched: number;
  imported: number;
  skipped: number;
  date_range: { start: string; end: string };
  transactions: Array<{
    id: string;
    date: string;
    description: string;
    counterparty: string;
    iban: string;
    amount_minor: number;
    currency: string;
    is_new: boolean;
  }>;
}

export async function importBankTransactions(
  accountUid: string,
  startDate: string,
  endDate: string,
): Promise<BankImportResult> {
  // 1. Fetch from Enable Banking
  const rawTransactions = await fetchTransactions(accountUid, startDate, endDate);

  // 2. Normalize
  const normalized: Transaction[] = rawTransactions.map(t => normalizeEbTransaction(t, accountUid));

  // 3. Upsert into SQLite
  const db = getDb();
  let imported = 0;
  let skipped = 0;

  const checkStmt = db.prepare('SELECT 1 FROM transactions WHERE transaction_id = ?');
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

  const resultTxns: BankImportResult['transactions'] = [];

  const run = db.transaction(() => {
    for (const t of normalized) {
      const exists = checkStmt.get(t.transaction_id);
      const txnResult = {
        id: t.source_row_ref,
        date: t.posting_at.slice(0, 10),
        description: t.description_raw,
        counterparty: t.counterparty_name ?? '',
        iban: t.counterparty_iban ?? '',
        amount_minor: t.amount_minor,
        currency: t.currency_code,
        is_new: false,
      };

      if (exists) {
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

  return {
    fetched: rawTransactions.length,
    imported,
    skipped,
    date_range: { start: startDate, end: endDate },
    transactions: resultTxns,
  };
}
