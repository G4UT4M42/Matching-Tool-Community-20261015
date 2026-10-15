import { describe, expect, it } from 'vitest';
import { createEmptyState, serializeCommunityState, deserializeCommunityState, COMMUNITY_ACCOUNTING_JSON_STATE_VERSION } from '../src/storage/json-store.js';
import type { MatchingState, Transaction, Document } from '../src/core/types.js';
import { acceptAllocations, classifyTax, classifyTransaction, setPrivateOrExcluded, undoAllocation, createSafeExclusionRule, roundRationalHalfAwayFromZero } from '../src/community/accounting/ledger.js';
import { accountingReport, reportCsv } from '../src/community/accounting/reports.js';
import { proposeExactMatches } from '../src/core/matching/community-proposals.js';
import { reviewDecision } from '../src/core/matching/decisions.js';

function fixture(): MatchingState {
  const s = createEmptyState('FICTIONAL_ACCOUNTING');
  for (const [key, amount, code] of [['T1', -600, 'EUR'], ['T2', -400, 'EUR'], ['T3', 500, 'EUR'], ['T4', -25, 'EUR'], ['T5', -1000, 'USD'], ['T6', -300, 'KWD'], ['T7', 300, 'KWD']] as const) {
    const t: Transaction = { transaction_id: key, source_system: 'sparkasse', source_account_id: 'SYNTHETIC', source_row_ref: key,
      posting_at: '2026-01-12T12:00:00Z', amount_minor: amount, currency_code: code, description_raw: `Fictional ${key}`,
      tags: [], meta: {} };
    s.transactions.set(key, t);
  }
  for (const [key, amount, code] of [['D1', -1000, 'EUR'], ['D2', 500, 'EUR'], ['D3', -500, 'EUR'], ['D4', -300, 'KWD'], ['D5', -100, 'JPY']] as const) {
    const d: Document = { document_id: key, source_system: 'manual', source_document_ref: key, captured_at: '2026-01-12T12:00:00Z',
      document_date: '2026-01-12', total_amount_minor: amount, currency_code: code, meta: { synthetic: true } };
    s.documents.set(key, d);
  }
  return s;
}
const leg = (transaction_id: string, document_id: string, amount: number) => ({ kind: 'payment', transaction_id, document_id,
  transaction_amount_minor: amount, document_amount_minor: amount });
const allocate = (s: MatchingState, allocations: unknown[]) => acceptAllocations(s, { revision: s.accounting?.revision ?? 0,
  evidence_ref: 'SYNTHETIC_REVIEW', allocations }, 'fictional-owner');
