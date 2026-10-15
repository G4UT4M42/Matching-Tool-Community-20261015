/**
 * Generate a Report from MatchingState.
 * Deterministically sorted, includes per-currency totals, tax categories, and VAT.
 */
import type { MatchingState, Report, ReportSummary, ReportItem } from '../types.js';
import { stableId } from '../ids.js';
import { getTaxCategory } from '../tax-category.js';

const SCHEMA_VERSIONS: Record<string, string> = {
  Transaction: '1.0.0',
  Document: '1.0.0',
  MatchGroup: '1.0.0',
  Report: '1.0.0',
};

export interface CurrencyTotal {
  currency_code: string;
  total_income_minor: number;
  total_expense_minor: number;
  net_minor: number;
  transaction_count: number;
}

export interface VatSummary {
  tax_category: string | null;
  vat_amount_minor: number;
  net_amount_minor: number;
  gross_amount_minor: number;
  document_count: number;
}

export interface ReportWithExtras extends Report {
  currency_totals: CurrencyTotal[];
  vat_summary: VatSummary[];
  errors: ReportError[];
}

export interface ReportError {
  entity_type: 'transaction' | 'document' | 'match_group';
  entity_id: string;
  code: string;
  message: string;
}

export function generateReport(state: MatchingState): ReportWithExtras {
  const errors: ReportError[] = [];

  // --- Build ReportItems (one per transaction, deterministically sorted) ---
  const txns = [...state.transactions.values()].sort((a, b) =>
    a.posting_at.localeCompare(b.posting_at) || a.transaction_id.localeCompare(b.transaction_id),
  );

  // Build reverse lookup: txnId → MatchGroup
  const txnToMg = new Map<string, import('../types.js').MatchGroup>();
  for (const mg of state.match_groups.values()) {
    for (const tid of mg.transaction_ids) {
      txnToMg.set(tid, mg);
    }
  }

  const items: ReportItem[] = txns.map((t) => {
    const mg = txnToMg.get(t.transaction_id);
    let status: ReportItem['status'];
    if (state.excluded_transaction_ids.has(t.transaction_id)) {
      status = 'excluded';
    } else if (mg?.rule_id === 'MANUAL') {
      status = 'manual';
    } else if (mg) {
      status = 'matched';
    } else {
      status = 'unmatched';
    }

    return {
      transaction_id: t.transaction_id,
      source_system: t.source_system,
      posting_at: t.posting_at,
      amount_minor: t.amount_minor,
      currency_code: t.currency_code,
      description: t.description_raw,
      match_group_id: mg?.match_group_id,
      matched_document_ids: mg?.document_ids ?? [],
      matched_transaction_ids: mg ? mg.transaction_ids.filter((id) => id !== t.transaction_id) : [],
      rule_id: mg?.rule_id,
      status,
    };
  });

  // --- Summary ---
  const bySource: ReportSummary['by_source'] = {};
  for (const t of txns) {
    if (!bySource[t.source_system]) {
      bySource[t.source_system] = { total: 0, matched: 0, unmatched: 0, excluded: 0 };
    }
    bySource[t.source_system].total++;
    if (state.excluded_transaction_ids.has(t.transaction_id)) {
      bySource[t.source_system].excluded++;
    } else if (state.matched_transaction_ids.has(t.transaction_id)) {
      bySource[t.source_system].matched++;
    } else {
      bySource[t.source_system].unmatched++;
    }
  }

  const byRule: Record<string, number> = {};
  for (const mg of state.match_groups.values()) {
    byRule[mg.rule_id] = (byRule[mg.rule_id] ?? 0) + 1;
  }

  const summary: ReportSummary = {
    total_transactions: state.transactions.size,
    matched_transactions: state.matched_transaction_ids.size,
    unmatched_transactions: state.transactions.size - state.matched_transaction_ids.size - state.excluded_transaction_ids.size,
    excluded_transactions: state.excluded_transaction_ids.size,
    total_documents: state.documents.size,
    matched_documents: state.matched_document_ids.size,
    unmatched_documents: state.documents.size - state.matched_document_ids.size,
    match_groups_count: state.match_groups.size,
    by_source: bySource,
    by_rule: byRule,
  };

  // --- Per-currency totals ---
  const currMap = new Map<string, CurrencyTotal>();
  for (const t of txns) {
    let ct = currMap.get(t.currency_code);
    if (!ct) {
      ct = { currency_code: t.currency_code, total_income_minor: 0, total_expense_minor: 0, net_minor: 0, transaction_count: 0 };
      currMap.set(t.currency_code, ct);
    }
    ct.transaction_count++;
    ct.net_minor += t.amount_minor;
    if (t.amount_minor >= 0) {
      ct.total_income_minor += t.amount_minor;
    } else {
      ct.total_expense_minor += t.amount_minor;
    }
  }
  const currencyTotals = [...currMap.values()].sort((a, b) => a.currency_code.localeCompare(b.currency_code));

  // --- VAT summary by tax category ---
  const vatMap = new Map<string, VatSummary>();
  for (const d of state.documents.values()) {
    // Skip income documents for VAT summary
    if (d.source_system === 'income') continue;

    const meta = (d.meta ?? {}) as Record<string, any>;
    const taxRate = meta.tax_rate ?? (d.vat_rate != null ? Math.round(d.vat_rate * 100) : null);
    const vatCountry = meta.vat_country ?? null;
    const category = meta.tax_category ?? getTaxCategory(vatCountry, taxRate) ?? 'uncategorized';

    let vs = vatMap.get(category);
    if (!vs) {
      vs = { tax_category: category === 'uncategorized' ? null : category, vat_amount_minor: 0, net_amount_minor: 0, gross_amount_minor: 0, document_count: 0 };
      vatMap.set(category, vs);
    }
    vs.document_count++;
    vs.gross_amount_minor += d.total_amount_minor;
    vs.vat_amount_minor += d.vat_amount_minor ?? 0;
    vs.net_amount_minor += d.total_amount_minor - (d.vat_amount_minor ?? 0);
  }
  const vatSummary = [...vatMap.values()].sort((a, b) =>
    (a.tax_category ?? 'zzz').localeCompare(b.tax_category ?? 'zzz'),
  );

  // --- VAT validation errors ---
  for (const d of state.documents.values()) {
    if (d.vat_amount_minor != null && d.vat_rate != null) {
      if (d.vat_rate < 0 || d.vat_rate > 1) {
        errors.push({
          entity_type: 'document',
          entity_id: d.document_id,
          code: 'VAT_RATE_OUT_OF_RANGE',
          message: `VAT rate ${d.vat_rate} is not between 0 and 1`,
        });
      }
    }
  }

  // --- Report ID is deterministic from run_id ---
  const reportId = 'RPT-' + stableId(state.run_id, 'report');

  return {
    report_id: reportId,
    run_id: state.run_id,
    created_at: new Date().toISOString(),
    input_manifest: [], // populated by caller if file hashes are available
    schema_versions: SCHEMA_VERSIONS,
    summary,
    items,
    currency_totals: currencyTotals,
    vat_summary: vatSummary,
    errors,
  };
}
