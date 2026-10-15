import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { COMMUNITY_SQLITE_MIGRATION_ID, communityPhysicalSchemaDigest } from './001-community-sqlite-baseline.js';

export const COMMUNITY_SQLITE_CURRENT_VERSION = 2;
export const COMMUNITY_SQLITE_V2_ID = 'community-sqlite-v2-statement-journal';
export const STATEMENT_JOURNAL_CAPABILITY = 'statement-journal-v1';
const DDL = `CREATE TABLE community_storage_capabilities (
  capability TEXT PRIMARY KEY NOT NULL,
  capability_version INTEGER NOT NULL CHECK (capability_version > 0)
)`;
export const COMMUNITY_SQLITE_V2_CHECKSUM = createHash('sha256')
  .update('community-sqlite-v2:statement-journal:2026-10-14\n' + DDL + '\n' + STATEMENT_JOURNAL_CAPABILITY)
  .digest('hex');

export function verifyCommunitySqliteV2(db: Database.Database, baselineDigest: string): void {
  if (Number(db.pragma('user_version', { simple: true })) !== 2) throw new Error('Unsupported Community SQLite version');
  const rows = db.prepare('SELECT migration_id, from_version, to_version, checksum_sha256, schema_sha256 FROM community_storage_migrations ORDER BY to_version').all() as Array<{
    migration_id: string; from_version: number; to_version: number; checksum_sha256: string; schema_sha256: string;
  }>;
  if (rows.length !== 2 || rows[0].migration_id !== COMMUNITY_SQLITE_MIGRATION_ID || rows[0].from_version !== 0 || rows[0].to_version !== 1 || rows[0].checksum_sha256 !== baselineDigest ||
      rows[1].migration_id !== COMMUNITY_SQLITE_V2_ID || rows[1].from_version !== 1 || rows[1].to_version !== 2 || rows[1].checksum_sha256 !== COMMUNITY_SQLITE_V2_CHECKSUM || rows[1].schema_sha256 !== communityPhysicalSchemaDigest(db)) {
    throw new Error('Community SQLite migration checksum, physical schema or history mismatch');
  }
  const caps = db.prepare('SELECT capability, capability_version FROM community_storage_capabilities').all() as Array<{ capability: string; capability_version: number }>;
  if (caps.length !== 1 || caps[0].capability !== STATEMENT_JOURNAL_CAPABILITY || caps[0].capability_version !== 1) throw new Error('Unsupported Community SQLite capability registry');
}

export function upgradeCommunitySqliteV1ToV2(db: Database.Database, baselineDigest: string, beforeCommit?: () => void): void {
  if (Number(db.pragma('user_version', { simple: true })) !== 1) throw new Error('SQLite v2 upgrade requires exact version 1');
  // The old ledger's physical hash belongs to v1; validate it before any DDL.
  const v1 = db.prepare('SELECT migration_id, from_version, to_version, checksum_sha256, schema_sha256 FROM community_storage_migrations').all() as Array<{
    migration_id: string; from_version: number; to_version: number; checksum_sha256: string; schema_sha256: string;
  }>;
  if (v1.length !== 1 || v1[0].migration_id !== COMMUNITY_SQLITE_MIGRATION_ID || v1[0].from_version !== 0 || v1[0].to_version !== 1 || v1[0].checksum_sha256 !== baselineDigest || v1[0].schema_sha256 !== communityPhysicalSchemaDigest(db)) {
    throw new Error('Community SQLite v1 preflight checksum or history mismatch');
  }
  db.transaction(() => {
    db.exec(DDL);
    db.prepare('INSERT INTO community_storage_capabilities (capability, capability_version) VALUES (?, 1)').run(STATEMENT_JOURNAL_CAPABILITY);
    db.prepare(`INSERT INTO community_storage_migrations (migration_id, from_version, to_version, checksum_sha256, schema_sha256, applied_at) VALUES (?, 1, 2, ?, ?, ?)`).run(
      COMMUNITY_SQLITE_V2_ID, COMMUNITY_SQLITE_V2_CHECKSUM, communityPhysicalSchemaDigest(db), new Date().toISOString(),
    );
    db.pragma('user_version = 2');
    beforeCommit?.();
  })();
  verifyCommunitySqliteV2(db, baselineDigest);
}