describe('exact accounting ledger', () => {
  it('reconciles split and partial payments without calling a partial document full', () => {
    const first = allocate(fixture(), [leg('T1', 'D1', -600)]);
    const partial = accountingReport(first, { start: '2026-01-01', end: '2026-01-31' });
    expect(partial.documents.find(d => d.document_id === 'D1')).toMatchObject({ remaining_minor: -400, reconciliation: 'partially_matched' });
    const second = allocate(first, [leg('T2', 'D1', -400)]);
    const completedReport = accountingReport(second, { start: '2026-01-01', end: '2026-01-31' });
    expect(completedReport.documents.find(d => d.document_id === 'D1')).toMatchObject({ remaining_minor: 0, reconciliation: 'fully_matched' });
    expect(completedReport.audit_ids).toEqual(second.audit_events.map(event => event.audit_id));
    expect(() => allocate(second, [leg('T2', 'D1', -1)])).toThrow(/exceed/);
    expect(() => allocate(first, [leg('T2', 'D1', -401)])).toThrow(/exceed/);
    expect(() => acceptAllocations(first, { revision: 0, evidence_ref: 'STALE', allocations: [leg('T2', 'D1', -400)] }, 'fictional-owner')).toThrow(/changed/);
    const restored = deserializeCommunityState(JSON.parse(serializeCommunityState(second)));
    expect(JSON.parse(serializeCommunityState(second)).schema_version).toBe(COMMUNITY_ACCOUNTING_JSON_STATE_VERSION);
    expect(restored.accounting?.allocations).toHaveLength(2);
    expect(restored.matched_transaction_ids.has('T1')).toBe(true);
    expect(restored.matched_document_ids.has('D1')).toBe(true);
  });
  it('supports a one-to-many split in one atomic batch and rejects overlap', () => {
    const s = fixture();
    s.documents.set('D6', { ...s.documents.get('D1')!, document_id: 'D6', source_document_ref: 'D6', total_amount_minor: -200 });
    const split = allocate(s, [leg('T1', 'D1', -400), leg('T1', 'D6', -200)]);
    const report = accountingReport(split, { start: '2026-01-12', end: '2026-01-12' });
    expect(report.rows.find(row => row.transaction_id === 'T1')?.remaining_minor).toBe(0);
    expect(report.documents.find(row => row.document_id === 'D1')?.remaining_minor).toBe(-600);
    expect(() => allocate(split, [leg('T1', 'D1', -1)])).toThrow(/exceed/);
  });
  it('rejects corrupt reload, orphan, double allocation and invalid FX evidence', () => {
    const state = allocate(fixture(), [leg('T1', 'D1', -600)]);
    const json = JSON.parse(serializeCommunityState(state));
    const disguised = structuredClone(json); disguised.schema_version = 1; disguised.format = 'matching-community-state-v1';
    expect(() => deserializeCommunityState(disguised)).toThrow(/migration/);
    json.accounting.allocations[0].document_id = 'MISSING';
    expect(() => deserializeCommunityState(json)).toThrow(/missing/);
    const wrong = { kind: 'payment', transaction_id: 'T5', document_id: 'D1', transaction_amount_minor: -1000, document_amount_minor: -1000 };
    expect(() => allocate(fixture(), [wrong])).toThrow(/conversion/);
    expect(() => allocate(fixture(), [{ ...wrong, conversion: { numerator: 1, denominator: 2, source: 'SYNTHETIC', evidence_ref: 'FX' } }])).toThrow(/conversion/);
    const valid = allocate(fixture(), [{ ...wrong, conversion: { numerator: 1, denominator: 1, source: 'SYNTHETIC', evidence_ref: 'FX' } }]);
    expect(valid.accounting?.allocations[0].conversion?.denominator).toBe(1);
    const rational = fixture(); rational.documents.get('D1')!.total_amount_minor = -1500;
    const converted = allocate(rational, [{ ...wrong, document_amount_minor: -1500,
      conversion: { numerator: 3, denominator: 2, source: 'SYNTHETIC_RATE', evidence_ref: 'FX_QUOTE' } }]);
    expect(converted.accounting?.allocations[0].conversion?.numerator).toBe(3);
  });
  it('requires explicit refund, credit-note, fee and balanced transfer directions', () => {
    const f = fixture();
    expect(() => allocate(f, [{ ...leg('T3', 'D2', 500), kind: 'refund', document_amount_minor: -500 }])).toThrow(/direction/);
    const refund = allocate(f, [{ ...leg('T3', 'D2', 500), kind: 'refund' }]);
    expect(refund.accounting?.allocations[0].kind).toBe('refund');
    expect(() => allocate(f, [{ kind: 'fee', transaction_id: 'T3', transaction_amount_minor: 500 }])).toThrow(/fee/);
    const fee = allocate(f, [{ kind: 'fee', transaction_id: 'T4', transaction_amount_minor: -25 }]);
    expect(fee.accounting?.allocations[0].kind).toBe('fee');
    expect(() => allocate(f, [{ kind: 'transfer', transaction_id: 'T6', transaction_amount_minor: -300 }])).toThrow(/balance/);
    const transfer = allocate(f, [{ kind: 'transfer', transaction_id: 'T6', transaction_amount_minor: -300 }, { kind: 'transfer', transaction_id: 'T7', transaction_amount_minor: 300 }]);
    expect(transfer.accounting?.allocations).toHaveLength(2);
    expect(undoAllocation(transfer, transfer.accounting!.allocations[0].allocation_id, 1, 'owner').accounting?.allocations.every(a => a.status === 'rejected')).toBe(true);
    const credit = allocate(f, [{ ...leg('T3', 'D2', 500), kind: 'credit_note' }]);
    expect(credit.accounting?.allocations[0].kind).toBe('credit_note');
  });
  it('audits private/exclusion actions and blocks accepted allocations', () => {
    const s = allocate(fixture(), [leg('T1', 'D1', -600)]);
    expect(() => setPrivateOrExcluded(s, { revision: 1, transaction_id: 'T1', disposition: 'private', evidence_ref: 'PRIVATE' }, 'owner')).toThrow(/Undo accepted/);
    const undo = undoAllocation(s, s.accounting!.allocations[0].allocation_id, 1, 'owner');
    const privateState = setPrivateOrExcluded(undo, { revision: 2, transaction_id: 'T1', disposition: 'private', evidence_ref: 'PRIVATE' }, 'owner');
    expect(privateState.audit_events.at(-1)?.actor_id).toBe('owner');
    expect(privateState.accounting?.classifications[0].category).toBe('private');
  });
  it('keeps currencies separate and VAT unclassified until reviewed evidence exists', () => {
    let s = fixture();
    s = classifyTransaction(s, { revision: 0, transaction_id: 'T3', category: 'income', evidence_ref: 'SYNTHETIC_INVOICE' }, 'owner');
    s = classifyTax(s, { revision: 1, document_id: 'D2', tax_category: 'output', rate_numerator: 1, rate_denominator: 5,
      vat_minor: 100, input_tax_eligible: false, evidence_ref: 'SYNTHETIC_TAX_REVIEW' }, 'owner');
    const r = accountingReport(s, { start: '2026-01-01', end: '2026-01-31' });
    expect(r.totals_by_currency.EUR.income).toBe(500);
    expect(r.totals_by_currency.USD.unclassified).toBe(-1000);
    expect(r.vat_by_currency.EUR.output_minor).toBe(0);
    s = allocate(s, [{ ...leg('T3', 'D2', 500), kind: 'refund' }]);
    expect(accountingReport(s, { start: '2026-01-01', end: '2026-01-31' }).vat_by_currency.EUR.output_minor).toBe(100);
    expect(() => accountingReport(s, { start: '2026-02-30', end: '2026-03-01' })).toThrow(/boundaries/);
    expect(accountingReport(s, { start: '2026-02-01', end: '2026-02-28' }).rows).toHaveLength(0);
    expect(roundRationalHalfAwayFromZero(5, 1, 2)).toBe(3);
    expect(roundRationalHalfAwayFromZero(-5, 1, 2)).toBe(-3);
    expect(roundRationalHalfAwayFromZero(1, 1, 3) + roundRationalHalfAwayFromZero(1, 1, 3)).toBe(0);
    expect(roundRationalHalfAwayFromZero(2, 1, 3)).toBe(1);
  });
  it('preserves three- and zero-decimal currency units as raw integers', () => {
    const s = fixture();
    s.transactions.set('TJ', { ...s.transactions.get('T1')!, transaction_id: 'TJ', source_row_ref: 'TJ', amount_minor: -100, currency_code: 'JPY' });
    const matched = allocate(s, [leg('T6', 'D4', -300), leg('TJ', 'D5', -100)]);
    const r = accountingReport(matched, { start: '2026-01-12', end: '2026-01-12' });
    expect(r.documents.find(d => d.document_id === 'D4')).toMatchObject({ remaining_minor: 0, currency_code: 'KWD' });
    expect(r.documents.find(d => d.document_id === 'D5')).toMatchObject({ remaining_minor: 0, currency_code: 'JPY' });
    expect(Object.keys(r.totals_by_currency)).toContain('KWD');
    expect(Object.keys(r.totals_by_currency)).toContain('JPY');
  });
  it('keeps explicit payout and transfer events out of revenue', () => {
    const s = fixture();
    s.transactions.get('T3')!.meta.accounting_event_kind = 'provider_payout';
    expect(() => classifyTransaction(s, { revision: 0, transaction_id: 'T3', category: 'income', evidence_ref: 'PAYOUT' }, 'owner')).toThrow(/revenue/);
    const report = accountingReport(s, { start: '2026-01-01', end: '2026-01-31' });
    expect(report.totals_by_currency.EUR.transfer).toBe(500);
    expect(report.totals_by_currency.EUR.income).toBeUndefined();
  });
  it('keeps cancelled source records visible without matching or VAT totals', () => {
    const s = fixture();
    s.transactions.get('T3')!.meta.accounting_status = 'cancelled';
    s.documents.get('D2')!.meta.accounting_status = 'cancelled';
    expect(proposeExactMatches(s).created.some(g => g.document_ids.includes('D2'))).toBe(false);
    expect(() => allocate(s, [leg('T3', 'D2', 500)])).toThrow(/Cancelled/);
    const report = accountingReport(s, { start: '2026-01-01', end: '2026-01-31' });
    expect(report.rows.find(row => row.transaction_id === 'T3')?.category).toBe('cancelled');
    expect(report.documents.find(row => row.document_id === 'D2')?.reconciliation).toBe('cancelled');
    expect(report.vat_by_currency.EUR.output_minor).toBe(0);
  });
  it('refuses duplicate recognized source events and invalid persisted metadata', () => {
    const s = fixture();
    s.transactions.set('T1_COPY', { ...s.transactions.get('T1')!, transaction_id: 'T1_COPY' });
    const first = allocate(s, [leg('T1', 'D1', -600)]);
    expect(() => allocate(first, [leg('T1_COPY', 'D1', -400)])).toThrow(/source event/);
    const corrupt = JSON.parse(serializeCommunityState(first));
    corrupt.accounting.allocations[0].evidence_ref = '';
    expect(() => deserializeCommunityState(corrupt)).toThrow(/metadata/);
  });
  it('uses bounded literal exclusions and keeps original records visible', () => {
    const s = fixture();
    expect(() => createSafeExclusionRule(s, { revision: 0, field: 'description_raw', operator: 'regex', value: '(a+)+$' }, 'owner')).toThrow(/literal/);
    const excluded = createSafeExclusionRule(s, { revision: 0, field: 'description_raw', operator: 'contains', value: 'T1' }, 'owner');
    expect(excluded.excluded_transaction_ids.has('T1')).toBe(true);
    expect(accountingReport(excluded, { start: '2026-01-01', end: '2026-01-31' }).rows.find(r => r.transaction_id === 'T1')?.category).toBe('excluded');
    const allocated = allocate(s, [leg('T1', 'D1', -600)]);
    expect(() => createSafeExclusionRule(allocated, { revision: 1, field: 'description_raw', operator: 'contains', value: 'T1' }, 'owner')).toThrow(/intersects/);
  });
  it('preserves rejection history across deterministic proposal reruns', () => {
    const s = fixture();
    const first = proposeExactMatches(s);
    expect(first.created.length).toBeGreaterThan(0);
    const same = proposeExactMatches(first.state);
    expect(same.created).toHaveLength(0);
    const group = first.created.find(g => g.transaction_ids[0] === 'T3' && g.document_ids[0] === 'D2')!;
    const rejected = reviewDecision(first.state, group.match_group_id, { status: 'rejected' }, 'owner');
    expect(proposeExactMatches(rejected.state).created.some(g => g.match_group_id === group.match_group_id)).toBe(false);
  });
  it('escapes spreadsheet formulas while retaining exact minor-unit columns', () => {
    const s = fixture(); s.transactions.get('T1')!.description_raw = '=HYPERLINK("evil")';
    const csv = reportCsv(accountingReport(s, { start: '2026-01-01', end: '2026-01-31' }));
    expect(csv).toContain('amount_minor');
    expect(csv).toContain('currency_code');
    expect(csv).toContain("'=HYPERLINK");
  });
});
