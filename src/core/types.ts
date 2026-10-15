/**
 * Canonical types per data contracts (docs/04_DATA_CONTRACTS/schemas/).
 * Transaction amounts use signed integer minor units. Documents retain their source amount convention; see community/accounting/document-settlement.ts.
 */

// --- Source systems ---
export type SourceSystem = 'sparkasse' | 'visa' | 'paypal' | 'stripe' | 'income' | 'amazon' | 'upload' | 'email';

export type TransactionSourceSystem = 'sparkasse' | 'visa' | 'paypal' | 'stripe' | 'enablebanking';
export type DocumentSourceSystem = 'income' | 'upload' | 'email' | 'amazon' | 'extracted_invoice' | 'invoice_file' | 'stripe_fee' | 'invoice_scan' | 'bank_fee' | 'manual';

// --- FX ---
export interface FxInfo {
  original_amount_minor: number;
  original_currency_code: string;
  rate: number;
  rate_source: string;
  fx_fee_minor?: number;
}

// --- Transaction (immutable record from raw source) ---
export interface Transaction {
  transaction_id: string;
  source_system: TransactionSourceSystem;
  source_account_id: string;
  source_row_ref: string;
  posting_at: string; // ISO-8601
  value_at?: string;
  amount_minor: number; // signed integer cents
  currency_code: string; // ISO-4217
  description_raw: string;
  counterparty_name?: string;
  counterparty_iban?: string;
  booking_reference?: string;
  payment_reference?: string;
  fx?: FxInfo;
  tags: string[];
  // Source-specific extras stored here
  meta: Record<string, unknown>;
}

// --- Document (invoice/receipt) ---
export interface Document {
  document_id: string;
  source_system: DocumentSourceSystem;
  source_document_ref: string;
  captured_at: string;
  document_date: string;
  total_amount_minor: number;
  currency_code: string;
  supplier_name?: string;
  vat_amount_minor?: number;
  vat_rate?: number; // decimal 0-1
  line_items?: LineItem[];
  file_hash?: string;
  filename?: string;
  meta: Record<string, unknown>;
}

export interface LineItem {
  description: string;
  amount_minor: number;
  quantity?: number;
}

// --- MatchGroup ---
export type MatchStatus = 'proposed' | 'accepted' | 'rejected' | 'manual' | 'confirmed';

export interface MatchGroup {
  match_group_id: string;
  status: MatchStatus;
  created_at: string;
  created_by: string; // 'system' or user ID
  rule_id: string; // R-DOMAIN-PAIR-NNN or 'MANUAL'
  transaction_ids: string[];
  document_ids: string[];
  amount_total_minor: number;
  currency_code: string;
  evidence?: Record<string, unknown>;
  reason_codes: string[];
  correlation_id?: string;
}

// --- Exclusion Rule ---
export interface ExclusionRule {
  exclusion_id: string;
  created_at: string;
  created_by: string;
  field: string; // e.g. 'counterparty_name', 'description_raw'
  operator: 'contains' | 'equals' | 'starts_with' | 'regex';
  value: string;
  source_system?: TransactionSourceSystem;
  enabled: boolean;
  description?: string;
}

// --- Report ---
export interface ReportSummary {
  total_transactions: number;
  matched_transactions: number;
  unmatched_transactions: number;
  excluded_transactions: number;
  total_documents: number;
  matched_documents: number;
  unmatched_documents: number;
  match_groups_count: number;
  by_source: Record<string, { total: number; matched: number; unmatched: number; excluded: number }>;
  by_rule: Record<string, number>;
}

export interface ReportItem {
  transaction_id: string;
  source_system: string;
  posting_at: string;
  amount_minor: number;
  currency_code: string;
  description: string;
  match_group_id?: string;
  matched_document_ids: string[];
  matched_transaction_ids: string[];
  rule_id?: string;
  status: 'matched' | 'unmatched' | 'excluded' | 'manual';
}

export interface Report {
  report_id: string;
  run_id: string;
  created_at: string;
  input_manifest: { filename: string; hash: string }[];
  schema_versions: Record<string, string>;
  summary: ReportSummary;
  items: ReportItem[];
}

