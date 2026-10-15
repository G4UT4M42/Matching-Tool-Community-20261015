import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';
import { MAX_STATEMENT_BYTES, parseStatementBuffer, statementDate, statementMinor } from '../src/import/statement-parser.js';

const runtime = mkdtempSync(join(tmpdir(), 'matching-statement-safety-synthetic-'));
const oldRoot = process.env.MATCHING_RUNTIME_ROOT, oldMode = process.env.MATCHING_RUNTIME_MODE;
let storage: typeof import('../src/storage/db.js');
let importer: typeof import('../src/import/file-import.js');
beforeAll(async () => {
  process.env.MATCHING_RUNTIME_ROOT = runtime; process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root';
  storage = await import('../src/storage/db.js'); importer = await import('../src/import/file-import.js');
  storage.getDb();
});
afterEach(() => storage.getDb().exec('DELETE FROM transaction_dispositions; DELETE FROM transactions;'));
afterAll(() => {
  storage?.closeDb();
  if (oldRoot === undefined) delete process.env.MATCHING_RUNTIME_ROOT; else process.env.MATCHING_RUNTIME_ROOT = oldRoot;
  if (oldMode === undefined) delete process.env.MATCHING_RUNTIME_MODE; else process.env.MATCHING_RUNTIME_MODE = oldMode;
  rmSync(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const header = 'Buchungsdatum;Partnername;Betrag;Waehrung;Buchungsreferenz;Verwendungszweck';
const row = (reference = 'SYN-001', amount = '-12,34', currency = 'EUR') => `13.01.2026;Fictional Supplier;${amount};${currency};${reference};Fictional purchase`;
function csv(rows: string[], filename = 'fictional.csv') {
  const path = join(runtime, filename); writeFileSync(path, [header, ...rows].join('\n')); return path;
}
const count = () => (storage.getDb().prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n;
function workbook(values: unknown[][]) {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(values), 'Fictional');
  return { book, buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer };
}

describe('P06 exact values and untrusted statement boundaries', () => {
  it('parses German grouped and decimal-point amounts exactly', () => {
    expect(statementMinor('-1.234,56', 'EUR')).toBe(-123456);
    expect(statementMinor('0.29', 'EUR')).toBe(29);
    expect(statementMinor(12.34, 'EUR')).toBe(1234);
  });
  it('uses zero- and three-decimal currency precision without cent relabeling', () => {
    expect(statementMinor('1200', 'JPY')).toBe(1200);
    expect(statementMinor('-1,234', 'BHD')).toBe(-1234);
    expect(() => statementMinor('12.34', 'JPY')).toThrow();
  });
  it.each(['invalid', 'Infinity', '1e3', '12 EUR', '', '1,2,3', '1.23,45', '12.345', '1.000'])('rejects malformed or ambiguous amount %j', value => {
    expect(() => statementMinor(value, 'EUR')).toThrow();
  });
  it('refuses unsafe exact totals and invalid currencies', () => {
    expect(() => statementMinor('9007199254740992', 'EUR')).toThrow(/range/);
    expect(() => statementMinor('12', 'ZZZ')).toThrow(/currency/);
  });
  it('validates leap years and does not reinterpret missing or ambiguous dates', () => {
    expect(statementDate('29.02.2024')).toBe('2024-02-29');
    for (const value of ['29.02.2026', '31.04.2026', '2026-02-30', '01.02.26', '', null]) expect(() => statementDate(value)).toThrow();
  });
  it('rejects contradictory debit and credit values', () => {
    const value = 'Datum;Soll;Haben;Waehrung\n13.01.2026;10,00;10,00;EUR';
    expect(() => parseStatementBuffer(Buffer.from(value), '.csv', 'sparkasse')).toThrow(/Conflicting/);
  });
  it('preserves two accounts using the same source reference', () => {
    const path = csv([row()]);
    expect(importer.importFile(path, 'sparkasse', 'fictional.csv', { accountId: 'SYNTHETIC-A' }).imported).toBe(1);
    expect(importer.importFile(path, 'sparkasse', 'fictional.csv', { accountId: 'SYNTHETIC-B' }).imported).toBe(1);
    expect(count()).toBe(2);
  });
  it('rejects a selected account that conflicts with statement metadata', () => {
    const value = header + ';Account\n' + row() + ';SYNTHETIC-A';
    expect(() => parseStatementBuffer(Buffer.from(value), '.csv', 'sparkasse', { accountId: 'SYNTHETIC-B' })).toThrow(/account/);
  });
  it('preserves and replays identical reference-less rows within one statement', () => {
    const path = csv([row(''), row('')]);
    expect(importer.importFile(path, 'sparkasse', 'fictional.csv').imported).toBe(2);
    expect(importer.importFile(path, 'sparkasse', 'fictional.csv').skipped).toBe(2);
    expect(count()).toBe(2);
  });
  it('requires reconciliation for reference-less overlap across different files', () => {
    importer.importFile(csv([row('')]), 'sparkasse', 'fictional.csv');
    const second = csv([row('SYN-OTHER', '-7,00'), row('')], 'fictional-other.csv');
    expect(() => importer.importFile(second, 'sparkasse', 'fictional-other.csv')).toThrow(/overlaps/);
    expect(count()).toBe(1);
  });
  it('rolls back the entire import if a later source reference conflicts', () => {
    importer.importFile(csv([row('SYN-001')]), 'sparkasse', 'fictional.csv');
    const conflicting = csv([row('SYN-NEW'), row('SYN-001', '-99,00')]);
    expect(() => importer.importFile(conflicting, 'sparkasse', 'fictional.csv')).toThrow(/conflicting financial/);
    expect(count()).toBe(1);
  });
  it('validates every row before writing any transaction', () => {
    const path = csv([row('SYN-VALID'), row('SYN-INVALID', 'bad')]);
    expect(() => importer.importFile(path, 'sparkasse', 'fictional.csv')).toThrow(); expect(count()).toBe(0);
  });
  it('preserves leading zero references in CSV and XLSX', () => {
    const content = Buffer.from([header, row('000001')].join('\n'));
    expect(parseStatementBuffer(content, '.csv', 'visa')[0].source_row_ref).toBe('000001');
    const { buffer } = workbook([header.split(';'), [new Date('2026-01-13T00:00:00Z'), 'Fictional', -12.34, 'USD', '000002', 'Fictional item']]);
    expect(parseStatementBuffer(buffer, '.xlsx', 'visa')[0]).toMatchObject({ source_row_ref: '000002', amount_minor: -1234, currency_code: 'USD', posting_at: '2026-01-13' });
  });
  it('handles UTF-16 little- and big-endian statements with BOM', () => {
    const little = Buffer.from('\ufeff' + [header, row('SYN-UTF16')].join('\n'), 'utf16le');
    expect(parseStatementBuffer(little, '.csv', 'sparkasse')[0].amount_minor).toBe(-1234);
    expect(parseStatementBuffer(Buffer.from(little).swap16(), '.csv', 'sparkasse')[0].source_row_ref).toBe('SYN-UTF16');
  });
  it('rejects duplicate headers, malformed CSV and unsupported file types', () => {
    for (const value of ['Datum;datum;Betrag\n13.01.2026;13.01.2026;1', header + '\n' + row() + ';extra', header + '\n"unterminated']) {
      expect(() => parseStatementBuffer(Buffer.from(value), '.csv', 'sparkasse')).toThrow();
    }
    expect(() => parseStatementBuffer(Buffer.from('not a workbook'), '.xlsm', 'sparkasse')).toThrow();
    expect(() => parseStatementBuffer(Buffer.from('not a workbook'), '.xlsx', 'sparkasse')).toThrow();
  });
  it('rejects formula-bearing XLSX and formula-like CSV cells', () => {
    const { book } = workbook([header.split(';'), ['13.01.2026', 'Fictional', -12, 'EUR', 'SYN-FORMULA', 'Fictional item']]);
    book.Sheets.Fictional.C2.f = '-6*2';
    expect(() => parseStatementBuffer(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), '.xlsx', 'sparkasse')).toThrow(/Formula/);
    expect(() => parseStatementBuffer(Buffer.from([header, row('SYN-CSV') + '=x'].join('\n')), '.csv', 'sparkasse')).not.toThrow();
    expect(() => parseStatementBuffer(Buffer.from([header, row('SYN-CSV').replace('Fictional purchase', '=HYPERLINK("example")')].join('\n')), '.csv', 'sparkasse')).toThrow();
  });
  it('rejects oversized files before parsing or writing', () => {
    expect(() => parseStatementBuffer(Buffer.alloc(MAX_STATEMENT_BYTES + 1), '.csv', 'sparkasse')).toThrow(/size/);
    expect(count()).toBe(0);
  });
  it('rejects excessive declared XLSX decompression before inflating entries', () => {
    const { buffer } = workbook([header.split(';'), row().split(';')]);
    const directory = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(directory).toBeGreaterThan(0); buffer.writeUInt32LE(100 * 1024 * 1024, directory + 24);
    expect(() => parseStatementBuffer(buffer, '.xlsx', 'sparkasse')).toThrow(/decompression/);
  });
});
