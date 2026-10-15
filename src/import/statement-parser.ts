import { createHash } from 'node:crypto';
import { inflateRawSync, crc32 } from 'node:zlib';
import { lstatSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';
import type { Transaction } from '../core/types.js';

export const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_COLUMNS = 64;
export class StatementError extends Error {
  constructor(public readonly code: string, message: string, public readonly row?: number) {
    super(message + (row === undefined ? '' : ` (row ${row})`));
    this.name = 'StatementError';
  }
}
export interface StatementOptions { accountId?: string }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const headerKey = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const blank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && !value.trim());
const supportedCurrencies = new Set(Intl.supportedValuesOf('currency'));

export function currencyPrecision(currency: string): number {
  if (!supportedCurrencies.has(currency)) throw new StatementError('INVALID_CURRENCY', 'Unsupported currency code');
  const precision = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  if (precision === undefined || !Number.isInteger(precision) || precision < 0 || precision > 4) throw new StatementError('INVALID_CURRENCY_PRECISION', 'Currency precision is unavailable');
  return precision;
}

/** Parse decimal text using integers; never round a malformed or over-precise amount. */
export function statementMinor(value: unknown, currency: string, row?: number): number {
  const precision = currencyPrecision(currency);
  if (typeof value !== 'string' && typeof value !== 'number') throw new StatementError('INVALID_AMOUNT', 'A decimal amount is required', row);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new StatementError('INVALID_AMOUNT', 'The amount must be finite', row);
  let text = String(value).trim();
  if (text.length > 80) throw new StatementError('INVALID_AMOUNT', 'The amount exceeds the supported range', row);
  if (text.includes(',')) {
    if (!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+),\d+$/.test(text)) throw new StatementError('INVALID_AMOUNT', 'Invalid decimal-comma amount', row);
    text = text.replace(/\./g, '').replace(',', '.');
  }
  // Plain numeric XLSX cells and unambiguous decimal-point CSV cells are supported.
  // A lone thousands separator without a decimal comma is not guessed.
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new StatementError('INVALID_AMOUNT', 'Invalid decimal amount', row);
  const fraction = match[3] ?? '';
  if (fraction.length > precision) throw new StatementError('AMOUNT_PRECISION', 'Amount has excess or ambiguous decimal precision', row);
  const absolute = BigInt(match[2]) * (10n ** BigInt(precision)) + BigInt((fraction.slice(0, precision).padEnd(precision, '0')) || '0');
  const result = match[1] === '-' ? -absolute : absolute;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new StatementError('AMOUNT_OVERFLOW', 'Amount exceeds the exact integer range', row);
  return Number(result);
}

/** A statement booking date is a calendar date, not an inferred local timestamp. */
export function statementDate(value: unknown, row?: number): string {
  let year: number, month: number, day: number;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    year = value.getUTCFullYear(); month = value.getUTCMonth() + 1; day = value.getUTCDate();
  } else if (typeof value === 'number' && Number.isFinite(value) && value >= 61 && value <= 2958465) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
    year = date.getUTCFullYear(); month = date.getUTCMonth() + 1; day = date.getUTCDate();
  } else if (typeof value === 'string') {
    const text = value.trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    const european = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(text);
    if (iso) { year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]); }
    else if (european) { day = Number(european[1]); month = Number(european[2]); year = Number(european[3]); }
    else throw new StatementError('INVALID_DATE', 'Use an unambiguous calendar date with a four-digit year', row);
  } else throw new StatementError('INVALID_DATE', 'A booking date is required', row);
  const checked = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 9999 || checked.getUTCFullYear() !== year || checked.getUTCMonth() + 1 !== month || checked.getUTCDate() !== day) throw new StatementError('INVALID_DATE', 'Invalid calendar date', row);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Bound ZIP metadata before the XLSX library inflates untrusted workbook content. */
