import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLegacy, legacySourceFingerprint, stageLegacyConversion } from '../src/community/persistence/legacy.js';

let base: string, close: (() => void) | undefined;
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
async function fixture() {
  base = mkdtempSync(join(tmpdir(), 'community-legacy-convert-'));
  const active = join(base, 'active'), legacy = join(base, 'legacy');
  mkdirSync(active); mkdirSync(join(legacy, 'data'), { recursive: true }); mkdirSync(join(legacy, 'Belege'));
  process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root'; process.env.MATCHING_RUNTIME_ROOT = active;
  vi.resetModules();
  const store = await import('../src/storage/db.js'); close = store.closeDb; store.getDb();
  mkdirSync(join(active, 'state'));
  writeFileSync(join(active, 'state', 'state.json'), JSON.stringify({ schema_version: 1, format: 'matching-community-state-v1', run_id: 'ACTIVE', transactions: {}, documents: {}, match_groups: {}, exclusion_rules: [], audit_events: [], matched_transaction_ids: [], matched_document_ids: [], excluded_transaction_ids: [] }));
  const receipt = Buffer.from('SYNTHETIC V2 RECEIPT'); writeFileSync(join(legacy, 'Belege', 'receipt.txt'), receipt);
  const state = { run_id: 'LEGACY-SYNTHETIC', transactions: { 'TX-OLD': { transaction_id: 'TX-OLD', source_system: 'sparkasse', source_account_id: 'OLD-A', source_row_ref: 'SOURCE-1', posting_at: '2024-01-02', amount_minor: -2999, currency_code: 'EUR', description_raw: 'Synthetic refund expense', tags: [], meta: { credential: 'DROP-ME' } } }, documents: { 'DOC-OLD': { document_id: 'DOC-OLD', source_system: 'upload', source_document_ref: 'SOURCE-DOC-1', captured_at: '2024-01-02', document_date: '2024-01-02', total_amount_minor: 2999, currency_code: 'EUR', filename: 'receipt.txt', file_hash: sha(receipt), meta: {} } }, match_groups: { 'MATCH-OLD': { match_group_id: 'MATCH-OLD', status: 'accepted', created_at: '2024-01-02', created_by: 'legacy-owner', rule_id: 'MANUAL', transaction_ids: ['TX-OLD'], document_ids: ['DOC-OLD'], amount_total_minor: -2999, currency_code: 'EUR', reason_codes: [] } }, exclusion_rules: [], audit_events: [{ audit_id: 'AUD-OLD', timestamp: '2024-01-02', actor_type: 'user', actor_id: 'legacy-owner', action: 'MATCH_ACCEPTED', entity_type: 'match', entity_id: 'MATCH-OLD' }], matched_transaction_ids: ['TX-OLD'], matched_document_ids: ['DOC-OLD'], excluded_transaction_ids: [] };
  writeFileSync(join(legacy, 'data', 'state.json'), JSON.stringify(state));
  const db = new Database(join(legacy, 'data', 'matching.db'));
  db.exec(`CREATE TABLE transactions (transaction_id TEXT PRIMARY KEY, source_system TEXT, source_account_id TEXT, source_row_ref TEXT, posting_at TEXT, amount_minor INTEGER, currency_code TEXT, description_raw TEXT);
    CREATE TABLE documents (document_id TEXT PRIMARY KEY, source_system TEXT, source_document_ref TEXT, captured_at TEXT, document_date TEXT, total_amount_minor INTEGER, currency_code TEXT, filename TEXT, file_hash TEXT);
    CREATE TABLE match_groups (match_group_id TEXT PRIMARY KEY, status TEXT, created_at TEXT, created_by TEXT, rule_id TEXT, amount_total_minor INTEGER, currency_code TEXT);
    CREATE TABLE match_group_transactions (match_group_id TEXT, transaction_id TEXT);
    CREATE TABLE match_group_documents (match_group_id TEXT, document_id TEXT);
    CREATE TABLE audit_events (audit_id TEXT PRIMARY KEY, timestamp TEXT, actor_type TEXT, actor_id TEXT, action TEXT, entity_type TEXT, entity_id TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  db.prepare('INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?)').run('TX-OLD','sparkasse','OLD-A','SOURCE-1','2024-01-02',-2999,'EUR','Synthetic refund expense');
  db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?)').run('DOC-OLD','upload','SOURCE-DOC-1','2024-01-02','2024-01-02',2999,'EUR','receipt.txt',sha(receipt));
  db.prepare('INSERT INTO match_groups VALUES (?,?,?,?,?,?,?)').run('MATCH-OLD','accepted','2024-01-02','legacy-owner','MANUAL',-2999,'EUR');
  db.prepare('INSERT INTO match_group_transactions VALUES (?,?)').run('MATCH-OLD','TX-OLD'); db.prepare('INSERT INTO match_group_documents VALUES (?,?)').run('MATCH-OLD','DOC-OLD');
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)').run('AUD-OLD','2024-01-02','user','legacy-owner','MATCH_ACCEPTED','match','MATCH-OLD');
  db.prepare('INSERT INTO settings VALUES (?,?)').run('theme','dark'); db.close();
  return { active, legacy, stateHash: sha(readFileSync(join(legacy, 'data', 'state.json'))), dbHash: sha(readFileSync(join(legacy, 'data', 'matching.db'))) };
}
afterEach(() => { close?.(); close = undefined; if (base) rmSync(base, { recursive: true, force: true }); delete process.env.MATCHING_RUNTIME_MODE; delete process.env.MATCHING_RUNTIME_ROOT; vi.resetModules(); });
describe('synthetic V2 to Community conversion', () => {
  it('preserves IDs, accepted links, audit, totals, source bytes and attachment hash', async () => {
    const f = await fixture();
    const preview = await inspectLegacy(f.legacy);
    expect(preview.fingerprint).toBe(legacySourceFingerprint(f.legacy));
    const staged = await stageLegacyConversion(f.active, f.legacy, preview.fingerprint, async run => run());
    expect(staged.manifest.financial.counts).toEqual({ transactions: 1, documents: 1, match_groups: 1, audit_events: 1 });
    expect(staged.manifest.financial.totals_minor_by_currency).toEqual({ EUR: -2999 });
    expect(staged.manifest.financial.match_statuses).toEqual({ accepted: 1 });
    expect(staged.mapping.mapped.match_group_documents).toBe(1);
    expect(sha(readFileSync(join(f.legacy, 'data', 'state.json')))).toBe(f.stateHash);
    expect(sha(readFileSync(join(f.legacy, 'data', 'matching.db')))).toBe(f.dbHash);
  });
  it('invalidates dry run when source bytes change', async () => {
    const f = await fixture(); const preview = await inspectLegacy(f.legacy);
    writeFileSync(join(f.legacy, 'Belege', 'receipt.txt'), 'CHANGED SYNTHETIC');
    await expect(stageLegacyConversion(f.active, f.legacy, preview.fingerprint, async run => run())).rejects.toThrow(/stale/);
  });
});
