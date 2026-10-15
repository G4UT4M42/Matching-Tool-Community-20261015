import { describe, expect, it } from 'vitest';
import { createEmptyState } from '../src/storage/json-store.js';
import type { Document, MatchGroup, MatchingState, Transaction, MatchStatus } from '../src/core/types.js';
import { generateVatReport } from '../src/core/reporting/vat-report.js';
import { generateIncomeTaxReport } from '../src/core/reporting/income-tax-report.js';

/** Independently generated fiction, never derived from a private bank statement. */
function fixture(status: MatchStatus, vatRate?: number): MatchingState {
  const state = createEmptyState('TEST_SYNTHETIC_REPORT_EVIDENCE');
  const transaction: Transaction = {
    transaction_id: 'TEST-TXN-A', source_system: 'sparkasse',
    source_account_id: 'FAKE-ACCOUNT', source_row_ref: 'FICTIONAL-EVENT-1',
    posting_at: '2026-01-15T12:00:00Z', amount_minor: -12000,
    currency_code: 'EUR', description_raw: 'Fictional office supplies',
    counterparty_name: 'Cedar Example Labs', tags: ['synthetic'], meta: {},
  };
  const document: Document = {
    document_id: 'TEST-DOC-A', source_system: 'amazon',
    source_document_ref: 'FICTIONAL-INVOICE-1', captured_at: '2026-01-15T12:00:00Z',
    document_date: '2026-01-14', total_amount_minor: -12000, currency_code: 'EUR',
    supplier_name: 'Cedar Example Labs',
    ...(vatRate === undefined ? {} : { vat_rate: vatRate }),
    meta: { invoice_country: 'AT', TEST_SYNTHETIC: true },
  };
  const group: MatchGroup = {
    match_group_id: 'TEST-MATCH-A', status, created_at: '2026-01-16T12:00:00Z',
    created_by: 'synthetic-test', rule_id: 'FICTIONAL-EXACT',
    transaction_ids: [transaction.transaction_id], document_ids: [document.document_id],
    amount_total_minor: -12000, currency_code: 'EUR',
    reason_codes: ['TEST_SYNTHETIC'],
  };
  state.transactions.set(transaction.transaction_id, transaction);
  state.documents.set(document.document_id, document);
  state.match_groups.set(group.match_group_id, group);
  // Legacy reservation sets can be set for unaccepted proposals.
  state.matched_document_ids.add(document.document_id);
  state.matched_transaction_ids.add(transaction.transaction_id);
  return state;
}

describe('Financial reporting requires accepted evidence and explicit tax basis', () => {
  for (const status of ['proposed', 'rejected'] as const) {
    it(`${status} matching is not accepted accounting evidence`, () => {
      const state = fixture(status, 0.2);
      const vat = generateVatReport(state, '2026-01-01', '2026-12-31');
      const income = generateIncomeTaxReport(state, '2026-01-01', '2026-12-31');
      expect(vat.cat_060.total_vat_minor).toBe(0);
      expect(vat.total_documents_processed).toBe(0);
      expect(income.total_documents_processed).toBe(0);
    });
  }
  it('accepted invoice lacking a VAT-rate basis cannot invent an input VAT deduction', () => {
    const vat = generateVatReport(fixture('accepted'), '2026-01-01', '2026-12-31');
    expect(vat.cat_060.total_vat_minor).toBe(0);
    expect(vat.total_unclassified).toBe(1);
    expect(vat.integrity_warnings.some(w => /rate|steuersatz|evidence/i.test(w))).toBe(true);
  });
  it('accepted Austrian invoice with evidenced rate is eligible for classification', () => {
    const vat = generateVatReport(fixture('accepted', 0.2), '2026-01-01', '2026-12-31');
    expect(vat.cat_060.lines).toHaveLength(1);
    expect(vat.cat_060.total_vat_minor).not.toBe(0);
    expect(vat.total_unclassified).toBe(0);
  });
});
