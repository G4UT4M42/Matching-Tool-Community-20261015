import type { Document } from '../../core/types.js';

export type DocumentSettlementConvention = 'signed-cashflow-v1' | 'payable-face-v1' | 'receivable-face-v1';

/**
 * Interpret evidence; never rewrite its original amount or choose a direction
 * from the bank transaction being matched. Historical normalized invoices are
 * signed cashflow. The reviewed upload workflow and new invoice-table importer
 * instead store supplier invoice face values. The latter carry table_kind.
 * Explicit metadata disambiguates credit notes and uploaded sales invoices.
 */
export function documentSettlementConvention(document: Document): DocumentSettlementConvention {
  const explicit = document.meta?.settlement_convention;
  if (explicit !== undefined) {
    if (explicit !== 'signed-cashflow-v1' && explicit !== 'payable-face-v1' && explicit !== 'receivable-face-v1') {
      throw new Error('Unsupported document settlement convention; explicit review is required');
    }
    if (document.source_system === 'income' && explicit === 'payable-face-v1') {
      throw new Error('Document settlement convention contradicts the income source contract');
    }
    return explicit;
  }
  if (document.source_system === 'upload' && document.total_amount_minor > 0) return 'payable-face-v1';
  if (document.source_system === 'invoice_file' && document.meta?.table_kind === 'invoice') return 'payable-face-v1';
  return 'signed-cashflow-v1';
}

/** Convert a whole value or allocation leg to the expected signed bank cashflow. */
export function documentSettlementMinor(document: Document, sourceMinor: number = document.total_amount_minor): number {
  if (!Number.isSafeInteger(document.total_amount_minor) || !Number.isSafeInteger(sourceMinor)) {
    throw new Error('Document settlement requires exact integer minor units');
  }
  const convention = documentSettlementConvention(document);
  return convention === 'payable-face-v1' ? -sourceMinor : sourceMinor;
}
