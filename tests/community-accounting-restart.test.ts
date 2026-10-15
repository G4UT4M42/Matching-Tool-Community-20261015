import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { acceptAllocations } from '../src/community/accounting/ledger.js';

const originalMode = process.env.MATCHING_RUNTIME_MODE;
const originalRoot = process.env.MATCHING_RUNTIME_ROOT;
let root: string | undefined;
afterEach(() => {
  process.env.MATCHING_RUNTIME_MODE = originalMode;
  process.env.MATCHING_RUNTIME_ROOT = originalRoot;
  vi.resetModules();
  if (root) {
    const target = resolve(root);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('community-accounting-restart-')) throw new Error('Unsafe synthetic cleanup path');
    rmSync(target, { recursive: true, force: true });
  }
  root = undefined;
});

it('restarts a real isolated v2 file and rejects corrupted allocation without modifying bytes', async () => {
  root = mkdtempSync(join(tmpdir(), 'community-accounting-restart-'));
  process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root';
  process.env.MATCHING_RUNTIME_ROOT = root;
  vi.resetModules();
  const store = await import('../src/storage/json-store.js');
  const state = store.createEmptyState('FICTIONAL_RESTART');
  state.transactions.set('T', { transaction_id: 'T', source_system: 'sparkasse', source_account_id: 'FICTIONAL', source_row_ref: 'T',
    posting_at: '2026-01-01T00:00:00Z', amount_minor: -200, currency_code: 'EUR', description_raw: 'Fictional', tags: [], meta: {} });
  state.documents.set('D', { document_id: 'D', source_system: 'manual', source_document_ref: 'D', captured_at: '2026-01-01T00:00:00Z',
    document_date: '2026-01-01', total_amount_minor: -300, currency_code: 'EUR', meta: {} });
  const allocated = acceptAllocations(state, { revision: 0, evidence_ref: 'FICTIONAL_INVOICE', allocations: [{ kind: 'payment', transaction_id: 'T', document_id: 'D', transaction_amount_minor: -200, document_amount_minor: -200 }] }, 'owner');
  store.saveState(allocated);
  const file = join(root, 'state', 'state.json');
  expect(JSON.parse(readFileSync(file, 'utf8')).schema_version).toBe(2);
  vi.resetModules();
  const restarted = await import('../src/storage/json-store.js');
  expect(restarted.loadState()?.accounting?.allocations[0].document_amount_minor).toBe(-200);
  const corrupt = JSON.parse(readFileSync(file, 'utf8'));
  corrupt.accounting.allocations[0].document_amount_minor = -301;
  const bytes = JSON.stringify(corrupt);
  writeFileSync(file, bytes);
  expect(() => restarted.loadState()).toThrow(/exceed|currency/);
  expect(readFileSync(file, 'utf8')).toBe(bytes);
});
