import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'migrations');
const initialMode = process.env.MATCHING_RUNTIME_MODE;
const initialRoot = process.env.MATCHING_RUNTIME_ROOT;
let root: string | undefined;
type StoreModule = typeof import('../src/storage/json-store.js');

async function useIsolatedState(): Promise<StoreModule> {
  root = mkdtempSync(join(tmpdir(), 'matching-community-state-test-'));
  process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root';
  process.env.MATCHING_RUNTIME_ROOT = root;
  vi.resetModules();
  return await import('../src/storage/json-store.js');
}
function storageDir() {
  if (!root) throw new Error('Missing fictional test runtime');
  const path = join(root, 'state');
  mkdirSync(path, { recursive: true });
  return path;
}
afterEach(() => {
  process.env.MATCHING_RUNTIME_MODE = initialMode;
  process.env.MATCHING_RUNTIME_ROOT = initialRoot;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.resetModules();
});

describe('versioned Community JSON snapshots and migration safety', () => {
  it('saves and reloads a synthetic matching proposal without promoting it to accepted', async () => {
    const store = await useIsolatedState();
    const state = store.createEmptyState('COMMUNITY_SYNTHETIC_DEMO_V1');
    const transaction = {
      transaction_id: 'FICT-TXN-1', source_system: 'sparkasse' as const,
      source_account_id: 'NON-ROUTABLE-DEMO', source_row_ref: 'FICTIONAL-EVENT-1',
      posting_at: '2026-01-15T12:00:00Z', amount_minor: -1540, currency_code: 'EUR',
      description_raw: 'Fictional sample', tags: ['synthetic'], meta: {},
    };
    const document = {
      document_id: 'FICT-DOC-1', source_system: 'amazon' as const,
      source_document_ref: 'FICT-RECEIPT-1',
      captured_at: '2026-01-15T12:00:00Z',
      document_date: '2026-01-14', total_amount_minor: -1540,
      currency_code: 'EUR', meta: { TEST_SYNTHETIC: true },
    };
    const match = {
      match_group_id: 'FICT-MATCH-1', status: 'proposed' as const,
      created_at: '2026-01-16T12:00:00Z', created_by: 'fictional-demo',
      rule_id: 'TEST-SYNTHETIC', transaction_ids: [transaction.transaction_id],
      document_ids: [document.document_id], amount_total_minor: -1540,
      currency_code: 'EUR', reason_codes: ['TEST'],
    };
    state.transactions.set(transaction.transaction_id, transaction);
    state.documents.set(document.document_id, document);
    state.match_groups.set(match.match_group_id, match);
    state.matched_transaction_ids.add(transaction.transaction_id);
    state.matched_document_ids.add(document.document_id);
    store.saveState(state);
    const source = JSON.parse(readFileSync(join(storageDir(), 'state.json'), 'utf8'));
    expect(source.schema_version).toBe(store.COMMUNITY_JSON_STATE_VERSION);
    expect(source.format).toBe(store.COMMUNITY_JSON_STATE_FORMAT);
    const reopened = store.loadState();
    expect(reopened?.transactions.get('FICT-TXN-1')?.amount_minor).toBe(-1540);
    expect(reopened?.match_groups.get('FICT-MATCH-1')?.status).toBe('proposed');
    expect(reopened?.matched_transaction_ids.has('FICT-TXN-1')).toBe(true);
  });

  it('never auto-upgrades or mutates a legacy unversioned JSON snapshot', async () => {
    const store = await useIsolatedState();
    const source = readFileSync(join(fixtureDir, 'community-state-v0.json'));
    const path = join(storageDir(), 'state.json');
    writeFileSync(path, source);
    expect(() => store.loadState()).toThrow(/offline migration required/i);
    expect(readFileSync(path)).toEqual(source);
  });

  it('rejects an unsupported future state version without overwriting it', async () => {
    const store = await useIsolatedState();
    const source = JSON.parse(readFileSync(join(fixtureDir, 'community-state-v1.json'), 'utf8'));
    source.schema_version = 999;
    const path = join(storageDir(), 'state.json');
    const bytes = JSON.stringify(source);
    writeFileSync(path, bytes);
    expect(() => store.loadState()).toThrow(/offline migration required/i);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('rejects orphaned match references, unknown approval statuses and non-integer amounts', async () => {
    const store = await useIsolatedState();
    const valid = JSON.parse(readFileSync(join(fixtureDir, 'community-state-v1.json'), 'utf8'));
    valid.match_groups['FICT-MATCH-X'] = {
      match_group_id: 'FICT-MATCH-X', transaction_ids: ['MISSING-TXN'], document_ids: [],
      amount_total_minor: 100, status: 'proposed',
    };
    expect(() => store.validateCommunityJsonState(valid)).toThrow(/relationship/i);
    valid.match_groups['FICT-MATCH-X'].transaction_ids = [];
    valid.match_groups['FICT-MATCH-X'].status = 'release-payment';
    expect(() => store.validateCommunityJsonState(valid)).toThrow(/approval/i);
    valid.match_groups['FICT-MATCH-X'].status = 'proposed';
    valid.match_groups['FICT-MATCH-X'].amount_total_minor = 0.4;
    expect(() => store.validateCommunityJsonState(valid)).toThrow(/financial/i);
  });

  it('keeps a valid snapshot intact if an atomic replacement is interrupted', async () => {
    const store = await useIsolatedState();
    const path = join(storageDir(), 'state.json');
    const original = readFileSync(join(fixtureDir, 'community-state-v1.json'), 'utf8');
    writeFileSync(path, original);
    expect(() => store.writeStateFileAtomically(path, 'bad', {
      beforeRename: () => { throw new Error('SYNTHETIC_FAULT_INJECTION'); },
    })).toThrow(/SYNTHETIC_FAULT_INJECTION/);
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readdirSync(storageDir()).filter(name => name.endsWith('.tmp'))).toHaveLength(0);
    expect(existsSync(path)).toBe(true);
  });
});
