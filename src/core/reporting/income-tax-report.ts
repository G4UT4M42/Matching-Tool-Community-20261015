/**
 * Einkommensteuer-Bericht (Austrian Income Tax Report - E1a)
 *
 * Categorizes all matched expenses into Austrian tax categories (Kennzahlen).
 * Vendor → KZ mapping is based on vendor names with user overrides from vendor_overrides.tax_category_kz.
 */

import type { MatchingState, Document } from '../types.js';
import { getDb } from '../../storage/db.js';
import { acceptedDocumentIds, isAcceptedMatchGroup } from './accepted-evidence.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IncomeTaxLine {
  document_id: string;
  document_date: string;
  supplier_name: string | null;
  net_minor: number;
  vat_minor: number;
  gross_minor: number;
  filename: string | null;
  source_system: string;
  needs_receipt: boolean;
  issue_accepted: { issue: string; reason: string; date: string } | null;
  description: string | null;
  details: { category: string; lines: string[] } | null;
  linked_transactions: Array<{
    transaction_id: string;
    source_system: string;
    posting_at: string;
    amount_minor: number;
    description_raw: string;
    counterparty_name: string | null;
    doc_count: number;
  }>;
}

export interface IncomeTaxCategory {
  kz: string;
  title: string;
  total_net_minor: number;
  lines: IncomeTaxLine[];
}

export interface IncomeTaxReport {
  period_start: string;
  period_end: string;
  created_at: string;

  // Revenue (Einnahmen)
  revenue_total_net_minor: number;
  revenue_lines: IncomeTaxLine[];

  // Expense categories
  categories: IncomeTaxCategory[];

  // Unclassified expenses
  unclassified: IncomeTaxLine[];

  // Totals
  expenses_total_net_minor: number;
  profit_minor: number; // revenue - expenses

  total_documents_processed: number;
}

// ---------------------------------------------------------------------------
// Vendor → KZ Mapping
// ---------------------------------------------------------------------------

const KZ_TITLES: Record<string, string> = {
  '9040': 'Betriebseinnahmen (Umsätze)',
  '9100': 'Waren, Rohstoffe, Hilfsstoffe',
  '9110': 'Beigestelltes Personal (Fremdpersonal)',
  '9130': 'AfA (Abschreibung)',
  '9180': 'Miet- und Pachtaufwand, Leasing',
  '9190': 'Provisionen an Dritte, Lizenzgebühren',
  '9225': 'Eigene Pflichtversicherungsbeiträge',
  '9230': 'Restliche Ausgaben',
  '9275': 'Arbeitszimmer',
};

/** Default vendor → KZ mapping. Checked in order; first match wins.
 *  More specific patterns MUST come before generic ones (e.g. 'hsh immobilien' before 'obi'). */
const VENDOR_CATEGORY_MAP: Array<{ patterns: string[]; kz: string }> = [
  // 9225 SVA — must be before 9230 (bank_fee fallback)
  { patterns: ['sva', 'svs', 'sozialversicherung'], kz: '9225' },
  // 9180 Miete/Leasing — must be before 9100 ('obi' in 'Immobilien' false positive)
  { patterns: ['hsh immobilien', 'self storage', 'selfstorage'], kz: '9180' },
  // 9275 Arbeitszimmer
  { patterns: ['gws'], kz: '9275' },
  // 9130 AfA
  { patterns: ['bambulab', 'bambu lab', 'motion cars'], kz: '9130' },
  // 9110 Beigestelltes Personal
  { patterns: ['weship', 'we ship', 'fiverr', 'meow arts', 'reflection media', 'google*ads', 'google ads'], kz: '9110' },
  // 9100 Waren, Rohstoffe, Hilfsstoffe
  { patterns: [
    'amazon', 'aliexpress', 'alibaba', 'tomtop', 'temu', 'hofer', 'obi markt', 'obi gmbh', 'bauhaus',
    'nero commerce', 'skyplast', 'mydisplays', 'euroelectronics', 'stm', 'qidi tech',
    'flying bear', '3djake', 'niceshops', 'druck.at', 'arduino', 'hornbach',
    'ips karton', 'reichelt', 'primus elektro', 'pu-parts', 'logoix',
  ], kz: '9100' },
  // 9190 Provisionen/Lizenzen
  { patterns: [
    'openai', 'runway', 'elevenlabs', 'eleven labs', 'ionos', 'domainfactory', 'domain factory',
    'nordvpn', 'spotify', 'openrouter', 'leonardo', 'midjourney', 'unity', 'epidemic sound',
    'construct', 'scirra', 'gravity forms', 'wp-staging',
    'fastspring', 'cults3d', 'cults', 'turbosquid', 'envato', 'pika', 'lumalabs', 'luma labs',
  ], kz: '9190' },
  // 9230 Restliche Ausgaben
  { patterns: [
    'post ag', 'österreichische post', 'apple', 'merkur versicherung', 'fedex', 'ups', 'dpd',
    'wk steiermark', 'td express', 'kontoführung', 'amazon prime', 'dhl', 'schenker',
    'cleverbridge', 'google one',
  ], kz: '9230' },
];