export function validateWorkbookContainer(buffer: Buffer): void {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw new StatementError('INVALID_WORKBOOK', 'A regular unencrypted XLSX workbook is required');
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { end = offset; break; }
  }
  if (end < 0) throw new StatementError('INVALID_WORKBOOK', 'The workbook archive is incomplete');
  const count = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || count !== buffer.readUInt16LE(end + 8) || count < 1 || count > 4096 || start + size !== end) throw new StatementError('WORKBOOK_LIMIT', 'Unsupported workbook archive structure');
  let position = start, inflated = 0;
  const names = new Set<string>();
  const regions: Array<[number, number]> = [];
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || buffer.readUInt32LE(position) !== 0x02014b50) throw new StatementError('INVALID_WORKBOOK', 'Invalid workbook directory');
    const flags = buffer.readUInt16LE(position + 8), method = buffer.readUInt16LE(position + 10);
    const compressed = buffer.readUInt32LE(position + 20), uncompressed = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28), extraLength = buffer.readUInt16LE(position + 30), commentLength = buffer.readUInt16LE(position + 32);
    const local = buffer.readUInt32LE(position + 42), next = position + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || ![0, 8].includes(method) || local + 30 > start || buffer.readUInt32LE(local) !== 0x04034b50) throw new StatementError('INVALID_WORKBOOK', 'Encrypted or malformed workbook entry');
    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(local + 26), localExtraLength = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (dataStart + compressed > start || buffer.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name || buffer.readUInt16LE(local + 8) !== method) throw new StatementError('INVALID_WORKBOOK', 'Inconsistent workbook entry');
    if (names.has(name) || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || /[\u0000-\u001f]/.test(name)) throw new StatementError('INVALID_WORKBOOK', 'Unsafe workbook member name');
    if (/vbaProject|externalLinks|embeddings|macrosheets|activeX/i.test(name)) throw new StatementError('ACTIVE_WORKBOOK', 'Active or externally linked workbooks are not accepted');
    inflated += uncompressed;
    if (inflated > 64 * 1024 * 1024 || uncompressed > 32 * 1024 * 1024 || uncompressed === 0xffffffff || compressed === 0xffffffff) throw new StatementError('WORKBOOK_LIMIT', 'Workbook exceeds decompression limits');
    if (buffer.readUInt16LE(local + 6) !== flags || regions.some(([begin, finish]) => local < finish && dataStart + compressed > begin)) throw new StatementError('INVALID_WORKBOOK', 'Overlapping or inconsistent workbook entries');
    regions.push([local, dataStart + compressed]);
    const compressedBytes = buffer.subarray(dataStart, dataStart + compressed);
    let expanded: Buffer;
    try { expanded = method === 0 ? compressedBytes : inflateRawSync(compressedBytes, { maxOutputLength: Math.max(1, uncompressed) }); }
    catch { throw new StatementError('INVALID_WORKBOOK', 'Workbook decompression exceeds its declared bounds'); }
    if (expanded.length !== uncompressed || crc32(expanded) !== buffer.readUInt32LE(position + 16)) throw new StatementError('INVALID_WORKBOOK', 'Workbook size or checksum verification failed');
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      const xml = expanded.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']/i.test(xml)) throw new StatementError('ACTIVE_WORKBOOK', 'External workbook relationships are not accepted');
    }
    names.add(name); position = next;
  }
  if (position !== end || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) throw new StatementError('INVALID_WORKBOOK', 'Missing XLSX workbook members');
}

