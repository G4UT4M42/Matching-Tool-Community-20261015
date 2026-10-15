import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { resolveAccountingPaths } from './paths.js';
import {
  communitySchemaDigest,
  initializeCommunitySqliteV1, verifyCommunitySqliteV1,
} from '../migrations/001-community-sqlite-baseline.js';
import { COMMUNITY_SCHEMA_VERSION, upgradeCommunitySchema, verifyCommunitySchema } from '../migrations/community-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');
const SCHEMA_INVOICEREC_PATH = join(__dirname, 'schema-invoicerec.sql');
const SCHEMA_INVOICEBOT_PATH = join(__dirname, 'schema-invoicebot.sql');
const SCHEMA_COSTMONITOR_PATH = join(__dirname, 'schema-costmonitor.sql');
const SCHEMA_PAYMENTS_PATH = join(__dirname, 'schema-payments.sql');
const PATHS = resolveAccountingPaths();
const DATA_DIR = PATHS.databaseRoot;
const DB_PATH = PATHS.databaseFile;

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  // This in-process bootstrap is only supported for a private synthetic preview.
  if (PATHS.mode !== 'external-runtime-root' || !process.env.MATCHING_RUNTIME_ROOT) {
    throw new Error('Community SQLite requires an explicit isolated external runtime root');
  }
  // Never construct an empty SQLite store beside an already persisted JSON state.
  // It would silently sever cross-store invoice and matching relationships.
  const existed = existsSync(DB_PATH);
  if (!existed && existsSync(join(PATHS.stateRoot, 'state.json'))) {
    throw new Error('Existing JSON state without SQLite database requires verified offline recovery');
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  try {
    // Reject future/unsupported versions BEFORE running CREATE/ALTER statements.
    const version = Number(db.pragma('user_version', { simple: true }));
    if (!Number.isInteger(version) || version < 0 || version > COMMUNITY_SCHEMA_VERSION) {
      throw new Error('Unsupported newer Community SQLite version; update the application first');
    }
    // Additive registered edges preserve the old statement journal and its tables.
    // Startup recovers that journal before admitting accounting reads or writes.
    const schemaFiles = [
      SCHEMA_PATH, SCHEMA_INVOICEREC_PATH, SCHEMA_INVOICEBOT_PATH,
      SCHEMA_COSTMONITOR_PATH, SCHEMA_PAYMENTS_PATH,
    ];
    if (schemaFiles.some(file => !existsSync(file))) {
      throw new Error('Required Community SQLite schema files are missing');
    }
    const sqlSources = schemaFiles.map(file => readFileSync(file, 'utf8'));
    const digest = communitySchemaDigest(sqlSources);
    if (version === 0) {
      if (existed) throw new Error('Unversioned existing database requires offline migration review');
      db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL');
      initializeCommunitySqliteV1(db, sqlSources, runMigrations);
    }
    upgradeCommunitySchema(db, digest);
    verifyCommunitySchema(db, digest);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' ||
        (db.pragma('foreign_key_check') as unknown[]).length !== 0) {
      throw new Error('Community SQLite integrity or relationship verification failed');
    }
    _db = db;
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Safe ALTER TABLE migrations — adds columns if they don't exist */
export function runMigrations(db: Database.Database): void {
  const hasColumn = (table: string, column: string): boolean => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.some(c => c.name === column);
  };
  const addCol = (table: string, column: string, type: string, dflt?: string) => {
    if (hasColumn(table, column)) return;
    const d = dflt != null ? ` DEFAULT ${dflt}` : '';
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${d}`);
  };

  // Invoice Bot portal extensions for browser-use
  addCol('invoice_bot_portals', 'adapter_type', 'TEXT', "'amazon'");
  addCol('invoice_bot_portals', 'run_strategy', 'TEXT', "'agentic'");
  addCol('invoice_bot_portals', 'login_strategy', 'TEXT', "'existing_session'");
  addCol('invoice_bot_portals', 'credential_ref', 'TEXT');
  addCol('invoice_bot_portals', 'task_prompt', 'TEXT');
  addCol('invoice_bot_portals', 'max_cost_per_run', 'REAL');
  addCol('invoice_bot_portals', 'portal_state', 'TEXT', "'active'");
  addCol('invoice_bot_portals', 'requires_human_login', 'INTEGER', '0');
  addCol('invoice_bot_portals', 'review_policy', 'TEXT', "'review_if_uncertain'");

  // Invoice Bot run extensions for cost tracking
  addCol('invoice_bot_runs', 'total_cost', 'REAL');
  addCol('invoice_bot_runs', 'total_tokens', 'INTEGER');
  addCol('invoice_bot_runs', 'mode', 'TEXT', "'collect_invoices'");
  addCol('invoice_bot_runs', 'profile_id', 'TEXT');
  addCol('invoice_bot_runs', 'warnings_count', 'INTEGER', '0');
  addCol('invoice_bot_runs', 'invoices_found_count', 'INTEGER', '0');
  addCol('invoice_bot_runs', 'files_downloaded_count', 'INTEGER', '0');

  // Persist generated SEPA XML inside the same CAS transaction as export.
  addCol('payment_batches', 'export_artifact_data', 'BLOB');
  // Sanitized George automation evidence (never a raw URL) and crash-safe claims.
  addCol('payment_automation_runs', 'last_verified_url_class', 'TEXT');
  addCol('payment_automation_runs', 'import_filename', 'TEXT', "'legacy-unknown.xml'");
  addCol('payment_automation_runs', 'upload_attempted_at', 'TEXT');
  addCol('payment_automation_runs', 'release_confirmation_json', 'TEXT');
  addCol('payment_automation_runs', 'release_click_claimed_at', 'TEXT');
  addCol('payment_automation_runs', 'release_retry_claimed_at', 'TEXT');
  addCol('payment_automation_runs', 'release_retry_clicked_at', 'TEXT');
  addCol('payment_automation_runs', 'release_retry_count', 'INTEGER', '0');

  // Vendor overrides: reverse charge flag + income tax category
  addCol('vendor_overrides', 'is_reverse_charge', 'INTEGER', '0');
  addCol('vendor_overrides', 'tax_category_kz', 'TEXT');
  addCol('vendor_overrides', 'address', 'TEXT');
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getDbPath(): string {
  return DB_PATH;
}
