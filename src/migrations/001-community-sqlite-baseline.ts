import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export const COMMUNITY_SQLITE_VERSION = 1;
export const COMMUNITY_SQLITE_MIGRATION_ID = 'community-sqlite-v1';

/** Hash the exact reviewed bootstrap SQL, never the filename or a mutable package version. */
export function communitySchemaDigest(sqlSources: string[]): string {
  if (sqlSources.length !== 5 || sqlSources.some(source => !source.trim())) {
    throw new Error('SQLite bootstrap requires all five reviewed schema files');
  }
  return createHash('sha256')
    .update('community-sqlite-v1:reviewed-schema-bundle:2026-10-13\n', 'utf8')
    .update(sqlSources.join('\n--SCHEMA-BOUNDARY--\n'), 'utf8')
    .digest('hex');
}

export function communityPhysicalSchemaDigest(db: Database.Database): string {
  const rows = db.prepare(`
    SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
    FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name, tbl_name, sql
  `).all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  return createHash('sha256')
    .update(rows.map(row => [row.type, row.name, row.tbl_name, row.sql].join('\u001f')).join('\n'), 'utf8')
    .digest('hex');
}

export function verifyCommunitySqliteV1(
  db: Database.Database, expectedDigest: string,
): void {
  const actualVersion = Number(db.pragma('user_version', { simple: true }));
  if (actualVersion !== COMMUNITY_SQLITE_VERSION) {
    throw new Error('Unsupported Community SQLite schema version; migration or newer application required');
  }
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='community_storage_migrations'",
  ).all();
  if (tables.length !== 1) throw new Error('Community SQLite migration ledger is missing');
  const rows = db.prepare(
    'SELECT from_version, to_version, checksum_sha256, schema_sha256 FROM community_storage_migrations WHERE migration_id=?',
  ).all(COMMUNITY_SQLITE_MIGRATION_ID) as Array<{
    from_version: number; to_version: number; checksum_sha256: string; schema_sha256: string;
  }>;
  if (rows.length !== 1 || rows[0].from_version !== 0 ||
      rows[0].to_version !== COMMUNITY_SQLITE_VERSION ||
      rows[0].checksum_sha256 !== expectedDigest ||
      rows[0].schema_sha256 !== communityPhysicalSchemaDigest(db)) {
    throw new Error('Community SQLite migration checksum, physical schema or history mismatch');
  }
  const historyCount = Number(db.prepare('SELECT COUNT(*) FROM community_storage_migrations').pluck().get());
  if (historyCount !== 1) throw new Error('Unexpected Community SQLite migration history');
}

export function initializeCommunitySqliteV1(
  db: Database.Database,
  sqlSources: string[],
  migrateLegacyColumns: (db: Database.Database) => void,
): void {
  const digest = communitySchemaDigest(sqlSources);
  const currentVersion = Number(db.pragma('user_version', { simple: true }));
  if (currentVersion !== 0) throw new Error('Baseline initializer only accepts an unversioned SQLite database');

  const run = db.transaction(() => {
    for (const sql of sqlSources) db.exec(sql);
    migrateLegacyColumns(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS community_storage_migrations (
        migration_id TEXT PRIMARY KEY NOT NULL,
        from_version INTEGER NOT NULL,
        to_version INTEGER NOT NULL,
        checksum_sha256 TEXT NOT NULL,
        schema_sha256 TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const existing = db.prepare('SELECT COUNT(*) FROM community_storage_migrations').pluck().get();
    if (Number(existing) !== 0) throw new Error('Existing unverified Community SQLite migration ledger');
    db.prepare(`
      INSERT INTO community_storage_migrations
      (migration_id, from_version, to_version, checksum_sha256, schema_sha256, applied_at)
      VALUES (?, 0, 1, ?, ?, ?)
    `).run(COMMUNITY_SQLITE_MIGRATION_ID, digest, communityPhysicalSchemaDigest(db), new Date().toISOString());
    db.pragma('user_version = 1');
  });
  run();
  verifyCommunitySqliteV1(db, digest);
}