function readRows(buffer: Buffer, extension: string): unknown[][] {
  if (extension === '.csv') {
    let text: string;
    try {
      if (buffer[0] === 0xfe && buffer[1] === 0xff) {
        if (buffer.length % 2) throw new Error('Odd UTF16 length');
        const swapped = Buffer.from(buffer); swapped.swap16();
        text = new TextDecoder('utf-16le', { fatal: true }).decode(swapped);
      } else text = new TextDecoder(buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le' : 'utf-8', { fatal: true }).decode(buffer);
      const first = text.split(/\r?\n/, 1)[0];
      const delimiter = first.includes('\t') ? '\t' : first.includes(';') ? ';' : ',';
      return parse(text, { bom: true, delimiter, skip_empty_lines: true, max_record_size: 256 * 1024, relax_column_count: false }) as unknown[][];
    } catch { throw new StatementError('INVALID_CSV', 'CSV encoding, quoting or column count is invalid'); }
  }
  if (extension !== '.xlsx') throw new StatementError('UNSUPPORTED_FORMAT', 'Use a CSV or XLSX statement');
  validateWorkbookContainer(buffer);
  let workbook: XLSX.WorkBook;
  try { workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: true, cellHTML: false, bookVBA: true, WTF: true }); }
  catch { throw new StatementError('INVALID_WORKBOOK', 'The XLSX workbook could not be parsed'); }
  if (workbook.vbaraw || workbook.SheetNames.length > 16) throw new StatementError('WORKBOOK_LIMIT', 'Unsupported active or oversized workbook');
  for (const sheet of Object.values(workbook.Sheets)) {
    const reference = sheet['!ref'];
    if (reference) {
      const range = XLSX.utils.decode_range(reference);
      if (range.e.r >= MAX_ROWS + 1 || range.e.c >= MAX_COLUMNS) throw new StatementError('WORKBOOK_LIMIT', 'Workbook exceeds row or column limits');
    }
    for (const [address, cell] of Object.entries(sheet)) {
      if (!address.startsWith('!') && cell?.f !== undefined) throw new StatementError('ACTIVE_WORKBOOK', 'Formula-bearing statements are not accepted');
    }
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new StatementError('EMPTY_STATEMENT', 'The statement has no worksheet');
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true, blankrows: false }) as unknown[][];
}

export function parseStatement(filePath: string, source: 'sparkasse' | 'visa', options: StatementOptions = {}): Transaction[] {
  if (source !== 'sparkasse' && source !== 'visa') throw new StatementError('INVALID_SOURCE', 'Unknown statement source');
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_STATEMENT_BYTES || metadata.size === 0) throw new StatementError('STATEMENT_LIMIT', 'A regular statement file of at most 10 MiB is required');
  return parseStatementBuffer(readFileSync(filePath), extname(filePath).toLowerCase(), source, options);
}