// PSP fees are always 9230
const FEE_SOURCE_SYSTEMS = new Set(['stripe_fee', 'bank_fee']);

function getVendorKz(
  d: Document,
  vendorKzOverrides: Map<string, string>,
): string | null {
  // 1. Per-document override (set via inline KZ assignment)
  const meta = (d.meta ?? {}) as Record<string, any>;
  if (meta.tax_category_kz) return meta.tax_category_kz;

  const supplier = (d.supplier_name ?? '').toLowerCase();

  // 2. PSP fees → 9230 (but not SVA/insurance which also use bank_fee source)
  if (FEE_SOURCE_SYSTEMS.has(d.source_system) && !supplier) return '9230';

  if (!supplier) return null;

  // 3. User overrides from vendor_overrides.tax_category_kz
  const override = vendorKzOverrides.get(supplier);
  if (override) return override;

  // 3. Default map
  for (const entry of VENDOR_CATEGORY_MAP) {
    for (const pattern of entry.patterns) {
      if (supplier.includes(pattern.toLowerCase())) return entry.kz;
    }
  }

  // 4. Check counterparty from linked transactions
  return null;
}

// ---------------------------------------------------------------------------
// Report Generation
// ---------------------------------------------------------------------------

const TRANSFER_RULES = new Set([
  'R-AUTO-PAYPAL_TRANSFER-001', 'R-PAYPAL-INTERNAL_FUNDING-001',
  'R-BANK-SPK_PAYPAL-001', 'R-BANK-SPK_STRIPE-001', 'R-BANK-SPK_STRIPE-003',
  'R-BANK-SPK_VISA-001',
]);

function inPeriod(d: Document, start: string, end: string): boolean {
  const date = d.document_date?.slice(0, 10) ?? '';
  return date >= start && date <= end;
}

function findLinkedTransactions(docId: string, state: MatchingState) {
  const result: IncomeTaxLine['linked_transactions'] = [];
  for (const mg of state.match_groups.values()) {
    if (!isAcceptedMatchGroup(mg)) continue;
    if (!mg.document_ids.includes(docId)) continue;
    for (const txnId of mg.transaction_ids) {
      const txn = state.transactions.get(txnId);
      if (!txn) continue;
      result.push({
        transaction_id: txn.transaction_id,
        source_system: txn.source_system,
        posting_at: txn.posting_at,
        amount_minor: txn.amount_minor,
        description_raw: String(txn.description_raw ?? ''),
        counterparty_name: txn.counterparty_name ?? null,
        doc_count: mg.document_ids.length,
      });
    }
  }
  return result;
}

