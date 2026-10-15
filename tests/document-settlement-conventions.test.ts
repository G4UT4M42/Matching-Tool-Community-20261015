import { describe, expect, it } from 'vitest';
import type { Document, MatchingState, Transaction } from '../src/core/types.js';
import { createEmptyState, deserializeCommunityState, serializeCommunityState } from '../src/storage/json-store.js';
import { createManualDecision, reviewDecision } from '../src/core/matching/decisions.js';
import { acceptAllocations, remainingBalances } from '../src/community/accounting/ledger.js';
import { proposeExactMatches } from '../src/core/matching/community-proposals.js';

function fixture(amount: number, documentAmount: number, source: Document['source_system'] = 'upload', meta: Record<string, unknown> = {}): MatchingState {
  const state = createEmptyState('SYNTHETIC_DOCUMENT_SETTLEMENT');
  const tx: Transaction = { transaction_id: 'SYN-T1', source_system: 'sparkasse', source_account_id: 'SYN-A1', source_row_ref: 'SYN-R1',
    posting_at: '2026-01-12', amount_minor: amount, currency_code: 'EUR', description_raw: 'Fictional supplier invoice SYN-I1', tags: [], meta: {} };
  const doc: Document = { document_id: 'SYN-D1', source_system: source, source_document_ref: 'SYN-I1', captured_at: '2026-01-12T00:00:00Z',
    document_date: '2026-01-12', total_amount_minor: documentAmount, currency_code: 'EUR', supplier_name: 'Fictional supplier', meta };
  state.transactions.set(tx.transaction_id, tx); state.documents.set(doc.document_id, doc);
  return state;
}
const manual = (state: MatchingState) => createManualDecision(state, { transaction_ids: ['SYN-T1'], document_ids: ['SYN-D1'], reason: 'Synthetic reviewed settlement' }, 'synthetic-reviewer').state;
const partial = (state: MatchingState, txAmount: number, docAmount: number) => acceptAllocations(state, {
  revision: state.accounting?.revision ?? 0, evidence_ref: 'SYNTHETIC_DOCUMENT_REVIEW',
  allocations: [{ kind: 'payment', transaction_id: 'SYN-T1', document_id: 'SYN-D1', transaction_amount_minor: txAmount, document_amount_minor: docAmount }],
}, 'synthetic-reviewer');