export function parseStatementBuffer(buffer: Buffer, extension: string, source: 'sparkasse' | 'visa', options: StatementOptions = {}): Transaction[] {
  if (source !== 'sparkasse' && source !== 'visa') throw new StatementError('INVALID_SOURCE', 'Unknown statement source');
  if (!buffer.length || buffer.length > MAX_STATEMENT_BYTES) throw new StatementError('STATEMENT_LIMIT', 'Statement size limit exceeded');
  const rows = readRows(buffer, extension);
  if (rows.length < 2 || rows.length > MAX_ROWS + 1) throw new StatementError('STATEMENT_LIMIT', 'Statement must contain 1 to 20000 data rows');
  const headers = rows[0].map(value => typeof value === 'string' ? value.trim() : '');
  if (headers.length > MAX_COLUMNS || headers.some(value => !value || value.length > 200) || new Set(headers.map(headerKey)).size !== headers.length) throw new StatementError('INVALID_HEADERS', 'Statement headers must be unique and nonempty');
  const digest = hash(buffer);
  const pick = (values: unknown[], names: string[]) => {
    const keys = new Set(names.map(headerKey));
    const indexes = headers.map((header, index) => keys.has(headerKey(header)) ? index : -1).filter(index => index >= 0);
    const available = indexes.filter(index => !blank(values[index]));
    if (available.length > 1) throw new StatementError('AMBIGUOUS_COLUMNS', 'Multiple columns supply the same statement field');
    return values[available[0]];
  };
  const text = (value: unknown, row: number, max = 8000): string => {
    if (blank(value)) return '';
    if (typeof value !== 'string' && typeof value !== 'number') throw new StatementError('INVALID_TEXT', 'Invalid statement text field', row);
    const result = String(value).trim();
    if (result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) throw new StatementError('INVALID_TEXT', 'Statement text exceeds its limits', row);
    return result;
  };
  return rows.slice(1).map((values, index) => {
    const row = index + 2;
    if (values.length > headers.length || values.some(value => typeof value === 'string' && /^\s*[=@]/.test(value))) throw new StatementError('INVALID_ROW', 'Invalid or formula-bearing statement row', row);
    const currency = text(pick(values, ['Währung', 'Waehrung', 'Currency']) ?? 'EUR', row, 3).toUpperCase();
    const precision = currencyPrecision(currency);
    const credit = pick(values, ['Eingehender Betrag', 'Haben', 'Credit']);
    const debit = pick(values, ['Ausgehender Betrag', 'Soll', 'Debit']);
    const signed = pick(values, ['Betrag', 'Umsatz', 'Amount']);
    let amount: number;
    if (!blank(credit) || !blank(debit)) {
      const incoming = blank(credit) ? 0 : statementMinor(credit, currency, row);
      const outgoing = blank(debit) ? 0 : statementMinor(debit, currency, row);
      if (incoming < 0 || (incoming !== 0 && outgoing !== 0)) throw new StatementError('AMBIGUOUS_AMOUNT', 'Conflicting debit and credit columns', row);
      amount = incoming !== 0 ? incoming : -Math.abs(outgoing);
      if (!blank(signed) && statementMinor(signed, currency, row) !== amount) throw new StatementError('AMBIGUOUS_AMOUNT', 'Signed amount disagrees with debit or credit', row);
    } else amount = statementMinor(signed, currency, row);
    // Booking, value and card transaction dates describe different events.
    // Keep ambiguity checks within one semantic field, not across these fields.
    const optionalDate = (names: string[]) => {
      const value = pick(values, names);
      return blank(value) ? undefined : statementDate(value, row);
    };
    const bookingDate = optionalDate(['Buchungsdatum', 'Buchungstag']);
    const valueDate = optionalDate(['Valutadatum', 'Wertstellungsdatum']);
    const transactionDate = optionalDate(['Transaktionsdatum']);
    const genericDate = optionalDate(['Datum', 'Date']);
    const date = (source === 'visa'
      ? bookingDate ?? transactionDate ?? genericDate ?? valueDate
      : bookingDate ?? genericDate ?? valueDate ?? transactionDate) ?? statementDate(undefined, row);
    const rowAccount = text(pick(values, ['Konto', 'Kontonummer', 'Account', 'Account ID']), row, 200);
    if (options.accountId !== undefined && (typeof options.accountId !== 'string' || !options.accountId.trim() || options.accountId.length > 200 || /[\u0000-\u001f]/.test(options.accountId))) throw new StatementError('INVALID_ACCOUNT', 'A valid local account identifier is required');
    if (rowAccount && options.accountId && rowAccount !== options.accountId.trim()) throw new StatementError('ACCOUNT_CONFLICT', 'Statement account differs from the selected account', row);
    const account = rowAccount || options.accountId?.trim() || (source === 'visa' ? 'business_gold' : 'main');
    const reference = text(pick(values, ['Buchungsreferenz', 'Referenz', 'Kundenreferenz', 'Transaction ID']), row, 200);
    const payment = text(pick(values, ['Zahlungsreferenz', 'Primanota']), row);
    const details = text(pick(values, ['Buchungs-Details', 'Verwendungszweck', 'Buchungstext', 'Vorgang/Verwendungszweck', 'Beschreibung', 'Transaktionsbeschreibung', 'Description']), row);
    const description = [payment, details].filter(Boolean).join(' | ');
    const counterparty = text(pick(values, ['Partnername', 'Auftraggeber/Empfänger', 'Beguenstigter/Zahlungspflichtiger', 'Name', 'Empfänger', 'Begünstigter']), row);
    const iban = text(pick(values, ['Partner IBAN', 'IBAN', 'Kontonummer/IBAN']), row, 100);
    const rowReference = reference || `FILE:${digest}:${index + 1}`;
    const fingerprint = hash(JSON.stringify([source, account, date, amount, currency, description, counterparty, iban]));
    return {
      transaction_id: 'TXN-' + hash(JSON.stringify([source, account, rowReference])).slice(0, 32),
      source_system: source, source_account_id: account, source_row_ref: rowReference,
      posting_at: date, ...(valueDate ? { value_at: valueDate } : {}), amount_minor: amount, currency_code: currency, description_raw: description,
      counterparty_name: counterparty || undefined, counterparty_iban: iban || undefined,
      booking_reference: reference || undefined, payment_reference: payment || undefined, tags: [],
      meta: { statement_sha256: digest, statement_row: index + 1, statement_fingerprint: fingerprint, source_reference_present: Boolean(reference), currency_precision: precision,
        ...(transactionDate ? { statement_transaction_at: transactionDate } : {}) },
    };
  });
}
