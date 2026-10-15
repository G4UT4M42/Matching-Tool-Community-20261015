import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { communitySchemaDigest, initializeCommunitySqliteV1 } from '../../migrations/001-community-sqlite-baseline.js';
import { upgradeCommunitySchema } from '../../migrations/community-registry.js';
import { runMigrations } from '../../storage/db.js';
import { validateCommunityJsonState } from '../../storage/json-store.js';
import { createCommunityBackup, type Exclusive } from './backup.js';
import { stageCommunityRestore } from './restore.js';
// The offline importer is read-only on its source and validates its historical whitelist.
// @ts-expect-error Existing reviewed JavaScript module has no declaration file.
import { stageLegacyV2 } from '../../migration/offline-v2.mjs';
// @ts-expect-error Existing reviewed JavaScript module has no declaration file.
import { verifyLegacyStage } from '../../migration/verify-offline-stage.mjs';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'storage');
const sourceNames = ['schema.sql','schema-invoicerec.sql','schema-invoicebot.sql','schema-costmonitor.sql','schema-payments.sql'];
function sources() { return sourceNames.map(name => readFileSync(join(schemaDir, name), 'utf8')); }
function normalFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw new Error('Unsafe legacy source file');
  return readFileSync(path);
}
function walk(root: string, path: string, out: string[]): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('Legacy source link is unsafe');
  if (stat.isFile()) { out.push(path); return; }
  if (!stat.isDirectory()) throw new Error('Unsupported legacy source entry');
  for (const name of readdirSync(path).sort()) {
    if (out.length > 4096) throw new Error('Legacy source has too many files');
    if (['backups','cache','logs','browser-profiles','node_modules'].includes(name)) continue;
    walk(root, join(path, name), out);
  }
}
export function legacySourceFingerprint(sourceRoot: string): string {
  const root = resolve(sourceRoot), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Legacy root must be a local directory');
  const files: string[] = []; walk(root, root, files);
  return sha(files.map(path => relative(root, path).replaceAll('\\','/') + ':' + sha(normalFile(path))).join('\n'));
}
const tableOrder: Array<[string, string]> = [
  ['transactions','transactions'],['documents','documents'],['line_items','line_items'],['match_groups','match_groups'],
  ['match_group_transactions','match_group_transactions'],['match_group_documents','match_group_documents'],
  ['exclusion_rules','exclusion_rules'],['transaction_dispositions','transaction_dispositions'],['document_dispositions','document_dispositions'],
  ['audit_events','audit_events'],['private_vendors','private_vendors'],['vendor_overrides','vendor_overrides'],
  ['invoice_scans','invoice_scans'],['invoicerec_scans','invoice_scans'],['invoicerec_templates','invoice_templates'],
  ['payment_candidates','invoice_payment_candidates'],['payment_batches','payment_batches'],['payment_batch_items','payment_batch_items'],
  ['payment_batch_events','payment_status_events'],['settings','settings'],
];
const stripped = /password|passwd|secret|credential|cookie|token|session|release_confirmation|release_click|release_retry|approval/i;
function translateDatabase(sourcePath: string, targetPath: string): { mapped: Record<string, number>; omitted: Record<string, number> } {
  const src = new Database(sourcePath, { readonly: true, fileMustExist: true }), dest = new Database(targetPath);
  try {
    if (src.pragma('integrity_check', { simple: true }) !== 'ok' || (src.pragma('foreign_key_check') as unknown[]).length) throw new Error('Legacy database integrity failure');
    const sql = sources(), digest = communitySchemaDigest(sql);
    dest.pragma('journal_mode = WAL');
    initializeCommunitySqliteV1(dest, sql, runMigrations);
    upgradeCommunitySchema(dest, digest);
    const existing = new Set((src.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[]));
    const mapped: Record<string, number> = {}, omitted: Record<string, number> = {};
    const known = new Set([...tableOrder.map(([name]) => name), 'schema_migrations', 'payment_automation_runs']);
    for (const name of existing) if (!known.has(name) && Number(src.prepare(`SELECT count(*) FROM "${name}"`).pluck().get()) > 0) throw new Error('Unmapped legacy table with persisted data: ' + name);
    dest.pragma('foreign_keys = OFF');
    dest.transaction(() => {
      for (const [from, to] of tableOrder) {
        if (!existing.has(from)) continue;
        const rows = src.prepare(`SELECT * FROM "${from}"`).all() as Array<Record<string, unknown>>;
        if (!rows.length) continue;
        const targetColumns = new Set((dest.pragma(`table_info(${to})`) as Array<{ name: string }>).map(row => row.name));
        const columns = Object.keys(rows[0]!).filter(name => targetColumns.has(name) && !stripped.test(name));
        for (const row of rows) {
          for (const [key, value] of Object.entries(row)) if (!columns.includes(key) && value !== null && !stripped.test(key)) throw new Error(`Unmapped legacy field ${from}.${key}`);
          if (from === 'settings' && (!['theme','locale','language','timezone','currency','default_currency','date_format','number_format'].includes(String(row.key)) || stripped.test(String(row.key)))) { omitted[from] = (omitted[from] ?? 0) + 1; continue; }
          const values = columns.map(name => row[name]);
          dest.prepare(`INSERT INTO "${to}" (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
          mapped[from] = (mapped[from] ?? 0) + 1;
        }
      }
      if (existing.has('payment_automation_runs')) omitted.payment_automation_runs = Number(src.prepare('SELECT count(*) FROM payment_automation_runs').pluck().get());
    })();
    dest.pragma('foreign_keys = ON');
    if ((dest.pragma('foreign_key_check') as unknown[]).length || dest.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Converted legacy relationship failure');
    return { mapped, omitted };
  } finally { src.close(); dest.close(); }
}
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 48) throw new Error('Legacy state nesting exceeds limit');
  if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__','constructor','prototype'].includes(key)) throw new Error('Unsafe legacy state key');
    if (!stripped.test(key)) out[key] = scrub(child, depth + 1);
  }
  return out;
}
export async function inspectLegacy(sourceRoot: string) {
  const before = legacySourceFingerprint(sourceRoot);
  const preview = await stageLegacyV2({ sourceRoot, destinationRoot: join(resolve(sourceRoot), '..', '.unused-preview-' + randomUUID()), confirmedOffline: true, dryRun: true });
  if (legacySourceFingerprint(sourceRoot) !== before) throw new Error('Legacy source changed during inspection');
  return { ...preview, fingerprint: before };
}
export async function stageLegacyConversion(runtimeRoot: string, sourceRoot: string, fingerprint: string, withExclusiveAccess: Exclusive) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || legacySourceFingerprint(sourceRoot) !== fingerprint) throw new Error('Legacy dry run confirmation is stale');
  const root = resolve(runtimeRoot), tempRoot = join(root, 'temp'); mkdirSync(tempRoot, { recursive: true });
  const offline = join(tempRoot, 'legacy-offline-' + randomUUID()), candidate = join(tempRoot, 'legacy-community-' + randomUUID());
  try {
    const preview = await stageLegacyV2({ sourceRoot, destinationRoot: offline, confirmedOffline: true, dryRun: false });
    verifyLegacyStage({ destinationRoot: offline });
    if (legacySourceFingerprint(sourceRoot) !== fingerprint) throw new Error('Legacy source changed after staging');
    mkdirSync(join(candidate, 'database'), { recursive: true }); mkdirSync(join(candidate, 'state')); mkdirSync(join(candidate, 'documents'));
    const mapped = translateDatabase(join(offline, 'database', 'matching.db'), join(candidate, 'database', 'matching.db'));
    const state = scrub(JSON.parse(normalFile(join(offline, 'state', 'state.json')).toString('utf8'))) as Record<string, unknown>;
    state.schema_version = 1; state.format = 'matching-community-state-v1';
    const sourceManifest = JSON.parse(normalFile(join(offline, 'migration-manifest.json')).toString('utf8')) as { documents: Array<{ document_id: string; path: string; sha256: string }> };
    const docs = state.documents as Record<string, { filename?: string; file_hash?: string }>;
    for (const entry of sourceManifest.documents) {
      const doc = docs[entry.document_id]; if (!doc) throw new Error('Orphan legacy attachment');
      if (!/^[A-Za-z0-9_.-]+$/.test(entry.path.split('/').at(-1) ?? '')) throw new Error('Unsafe staged legacy document path');
      const name = `${entry.document_id.replace(/[^A-Za-z0-9_-]/g,'_')}-${entry.sha256}`;
      const bytes = normalFile(join(offline, ...entry.path.split('/')));
      if (sha(bytes) !== entry.sha256) throw new Error('Legacy attachment hash changed');
      writeFileSync(join(candidate, 'documents', name), bytes, { flag: 'wx' });
      doc.filename = name; doc.file_hash = entry.sha256;
      const targetDb = new Database(join(candidate, 'database', 'matching.db'));
      try { targetDb.prepare('UPDATE documents SET filename=?, file_hash=? WHERE document_id=?').run(name, entry.sha256, entry.document_id); }
      finally { targetDb.close(); }
    }
    validateCommunityJsonState(state);
    writeFileSync(join(candidate, 'state', 'state.json'), JSON.stringify(state));
    const backup = await createCommunityBackup(candidate, async run => run());
    const staged = await stageCommunityRestore(root, normalFile(backup.path), withExclusiveAccess);
    return { ...staged, source_fingerprint: fingerprint, source_preview: preview, mapping: mapped, requires_reconnection: ['banking','oauth','payment_provider','invoice_bot'] };
  } finally {
    if (existsSync(offline)) rmSync(offline, { recursive: true, force: true });
    if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
  }
}
