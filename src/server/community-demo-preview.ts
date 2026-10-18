import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CommunityAllocation, Document, FinancialCategory, MatchingState, Transaction } from '../core/types.js';
import { validateAccountingState } from '../community/accounting/ledger.js';
import { accountingReport } from '../community/accounting/reports.js';
import { currentPaymentInvoices, provedPaymentReconciliation } from '../community/payments/community-evidence.js';
import { CommunityPaymentService } from '../community/payments/service.js';
import { PaymentRepository } from '../community/payments/repository.js';
import { communitySimulatedPaymentAdapter } from '../community/payments/simulated-adapter.js';
import type { Principal } from '../community/payments/types.js';

export const DEMO_WORKSPACE = 'COMMUNITY_SYNTHETIC_DEMO_V1';
export const DEMO_TIME = '2026-01-22T12:00:00Z';
// Checksum-valid, nonroutable fixture. Never a real account or provider credential.
const syntheticIban = 'DE36' + '0'.repeat(18);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Deterministic, explicitly fictional financial evidence; the original four transactions and two documents remain intact. */
export function enrichCommunityDemoState(state: MatchingState): MatchingState {
  if (state.run_id !== DEMO_WORKSPACE || state.accounting) throw new Error('DEMO_SEED_SCOPE_INVALID');
  const addTransaction = (n: number, provider: Transaction['source_system'], amount: number, note: string, category: FinancialCategory, currency = 'EUR') => {
    const id = `DEMO-TXN-${String(n).padStart(3, '0')}`;
    const row: Transaction = { transaction_id: id, source_system: provider, source_account_id: `NON-ROUTABLE-DEMO-${provider.toUpperCase()}`,
      source_row_ref: id, posting_at: '2026-01-20T12:00:00Z', amount_minor: amount, currency_code: currency,
      description_raw: `Fictional ${note}`, counterparty_name: 'Example Demonstration Trading', tags: ['synthetic-demo'],
      meta: { source: 'TEST_SYNTHETIC', network_enabled: false, ...(category === 'transfer' ? { accounting_event_kind: 'provider_payout' } : {}) } };
    state.transactions.set(id, row); return row;
  };
  const categories: Array<[number, Transaction['source_system'], number, string, FinancialCategory, string?]> = [
    [5, 'paypal', 12000, 'PayPal sale', 'income'], [6, 'paypal', -420, 'PayPal processing fee', 'fee'],
    [7, 'paypal', -3000, 'PayPal customer refund', 'refund'], [8, 'stripe', 24000, 'Stripe sale', 'income'],
    [9, 'stripe', -720, 'Stripe processing fee', 'fee'], [10, 'stripe', -5000, 'Stripe customer refund', 'refund'],
    [11, 'visa', -9000, 'card purchase settling USD 100.00', 'expense'], [12, 'sparkasse', -4000, 'partial supplier payment', 'expense'],
    [13, 'sparkasse', -2000, 'private purchase excluded from business evidence', 'private'],
    [14, 'enablebanking', -1800, 'read-only bank statement fee', 'fee'],
    [15, 'stripe', -18280, 'payout transfer to demo bank', 'transfer'], [16, 'sparkasse', 18280, 'payout transfer from demo Stripe', 'transfer'],
    [17, 'paypal', 5000, 'USD sale', 'income', 'USD'],
  ];
  for (const row of categories) addTransaction(...row);
  state.transactions.get('DEMO-TXN-011')!.fx = { original_amount_minor: -10000, original_currency_code: 'USD', rate: 0.9, rate_source: 'TEST_SYNTHETIC_EXACT_9_10' };
  const docs: Array<[number, Document['source_system'], number, string, string, number]> = [
    [3, 'income', 12000, 'PayPal fictional customer', 'EUR', 2000], [4, 'income', 24000, 'Stripe fictional customer', 'EUR', 4000],
    [5, 'income', -3000, 'PayPal fictional credit note', 'EUR', -500], [6, 'stripe_fee', -720, 'Stripe fictional fee', 'EUR', 0],
    [7, 'upload', 10000, 'Example Partial Supplier', 'EUR', 1667], [8, 'invoice_file', -10000, 'Example Overseas Supplier', 'USD', 0],
    [9, 'upload', 3600, 'Example Unpaid Supplier', 'EUR', 600], [10, 'income', 39200, 'Sunrise Example Services', 'EUR', 6533],
    [11, 'income', -5000, 'Stripe fictional credit note', 'EUR', -833], [12, 'bank_fee', -1800, 'Example Bank Fee', 'EUR', 0],
    [13, 'income', 5000, 'Example USD Customer', 'USD', 0],
  ];
  for (const [n, source, amount, supplier, currency, vat] of docs) {
    const id = `DEMO-DOC-${String(n).padStart(3, '0')}`, payable = n === 7 || n === 9;
    // This is the digest of the declared synthetic source fixture, not an OCR or downloaded-invoice claim.
    const sourceFixture = JSON.stringify({ classification: 'TEST_SYNTHETIC', id, amount_minor: amount, currency, supplier, vat_minor: vat });
    state.documents.set(id, { document_id: id, source_system: source, source_document_ref: id, captured_at: DEMO_TIME,
      document_date: '2026-01-20', total_amount_minor: amount, currency_code: currency, supplier_name: supplier,
      vat_amount_minor: vat, vat_rate: vat === 0 ? 0 : 0.2, file_hash: hash(sourceFixture),
      meta: { source: 'TEST_SYNTHETIC', sample_only: true, network_enabled: false, source_fixture: sourceFixture,
        invoice_country: currency === 'USD' ? 'US' : 'AT', ...(amount < 0 && source === 'income' ? { document_type: 'credit_note' } : {}),
        ...(payable ? { workspace_id: DEMO_WORKSPACE, settlement_convention: 'payable-face-v1', document_review_status: 'confirmed',
          invoice_number: id, iban: syntheticIban, payment_reference: id, due_date: '2026-02-10' } : {}) } });
  }
  const allocations: CommunityAllocation[] = [];
  const allocation = (n: number, kind: CommunityAllocation['kind'], tx: number, amount: number, doc?: number, documentAmount?: number, conversion?: CommunityAllocation['conversion'], batch?: string) => {
    allocations.push({ allocation_id: `DEMO-ALLOCATION-${String(n).padStart(3, '0')}`, batch_id: batch ?? `DEMO-BATCH-${n}`, kind,
      transaction_id: `DEMO-TXN-${String(tx).padStart(3, '0')}`, transaction_amount_minor: amount,
      ...(doc === undefined ? {} : { document_id: `DEMO-DOC-${String(doc).padStart(3, '0')}`, document_amount_minor: documentAmount }),
      ...(conversion ? { conversion } : {}), status: 'accepted', created_at: DEMO_TIME, created_by: 'community-demo', evidence_ref: 'TEST_SYNTHETIC_REVIEWED_FIXTURE' });
  };
  allocation(1, 'payment', 5, 12000, 3, 12000); allocation(2, 'fee', 6, -420);
  allocation(3, 'refund', 7, -3000, 5, -3000); allocation(4, 'payment', 8, 24000, 4, 24000);
  allocation(5, 'payment', 9, -720, 6, -720); allocation(6, 'refund', 10, -5000, 11, -5000);
  allocation(7, 'payment', 11, -9000, 8, -10000, { numerator: 10, denominator: 9, source: 'TEST_SYNTHETIC_EXACT_10_9', evidence_ref: 'DEMO-FX-001' });
  allocation(8, 'payment', 12, -4000, 7, 4000); allocation(9, 'payment', 4, 39200, 10, 39200);
  allocation(10, 'payment', 14, -1800, 12, -1800);
  allocation(11, 'transfer', 15, -18280, undefined, undefined, undefined, 'DEMO-PAYOUT-TRANSFER');
  allocation(12, 'transfer', 16, 18280, undefined, undefined, undefined, 'DEMO-PAYOUT-TRANSFER');
  allocation(13, 'payment', 17, 5000, 13, 5000);
  state.accounting = { capability: 'exact-accounting-v1', revision: 1, allocations,
    classifications: ([ [1, 'expense'], [2, 'expense'], [3, 'refund'], [4, 'income'] ] as Array<[number, FinancialCategory]>)
      .concat(categories.map(row => [row[0], row[4]] as [number, FinancialCategory])).map(([n, category]) => ({
        transaction_id: `DEMO-TXN-${String(n).padStart(3, '0')}`, category, evidence_ref: 'TEST_SYNTHETIC_REVIEWED_FIXTURE', set_at: DEMO_TIME, set_by: 'community-demo' })),
    document_taxes: [...state.documents.values()].map(doc => ({ document_id: doc.document_id,
      tax_category: doc.currency_code === 'USD' ? 'outside_scope' : doc.source_system === 'income' ? 'output' : doc.source_system === 'bank_fee' || doc.source_system === 'stripe_fee' ? 'exempt' : 'input',
      rate_numerator: doc.currency_code === 'USD' || doc.source_system === 'bank_fee' || doc.source_system === 'stripe_fee' ? 0 : 1,
      rate_denominator: 5, vat_minor: doc.vat_amount_minor ?? (doc.document_id === 'DEMO-DOC-001' ? -2150 : -842),
      input_tax_eligible: doc.currency_code === 'EUR' && !['income', 'bank_fee', 'stripe_fee'].includes(doc.source_system),
      evidence_ref: 'TEST_SYNTHETIC_TAX_EXAMPLE_NOT_ADVICE', set_at: DEMO_TIME, set_by: 'community-demo' })) };
  for (const a of allocations) { state.matched_transaction_ids.add(a.transaction_id); if (a.document_id) state.matched_document_ids.add(a.document_id); }
  state.audit_events.push({ audit_id: 'DEMO-AUDIT-ALLOCATIONS', timestamp: DEMO_TIME, actor_type: 'system', actor_id: 'community-demo', action: 'ACCOUNTING_ALLOCATED', entity_type: 'Run', entity_id: DEMO_WORKSPACE, after: { allocations }, reason: 'Fictional demonstration data only' });
  for (const c of state.accounting.classifications) state.audit_events.push({ audit_id: `DEMO-AUDIT-${c.transaction_id}`, timestamp: DEMO_TIME, actor_type: 'system', actor_id: 'community-demo', action: 'ACCOUNTING_CLASSIFIED', entity_type: 'Transaction', entity_id: c.transaction_id, after: { classification: c } });
  for (const tax of state.accounting.document_taxes) state.audit_events.push({ audit_id: `DEMO-AUDIT-${tax.document_id}`, timestamp: DEMO_TIME, actor_type: 'system', actor_id: 'community-demo', action: 'ACCOUNTING_TAX_CLASSIFIED', entity_type: 'Document', entity_id: tax.document_id, after: { tax } });
  validateAccountingState(state); return state;
}