// --- Disposition ---
export type Disposition = 'matched' | 'privat' | 'ok_no_match' | 'quarterly_aggregate' | 'open' | 'steuerzahlung';

export interface TransactionDisposition {
  transaction_id: string;
  disposition: Disposition;
  set_at: string;
  set_by: string;
  note?: string;
  aggregate_quarter?: string; // e.g. '2025-Q1', only for 'quarterly_aggregate'
}

export interface DocumentDisposition {
  document_id: string;
  disposition: Disposition;
  set_at: string;
  set_by: string;
  note?: string;
}

// --- Audit ---
export type AuditAction =
  | 'TRANSACTIONS_IMPORTED'
  | 'STATE_COMMITTED'
  | 'MATCH_ACCEPTED'
  | 'MATCH_PROPOSED'
  | 'MATCH_REJECTED'
  | 'MATCH_REOPENED'
  | 'MATCH_CREATED_MANUAL'
  | 'MATCH_DELETED'
  | 'MATCHGROUP_SPLIT'
  | 'MATCHGROUP_MERGE'
  | 'DOCUMENT_CORRECTED'
  | 'VAT_OVERRIDE_APPLIED'
  | 'EXCLUSION_CREATED'
  | 'EXCLUSION_DELETED'
  | 'EXCLUSION_TOGGLED'
  | 'DISPOSITION_SET'
  | 'RUN_STARTED'
  | 'RUN_FINISHED'
  | 'ACCOUNTING_ALLOCATED'
  | 'ACCOUNTING_ALLOCATION_UNDONE'
  | 'ACCOUNTING_CLASSIFIED'
  | 'ACCOUNTING_TAX_CLASSIFIED'
  | 'ACCOUNTING_DISPOSITION_SET'
  | 'ACCOUNTING_EXCLUSION_RULE_CREATED';

export interface AuditEvent {
  audit_id: string;
  timestamp: string;
  actor_type: 'system' | 'user';
  actor_id: string;
  action: AuditAction;
  entity_type: 'MatchGroup' | 'Transaction' | 'Document' | 'ExclusionRule' | 'Run';
  entity_id: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  run_id?: string;
  correlation_id?: string;
}

// --- Pipeline state ---
export interface MatchingState {
  run_id: string;
  transactions: Map<string, Transaction>;
  documents: Map<string, Document>;
  match_groups: Map<string, MatchGroup>;
  exclusion_rules: ExclusionRule[];
  audit_events: AuditEvent[];
  // Track which transactions/documents are already matched
  matched_transaction_ids: Set<string>;
  matched_document_ids: Set<string>;
  excluded_transaction_ids: Set<string>;
  /** Optional reviewed accounting capability; absent in historical v1 snapshots. */
  accounting?: CommunityAccounting;
}

export type AllocationKind = 'payment' | 'refund' | 'credit_note' | 'fee' | 'transfer';
export interface ExactConversion {
  numerator: number;
  denominator: number;
  source: string;
  evidence_ref: string;
}
export interface CommunityAllocation {
  allocation_id: string;
  batch_id: string;
  kind: AllocationKind;
  transaction_id: string;
  document_id?: string;
  transaction_amount_minor: number;
  document_amount_minor?: number;
  conversion?: ExactConversion;
  status: 'accepted' | 'rejected';
  created_at: string;
  created_by: string;
  evidence_ref: string;
}
export type FinancialCategory = 'income' | 'expense' | 'fee' | 'refund' | 'transfer' | 'private' | 'unclassified';
export interface TransactionClassification {
  transaction_id: string;
  category: FinancialCategory;
  evidence_ref: string;
  set_at: string;
  set_by: string;
}
export interface DocumentTaxClassification {
  document_id: string;
  tax_category: 'output' | 'input' | 'exempt' | 'outside_scope' | 'unclassified';
  rate_numerator: number;
  rate_denominator: number;
  vat_minor: number;
  input_tax_eligible: boolean;
  evidence_ref: string;
  set_at: string;
  set_by: string;
}
export interface CommunityAccounting {
  capability: 'exact-accounting-v1';
  revision: number;
  allocations: CommunityAllocation[];
  classifications: TransactionClassification[];
  document_taxes: DocumentTaxClassification[];
}
