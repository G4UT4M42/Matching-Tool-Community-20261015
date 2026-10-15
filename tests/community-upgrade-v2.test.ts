import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { communitySchemaDigest, initializeCommunitySqliteV1, verifyCommunitySqliteV1 } from '../src/migrations/001-community-sqlite-baseline.js';
import { COMMUNITY_SQLITE_V2_CHECKSUM, upgradeCommunitySqliteV1ToV2, verifyCommunitySqliteV2 } from '../src/migrations/002-statement-journal-capability.js';

const base = join(import.meta.dirname, '..', 'src', 'storage');
const names = ['schema.sql', 'schema-invoicerec.sql', 'schema-invoicebot.sql', 'schema-costmonitor.sql', 'schema-payments.sql'];
const sql = names.map(name => readFileSync(join(base, name), 'utf8'));
const digest = communitySchemaDigest(sql);
function syntheticV1() {
  const db = new Database(':memory:');
  // Baseline's migration callback is supplied by db.ts in production. These
  // fields reproduce its reviewed v1 physical schema in the test fixture.
  const add = (table: string, column: string, type: string, value?: string) => {
    if ((db.pragma(`table_info(${table})`) as Array<{ name: string }>).some(row => row.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${value === undefined ? '' : ` DEFAULT ${value}`}`);
  };
  initializeCommunitySqliteV1(db, sql, () => {
    for (const [table, cols] of Object.entries({
      invoice_bot_portals: [['adapter_type','TEXT',"'amazon'"],['run_strategy','TEXT',"'agentic'"],['login_strategy','TEXT',"'existing_session'"],['credential_ref','TEXT'],['task_prompt','TEXT'],['max_cost_per_run','REAL'],['portal_state','TEXT',"'active'"],['requires_human_login','INTEGER','0'],['review_policy','TEXT',"'review_if_uncertain'"]],
      invoice_bot_runs: [['total_cost','REAL'],['total_tokens','INTEGER'],['mode','TEXT',"'collect_invoices'"],['profile_id','TEXT'],['warnings_count','INTEGER','0'],['invoices_found_count','INTEGER','0'],['files_downloaded_count','INTEGER','0']],
      payment_batches: [['export_artifact_data','BLOB']],
      payment_automation_runs: [['last_verified_url_class','TEXT'],['import_filename','TEXT',"'legacy-unknown.xml'"],['upload_attempted_at','TEXT'],['release_confirmation_json','TEXT'],['release_click_claimed_at','TEXT'],['release_retry_claimed_at','TEXT'],['release_retry_clicked_at','TEXT'],['release_retry_count','INTEGER','0']],
      vendor_overrides: [['is_reverse_charge','INTEGER','0'],['tax_category_kz','TEXT'],['address','TEXT']],
    })) for (const col of cols) add(table, col[0]!, col[1]!, col[2]);
  });
  return db;
}

describe('Community SQLite v2 journal capability', () => {
  it('upgrades exact v1 transactionally and preserves its immutable ledger', () => {
    const db = syntheticV1();
    try {
      const before = db.prepare('SELECT * FROM community_storage_migrations').get();
      upgradeCommunitySqliteV1ToV2(db, digest);
      verifyCommunitySqliteV2(db, digest);
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(2);
      expect(db.prepare('SELECT * FROM community_storage_migrations WHERE to_version=1').get()).toEqual(before);
      expect(db.prepare('SELECT checksum_sha256 FROM community_storage_migrations WHERE to_version=2').pluck().get()).toBe(COMMUNITY_SQLITE_V2_CHECKSUM);
      expect(() => upgradeCommunitySqliteV1ToV2(db, digest)).toThrow(/exact version 1/);
      expect(() => verifyCommunitySqliteV1(db, digest)).toThrow(/Unsupported/);
    } finally { db.close(); }
  });
  it('rolls back an interrupted upgrade and refuses tampered history', () => {
    const db = syntheticV1();
    try {
      expect(() => upgradeCommunitySqliteV1ToV2(db, digest, () => { throw new Error('synthetic power loss'); })).toThrow(/power loss/);
      verifyCommunitySqliteV1(db, digest);
      expect(db.prepare("SELECT count(*) FROM sqlite_schema WHERE name='community_storage_capabilities'").pluck().get()).toBe(0);
      db.prepare("UPDATE community_storage_migrations SET checksum_sha256='bad' WHERE to_version=1").run();
      expect(() => upgradeCommunitySqliteV1ToV2(db, digest)).toThrow(/preflight/);
    } finally { db.close(); }
  });
});
