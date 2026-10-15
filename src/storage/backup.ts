/**
 * Local backup compatibility layer.
 *
 * The legacy implementation copied the SQLite main file without WAL and
 * overwrote an open database on restore. New backups use SQLite's online
 * backup API and verified artifacts. Online restore is intentionally blocked
 * until an application-wide, offline maintenance protocol exists.
 */
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, rmSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveAccountingPaths } from './paths.js';

const PATHS = resolveAccountingPaths();
const BACKUP_DIR = PATHS.backupRoot;

export interface BackupInfo {
  name: string;
  created_at: string;
  size_bytes: number;
  files: string[];
  format?: 'verified-v1' | 'legacy-unverified';
  restore_available?: boolean;
}

interface BackupManifest {
  format: 'matching-tool-backup-v1';
  created_at: string;
  consistency: 'sqlite-online-and-state-snapshot;cross-store-epoch-unverified';
  files: Record<'matching.db' | 'state.json', { sha256: string; size: number }>;
  integrity_check: 'ok';
  foreign_key_violations: 0;
}

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function fileInfo(path: string): { sha256: string; size: number } {
  const bytes = readFileSync(path);
  return { sha256: digest(bytes), size: bytes.length };
}

function backupName(label?: string): string {
  const suffix = label ? label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30) : '';
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  return `backup_${iso}_${randomUUID().slice(0, 12)}${suffix ? '_' + suffix : ''}`;
}

function inspectSqlite(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Backup SQLite integrity verification failed');
    }
    const foreignKeys = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeys.length > 0) {
      throw new Error('Backup contains foreign-key inconsistencies');
    }
  } finally {
    db.close();
  }
}

/**
 * Return a WAL-aware DB snapshot and a verified JSON snapshot.
 * No claim of atomicity across the two stores is made until an epoch exists.
 */
export async function createBackup(label?: string): Promise<BackupInfo> {
  mkdirSync(BACKUP_DIR, { recursive: true });
  if (!existsSync(PATHS.databaseFile) || !existsSync(join(PATHS.stateRoot, 'state.json'))) {
    throw new Error('A complete SQLite and state.json source is required for backup');
  }
  const name = backupName(label);
  const pending = join(BACKUP_DIR, `.pending-${name}`);
  const finished = join(BACKUP_DIR, name);
  mkdirSync(pending);
  const dbTarget = join(pending, 'matching.db');
  const stateTarget = join(pending, 'state.json');
  try {
    const originalState = readFileSync(join(PATHS.stateRoot, 'state.json'));
    JSON.parse(originalState.toString('utf8'));

    // Read-only connection: SQLite's online API includes uncheckpointed WAL
    // transactions and does not require copying the -wal/-shm sidecars.
    const source = new Database(PATHS.databaseFile, { readonly: true, fileMustExist: true });
    try {
      await source.backup(dbTarget);
    } finally {
      source.close();
    }
    inspectSqlite(dbTarget);
    // Refuse a snapshot if JSON changed while the SQLite copy was running.
    const latestState = readFileSync(join(PATHS.stateRoot, 'state.json'));
    if (digest(originalState) !== digest(latestState)) {
      throw new Error('Accounting state changed during backup; retry when idle');
    }
    writeFileSync(stateTarget, originalState, { flag: 'wx', mode: 0o600 });
    JSON.parse(readFileSync(stateTarget, 'utf8'));

    const createdAt = new Date().toISOString();
    const manifest: BackupManifest = {
      format: 'matching-tool-backup-v1',
      created_at: createdAt,
      consistency: 'sqlite-online-and-state-snapshot;cross-store-epoch-unverified',
      files: {
        'matching.db': fileInfo(dbTarget),
        'state.json': fileInfo(stateTarget),
      },
      integrity_check: 'ok',
      foreign_key_violations: 0,
    };
    writeFileSync(join(pending, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      flag: 'wx', mode: 0o600,
    });
    renameSync(pending, finished);
    return {
      name, created_at: createdAt,
      size_bytes: Object.values(manifest.files).reduce((sum, part) => sum + part.size, 0),
      files: ['matching.db', 'state.json', 'manifest.json'],
      format: 'verified-v1',
      restore_available: false,
    };
  } catch (error) {
    rmSync(pending, { recursive: true, force: true });
    throw error;
  }
}

export function listBackups(): BackupInfo[] {
  if (!existsSync(BACKUP_DIR)) return [];
  const names = readdirSync(BACKUP_DIR).filter(name => /^backup_[A-Za-z0-9_.-]+$/.test(name));
  const backups: BackupInfo[] = [];
  const legacy = new Map<string, string[]>();
  for (const name of names) {
    const path = join(BACKUP_DIR, name);
    if (statSync(path).isDirectory()) {
      const manifestPath = join(path, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
        if (m.format !== 'matching-tool-backup-v1') continue;
        const paths = ['matching.db', 'state.json'] as const;
        if (paths.some(f => !existsSync(join(path, f))
          || digest(readFileSync(join(path, f))) !== m.files[f]?.sha256)) continue;
        backups.push({
          name, created_at: m.created_at,
          size_bytes: paths.reduce((sum, file) => sum + m.files[file].size, 0),
          files: ['matching.db', 'state.json', 'manifest.json'],
          format: 'verified-v1', restore_available: false,
        });
      } catch {
        // Invalid/incomplete backups are never represented as verified.
      }
    } else if (/_state\.json$|_matching\.db$/.test(name)) {
      const groupName = name.replace(/_state\.json$|_matching\.db$/, '');
      const files = legacy.get(groupName) ?? [];
      files.push(name);
      legacy.set(groupName, files);
    }
  }
  for (const [name, files] of legacy) {
    backups.push({
      name, created_at: name,
      size_bytes: files.reduce((sum, f) => sum + statSync(join(BACKUP_DIR, f)).size, 0),
      files, format: 'legacy-unverified', restore_available: false,
    });
  }
  return backups.sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Never overwrite live matching.db or JSON while application connections
 * remain open; that operation can discard committed WAL transactions.
 */
export function restoreBackup(_backupName: string): never {
  throw new Error(
    'Online restore is disabled to prevent bookkeeping corruption. ' +
    'Use a separately verified offline maintenance/restore procedure.'
  );
}

/** Destructive backup deletion is denied until owner authorization is implemented. */
export function deleteBackup(_backupName: string): boolean {
  throw new Error('Backup deletion requires authenticated owner maintenance mode');
}
