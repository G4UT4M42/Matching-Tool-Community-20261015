import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createCommunityBackup, inspectBackupBytes } from '../src/community/persistence/backup.js';
import { decodeZip, encodeZip } from '../src/community/persistence/zip.js';
import { activateCommunityRestore, stageCommunityRestore } from '../src/community/persistence/restore.js';
import type Database from 'better-sqlite3';

let root: string;
let close: (() => void) | undefined;
const exclusive = async <T>(run: () => Promise<T>) => run();
function state(documentName = 'synthetic.txt') {
  const attachment = Buffer.from('SYNTHETIC INVOICE');
  return {
    schema_version: 1, format: 'matching-community-state-v1', run_id: 'SYNTHETIC',
    transactions: { 'TX-1': { transaction_id: 'TX-1', source_system: 'sparkasse', source_account_id: 'A-1', source_row_ref: 'R-1', posting_at: '2026-01-01', amount_minor: -1250, currency_code: 'EUR', description_raw: 'Synthetic', tags: [], meta: {} } },
    documents: { 'DOC-1': { document_id: 'DOC-1', source_system: 'upload', source_document_ref: 'D-1', captured_at: '2026-01-01', document_date: '2026-01-01', total_amount_minor: 1250, currency_code: 'EUR', file_hash: createHash('sha256').update(attachment).digest('hex'), filename: documentName, meta: {} } },
    match_groups: { 'M-1': { match_group_id: 'M-1', status: 'accepted', created_at: '2026-01-01', created_by: 'owner', rule_id: 'MANUAL', transaction_ids: ['TX-1'], document_ids: ['DOC-1'], amount_total_minor: -1250, currency_code: 'EUR', reason_codes: [] } },
    exclusion_rules: [], audit_events: [], matched_transaction_ids: ['TX-1'], matched_document_ids: ['DOC-1'], excluded_transaction_ids: [],
  };
}
async function setup() {
  root = mkdtempSync(join(tmpdir(), 'community-persistence-'));
  process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root'; process.env.MATCHING_RUNTIME_ROOT = root;
  vi.resetModules();
  const store = await import('../src/storage/db.js'); close = store.closeDb;
  const db: Database.Database = store.getDb();
  mkdirSync(join(root, 'state')); mkdirSync(join(root, 'documents'));
  writeFileSync(join(root, 'state', 'state.json'), JSON.stringify(state()));
  writeFileSync(join(root, 'documents', 'synthetic.txt'), 'SYNTHETIC INVOICE');
  db.prepare(`INSERT INTO transactions (transaction_id,source_system,source_account_id,source_row_ref,posting_at,amount_minor,currency_code,description_raw) VALUES ('TX-1','sparkasse','A-1','R-1','2026-01-01',-1250,'EUR','Synthetic')`).run();
  db.prepare(`INSERT INTO documents (document_id,source_system,source_document_ref,captured_at,document_date,total_amount_minor,currency_code,file_hash,filename) VALUES ('DOC-1','upload','D-1','2026-01-01','2026-01-01',1250,'EUR',?, 'synthetic.txt')`).run(state().documents['DOC-1'].file_hash);
  // A valid backup fixture must agree in every SQL/JSON relationship, not
  // only in aggregate transaction totals. Do not weaken the full-row verifier.
  db.prepare("INSERT INTO match_groups(match_group_id,status,created_at,created_by,rule_id,amount_total_minor,currency_code,reason_codes) VALUES('M-1','accepted','2026-01-01','owner','MANUAL',-1250,'EUR','[]')").run();
  db.prepare("INSERT INTO match_group_transactions(match_group_id,transaction_id) VALUES('M-1','TX-1')").run();
  db.prepare("INSERT INTO match_group_documents(match_group_id,document_id) VALUES('M-1','DOC-1')").run();
  return db;
}
afterEach(() => { close?.(); close = undefined; if (root) rmSync(root, { recursive: true, force: true }); delete process.env.MATCHING_RUNTIME_MODE; delete process.env.MATCHING_RUNTIME_ROOT; vi.resetModules(); });
describe('Community backup artifact', () => {
  it('captures committed WAL rows, JSON, referenced document and excludes credential settings', async () => {
    const db = await setup();
    db.prepare("INSERT INTO settings (key,value) VALUES ('password','SYNTHETIC_SECRET')").run();
    const backup = await createCommunityBackup(root, exclusive);
    const zip = readFileSync(backup.path), { manifest, files } = inspectBackupBytes(zip);
    expect(manifest.financial.totals_minor_by_currency).toEqual({ EUR: -1250 });
    expect(manifest.financial.counts).toEqual({ transactions: 1, documents: 1, match_groups: 1, audit_events: 0 });
    expect(files.get('documents/synthetic.txt')?.toString()).toBe('SYNTHETIC INVOICE');
    expect(zip.includes(Buffer.from('SYNTHETIC_SECRET'))).toBe(false);
    expect(existsSync(join(root, 'database', 'matching.db-wal'))).toBe(true);
  });
  it('rejects pending recovery, unsafe paths and corrupt archive bytes', async () => {
    await setup();
    const backup = await createCommunityBackup(root, exclusive);
    const original = readFileSync(backup.path), files = decodeZip(original);
    files.set('state/state.json', Buffer.from('{}'));
    expect(() => inspectBackupBytes(encodeZip(files))).toThrow(/checksum/);
    const orphan = decodeZip(original);
    const changed = JSON.parse(orphan.get('state/state.json')!.toString('utf8'));
    changed.match_groups['M-1'].document_ids = ['MISSING'];
    const changedBytes = Buffer.from(JSON.stringify(changed)); orphan.set('state/state.json', changedBytes);
    const manifest = JSON.parse(orphan.get('manifest.json')!.toString('utf8'));
    manifest.files['state/state.json'] = { bytes: changedBytes.length, sha256: createHash('sha256').update(changedBytes).digest('hex') };
    orphan.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    expect(() => inspectBackupBytes(encodeZip(orphan))).toThrow(/relationship/);
    expect(() => encodeZip(new Map([['../escape', Buffer.from('x')]]))).toThrow(/Unsafe archive path/);
    const unsafe = Buffer.from(original);
    const central = unsafe.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    unsafe.writeUInt32LE(0xa0000000, central + 38); // UNIX symlink external attributes.
    expect(() => decodeZip(unsafe)).toThrow(/unsafe ZIP entry/);
    writeFileSync(join(root, 'state', 'statement-journal-v1.json'), '{}');
    await expect(createCommunityBackup(root, exclusive)).rejects.toThrow(/Pending statement/);
  });
  it('stages, detects stale confirmation and activates only through a closed-runtime callback', async () => {
    await setup();
    const original = readFileSync(join(root, 'state', 'state.json'));
    const backup = await createCommunityBackup(root, exclusive);
    const staged = await stageCommunityRestore(root, readFileSync(backup.path), exclusive);
    writeFileSync(join(root, 'state', 'state.json'), original.toString().replace('SYNTHETIC', 'MODIFIED'));
    await expect(activateCommunityRestore(root, staged.id, staged.fingerprint, exclusive, async () => {})).rejects.toThrow(/stale/);
    writeFileSync(join(root, 'state', 'state.json'), original);
    let changed = false;
    await activateCommunityRestore(root, staged.id, staged.fingerprint, exclusive, async (change, rollback) => {
      close?.();
      try { change(); changed = true; } catch (error) { rollback(); throw error; }
    });
    expect(changed).toBe(true);
    expect(readFileSync(join(root, 'state', 'state.json'))).toEqual(original);
    expect(existsSync(join(root, '.restore-previous-' + staged.id, 'database', 'matching.db'))).toBe(true);
  });
  it('rolls back interrupted activation and retains previous accounting state', async () => {
    await setup();
    const original = readFileSync(join(root, 'state', 'state.json'));
    const backup = await createCommunityBackup(root, exclusive);
    const staged = await stageCommunityRestore(root, readFileSync(backup.path), exclusive);
    await expect(activateCommunityRestore(root, staged.id, staged.fingerprint, exclusive, async (change) => {
      close?.(); change(); throw new Error('synthetic reopen failure');
    })).rejects.toThrow(/synthetic reopen failure/);
    expect(readFileSync(join(root, 'state', 'state.json'))).toEqual(original);
    expect(existsSync(join(root, '.restore-operation-v1.json'))).toBe(false);
  });
});
