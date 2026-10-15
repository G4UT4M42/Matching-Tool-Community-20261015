/**
 * CSV export: transactions + match status.
 * Deterministically sorted by posting_at, then transaction_id.
 */
import type { ReportWithExtras } from './generate-report.js';
import { fromMinor } from '../normalization/amount.js';

const CSV_HEADERS = [
  'transaction_id',
  'source_system',
  'posting_at',
  'amount',
  'currency_code',
  'description',
  'status',
  'match_group_id',
  'rule_id',
  'matched_document_ids',
  'matched_transaction_ids',
] as const;

function escapeCsv(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

export function exportCsv(report: ReportWithExtras): string {
  const lines: string[] = [];

  // Header
  lines.push(CSV_HEADERS.join(','));

  // Items (already sorted deterministically in generate-report)
  for (const item of report.items) {
    const row = [
      item.transaction_id,
      item.source_system,
      item.posting_at,
      fromMinor(item.amount_minor).toFixed(2),
      item.currency_code,
      item.description,
      item.status,
      item.match_group_id ?? '',
      item.rule_id ?? '',
      item.matched_document_ids.join(';'),
      item.matched_transaction_ids.join(';'),
    ];
    lines.push(row.map(escapeCsv).join(','));
  }

  return lines.join('\n') + '\n';
}
