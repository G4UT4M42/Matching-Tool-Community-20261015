import type { MatchingState } from '../../core/types.js';
import { accountingOf, remainingBalances, validateAccountingState, AccountingError } from './ledger.js';

export interface ReportQuery { start: string; end: string }
const date = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export function validatePeriod(query: ReportQuery): void {
  if (!date(query.start) || !date(query.end) || query.start > query.end) throw new AccountingError(400, 'INVALID_PERIOD', 'Use valid inclusive YYYY-MM-DD boundaries');
}
export function accountingReport(state: MatchingState, query: ReportQuery) {
  validateAccountingState(state); validatePeriod(query);
  const account = accountingOf(state);
  const balances = remainingBalances(state);
  const classifications = new Map(account.classifications.map(c => [c.transaction_id, c]));
  const taxes = new Map(account.document_taxes.map(c => [c.document_id, c]));
  const allocations = account.allocations.filter(a => a.status === 'accepted');
  const rows = [...state.transactions.values()].filter(t => t.posting_at.slice(0, 10) >= query.start && t.posting_at.slice(0, 10) <= query.end)
    .sort((a, b) => a.posting_at.localeCompare(b.posting_at) || a.transaction_id.localeCompare(b.transaction_id))
    .map(t => {
      const assigned = allocations.filter(a => a.transaction_id === t.transaction_id);
      const fullGroups = [...state.match_groups.values()].filter(g => ['accepted', 'confirmed', 'manual'].includes(g.status) && g.transaction_ids.includes(t.transaction_id));
      const explicit = classifications.get(t.transaction_id);
      const component = new Set(assigned.map(a => a.kind));
      const category = t.meta?.accounting_status === 'cancelled' ? 'cancelled' : state.excluded_transaction_ids.has(t.transaction_id) ? 'excluded' :
        (component.has('transfer') || ['provider_payout', 'internal_transfer'].includes(String(t.meta?.accounting_event_kind))) ? 'transfer' :
        component.has('fee') ? 'fee' : component.has('refund') || component.has('credit_note') ? 'refund' :
        explicit?.category ?? 'unclassified';
      return { transaction_id: t.transaction_id, source_system: t.source_system, source_account_id: t.source_account_id,
        source_row_ref: t.source_row_ref, posting_at: t.posting_at, description_raw: t.description_raw,
        amount_minor: t.amount_minor, currency_code: t.currency_code, category,
        remaining_minor: Number(balances.transaction.get(t.transaction_id)),
        allocation_ids: assigned.map(a => a.allocation_id), match_group_ids: fullGroups.map(g => g.match_group_id),
        document_ids: [...new Set([...assigned.flatMap(a => a.document_id ? [a.document_id] : []), ...fullGroups.flatMap(g => g.document_ids)])],
        evidence_ref: explicit?.evidence_ref ?? null };
    });
  const byCurrency: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const bucket = byCurrency[row.currency_code] ??= {};
    const amount = BigInt(bucket[row.category] ?? 0) + BigInt(row.amount_minor);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER)) throw new AccountingError(409, 'REPORT_OVERFLOW', 'Report total exceeds exact integer range');
    bucket[row.category] = Number(amount);
  }
  const documents = [...state.documents.values()].filter(d => d.document_date >= query.start && d.document_date <= query.end)
    .sort((a, b) => a.document_date.localeCompare(b.document_date) || a.document_id.localeCompare(b.document_id))
    .map(d => {
      const matching = allocations.filter(a => a.document_id === d.document_id);
      const full = [...state.match_groups.values()].filter(g => ['accepted', 'confirmed', 'manual'].includes(g.status) && g.document_ids.includes(d.document_id));
      const remaining = Number(balances.document.get(d.document_id));
      const tax = taxes.get(d.document_id);
      return { document_id: d.document_id, source_document_ref: d.source_document_ref, document_date: d.document_date,
        total_amount_minor: d.total_amount_minor, currency_code: d.currency_code, remaining_minor: remaining,
        reconciliation: d.meta?.accounting_status === 'cancelled' ? 'cancelled' : remaining === 0 ? 'fully_matched' : remaining === d.total_amount_minor ? 'unmatched' : 'partially_matched',
        allocation_ids: matching.map(a => a.allocation_id), match_group_ids: full.map(g => g.match_group_id),
        tax_category: tax?.tax_category ?? 'unclassified', vat_minor: tax?.vat_minor ?? 0,
        input_tax_eligible: Boolean(tax?.input_tax_eligible && remaining === 0),
        evidence_ref: tax?.evidence_ref ?? null, rate_numerator: tax?.rate_numerator ?? null, rate_denominator: tax?.rate_denominator ?? null };
    });
  const vatByCurrency: Record<string, { output_minor: number; eligible_input_minor: number; unclassified_documents: number }> = {};
  for (const d of documents) {
    const bucket = vatByCurrency[d.currency_code] ??= { output_minor: 0, eligible_input_minor: 0, unclassified_documents: 0 };
    if (d.tax_category === 'unclassified') bucket.unclassified_documents++;
    if (d.reconciliation !== 'fully_matched') continue;
    if (d.tax_category === 'output') bucket.output_minor = Number(BigInt(bucket.output_minor) + BigInt(d.vat_minor));
    if (d.tax_category === 'input' && d.input_tax_eligible) bucket.eligible_input_minor = Number(BigInt(bucket.eligible_input_minor) + BigInt(d.vat_minor));
    if (![bucket.output_minor, bucket.eligible_input_minor].every(Number.isSafeInteger)) throw new AccountingError(409, 'REPORT_OVERFLOW', 'VAT report total exceeds exact integer range');
  }
  return { capability: 'exact-accounting-v1', run_id: state.run_id, revision: account.revision,
    period: query, rows, documents, totals_by_currency: byCurrency, vat_by_currency: vatByCurrency,
    audit_ids: state.audit_events.map(e => e.audit_id) };
}

function csvCell(value: unknown): string {
  let raw = String(value ?? '');
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(raw)) raw = `'${raw}`;
  return `"${raw.replaceAll('"', '""')}"`;
}
export function reportCsv(report: ReturnType<typeof accountingReport>): string {
  const headers = ['transaction_id', 'source_system', 'source_account_id', 'source_row_ref', 'posting_at', 'description_raw', 'amount_minor', 'currency_code', 'category', 'remaining_minor', 'document_ids', 'allocation_ids', 'match_group_ids', 'evidence_ref'];
  const lines = [headers.map(csvCell).join(',')];
  for (const row of report.rows) lines.push(headers.map(key => csvCell((row as unknown as Record<string, unknown>)[key] instanceof Array ? ((row as unknown as Record<string, unknown>)[key] as string[]).join('|') : (row as unknown as Record<string, unknown>)[key])).join(','));
  return lines.join('\r\n') + '\r\n';
}
