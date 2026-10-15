import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { MatchingState, Transaction } from '../core/types.js';
import { recordAudit } from '../observability/audit.js';
import { storeStatementTransactions, type FileImportResult, type FileSourceType } from '../import/file-import.js';
import { StatementError } from '../import/statement-parser.js';
import { getDb } from './db.js';
import { commitCanonicalMutation, recoverCanonicalTransaction } from './canonical-transaction.js';
import { resolveAccountingPaths } from './paths.js';
import { deserializeCommunityState, serializeCommunityState, validateCommunityJsonState, writeStateFileAtomically } from './json-store.js';

const FORMAT = 'matching-community-statement-journal';
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 2 * MAX_SNAPSHOT_BYTES + 1024 * 1024;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
interface Journal {
  format: typeof FORMAT;
  version: 1;
  operation_id: string;
  audit_id: string;
  before: string;
  after: string;
  before_sha256: string;
  after_sha256: string;
}
export type StatementCommitPhase = 'before_journal' | 'after_journal' | 'after_json' | 'after_commit';
export interface StatementCommitHooks { onPhase?: (phase: StatementCommitPhase) => void }
function locations() {
  const paths = resolveAccountingPaths();
  if (paths.mode !== 'external-runtime-root') throw new Error('Statement persistence requires an isolated runtime');
  return { directory: paths.stateRoot, snapshot: join(paths.stateRoot, 'state.json'), journal: join(paths.stateRoot, 'statement-journal-v1.json') };
}
function readRegular(path: string, maximum: number): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('Invalid persisted statement recovery file');
  return readFileSync(path, 'utf8');
}
export function statementRecoveryPending(): boolean { return existsSync(locations().journal); }
function readJournal(path: string): Journal {
  const raw: unknown = JSON.parse(readRegular(path, MAX_JOURNAL_BYTES));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid statement recovery journal');
  const value = raw as Record<string, unknown>;
  const keys = ['format', 'version', 'operation_id', 'audit_id', 'before', 'after', 'before_sha256', 'after_sha256'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) || value.format !== FORMAT || value.version !== 1 ||
      typeof value.operation_id !== 'string' || !/^STATEMENT-[a-f0-9-]{36}$/.test(value.operation_id) ||
      typeof value.audit_id !== 'string' || !/^AUD-[a-f0-9]{16}$/.test(value.audit_id) ||
      typeof value.before !== 'string' || typeof value.after !== 'string' ||
      Buffer.byteLength(value.before) > MAX_SNAPSHOT_BYTES || Buffer.byteLength(value.after) > MAX_SNAPSHOT_BYTES ||
      digest(value.before) !== value.before_sha256 || digest(value.after) !== value.after_sha256) {
    throw new Error('Statement recovery journal version, structure or checksum is invalid');
  }
  const before = validateCommunityJsonState(JSON.parse(value.before));
  const after = validateCommunityJsonState(JSON.parse(value.after));
  if (before.run_id !== after.run_id || !after.audit_events.some(event => event.audit_id === value.audit_id && event.correlation_id === value.operation_id && event.action === 'TRANSACTIONS_IMPORTED')) {
    throw new Error('Statement recovery journal does not match its accounting dataset');
  }
  return value as unknown as Journal;
}

/** SQLite is the commit decision; the durable journal repairs the JSON participant. */
export function recoverStatementImport(): { committed: boolean; state: MatchingState } | null {
  const paths = locations();
  if (!existsSync(paths.journal)) return null;
  const envelope = JSON.parse(readRegular(paths.journal, MAX_JOURNAL_BYTES));
  if (envelope?.format === 'matching-community-financial-journal' && envelope.version === 2) return recoverCanonicalTransaction();
  const journal = readJournal(paths.journal);
  const current = readRegular(paths.snapshot, MAX_SNAPSHOT_BYTES);
  const currentHash = digest(current);
  if (currentHash !== journal.before_sha256 && currentHash !== journal.after_sha256) {
    throw new Error('Concurrent or corrupted accounting state prevents automatic statement recovery');
  }
  const marker = getDb().prepare('SELECT action, correlation_id, entity_id FROM audit_events WHERE audit_id = ?').get(journal.audit_id) as { action: string; correlation_id: string; entity_id: string } | undefined;
  if (marker && (marker.action !== 'TRANSACTIONS_IMPORTED' || marker.correlation_id !== journal.operation_id || marker.entity_id !== journal.operation_id)) throw new Error('Statement commit marker does not match its recovery journal');
  const committed = Boolean(marker);
  const restored = committed ? journal.after : journal.before;
  if (current !== restored) writeStateFileAtomically(paths.snapshot, restored);
  // Keep the journal until both participants agree. Failure leaves the API closed.
  unlinkSync(paths.journal);
  return { committed, state: deserializeCommunityState(JSON.parse(restored)) };
}

/** Statement import is one client of the shared canonical financial transaction. */
export function commitStatementImport(
  input: MatchingState,
  transactions: Transaction[],
  source: FileSourceType,
  filename: string,
  actor: string,
  hooks: StatementCommitHooks = {},
): { state: MatchingState; result: FileImportResult } {
  return commitCanonicalMutation(input, actor, () => {
    const result = storeStatementTransactions(transactions, source, filename);
    const candidate = structuredClone(input);
    const totals = new Map<string, bigint>();
    for (let index = 0; index < transactions.length; index++) {
      const transaction = transactions[index];
      const decision = result.transactions[index];
      const current = candidate.transactions.get(decision.transaction_id);
      if (current && (current.amount_minor !== transaction.amount_minor || current.currency_code !== transaction.currency_code || current.source_account_id !== transaction.source_account_id || current.source_row_ref !== transaction.source_row_ref)) {
        throw new StatementError('CROSS_STORE_CONFLICT', 'A stored transaction disagrees with its accounting snapshot');
      }
      if (!current) candidate.transactions.set(decision.transaction_id, { ...transaction, transaction_id: decision.transaction_id });
      if (decision.is_new) totals.set(transaction.currency_code, (totals.get(transaction.currency_code) ?? 0n) + BigInt(transaction.amount_minor));
    }
    const exactTotals: Record<string, number> = {};
    for (const [currency, total] of totals) {
      if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) throw new StatementError('IMPORT_TOTAL_OVERFLOW', 'The statement total exceeds the exact integer range');
      exactTotals[currency] = Number(total);
    }
    const operation = 'STATEMENT-' + randomUUID();
    recordAudit(candidate, 'TRANSACTIONS_IMPORTED', 'Run', operation, {
      actor_type: 'user', actor_id: actor, correlation_id: operation,
      reason: 'Explicit offline statement import',
      after: { source, fetched: result.fetched, imported: result.imported, skipped: result.skipped, signed_totals_minor: exactTotals, statement_sha256: transactions[0]?.meta.statement_sha256 },
    });
    return { state: candidate, result };
  }, hooks);
}
