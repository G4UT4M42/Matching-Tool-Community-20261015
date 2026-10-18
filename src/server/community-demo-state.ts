import type { MatchingState, Transaction, Document, MatchGroup } from '../core/types.js';
import { createEmptyState } from '../storage/json-store.js';
import { enrichCommunityDemoState } from './community-demo-preview.js';

/** All records are fictional and created specifically for Community Preview. */
export function createCommunityDemoState(): MatchingState {
  const state = createEmptyState('COMMUNITY_SYNTHETIC_DEMO_V1');
  const rows: Array<{ id: string; minor: number; date: string; counterparty: string; note: string }> = [
    { id: 'DEMO-TXN-001', minor: -12900, date: '2026-01-14', counterparty: 'Cedar Example Labs', note: 'Fictional office supplies' },
    { id: 'DEMO-TXN-002', minor: -5050, date: '2026-01-15', counterparty: 'Harbor Demonstration Supplies', note: 'Fictional subscription' },
    { id: 'DEMO-TXN-003', minor: 5050, date: '2026-01-17', counterparty: 'Harbor Demonstration Supplies', note: 'Fictional refund' },
    { id: 'DEMO-TXN-004', minor: 39200, date: '2026-01-21', counterparty: 'Sunrise Example Services', note: 'Fictional revenue' },
  ];
  for (const row of rows) {
    const transaction: Transaction = {
      transaction_id: row.id,
      source_system: 'sparkasse',
      source_account_id: 'NON-ROUTABLE-DEMO',
      source_row_ref: row.id,
      posting_at: row.date + 'T12:00:00Z',
      amount_minor: row.minor,
      currency_code: 'EUR',
      description_raw: row.note,
      counterparty_name: row.counterparty,
      tags: ['synthetic-demo'],
      meta: { source: 'TEST_SYNTHETIC', network_enabled: false },
    };
    state.transactions.set(transaction.transaction_id, transaction);
  }
  for (const doc of [
    { id: 'DEMO-DOC-001', date: '2026-01-13', supplier: 'Cedar Example Labs', minor: -12900, vatRate: 0.2 },
    { id: 'DEMO-DOC-002', date: '2026-01-14', supplier: 'Harbor Demonstration Supplies', minor: -5050, vatRate: 0.2 },
  ]) {
    const document: Document = {
      document_id: doc.id, source_system: 'amazon',
      source_document_ref: doc.id,
      captured_at: doc.date + 'T13:00:00Z',
      document_date: doc.date,
      total_amount_minor: doc.minor,
      currency_code: 'EUR',
      supplier_name: doc.supplier,
      vat_rate: doc.vatRate,
      meta: { source: 'TEST_SYNTHETIC', invoice_country: 'AT', sample_only: true },
    };
    state.documents.set(document.document_id, document);
  }
  const groups: Array<{ id: string; status: MatchGroup['status']; txn: string; doc: string; minor: number }> = [
    { id: 'DEMO-MATCH-001', status: 'accepted', txn: 'DEMO-TXN-001', doc: 'DEMO-DOC-001', minor: -12900 },
    { id: 'DEMO-MATCH-002', status: 'proposed', txn: 'DEMO-TXN-002', doc: 'DEMO-DOC-002', minor: -5050 },
  ];
  for (const group of groups) {
    const mg: MatchGroup = {
      match_group_id: group.id,
      status: group.status,
      created_at: '2026-01-22T12:00:00Z',
      created_by: 'community-demo',
      rule_id: 'DEMO-EXACT',
      transaction_ids: [group.txn],
      document_ids: [group.doc],
      amount_total_minor: group.minor,
      currency_code: 'EUR',
      reason_codes: ['SYNTHETIC_DEMO'],
    };
    state.match_groups.set(group.id, mg);
    // Legacy reservation sets are not proof of acceptance.
    state.matched_transaction_ids.add(group.txn);
    state.matched_document_ids.add(group.doc);
  }
  return enrichCommunityDemoState(state);
}