function toLine(d: Document, state: MatchingState): IncomeTaxLine {
  const meta = (d.meta ?? {}) as Record<string, any>;
  let gross = d.total_amount_minor;
  let vat = d.vat_amount_minor ?? 0;

  const linkedTxns = findLinkedTransactions(d.document_id, state);

  // For FX documents (USD invoices matched to EUR transactions):
  // Use the EUR transaction amount instead of the USD invoice amount
  const isFx = d.currency_code === 'USD' || meta.original_currency === 'USD';
  if (isFx) {
    const eurTxn = linkedTxns.find(t => t.amount_minor !== 0);
    if (eurTxn) {
      gross = eurTxn.amount_minor;
      vat = 0; // FX invoices have no VAT
    }
  }

  const net = gross - vat;

  return {
    document_id: d.document_id,
    document_date: d.document_date,
    supplier_name: d.supplier_name ?? null,
    net_minor: net,
    vat_minor: vat,
    gross_minor: gross,
    filename: d.filename ?? null,
    source_system: d.source_system,
    needs_receipt: !!meta.needs_receipt,
    issue_accepted: meta.issue_accepted ?? null,
    description: meta.description ?? null,
    details: meta.details ?? null,
    linked_transactions: linkedTxns,
  };
}

export function generateIncomeTaxReport(
  state: MatchingState,
  periodStart: string,
  periodEnd: string,
): IncomeTaxReport {
  // Load vendor KZ overrides
  const vendorKzOverrides = new Map<string, string>();
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT vendor_key, tax_category_kz FROM vendor_overrides WHERE tax_category_kz IS NOT NULL AND tax_category_kz != ''"
    ).all() as any[];
    for (const r of rows) vendorKzOverrides.set(r.vendor_key, r.tax_category_kz);
  } catch {}

  // Load privat dispositions
  const privatTxnIds = new Set<string>();
  try {
    const db = getDb();
    const rows = db.prepare("SELECT transaction_id FROM transaction_dispositions WHERE disposition = 'privat'").all() as { transaction_id: string }[];
    for (const r of rows) privatTxnIds.add(r.transaction_id);
  } catch {}

  // Build doc → txn + rule mapping, and identify EUSt-only docs
  const docToTxns = new Map<string, string[]>();
  const docToRules = new Map<string, Set<string>>();
  const eustDocIds = new Set<string>(); // EUSt portion docs (exclude from income tax)
  for (const mg of state.match_groups.values()) {
    if (!isAcceptedMatchGroup(mg)) continue;
    for (const docId of mg.document_ids) {
      if (!docToTxns.has(docId)) docToTxns.set(docId, []);
      docToTxns.get(docId)!.push(...mg.transaction_ids);
      if (!docToRules.has(docId)) docToRules.set(docId, new Set());
      docToRules.get(docId)!.add(mg.rule_id);
    }
    // EUSt groups: exclude the EUSt tax portion, keep only the service/shipping fee
    if (mg.rule_id === 'R-EUST-GROUP-001' && mg.document_ids.length >= 2) {
      const groupDocs = mg.document_ids.map(id => state.documents.get(id)).filter(Boolean) as Document[];
      if (groupDocs.length >= 2) {
        // Sort by absolute amount — smallest is the service fee, rest are EUSt
        const sorted = [...groupDocs].sort((a, b) => Math.abs(a.total_amount_minor) - Math.abs(b.total_amount_minor));
        // Keep the smallest (service fee), exclude the rest (EUSt portions)
        for (let i = 1; i < sorted.length; i++) {
          eustDocIds.add(sorted[i].document_id);
        }
      }
    }
  }

  // Transfer-only docs
  const transferOnlyDocs = new Set<string>();
  for (const [docId, rules] of docToRules) {
    if (rules.size > 0 && [...rules].every(r => TRANSFER_RULES.has(r))) {
      transferOnlyDocs.add(docId);
    }
  }

  // Categorize
  const categoryMap = new Map<string, IncomeTaxCategory>();
  for (const kz of Object.keys(KZ_TITLES)) {
    if (kz === '9040') continue; // revenue handled separately
    categoryMap.set(kz, { kz, title: KZ_TITLES[kz], total_net_minor: 0, lines: [] });
  }

  const revenueLines: IncomeTaxLine[] = [];
  const unclassified: IncomeTaxLine[] = [];
  let totalProcessed = 0;
  let revenueTotalGross = 0;
  let expensesTotalGross = 0;

  // Also load manual docs from DB (they aren't in state)
  try {
    const db = getDb();
    const manualDocs = db.prepare("SELECT * FROM documents WHERE source_system = 'manual'").all() as any[];
    for (const row of manualDocs) {
      if (!state.documents.has(row.document_id)) {
        state.documents.set(row.document_id, {
          document_id: row.document_id, source_system: row.source_system,
          source_document_ref: row.source_document_ref, captured_at: row.captured_at,
          document_date: row.document_date, total_amount_minor: row.total_amount_minor,
          currency_code: row.currency_code, supplier_name: row.supplier_name ?? undefined,
          vat_amount_minor: row.vat_amount_minor ?? undefined, vat_rate: row.vat_rate ?? undefined,
          filename: row.filename ?? undefined, meta: JSON.parse(row.meta || '{}'),
        });
      }
    }
  } catch {}

  const acceptedDocs = acceptedDocumentIds(state);
  for (const d of state.documents.values()) {
    if (!inPeriod(d, periodStart, periodEnd)) continue;
    // Manual docs and cash payments are always included (no bank match needed)
    const isCash = ((d.meta ?? {}) as any).cash_payment;
    if (d.source_system !== 'manual' && !isCash && !acceptedDocs.has(d.document_id)) continue;

    // Exclude privat
    const linkedTxns = docToTxns.get(d.document_id) ?? [];
    if (linkedTxns.length > 0 && linkedTxns.every(id => privatTxnIds.has(id))) continue;

    // Exclude transfers
    if (transferOnlyDocs.has(d.document_id)) continue;

    // Skip zero USD docs
    if (d.total_amount_minor === 0 && d.currency_code === 'USD') continue;

    // Exclude EUSt tax portion (only shipping/service fee stays as expense)
    if (eustDocIds.has(d.document_id)) continue;

    totalProcessed++;
    const line = toLine(d, state);
    const isIncome = d.source_system === 'income';
    // WooCommerce invoices/refunds (WC-XXXXX-Invoice/refund) are outgoing → revenue
    const isWcRevenue = /^WC-\d+-(?:Invoice|refund)/i.test(d.filename ?? '');

    if (isIncome || isWcRevenue) {
      revenueLines.push(line);
      revenueTotalGross += line.net_minor;
      continue;
    }

    // Expense classification
    const kz = getVendorKz(d, vendorKzOverrides);
    if (kz === '9040' || kz === 'refund') {
      // Reclassified as revenue/refund
      revenueLines.push(line);
      revenueTotalGross += line.net_minor;
    } else if (kz && categoryMap.has(kz)) {
      const cat = categoryMap.get(kz)!;
      cat.lines.push(line);
      // Signed sum: expenses are negative, refunds positive → abs of signed sum = net expense
      cat.total_net_minor += line.net_minor;
    } else {
      unclassified.push(line);
    }
    if (kz !== '9040' && kz !== 'refund') {
      expensesTotalGross += line.net_minor;
    }
  }

  // Sort lines within categories
  const sortLines = (lines: IncomeTaxLine[]) =>
    lines.sort((a, b) => a.document_date.localeCompare(b.document_date));

  const categories = [...categoryMap.values()]
    .filter(c => c.lines.length > 0)
    .sort((a, b) => a.kz.localeCompare(b.kz));
  // Convert signed totals to absolute (refunds already subtracted)
  for (const cat of categories) {
    cat.total_net_minor = Math.abs(cat.total_net_minor);
    sortLines(cat.lines);
  }
  sortLines(revenueLines);
  sortLines(unclassified);

  return {
    period_start: periodStart,
    period_end: periodEnd,
    created_at: new Date().toISOString(),
    revenue_total_net_minor: revenueTotalGross,
    revenue_lines: revenueLines,
    categories,
    unclassified,
    expenses_total_net_minor: Math.abs(expensesTotalGross),
    profit_minor: revenueTotalGross - Math.abs(expensesTotalGross),
    total_documents_processed: totalProcessed,
  };
}