/** Boot-only creation through the reviewed service. No approval, capability, credential or transport is created. */
export function ensureCommunityDemoDraft(db: Database.Database, state: MatchingState): void {
  if (state.run_id !== DEMO_WORKSPACE) throw new Error('DEMO_SEED_SCOPE_INVALID');
  const repository = new PaymentRepository(db);
  if (repository.list(DEMO_WORKSPACE).length || !state.documents.has('DEMO-DOC-009')) return;
  const principal: Principal = { subject: 'community-demo', workspace_id: DEMO_WORKSPACE, role: 'owner', session_id: 'synthetic-boot-only', authenticated_at: DEMO_TIME, permissions: [] };
  const service = new CommunityPaymentService({ db, accounting: { loadState: () => state, persistAndActivate: () => { throw new Error('DEMO_READ_ONLY'); },
    invoiceEvidence: currentPaymentInvoices, confirmedReconciliation: provedPaymentReconciliation },
    authorize: (p, permission) => p === principal && ['finance:read', 'payments:prepare'].includes(permission), recentAuth: () => false, csrf: () => false,
    credentialResolver: { resolve: async () => { throw new Error('DEMO_NETWORK_DISABLED'); } }, adapter: communitySimulatedPaymentAdapter, now: () => new Date(DEMO_TIME) });
  service.createDraft(principal, ['DEMO-DOC-007', 'DEMO-DOC-009'], syntheticIban, 'Example Demonstration Business');
}

