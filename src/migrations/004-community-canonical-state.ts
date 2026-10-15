import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export const CANONICAL_STATE_CAPABILITY = 'canonical-state-journal-v1';
export const CANONICAL_STATE_DDL = `
CREATE TABLE community_canonical_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  run_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  state_sha256 TEXT NOT NULL CHECK(length(state_sha256) = 64),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER community_audit_no_update BEFORE UPDATE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'Accounting audit is append only'); END;
CREATE TRIGGER community_audit_no_delete BEFORE DELETE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'Accounting audit is append only'); END;
CREATE TRIGGER community_migration_no_update BEFORE UPDATE ON community_storage_migrations
  BEGIN SELECT RAISE(ABORT, 'Migration history is immutable'); END;
CREATE TRIGGER community_migration_no_delete BEFORE DELETE ON community_storage_migrations
  BEGIN SELECT RAISE(ABORT, 'Migration history is immutable'); END;
`;
export const CANONICAL_STATE_MIGRATION_CHECKSUM = createHash('sha256')
  .update('matching-community-canonical-state-v1\n'+CANONICAL_STATE_DDL+'\n'+CANONICAL_STATE_CAPABILITY).digest('hex');
export function upCommunityCanonicalState004(db: Database.Database): void { db.exec(CANONICAL_STATE_DDL); }
