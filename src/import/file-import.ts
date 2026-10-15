import { createHash } from 'node:crypto';
import { getDb } from '../storage/db.js';
import type { Transaction } from '../core/types.js';
import { parseStatement, StatementError, type StatementOptions } from './statement-parser.js';

export type FileSourceType = 'sparkasse' | 'visa';
export interface FileImportResult {
  source: FileSourceType;
  filename: string;
  fetched: number;
  imported: number;
  skipped: number;
  transactions: Array<{
    id: string; transaction_id: string; date: string; description: string;
    counterparty: string; amount_minor: number; currency: string; is_new: boolean;
  }>;
}
interface ExistingRow {
  transaction_id: string; source_system: string; source_account_id: string; source_row_ref: string;
  posting_at: string; amount_minor: number; currency_code: string; description_raw: string;
  counterparty_name: string | null; counterparty_iban: string | null; meta: string;
}
const sourceKey = (account: string, reference: string) => JSON.stringify([account, reference]);
function fingerprint(row: ExistingRow): string {
  return createHash('sha256').update(JSON.stringify([
    row.source_system, row.source_account_id, row.posting_at.slice(0, 10), row.amount_minor,
    row.currency_code, row.description_raw, row.counterparty_name ?? '', row.counterparty_iban ?? '',
  ])).digest('hex');
}

/** Validate the entire statement before acquiring or mutating its isolated database. */
export function importFile(filePath: string, source: FileSourceType, filename: string, options: StatementOptions = {}): FileImportResult {
  return storeStatementTransactions(parseStatement(filePath, source, options), source, filename);
}

/** Call within a surrounding database transaction when another store must be coordinated. */
export function storeStatementTransactions(normalized: Transaction[], source: FileSourceType, filename: string): FileImportResult {
  const db = getDb();
  const insert = db.prepare(`INSERT INTO transactions (
    transaction_id, source_system, source_account_id, source_row_ref, posting_at, value_at,
    amount_minor, currency_code, description_raw, counterparty_name, counterparty_iban,
    booking_reference, payment_reference, tags, meta,
    fx_original_amount_minor, fx_original_currency_code, fx_rate, fx_rate_source, fx_fee_minor
  ) VALUES (
    @transaction_id, @source_system, @source_account_id, @source_row_ref, @posting_at, @value_at,
    @amount_minor, @currency_code, @description_raw, @counterparty_name, @counterparty_iban,
    @booking_reference, @payment_reference, @tags, @meta,
    @fx_original_amount_minor, @fx_original_currency_code, @fx_rate, @fx_rate_source, @fx_fee_minor
  )`);
  const disposition = db.prepare("INSERT OR IGNORE INTO transaction_dispositions (transaction_id, disposition, set_by) VALUES (?, 'open', 'system')");
  return db.transaction(() => {
    const existing = db.prepare(`SELECT transaction_id, source_system, source_account_id, source_row_ref,
      posting_at, amount_minor, currency_code, description_raw, counterparty_name, counterparty_iban, meta
      FROM transactions WHERE source_system = ?`).all(source) as ExistingRow[];
    const identities = new Map<string, ExistingRow>();
    const knownFingerprints = new Map<string, Set<string>>();
    for (const row of existing) {
      const key = sourceKey(row.source_account_id, row.source_row_ref);
      if (identities.has(key)) throw new StatementError('EXISTING_IDENTITY_CONFLICT', 'Existing duplicate source identities require reconciliation before import');
      identities.set(key, row);
      const value = fingerprint(row);
      const statements = knownFingerprints.get(value) ?? new Set<string>();
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(row.meta || '{}'); } catch { throw new StatementError('INVALID_STORED_METADATA', 'Stored transaction metadata is invalid'); }
      statements.add(typeof meta.statement_sha256 === 'string' ? meta.statement_sha256 : 'legacy');
      knownFingerprints.set(value, statements);
    }
    const result: FileImportResult = { source, filename, fetched: normalized.length, imported: 0, skipped: 0, transactions: [] };
    for (const transaction of normalized) {
      if (transaction.source_system !== source || !Number.isSafeInteger(transaction.amount_minor)) throw new StatementError('INVALID_TRANSACTION', 'Invalid normalized statement transaction');
      const key = sourceKey(transaction.source_account_id, transaction.source_row_ref);
      const previous = identities.get(key);
      const incomingFingerprint = String(transaction.meta.statement_fingerprint);
      const output = {
        id: transaction.source_row_ref, transaction_id: previous?.transaction_id ?? transaction.transaction_id,
        date: transaction.posting_at.slice(0, 10), description: transaction.description_raw,
        counterparty: transaction.counterparty_name ?? '', amount_minor: transaction.amount_minor,
        currency: transaction.currency_code, is_new: false,
      };
      if (previous) {
        if (fingerprint(previous) !== incomingFingerprint) throw new StatementError('SOURCE_IDENTITY_CONFLICT', 'An existing source reference has conflicting financial content');
        result.skipped++; result.transactions.push(output); continue;
      }
      const known = knownFingerprints.get(incomingFingerprint);
      if (transaction.meta.source_reference_present === false && known && [...known].some(value => value !== transaction.meta.statement_sha256)) {
        throw new StatementError('AMBIGUOUS_STATEMENT_OVERLAP', 'A reference-less row overlaps a different statement; explicit reconciliation is required');
      }
      insert.run({
        ...transaction, value_at: transaction.value_at ?? null,
        counterparty_name: transaction.counterparty_name ?? null, counterparty_iban: transaction.counterparty_iban ?? null,
        booking_reference: transaction.booking_reference ?? null, payment_reference: transaction.payment_reference ?? null,
        tags: JSON.stringify(transaction.tags), meta: JSON.stringify(transaction.meta),
        fx_original_amount_minor: transaction.fx?.original_amount_minor ?? null,
        fx_original_currency_code: transaction.fx?.original_currency_code ?? null,
        fx_rate: transaction.fx?.rate ?? null, fx_rate_source: transaction.fx?.rate_source ?? null, fx_fee_minor: transaction.fx?.fx_fee_minor ?? null,
      });
      disposition.run(transaction.transaction_id);
      const saved: ExistingRow = { ...transaction, counterparty_name: transaction.counterparty_name ?? null, counterparty_iban: transaction.counterparty_iban ?? null, meta: JSON.stringify(transaction.meta) };
      identities.set(key, saved);
      const statements = knownFingerprints.get(incomingFingerprint) ?? new Set<string>();
      statements.add(String(transaction.meta.statement_sha256)); knownFingerprints.set(incomingFingerprint, statements);
      result.imported++; output.is_new = true; result.transactions.push(output);
    }
    return result;
  })();
}