/** Explicit financial allowlist: no raw metadata, credentials, confirmations, sessions, callbacks or provider endpoints. */
export function communityDemoProjection(db: Database.Database, state: MatchingState) {
  if (state.run_id !== DEMO_WORKSPACE) throw new Error('DEMO_SEED_SCOPE_INVALID');
  if (state.transactions.size > 1000 || state.documents.size > 1000) throw new Error('DEMO_PROJECTION_LIMIT');
  const accounts = new Map<string, { source_system: string; source_account_id: string; currencies: string[]; transaction_count: number }>();
  const transactions = [...state.transactions.values()].map(t => {
    const key = JSON.stringify([t.source_system, t.source_account_id]), entry = accounts.get(key) ?? { source_system: t.source_system, source_account_id: t.source_account_id, currencies: [], transaction_count: 0 };
    entry.transaction_count++; if (!entry.currencies.includes(t.currency_code)) entry.currencies.push(t.currency_code); accounts.set(key, entry);
    return { transaction_id: t.transaction_id, source_system: t.source_system, source_account_id: t.source_account_id, source_row_ref: t.source_row_ref,
      posting_at: t.posting_at, amount_minor: t.amount_minor, currency_code: t.currency_code, description_raw: t.description_raw, counterparty_name: t.counterparty_name ?? '',
      ...(t.fx ? { fx: { original_amount_minor: t.fx.original_amount_minor, original_currency_code: t.fx.original_currency_code, rate: t.fx.rate, rate_source: t.fx.rate_source,
        ...(t.fx.fx_fee_minor === undefined ? {} : { fx_fee_minor: t.fx.fx_fee_minor }) } } : {}) };
  });
  const documents = [...state.documents.values()].map(d => ({ document_id: d.document_id, source_system: d.source_system, source_document_ref: d.source_document_ref,
    document_date: d.document_date, total_amount_minor: d.total_amount_minor, currency_code: d.currency_code, supplier_name: d.supplier_name ?? '',
    ...(d.vat_amount_minor === undefined ? {} : { vat_amount_minor: d.vat_amount_minor }), ...(d.vat_rate === undefined ? {} : { vat_rate: d.vat_rate }) }));
  const report = accountingReport(state, { start: '2026-01-01', end: '2026-12-31' });
  const payments = new PaymentRepository(db).list(DEMO_WORKSPACE);
  if (accounts.size > 100 || payments.length > 100 || payments.some(batch => batch.items.length > 100)) throw new Error('DEMO_PROJECTION_LIMIT');
  // Audit IDs are financial provenance only; no audit payload or actor authority is exposed.
  return { mode: 'synthetic-preview' as const, network_enabled: false as const, transactions, documents, accounts: [...accounts.values()], reports: { accounting: report },
    payments: payments.map(batch => ({ id: batch.id, workspaceId: batch.workspaceId, debtorIban: batch.debtorIban, debtorName: batch.debtorName,
      provider: batch.provider, environment: batch.environment, status: batch.status, revision: batch.revision, detailDigest: batch.detailDigest,
      items: batch.items.map(item => ({ id: item.id, documentId: item.documentId, invoiceId: item.invoiceId, sourceHash: item.sourceHash,
        creditorName: item.creditorName, creditorIban: item.creditorIban, amountMinor: item.amountMinor, currency: item.currency, reference: item.reference,
        dueDate: item.dueDate, matchIds: item.matchIds })), createdAt: batch.createdAt })),
    capabilities: { read_only_projection: true, provider_network: false, payment_submission: false, synthetic_data: true } };
}
