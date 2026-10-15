import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';
import { statementDate, statementMinor, validateWorkbookContainer } from '../../import/statement-parser.js';
import { DocumentInputError } from './recognition.js';

export type TableKind = 'income' | 'invoice';
export interface TableRow { source_id: string; invoice_number: string; supplier_name: string; document_date: string; total_amount_minor: number; net_amount_minor?: number; vat_amount_minor?: number; currency_code: string }
const bad = (code: string, message: string): never => { throw new DocumentInputError(code, message); };
const unsafeCell = (value: unknown): boolean => typeof value === 'string' && /^[\s\uFEFF]*[=+@\t\r\n]/.test(value);
export function parseDocumentTable(buffer: Buffer, extension: string, kind: TableKind): TableRow[] {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 5_000_000) bad('FILE_LIMIT', 'Table exceeds 5 MiB');
  if (kind !== 'income' && kind !== 'invoice') bad('INVALID_KIND', 'Select income or invoice');
  let rows: Record<string, unknown>[] = [];
  if (extension === '.csv') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (text.includes('\u0000')) bad('INVALID_CSV', 'CSV contains binary content');
    rows = parse(text.replace(/^\uFEFF/, ''), { columns: (headers: string[]) => {
      if (headers.length > 64 || headers.some(header => !header.trim() || header.length > 200) || new Set(headers.map(header => header.trim().toLowerCase())).size !== headers.length) bad('INVALID_COLUMNS', 'Duplicate or invalid document table headers');
      return headers.map(header => header.trim());
    }, bom: true, skip_empty_lines: true, relax_quotes: false, relax_column_count: false, max_record_size: 10_000, delimiter: text.split(/\r?\n/, 1)[0].includes(';') ? ';' : ',' }) as Record<string, unknown>[];
  } else if (extension === '.xlsx') {
    validateWorkbookContainer(buffer);
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellFormula: true, WTF: true });
    if (workbook.SheetNames.length !== 1) bad('INVALID_WORKBOOK', 'One worksheet is required');
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const area = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
    if (!area) throw new DocumentInputError('ROW_LIMIT', 'The workbook has no document rows');
    if (area.e.r > 10000 || area.e.c > 63) bad('ROW_LIMIT', 'Document table exceeds row or column limits');
    const headerRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, range: { s: {r: area.s.r, c: area.s.c}, e: {r: area.s.r, c: area.e.c} }, raw: true });
    const headers = headerRows[0] ?? [];
    if (headers.some(header => typeof header !== 'string' || !header.trim()) || new Set(headers.map(header => String(header).trim().toLowerCase())).size !== headers.length) bad('INVALID_COLUMNS', 'Duplicate or invalid document table headers');
    if (Object.values(sheet).some(cell => cell && typeof cell === 'object' && ('f' in cell || 'F' in cell))) bad('FORMULA_FORBIDDEN', 'Workbook formulas are unsupported');
    rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true, defval: '' });
  } else bad('UNSUPPORTED_CONTENT', 'Only CSV and XLSX tables are supported');
  if (!rows.length || rows.length > 10_000) bad('ROW_LIMIT', 'Table must have 1 to 10,000 rows');
  const required = ['source_id','invoice_number','supplier_name','document_date','total_amount','currency_code'];
  const allowed = new Set([...required,'net_amount','vat_amount']);
  if (rows.some(row => required.some(key => !(key in row)) || Object.keys(row).some(key => !allowed.has(key)) || Object.values(row).some(unsafeCell))) bad('INVALID_COLUMNS', 'Table contains missing, unknown or formula-like cells');
  const ids = new Set<string>();
  return rows.map((row, index) => {
    const sourceId = String(row.source_id).trim();
    if (!/^[\w.:-]{1,160}$/.test(sourceId) || ids.has(sourceId)) bad('INVALID_SOURCE_ID', `Invalid or duplicate source identifier at row ${index + 2}`);
    ids.add(sourceId);
    const currency = String(row.currency_code).trim();
    if (!/^[A-Z]{3}$/.test(currency)) bad('INVALID_CURRENCY', `Invalid currency at row ${index + 2}`);
    const name = String(row.supplier_name).trim(), invoiceNumber = String(row.invoice_number).trim();
    if (!name || name.length > 200 || !invoiceNumber || invoiceNumber.length > 160) bad('INVALID_FIELDS', `Missing invoice fields at row ${index + 2}`);
    const date = statementDate(row.document_date, index + 2);
    const total = statementMinor(row.total_amount, currency, index + 2);
    const net = row.net_amount === '' || row.net_amount === undefined ? undefined : statementMinor(row.net_amount, currency, index + 2);
    const vat = row.vat_amount === '' || row.vat_amount === undefined ? undefined : statementMinor(row.vat_amount, currency, index + 2);
    if (total <= 0 || net !== undefined && net < 0 || vat !== undefined && vat < 0 || net !== undefined && vat !== undefined && net + vat !== total) bad('INVALID_AMOUNT', `Invalid totals at row ${index + 2}`);
    return { source_id: sourceId, invoice_number: invoiceNumber, supplier_name: name, document_date: date, total_amount_minor: total, currency_code: currency, ...(net === undefined ? {} : { net_amount_minor: net }), ...(vat === undefined ? {} : { vat_amount_minor: vat }) };
  });
}
export function tableDocumentId(workspace: string, kind: TableKind, sourceId: string): string { return `doc_tab_${createHash('sha256').update(`${workspace}\0${kind}\0${sourceId}`).digest('hex')}`; }
