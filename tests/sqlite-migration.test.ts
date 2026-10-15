import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMUNITY_SQLITE_VERSION, communitySchemaDigest,
  initializeCommunitySqliteV1, verifyCommunitySqliteV1,
} from '../src/migrations/001-community-sqlite-baseline.js';
import { COMMUNITY_SQLITE_V2_ID } from '../src/migrations/002-statement-journal-capability.js';
import { COMMUNITY_SCHEMA_VERSION, verifyCommunitySchema } from '../src/migrations/community-registry.js';

const parent = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(parent, 'fixtures', 'migrations', 'community-sqlite-v1.json'), 'utf8')) as {
  required_version: number;
  required_tables: string[];
};
const prevMode = process.env.MATCHING_RUNTIME_MODE;
const prevRoot = process.env.MATCHING_RUNTIME_ROOT;
let root: string | undefined;
let loadedDbModule: { getDb: () => Database.Database; closeDb: () => void } | undefined;

async function isolatedDatabase() {
  root = mkdtempSync(join(tmpdir(), 'matching-community-schema-test-'));
  process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root';
  process.env.MATCHING_RUNTIME_ROOT = root;
  vi.resetModules();
  loadedDbModule = await import('../src/storage/db.js');
  return loadedDbModule;
}
function freshDbFile() {
  if (!root) throw new Error('Synthetic test root not initialized');
  const dir = join(root, 'database');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'matching.db');
}
afterEach(() => {
  loadedDbModule?.closeDb();
  loadedDbModule = undefined;
  process.env.MATCHING_RUNTIME_MODE = prevMode;
  process.env.MATCHING_RUNTIME_ROOT = prevRoot;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.resetModules();
});

describe('synthetic Community SQLite immutable baseline and registered current version', () => {
  it('initializes all schemas once with an immutable ledger and reopens without DDL changes', async () => {
    const store = await isolatedDatabase();
    const db = store.getDb();
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(COMMUNITY_SCHEMA_VERSION);
    expect(fixture.required_version).toBe(COMMUNITY_SQLITE_VERSION);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all() as string[]);
    for (const expected of fixture.required_tables) expect(tables).toContain(expected);
    const ledger = db.prepare('SELECT * FROM community_storage_migrations ORDER BY to_version').all() as Array<{
      migration_id: string; from_version: number; to_version: number; checksum_sha256: string; schema_sha256: string; applied_at: string;
    }>;
    expect(ledger.map(row => [row.from_version, row.to_version])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
    expect(ledger[1].migration_id).toBe(COMMUNITY_SQLITE_V2_ID);
    for (const row of ledger) {
      expect(row.checksum_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(row.schema_sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const sourceNames = ['schema.sql', 'schema-invoicerec.sql', 'schema-invoicebot.sql', 'schema-costmonitor.sql', 'schema-payments.sql'];
    const digest = communitySchemaDigest(sourceNames.map(name => readFileSync(join(parent, '..', 'src', 'storage', name), 'utf8')));
    expect(ledger[0].checksum_sha256).toBe(digest);
    verifyCommunitySchema(db, digest);
    store.closeDb();
    const reopened = store.getDb();
    const newLedger = reopened.prepare('SELECT * FROM community_storage_migrations ORDER BY to_version').all() as typeof ledger;
    expect(newLedger).toEqual(ledger);
    verifyCommunitySchema(reopened, digest);
    expect(reopened.pragma('foreign_key_check')).toEqual([]);
  });

  it('blocks an unknown pre-existing unversioned database without changing its schema', async () => {
    const store = await isolatedDatabase();
    const path = freshDbFile();
    const db = new Database(path);
    db.exec('CREATE TABLE old_accounting_records (id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO old_accounting_records VALUES (?)').run('FICTIONAL-KEEP');
    db.close();
    expect(() => store.getDb()).toThrow(/offline migration review/i);
    const check = new Database(path, { readonly: true });
    expect(check.prepare('SELECT id FROM old_accounting_records').pluck().get()).toBe('FICTIONAL-KEEP');
    expect(check.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name='community_storage_migrations'").pluck().get()).toBe(0);
    expect(Number(check.pragma('user_version', { simple: true }))).toBe(0);
    check.close();
  });

  it('blocks a future database version before creating any Community schema', async () => {
    const store = await isolatedDatabase();
    const path = freshDbFile();
    const db = new Database(path);
    db.exec('CREATE TABLE future_records (id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO future_records VALUES (?)').run('FICTIONAL-PRESERVE');
    db.pragma('user_version = 999');
    db.close();
    expect(() => store.getDb()).toThrow(/unsupported newer/i);
    const check = new Database(path, { readonly: true });
    expect(check.prepare('SELECT id FROM future_records').pluck().get()).toBe('FICTIONAL-PRESERVE');
    expect(check.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name='community_storage_migrations'").pluck().get()).toBe(0);
    expect(Number(check.pragma('user_version', { simple: true }))).toBe(999);
    check.close();
  });

  it('rejects tampered physical schema on restart without rewriting the ledger', async () => {
    const store = await isolatedDatabase();
    const db = store.getDb();
    const originalLedger = db.prepare('SELECT * FROM community_storage_migrations').get();
    db.exec('CREATE TABLE unauthorized_example_extension (id INTEGER)');
    store.closeDb();
    expect(() => store.getDb()).toThrow(/checksum, physical schema or history mismatch/i);
    const check = new Database(freshDbFile(), { readonly: true });
    expect(check.prepare('SELECT * FROM community_storage_migrations').get()).toEqual(originalLedger);
    check.close();
  });

  it('refuses a saved JSON state with missing SQLite evidence before creating an empty database', async () => {
    const store = await isolatedDatabase();
    if (!root) throw new Error('Synthetic test root missing');
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'state.json'),
      JSON.stringify({ run_id: 'COMMUNITY_SYNTHETIC_DEMO_V1', transactions: {} }));
    expect(() => store.getDb()).toThrow(/missing|recovery|without SQLite/i);
    expect(existsSync(join(root, 'database', 'matching.db'))).toBe(false);
  });

  it('rolls back a failed schema step rather than marking schema version as 1', () => {
    const db = new Database(':memory:');
    try {
      const badSources = [
        'CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)',
        'THIS IS NOT SQL',
        'CREATE TABLE unused_1 (id INTEGER)',
        'CREATE TABLE unused_2 (id INTEGER)',
        'CREATE TABLE unused_3 (id INTEGER)',
      ];
      expect(communitySchemaDigest(badSources)).toMatch(/^[a-f0-9]{64}$/);
      expect(() => initializeCommunitySqliteV1(db, badSources, () => {})).toThrow();
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(0);
      expect(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name='should_rollback'").pluck().get()).toBe(0);
      expect(() => verifyCommunitySqliteV1(db, 'invalid')).toThrow(/unsupported/i);
    } finally {
      db.close();
    }
  });
});
