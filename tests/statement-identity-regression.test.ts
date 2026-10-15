import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Independently generated fictional statements. Never open an existing runtime.
const runtime = mkdtempSync(join(tmpdir(), 'matching-statement-identity-synthetic-'));
let storage: typeof import('../src/storage/db.js');
let imports: typeof import('../src/import/file-import.js');
const oldRoot = process.env.MATCHING_RUNTIME_ROOT;
const oldMode = process.env.MATCHING_RUNTIME_MODE;
beforeAll(async () => {
  process.env.MATCHING_RUNTIME_ROOT = runtime;
  process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root';
  storage = await import('../src/storage/db.js');
  imports = await import('../src/import/file-import.js');
  storage.getDb();
});
afterEach(() => {
  storage.getDb().exec('DELETE FROM transaction_dispositions; DELETE FROM transactions;');
});
afterAll(() => {
  storage?.closeDb();
  if (oldRoot === undefined) delete process.env.MATCHING_RUNTIME_ROOT;
  else process.env.MATCHING_RUNTIME_ROOT = oldRoot;
  if (oldMode === undefined) delete process.env.MATCHING_RUNTIME_MODE;
  else process.env.MATCHING_RUNTIME_MODE = oldMode;
  rmSync(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function statement(rows: string[], amountHeader = 'Betrag'): string {
  const filename = join(runtime, 'fictional-statement.csv');
  writeFileSync(filename, ['Buchungsdatum;Partnername;' + amountHeader + ';Waehrung;Buchungsreferenz;Verwendungszweck', ...rows].join('\n'));
  return filename;
}
function importedRows(): Array<{ amount_minor: number; currency_code: string; source_row_ref: string }> {
  return storage.getDb().prepare('SELECT amount_minor, currency_code, source_row_ref FROM transactions ORDER BY source_row_ref').all() as Array<{ amount_minor: number; currency_code: string; source_row_ref: string }>;
}
describe('P06 statement identity and financial validation regression', () => {
  it('preserves two distinct source references with identical amount, description and date', () => {
    const file = statement([
      '13.01.2026;Fictional Supplier;-10,00;EUR;SYN-A;Fictional purchase',
      '13.01.2026;Fictional Supplier;-10,00;EUR;SYN-B;Fictional purchase',
    ]);
    expect(imports.importFile(file, 'sparkasse', 'fictional.csv').imported).toBe(2);
    expect(importedRows().map(t => t.source_row_ref)).toEqual(['SYN-A', 'SYN-B']);
    expect(importedRows().reduce((sum, t) => sum + t.amount_minor, 0)).toBe(-2000);
  });
  it('replaying an identical statement is idempotent', () => {
    const file = statement(['13.01.2026;Fictional Supplier;-12,34;EUR;SYN-C;Fictional purchase']);
    expect(imports.importFile(file, 'sparkasse', 'fictional.csv').imported).toBe(1);
    expect(imports.importFile(file, 'sparkasse', 'fictional.csv').imported).toBe(0);
    expect(importedRows()).toHaveLength(1);
  });
  it('preserves the declared currency rather than relabeling it EUR', () => {
    const file = statement(['13.01.2026;Fictional Supplier;-12,34;USD;SYN-D;Fictional purchase']);
    imports.importFile(file, 'sparkasse', 'fictional.csv');
    expect(importedRows()[0]).toMatchObject({ amount_minor: -1234, currency_code: 'USD' });
  });
  it('interprets a positive debit column as an outgoing amount', () => {
    const file = statement(['13.01.2026;Fictional Supplier;12,34;EUR;SYN-E;Fictional purchase'], 'Soll');
    imports.importFile(file, 'sparkasse', 'fictional.csv');
    expect(importedRows()[0].amount_minor).toBe(-1234);
  });
  it('rejects malformed financial amounts without writing a zero-valued event', () => {
    const file = statement(['13.01.2026;Fictional Supplier;invalid;EUR;SYN-F;Fictional purchase']);
    expect(() => imports.importFile(file, 'sparkasse', 'fictional.csv')).toThrow();
    expect(importedRows()).toHaveLength(0);
  });
  it('rejects invalid calendar dates rather than rolling them into another month', () => {
    const file = statement(['30.02.2026;Fictional Supplier;-12,34;EUR;SYN-G;Fictional purchase']);
    expect(() => imports.importFile(file, 'sparkasse', 'fictional.csv')).toThrow();
    expect(importedRows()).toHaveLength(0);
  });
  it('keeps reference-less rows distinct inside one statement', () => {
    const file = statement([
      '13.01.2026;Fictional Supplier;-10,00;EUR;;Fictional purchase A',
      '13.01.2026;Fictional Supplier;-10,00;EUR;;Fictional purchase B',
    ]);
    expect(imports.importFile(file, 'sparkasse', 'fictional.csv').imported).toBe(2);
    expect(importedRows()).toHaveLength(2);
  });
});
