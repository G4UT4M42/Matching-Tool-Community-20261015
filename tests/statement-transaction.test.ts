import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { MatchingState } from '../src/core/types.js';

const originalRoot = process.env.MATCHING_RUNTIME_ROOT;
const originalMode = process.env.MATCHING_RUNTIME_MODE;
let runtime: string;
let dbModule: typeof import('../src/storage/db.js');
let store: typeof import('../src/storage/json-store.js');
let atomic: typeof import('../src/storage/statement-transaction.js');
let parser: typeof import('../src/import/statement-parser.js');
let state: MatchingState;
const bytes = Buffer.from('Buchungsdatum;Partnername;Betrag;Waehrung;Buchungsreferenz;Verwendungszweck\n13.01.2026;Fictional Supplier;-12,34;EUR;SYN-ATOMIC-001;Fictional purchase');
beforeEach(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'matching-atomic-statement-synthetic-'));
  process.env.MATCHING_RUNTIME_ROOT = runtime; process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root';
  vi.resetModules();
  dbModule = await import('../src/storage/db.js'); dbModule.getDb();
  store = await import('../src/storage/json-store.js');
  atomic = await import('../src/storage/statement-transaction.js');
  parser = await import('../src/import/statement-parser.js');
  state = store.createEmptyState('SYNTHETIC_ATOMIC_STATEMENT'); store.saveState(state);
});
afterEach(() => {
  dbModule?.closeDb();
  if (originalRoot === undefined) delete process.env.MATCHING_RUNTIME_ROOT; else process.env.MATCHING_RUNTIME_ROOT = originalRoot;
  if (originalMode === undefined) delete process.env.MATCHING_RUNTIME_MODE; else process.env.MATCHING_RUNTIME_MODE = originalMode;
  rmSync(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vi.resetModules();
});
const count = (table: 'transactions' | 'audit_events') => (dbModule.getDb().prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
const normalized = () => parser.parseStatementBuffer(bytes, '.csv', 'sparkasse', { accountId: 'SYNTHETIC_ATOMIC_ACCOUNT' });
const snapshot = () => readFileSync(join(runtime, 'state', 'state.json'), 'utf8');

describe('P06 coordinated SQLite and JSON import durability', () => {
  it('commits both stores, source identities and authenticated audit without mutating the input', () => {
    const committed = atomic.commitStatementImport(state, normalized(), 'sparkasse', 'fictional.csv', 'synthetic-user');
    expect(state.transactions.size).toBe(0);
    expect(committed.result.imported).toBe(1);
    expect(committed.state.transactions.size).toBe(1);
    expect(store.loadState()).toEqual(committed.state);
    expect(count('transactions')).toBe(1); expect(count('audit_events')).toBe(1);
    expect(committed.state.audit_events[0]).toMatchObject({ action: 'TRANSACTIONS_IMPORTED', actor_id: 'synthetic-user', after: { signed_totals_minor: { EUR: -1234 } } });
    expect(atomic.statementRecoveryPending()).toBe(false);
  });
  it('replays a statement without duplicating its economic event', () => {
    const first = atomic.commitStatementImport(state, normalized(), 'sparkasse', 'fictional.csv', 'synthetic-user');
    const second = atomic.commitStatementImport(first.state, normalized(), 'sparkasse', 'fictional.csv', 'synthetic-user');
    expect(second.result).toMatchObject({ imported: 0, skipped: 1 });
    expect(count('transactions')).toBe(1); expect(second.state.transactions.size).toBe(1);
    expect(count('audit_events')).toBe(2);
  });
  it.each(['before_journal', 'after_journal', 'after_json'] as const)('rolls back both stores after an injected exception at %s', phase => {
    const before = snapshot();
    expect(() => atomic.commitStatementImport(state, normalized(), 'sparkasse', 'fictional.csv', 'synthetic-user', {
      onPhase: current => { if (current === phase) throw new Error('SYNTHETIC_STORAGE_FAILURE'); },
    })).toThrow('SYNTHETIC_STORAGE_FAILURE');
    expect(snapshot()).toBe(before); expect(count('transactions')).toBe(0); expect(count('audit_events')).toBe(0);
    expect(state.transactions.size).toBe(0); expect(atomic.statementRecoveryPending()).toBe(false);
  });
  it('resolves a post-commit exception as the committed outcome, not a blind retry', () => {
    const completed = atomic.commitStatementImport(state, normalized(), 'sparkasse', 'fictional.csv', 'synthetic-user', {
      onPhase: phase => { if (phase === 'after_commit') throw new Error('SYNTHETIC_AFTER_COMMIT'); },
    });
    expect(completed.result.imported).toBe(1); expect(completed.state.transactions.size).toBe(1);
    expect(store.loadState()).toEqual(completed.state); expect(atomic.statementRecoveryPending()).toBe(false);
  });
  it('rejects a stale active state before financial writes', () => {
    const newer = structuredClone(state); newer.run_id = 'SYNTHETIC_NEWER_STATE'; store.saveState(newer);
    const before = snapshot();
    expect(() => atomic.commitStatementImport(state, normalized(), 'sparkasse', 'fictional.csv', 'synthetic-user')).toThrow(/changed/);
    expect(snapshot()).toBe(before); expect(count('transactions')).toBe(0); expect(atomic.statementRecoveryPending()).toBe(false);
  });
  it('keeps a corrupt recovery journal closed without overwriting either participant', () => {
    let validJournal = '';
    expect(() => atomic.commitStatementImport(state, normalized(), 'sparkasse', 'fictional.csv', 'synthetic-user', {
      onPhase: phase => {
        if (phase !== 'after_commit') return;
        const path = join(runtime, 'state', 'statement-journal-v1.json');
        validJournal = readFileSync(path, 'utf8');
        const damaged = JSON.parse(validJournal); damaged.after_sha256 = 'incorrect';
        writeFileSync(path, JSON.stringify(damaged)); throw new Error('SYNTHETIC_JOURNAL_DAMAGE');
      },
    })).toThrow(/checksum/);
    const committed = snapshot();
    expect(count('transactions')).toBe(1); expect(atomic.statementRecoveryPending()).toBe(true);
    expect(() => atomic.recoverStatementImport()).toThrow(/checksum/);
    expect(() => store.saveState(state)).toThrow(/recovery/);
    expect(snapshot()).toBe(committed);
    writeFileSync(join(runtime, 'state', 'statement-journal-v1.json'), validJournal);
    expect(atomic.recoverStatementImport()?.committed).toBe(true);
  });
  it.each(['after_journal', 'after_json', 'after_commit'] as const)('recovers after actual child-process termination at %s', phase => {
    dbModule.closeDb();
    const script = `
      const store = await import('./src/storage/json-store.ts');
      const db = await import('./src/storage/db.ts'); db.getDb();
      const atomic = await import('./src/storage/statement-transaction.ts');
      const parser = await import('./src/import/statement-parser.ts');
      const rows = parser.parseStatementBuffer(Buffer.from(${JSON.stringify(bytes.toString())}), '.csv', 'sparkasse', { accountId: 'SYNTHETIC_ATOMIC_ACCOUNT' });
      atomic.commitStatementImport(store.loadState(), rows, 'sparkasse', 'fictional.csv', 'synthetic-child', { onPhase(current) { if (current === ${JSON.stringify(phase)}) process.exit(86); } });
      process.exit(87);
    `;
    const execution = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...process.env }, encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    expect(execution.status, execution.stderr).toBe(86);
    expect(atomic.statementRecoveryPending()).toBe(true);
    const recovered = atomic.recoverStatementImport();
    const committed = phase === 'after_commit';
    expect(recovered?.committed).toBe(committed);
    expect(count('transactions')).toBe(committed ? 1 : 0);
    expect(count('audit_events')).toBe(committed ? 1 : 0);
    expect(store.loadState()?.transactions.size).toBe(committed ? 1 : 0);
    expect(atomic.statementRecoveryPending()).toBe(false);
    expect(atomic.recoverStatementImport()).toBeNull();
  }, 20000);
});