describe('document face values versus signed bank cashflow', () => {
  it('matches a positive uploaded supplier invoice to the equal bank debit without changing source values', () => {
    const original = fixture(-1250, 1250);
    const next = manual(original);
    expect(original.match_groups.size).toBe(0);
    expect(next.transactions.get('SYN-T1')?.amount_minor).toBe(-1250);
    expect(next.documents.get('SYN-D1')?.total_amount_minor).toBe(1250);
    expect([...next.match_groups.values()][0].amount_total_minor).toBe(-1250);
    expect(deserializeCommunityState(JSON.parse(serializeCommunityState(next)))).toEqual(next);
  });
  it('preserves an existing accepted legacy payable association during state validation', () => {
    const state = fixture(-1250, 1250);
    state.match_groups.set('SYN-M1', { match_group_id: 'SYN-M1', status: 'accepted', created_at: '2026-01-12', created_by: 'synthetic-original-owner',
      rule_id: 'MANUAL', transaction_ids: ['SYN-T1'], document_ids: ['SYN-D1'], amount_total_minor: -1250, currency_code: 'EUR', reason_codes: [] });
    state.matched_transaction_ids.add('SYN-T1'); state.matched_document_ids.add('SYN-D1');
    expect(deserializeCommunityState(JSON.parse(serializeCommunityState(state)))).toEqual(state);
  });
  it('retains canonical signed expenses and receipts without absolute-value matching', () => {
    for (const [amount, documentAmount, source] of [[-1250, -1250, 'invoice_file'], [-1250, -1250, 'upload'], [1250, 1250, 'income'], [1250, 1250, 'manual']] as const) {
      const next = manual(fixture(amount, documentAmount, source));
      expect(next.documents.get('SYN-D1')?.total_amount_minor).toBe(documentAmount);
      expect(remainingBalances(next).document.get('SYN-D1')).toBe(0n);
    }
    expect(() => manual(fixture(-1250, 1250, 'income'))).toThrow();
    expect(() => manual(fixture(1250, -1250, 'invoice_file'))).toThrow();
    expect(() => manual(fixture(1250, 1250, 'upload'))).toThrow();
  });
  it('recognizes the new explicitly selected supplier-invoice table format without reinterpreting historical credit notes', () => {
    expect(manual(fixture(-1250, 1250, 'invoice_file', { table_kind: 'invoice' })).match_groups.size).toBe(1);
    expect(manual(fixture(1250, 1250, 'invoice_file')).match_groups.size).toBe(1);
  });
  it('rejects mismatched values and currencies even for a face-value supplier invoice', () => {
    expect(() => manual(fixture(-1249, 1250))).toThrow();
    const cross = fixture(-1250, 1250); cross.documents.get('SYN-D1')!.currency_code = 'USD';
    expect(() => manual(cross)).toThrow(/currency|exchange|allocation/i);
    const stale = manual(fixture(-1250, 1250));
    stale.match_groups.values().next().value!.amount_total_minor = -1200;
    expect(() => serializeCommunityState(stale)).toThrow();
  });
  it('accepts a reviewed proposal using the same interpretation as manual matching', () => {
    const state = fixture(-1250, 1250);
    state.match_groups.set('SYN-P1', { match_group_id: 'SYN-P1', status: 'proposed', created_at: '2026-01-12', created_by: 'system',
      rule_id: 'SYNTHETIC', transaction_ids: ['SYN-T1'], document_ids: ['SYN-D1'], amount_total_minor: -1250, currency_code: 'EUR', reason_codes: [] });
    const next = reviewDecision(state, 'SYN-P1', {status:'accepted'}, 'synthetic-reviewer').state;
    expect(next.match_groups.get('SYN-P1')?.status).toBe('accepted');
    expect(() => serializeCommunityState(next)).not.toThrow();
  });
  it('proposes only the actual cashflow direction and preserves rejection history', () => {
    const result = proposeExactMatches(fixture(-1250, 1250));
    expect(result.created).toHaveLength(1);
    const rejected = reviewDecision(result.state, result.created[0].match_group_id, {status:'rejected'}, 'synthetic-reviewer').state;
    expect(proposeExactMatches(rejected).created).toHaveLength(0);
    expect(proposeExactMatches(fixture(1250, 1250)).created).toHaveLength(0);
  });
  it('keeps document-side partial balances in their original denomination and prevents over-allocation', () => {
    const state = fixture(-1250, 1250);
    const first = partial(state, -500, 500);
    expect(remainingBalances(first).transaction.get('SYN-T1')).toBe(-750n);
    expect(remainingBalances(first).document.get('SYN-D1')).toBe(750n);
    const second = partial(first, -750, 750);
    expect(remainingBalances(second).document.get('SYN-D1')).toBe(0n);
    expect(() => partial(second, -1, 1)).toThrow(/exceed/);
    expect(() => partial(state, -500, -500)).toThrow(/direction/i);
    expect(deserializeCommunityState(JSON.parse(serializeCommunityState(second)))).toEqual(second);
  });
  it('requires exact FX evidence while retaining opposite source and document leg signs', () => {
    const state = fixture(-1000, 900); state.transactions.get('SYN-T1')!.currency_code = 'USD';
    const request = {revision:0, evidence_ref:'SYNTHETIC_FX', allocations:[{kind:'payment', transaction_id:'SYN-T1', document_id:'SYN-D1', transaction_amount_minor:-1000, document_amount_minor:900,
      conversion:{numerator:9,denominator:10,source:'SYNTHETIC_QUOTE',evidence_ref:'SYNTHETIC_FX'}}]};
    expect(remainingBalances(acceptAllocations(state,request,'synthetic-reviewer')).document.get('SYN-D1')).toBe(0n);
    request.allocations[0].conversion.numerator = 8;
    expect(() => acceptAllocations(state,request,'synthetic-reviewer')).toThrow(/conversion/);
  });
  it('honors explicit face-value credit notes and rejects unknown conventions', () => {
    const credit = fixture(1250, -1250, 'upload', { settlement_convention:'payable-face-v1' });
    expect(manual(credit).match_groups.size).toBe(1);
    const receipt = fixture(1250, 1250, 'upload', {settlement_convention:'receivable-face-v1'});
    expect(manual(receipt).match_groups.size).toBe(1);
    expect(() => manual(fixture(-1250,1250,'upload',{settlement_convention:'unknown-v99'}))).toThrow();
  });
});
