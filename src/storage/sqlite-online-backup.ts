import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, join, normalize } from 'path';

export interface ApplicationConsistencyCheck {
  status: 'ok' | 'failed';
  missing_required_tables: string[];
  foreign_key_violation_count: number;
  critical_table_row_counts: Record<string, number>;
}

export interface SqliteValidation {
  sqlite_version: string;
  integrity_check: string;
  schema_hash: string;
  user_version: number;
  application_id: number;
  table_count: number;
  application_consistency_check: ApplicationConsistencyCheck;
}

export interface AccountingSqliteBackupV1 {
  contract_version: 'accounting_sqlite_backup_v1';
  backup_id: string;
  database_id: string;
  source_path_hash: string;
  backup_path: string;
  metadata_path: string;
  created_at: string;
  sqlite_version: string;
  source_size: number;
  backup_size: number;
  source_schema_hash: string;
  backup_schema_hash: string;
  source_user_version: number;
  backup_user_version: number;
  integrity_check: string;
  application_consistency_check: ApplicationConsistencyCheck;
  sha256: string;
}

export interface RestoreValidation {
  backup_id: string;
  restore_path: string;
  integrity_check: string;
  schema_hash: string;
  user_version: number;
  table_count: number;
  application_consistency_check: ApplicationConsistencyCheck;
  sha256: string;
}

interface OnlineBackupOptions {
  databaseId: string;
  sourcePath: string;
  backupRoot: string;
  requiredTables: string[];
}

interface RestoreOptions {
  backup: AccountingSqliteBackupV1;
  restoreRoot: string;
  requiredTables: string[];
}

function sha256Bytes(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function removeValidationSidecars(path: string): void {
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    if (existsSync(sidecar)) rmSync(sidecar);
  }
}

function schemaHash(database: Database.Database): string {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
    FROM sqlite_schema
    ORDER BY type, name, tbl_name, sql
  `).all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  return sha256Bytes(rows.map((row) => [row.type, row.name, row.tbl_name, row.sql].join('\u001f')).join('\n'));
}

function applicationConsistency(
  database: Database.Database,
  requiredTables: string[],
): ApplicationConsistencyCheck {
  const tables = new Set(
    (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").pluck().all() as string[]),
  );
  const missing = requiredTables.filter((table) => !tables.has(table)).sort();
  const rowCounts: Record<string, number> = {};
  for (const table of requiredTables.filter((name) => tables.has(name)).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error('invalid required table identifier');
    }
    rowCounts[table] = Number(
      (database.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get() as number | bigint),
    );
  }
  const foreignKeyViolations = database.pragma('foreign_key_check') as unknown[];
  return {
    status: missing.length === 0 && foreignKeyViolations.length === 0 ? 'ok' : 'failed',
    missing_required_tables: missing,
    foreign_key_violation_count: foreignKeyViolations.length,
    critical_table_row_counts: rowCounts,
  };
}

export function validateSqliteDatabase(
  path: string,
  requiredTables: string[],
): SqliteValidation {
  let database: Database.Database | undefined;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    const integrity = String(database.pragma('integrity_check', { simple: true }));
    if (integrity !== 'ok') throw new Error('integrity_check did not return ok');
    const consistency = applicationConsistency(database, requiredTables);
    if (consistency.status !== 'ok') throw new Error('application consistency check failed');
    return {
      sqlite_version: String(database.prepare('SELECT sqlite_version()').pluck().get()),
      integrity_check: integrity,
      schema_hash: schemaHash(database),
      user_version: Number(database.pragma('user_version', { simple: true })),
      application_id: Number(database.pragma('application_id', { simple: true })),
      table_count: Number(
        database.prepare(
          "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        ).pluck().get(),
      ),
      application_consistency_check: consistency,
    };
  } catch (error) {
    throw new Error('SQLite validation failed', { cause: error });
  } finally {
    database?.close();
  }
}

export async function createSqliteOnlineBackup(
  options: OnlineBackupOptions,
): Promise<AccountingSqliteBackupV1> {
  const sourcePath = normalize(options.sourcePath);
  const backupRoot = normalize(options.backupRoot);
  if (!existsSync(sourcePath)) throw new Error('source database does not exist');
  mkdirSync(backupRoot, { recursive: true });
  const createdAt = new Date().toISOString();
  const compactTimestamp = createdAt.replace(/\D/g, '').slice(0, 14);
  const backupId = `${options.databaseId}-${compactTimestamp}-${randomUUID().slice(0, 12)}`;
  const backupDirectory = join(backupRoot, backupId);
  mkdirSync(backupDirectory, { recursive: false });
  const backupPath = join(backupDirectory, `${backupId}.sqlite`);
  const metadataPath = join(backupDirectory, `${backupId}.json`);
  const sourceValidation = validateSqliteDatabase(sourcePath, options.requiredTables);

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(backupPath);
  } finally {
    source.close();
  }
  const backupValidation = validateSqliteDatabase(backupPath, options.requiredTables);
  removeValidationSidecars(backupPath);
  if (sourceValidation.schema_hash !== backupValidation.schema_hash) {
    throw new Error('backup schema hash does not match source');
  }
  if (sourceValidation.user_version !== backupValidation.user_version) {
    throw new Error('backup user version does not match source');
  }

  const result: AccountingSqliteBackupV1 = {
    contract_version: 'accounting_sqlite_backup_v1',
    backup_id: backupId,
    database_id: options.databaseId,
    source_path_hash: sha256Bytes(sourcePath.toLocaleLowerCase()),
    backup_path: backupPath,
    metadata_path: metadataPath,
    created_at: createdAt,
    sqlite_version: backupValidation.sqlite_version,
    source_size: statSync(sourcePath).size,
    backup_size: statSync(backupPath).size,
    source_schema_hash: sourceValidation.schema_hash,
    backup_schema_hash: backupValidation.schema_hash,
    source_user_version: sourceValidation.user_version,
    backup_user_version: backupValidation.user_version,
    integrity_check: backupValidation.integrity_check,
    application_consistency_check: backupValidation.application_consistency_check,
    sha256: sha256File(backupPath),
  };
  writeFileSync(metadataPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return result;
}

export function restoreAndValidateSqliteBackup(options: RestoreOptions): RestoreValidation {
  const restoreRoot = normalize(options.restoreRoot);
  mkdirSync(restoreRoot, { recursive: true });
  const restoreDirectory = join(restoreRoot, options.backup.backup_id);
  const restorePath = join(restoreDirectory, basename(options.backup.backup_path));
  mkdirSync(restoreDirectory, { recursive: false });
  copyFileSync(options.backup.backup_path, restorePath, 1);
  const validation = validateSqliteDatabase(restorePath, options.requiredTables);
  removeValidationSidecars(restorePath);
  const digest = sha256File(restorePath);
  if (digest !== options.backup.sha256) throw new Error('restore hash does not match backup');
  return {
    backup_id: options.backup.backup_id,
    restore_path: restorePath,
    integrity_check: validation.integrity_check,
    schema_hash: validation.schema_hash,
    user_version: validation.user_version,
    table_count: validation.table_count,
    application_consistency_check: validation.application_consistency_check,
    sha256: digest,
  };
}
