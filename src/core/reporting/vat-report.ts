/**
 * Umsatzsteuer-Bericht Österreich (Austrian VAT Report)
 *
 * Design decisions (answers to clarifying questions):
 * 1) Revenue totals: NETTO + USt separately (both shown).
 * 2) Umsätze Österreich: single bucket (no split by VAT rate) — can be extended later.
 * 3) Code 076 (DE invoices with foreign VAT): excluded from AT VAT payable AND from
 *    AT input VAT deduction. Refund must be claimed in the origin country.
 * 4) 072/065: both acquisition tax base (072) and deductible VAT (065) are shown.
 *    065 amount = 072 net × 20% (Austrian standard rate, self-assessed).
 * 5) Refunds/credit notes: negative amounts reduce the respective bucket automatically.
 *    They are identified by negative total_amount_minor on income docs or positive on expense docs.
 *
 * Amount convention in this report:
 * - All amounts in MINOR units (cents), signed as stored.
 * - Income docs: positive amounts. Expense docs: negative amounts.
 * - For display, expenses are shown as absolute values in the frontend.
 */

import type { MatchingState, Document } from '../types.js';
import { EU_COUNTRIES, normalizeCountryCode } from '../tax-category.js';
import { getDb } from '../../storage/db.js';
import { acceptedDocumentIds, isAcceptedMatchGroup } from './accepted-evidence.js';

const AT_STANDARD_RATE = 0.20;



// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VatReportLinkedTransaction {
  transaction_id: string;
  source_system: string;
  posting_at: string;
  amount_minor: number;
  description_raw: string;
  counterparty_name: string | null;
  doc_count: number;
}

export interface VatReportLine {
  document_id: string;
  filename: string | null;
  document_date: string;
  supplier_name: string | null;
  country_code: string | null;
  country_raw: string | null;
  net_minor: number;
  vat_minor: number;
  gross_minor: number;
  vat_rate: number | null; // decimal 0-1
  source_system: string;
  is_reverse_charge: boolean;
  linked_transactions: VatReportLinkedTransaction[];
}

export interface VatReportCategory {
  code: string;
  title: string;
  total_net_minor: number;
  total_vat_minor: number;
  total_gross_minor: number;
  lines: VatReportLine[];
}

export interface VatReportRevenueBucket {
  code: string;
  label: string;
  total_net_minor: number;
  total_vat_minor: number;
  total_gross_minor: number;
  lines: VatReportLine[];
}

export interface VatReport {
  period_start: string; // YYYY-MM-DD
  period_end: string;
  created_at: string;

  // Revenue (Umsatz)
  revenue_at: VatReportRevenueBucket;
  revenue_non_eu: VatReportRevenueBucket;
  revenue_total_net_minor: number;
  revenue_total_vat_minor: number;
  revenue_total_gross_minor: number;
  revenue_excluded_eu: VatReportRevenueBucket; // EU revenue excluded from this report

  // Input VAT (Vorsteuer) categories
  cat_072: VatReportCategory; // IGL acquisitions standard rate
  cat_076: VatReportCategory; // Taxed in destination country
  cat_065: VatReportCategory; // Input VAT deduction IGL
  cat_066: VatReportCategory; // Input VAT deduction reverse charge
  cat_060: VatReportCategory; // Input VAT deduction AT domestic
  cat_061: VatReportCategory; // Input VAT deduction EUSt (import)

  // Other expenses without VAT relevance
  other_no_vat: VatReportCategory; // Non-EU goods imports (IOSS), 0% — no AT VAT relevance

  // Reconciliation
  total_documents_processed: number;
  total_unclassified: number;
  unclassified_lines: VatReportLine[];
  integrity_warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract country string from document meta depending on source_system */
/**
 * Known service providers and their countries for automatic classification.
 * These are PSPs and SaaS providers whose fees are reverse-charge relevant.
 */
const KNOWN_SUPPLIER_COUNTRIES: Record<string, string> = {
  'stripe': 'IE',          // Stripe Payments Europe, Ireland
  'paypal': 'LU',          // PayPal (Europe) S.à r.l., Luxembourg
  'fiverr': 'IL',          // Fiverr International Ltd., Israel
  'google': 'IE',          // Google Ireland Limited
  'openai': 'IE',          // OpenAI Ireland Limited
  'meta': 'IE',            // Meta Platforms Ireland Limited
  'oculus': 'IE',          // Meta (Oculus)
};

function getCountryRaw(d: Document, vendorOverrides?: Map<string, { country: string | null; name: string | null; is_reverse_charge: boolean }>): string | null {
  const meta = (d.meta ?? {}) as Record<string, any>;
  if (d.source_system === 'income') return meta.land ?? null;
  if (d.source_system === 'amazon') {
    const fromMeta = meta.invoice_country ?? meta.vat_country;
    if (fromMeta) return fromMeta;
    // Fallback: extract country from invoice filename (e.g. "AT4VZHSABEI.pdf" → AT)
    const fn = d.filename ?? '';
    const invoiceMatch = fn.match(/([A-Z]{2})[A-Z0-9]+ABE[A-Z]\.pdf/i);
    if (invoiceMatch) return invoiceMatch[1].toUpperCase();
    return null;
  }

  // User-set vendor overrides take highest priority
  const supplier = (d.supplier_name ?? '').toLowerCase();
  if (vendorOverrides && supplier) {
    const override = vendorOverrides.get(supplier);
    if (override?.country) return override.country;
  }

  // Known supplier names override OCR-detected countries (OCR may be wrong, e.g. "FI" for Fiverr Israel)
  for (const [key, country] of Object.entries(KNOWN_SUPPLIER_COUNTRIES)) {
    if (supplier.includes(key)) return country;
  }

  // Fall back to explicit country in meta
  return meta.invoice_country ?? meta.country ?? meta.vat_country ?? meta.seller_country ?? null;
}

/** Get the VAT rate as a decimal 0-1, normalizing Amazon's whole-number format */
function getVatRateDecimal(d: Document): number | null {
  const meta = (d.meta ?? {}) as Record<string, any>;
  if (d.vat_rate != null) return d.vat_rate;
  if (meta.tax_rate != null) return meta.tax_rate / 100;
  return null;
}

/** Build a VatReportLine from a Document, including linked transactions */
function toLine(d: Document, state: MatchingState, vendorOverrides?: Map<string, { country: string | null; name: string | null; is_reverse_charge: boolean }>): VatReportLine {
  const countryRaw = getCountryRaw(d, vendorOverrides);
  const code = countryRaw ? normalizeCountryCode(countryRaw) : null;
  let vatRate = getVatRateDecimal(d);
  let gross = d.total_amount_minor;
  const meta = (d.meta ?? {}) as Record<string, any>;

  // For FX documents (USD): use EUR amount from matched transaction
  const isFx = d.currency_code === 'USD' || meta.original_currency === 'USD';
  if (isFx) {
    const linkedTxns = findLinkedTransactions(d.document_id, state);
    const eurTxn = linkedTxns.find(t => t.amount_minor !== 0);
    if (eurTxn) {
      gross = eurTxn.amount_minor;
    }
    // If no EUR txn found and gross is likely a USD amount stored as EUR, keep it
    // (will be caught by amount mismatch warning in UI)
  }

  // USt-Betrag: direkt vom Dokument, oder berechnen aus Brutto + Steuersatz
  let vat = d.vat_amount_minor ?? 0;
  let net = gross - vat;

  if (vat === 0 && vatRate != null && vatRate > 0 && gross !== 0) {
    // Berechne USt aus Brutto: Brutto = Netto * (1 + rate) → Netto = Brutto / (1 + rate)
    net = Math.round(gross / (1 + vatRate));
    vat = gross - net;
  }

  // Infer VAT rate from amounts if not set (e.g. Amazon refunds with vat but no rate)
  // Only if vat and net have the same sign (both positive or both negative)
  if ((vatRate == null || vatRate === 0) && vat !== 0 && net !== 0 && (vat > 0) === (net > 0)) {
    const rawRate = Math.abs(vat) / Math.abs(net);
    // Round to nearest 0.5% (e.g. 0.19, 0.20, 0.21, 0.225)
    vatRate = Math.round(rawRate * 200) / 200;
  }

  const supplierKey = (d.supplier_name ?? '').toLowerCase();
  const isRC = vendorOverrides?.get(supplierKey)?.is_reverse_charge ?? false;

  return {
    document_id: d.document_id,
    filename: d.filename ?? null,
    document_date: d.document_date,
    supplier_name: d.supplier_name ?? null,
    country_code: code,
    country_raw: countryRaw,
    net_minor: net,
    vat_minor: vat,
    gross_minor: gross,
    vat_rate: vatRate,
    source_system: d.source_system,
    is_reverse_charge: isRC,
    linked_transactions: findLinkedTransactions(d.document_id, state),
  };
}

function findLinkedTransactions(docId: string, state: MatchingState): VatReportLinkedTransaction[] {
  const result: VatReportLinkedTransaction[] = [];
  for (const mg of state.match_groups.values()) {
    if (!isAcceptedMatchGroup(mg)) continue;
    if (mg.document_ids.includes(docId)) {
      for (const tid of mg.transaction_ids) {
        const t = state.transactions.get(tid);
        if (t) {
          result.push({
            transaction_id: t.transaction_id,
            source_system: t.source_system,
            posting_at: t.posting_at,
            amount_minor: t.amount_minor,
            description_raw: t.description_raw,
            counterparty_name: t.counterparty_name ?? null,
            doc_count: mg.document_ids.length,
          });
        }
      }
    }
  }
  return result;
}

function emptyBucket(code: string, label: string): VatReportRevenueBucket {
  return { code, label, total_net_minor: 0, total_vat_minor: 0, total_gross_minor: 0, lines: [] };
}

function emptyCat(code: string, title: string): VatReportCategory {
  return { code, title, total_net_minor: 0, total_vat_minor: 0, total_gross_minor: 0, lines: [] };
}

function addLine(bucket: { total_net_minor: number; total_vat_minor: number; total_gross_minor: number; lines: VatReportLine[] }, line: VatReportLine) {
  bucket.lines.push(line);
  bucket.total_net_minor += line.net_minor;
  bucket.total_vat_minor += line.vat_minor;
  bucket.total_gross_minor += line.gross_minor;
}

function inPeriod(d: Document, start: string, end: string): boolean {
  const date = d.document_date;
  if (!date) return false;
  return date >= start && date <= end;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function generateVatReport(
  state: MatchingState,
  periodStart: string,
  periodEnd: string,
): VatReport {
  const warnings: string[] = [];

  // Load vendor overrides for country resolution + reverse charge flag
  const vendorOverrides = new Map<string, { country: string | null; name: string | null; is_reverse_charge: boolean }>();
  try {
    const overrideDb = getDb();
    const rows = overrideDb.prepare('SELECT vendor_key, country, name, is_reverse_charge FROM vendor_overrides').all() as any[];
    for (const r of rows) vendorOverrides.set(r.vendor_key, { country: r.country, name: r.name, is_reverse_charge: !!r.is_reverse_charge });
  } catch {}

  // Revenue buckets
  const revenueAt = emptyBucket('022', 'Umsätze Österreich');
  const revenueNonEu = emptyBucket('011', 'Umsätze aus nicht EU Ländern mit 0% USt.');
  const revenueExcludedEu = emptyBucket('---', 'Einnahmen aus anderen EU-Ländern (ausgeschlossen)');

  // Expense categories
  const cat060 = emptyCat('060', 'Vorsteuerabzug Österreich');
  const cat061 = emptyCat('061', 'Vorsteuerabzug EUSt.');
  const cat065 = emptyCat('065', 'Vorsteuerabzug auf innergemeinschaftliche Erwerbe');
  const cat066 = emptyCat('066', 'Vorsteuerabzug reverse charge');
  const otherNoVat = emptyCat('---', 'Sonstige Ausgaben ohne umsatzsteuerliche Relevanz');
  const cat072 = emptyCat('072', 'Innergemeinschaftliche Erwerbe standard Steuersatz');
  const cat076 = emptyCat('076', 'Nicht zu Versteuern weil es im Bestimmungsland besteuert worden sind');

  const unclassifiedLines: VatReportLine[] = [];
  let totalProcessed = 0;

  // Load private/excluded transaction dispositions
  const privatTxnIds = new Set<string>();
  try {
    const dispDb = getDb();
    const dispRows = dispDb.prepare("SELECT transaction_id FROM transaction_dispositions WHERE disposition = 'privat'").all() as { transaction_id: string }[];
    for (const r of dispRows) privatTxnIds.add(r.transaction_id);
  } catch {}

  // Build doc → transaction mapping from match groups
  const docToTxns = new Map<string, string[]>();
  // Track which docs are ONLY linked to transfer/internal match groups (no invoice needed)
  const TRANSFER_RULES = new Set([
    'R-AUTO-PAYPAL_TRANSFER-001', 'R-PAYPAL-INTERNAL_FUNDING-001',
    'R-BANK-SPK_PAYPAL-001', 'R-BANK-SPK_STRIPE-001', 'R-BANK-SPK_STRIPE-003',
    'R-BANK-SPK_VISA-001',
  ]);
  const docToRules = new Map<string, Set<string>>();
  for (const mg of state.match_groups.values()) {
    if (!isAcceptedMatchGroup(mg)) continue;
    for (const docId of mg.document_ids) {
      if (!docToTxns.has(docId)) docToTxns.set(docId, []);
      docToTxns.get(docId)!.push(...mg.transaction_ids);
      if (!docToRules.has(docId)) docToRules.set(docId, new Set());
      docToRules.get(docId)!.add(mg.rule_id);
    }
  }
  const transferOnlyDocs = new Set<string>();
  for (const [docId, rules] of docToRules) {
    if (rules.size > 0 && [...rules].every(r => TRANSFER_RULES.has(r))) {
      transferOnlyDocs.add(docId);
    }
  }

  const acceptedDocs = acceptedDocumentIds(state);
  for (const d of state.documents.values()) {
    if (!inPeriod(d, periodStart, periodEnd)) continue;
    // Only include documents that have a matched bank transaction
    const isCashPayment = ((d.meta ?? {}) as any).cash_payment;
    if (!isCashPayment && !acceptedDocs.has(d.document_id)) continue;
    // Exclude documents whose linked transactions are ALL marked as 'privat'
    const linkedTxns = docToTxns.get(d.document_id) ?? [];
    if (linkedTxns.length > 0 && linkedTxns.every(id => privatTxnIds.has(id))) continue;
    // Skip USD/FX documents without EUR amount (not yet matched with bank transaction)
    if (d.total_amount_minor === 0 && d.currency_code === 'USD') continue;
    // Exclude documents only linked to transfer/internal matches (Umbuchungen between accounts)
    if (transferOnlyDocs.has(d.document_id)) continue;
    totalProcessed++;

    const line = toLine(d, state, vendorOverrides);
    const countryCode = line.country_code;
    const vatRate = line.vat_rate;
    const isIncome = d.source_system === 'income';

    if (isIncome) {
      // ----- REVENUE classification -----
      const isAt20 = countryCode === 'AT' && vatRate != null && Math.round(vatRate * 100) === 20;
      const isAtNoCountry = !countryCode && !line.country_raw;

      if (isAtNoCountry) {
        // No country → cannot confirm AT 20%, exclude with warning
        unclassifiedLines.push(line);
        warnings.push(`Income ${d.document_id}: kein Land angegeben, nicht klassifizierbar`);
      } else if (isAt20) {
        // Only AT with exactly 20% USt goes into Umsätze Österreich
        addLine(revenueAt, line);
      } else if (countryCode === 'AT') {
        // AT but not 20% → unclassified (e.g. reduced rate, 0%, missing rate)
        unclassifiedLines.push(line);
        warnings.push(`Income ${d.document_id}: AT aber Steuersatz ${vatRate != null ? Math.round(vatRate * 100) + '%' : 'fehlt'} (nicht 20%)`);
      } else if (EU_COUNTRIES.has(countryCode!) && countryCode !== 'AT') {
        // EU revenue → excluded from this AT VAT report
        addLine(revenueExcludedEu, line);
      } else {
        // Non-EU → 0% USt for AT purposes
        addLine(revenueNonEu, line);
      }
    } else {
      // ----- EXPENSE classification (input VAT / Vorsteuer) -----

      // Check for EUSt tag (carrier split invoices) — requires non-EU or AT country
      const meta = (d.meta ?? {}) as Record<string, any>;
      const tags: string[] = meta.tags ?? [];
      if ((tags.includes('eust') || meta.split_type === 'eust') && (!countryCode || countryCode === 'AT' || !EU_COUNTRIES.has(countryCode))) {
        addLine(cat061, line);
        continue;
      }

      if (!countryCode) {
        unclassifiedLines.push(line);
        continue;
      }

      // Explicit reverse charge vendor flag overrides normal classification (for any non-AT country)
      const supplierLower = (d.supplier_name ?? '').toLowerCase();
      const vendorRC = vendorOverrides?.get(supplierLower)?.is_reverse_charge ?? false;

      if (vendorRC && countryCode !== 'AT') {
        // 066: Reverse charge — user explicitly marked this vendor
        addLine(cat066, line);
      } else if (countryCode === 'AT') {
        const hasAt20 = vatRate != null && Math.round(vatRate * 100) === 20;
        const missingRate = vatRate == null || vatRate === 0;
        if (hasAt20) {
          // Input VAT must be supported by documented VAT evidence, not source-system assumptions.
          addLine(cat060, line);
        } else if (vatRate == null) {
          unclassifiedLines.push(line);
          warnings.push(`Expense ${d.document_id}: AT VAT rate missing; no input VAT deduction without original evidence`);
        } else if (missingRate) {
          // Documented 0% VAT is not an automatic input VAT deduction.
          addLine(otherNoVat, line);
        } else {
          // AT but non-standard rate → unclassified
          unclassifiedLines.push(line);
          warnings.push(`Expense ${d.document_id}: AT aber Steuersatz ${Math.round(vatRate! * 100)}% (nicht 20%)`);
        }
      } else if (EU_COUNTRIES.has(countryCode)) {
        const hasVat = vatRate != null && vatRate > 0;
        if (hasVat) {
          // 076: EU invoice WITH foreign VAT charged (e.g., DE 19%)
          // Not deductible in AT, must claim refund in origin country
          addLine(cat076, line);
        } else {
          // 072: Intra-community acquisition (IGL), 0% VAT on invoice
          addLine(cat072, line);
        }
      } else {
        // Non-EU supplier
        const meta = (d.meta ?? {}) as Record<string, any>;
        const category = String(meta.category ?? meta.ausgaben_kategorie ?? '').toLowerCase();
        const sourceSystem = d.source_system;

        {
          // Detect goods imports (Warenimporte) — NOT reverse charge
          const isGoodsImport = category.includes('import') || category.includes('einfuhr') ||
            category.includes('eust') || category.includes('zoll') ||
            // AliExpress/Alibaba are always physical goods from CN
            (sourceSystem as string) === 'aliexpress' ||
            supplierLower.includes('aliexpress') || supplierLower.includes('alibaba');

          if (isGoodsImport) {
            // Non-EU goods imports: no AT VAT relevance
            // AliExpress/Alibaba: VAT collected at checkout via IOSS (included in price)
            // No input VAT deduction possible — goes to "sonstige Ausgaben"
            addLine(otherNoVat, line);
          } else {
            // 066: Reverse charge services from non-EU (e.g. digital services, SaaS)
            addLine(cat066, line);
          }
        }
      }
    }
  }

  // Revenue totals (AT + non-EU only; EU excluded)
  const revTotalNet = revenueAt.total_net_minor + revenueNonEu.total_net_minor;
  const revTotalVat = revenueAt.total_vat_minor + revenueNonEu.total_vat_minor;
  const revTotalGross = revenueAt.total_gross_minor + revenueNonEu.total_gross_minor;

  // Sort all detail lists by document_date
  const sortLines = (lines: VatReportLine[]) =>
    lines.sort((a, b) => a.document_date.localeCompare(b.document_date) || a.document_id.localeCompare(b.document_id));

  sortLines(revenueAt.lines);
  sortLines(revenueNonEu.lines);
  sortLines(revenueExcludedEu.lines);
  sortLines(cat060.lines);
  sortLines(cat061.lines);
  sortLines(cat066.lines);
  sortLines(cat072.lines);

  // 065: Virtual category — deductible input VAT = 072 total × AT standard rate (self-assessed)
  // No individual lines, only totals computed from 072
  cat065.total_net_minor = cat072.total_net_minor;
  cat065.total_vat_minor = Math.round(cat072.total_net_minor * AT_STANDARD_RATE);
  cat065.total_gross_minor = cat072.total_gross_minor;
  sortLines(cat076.lines);
  sortLines(otherNoVat.lines);
  sortLines(unclassifiedLines);

  // Integrity check: broken file links flagged as warnings
  const allLines = [
    ...revenueAt.lines, ...revenueNonEu.lines, ...revenueExcludedEu.lines,
    ...cat060.lines, ...cat061.lines, ...cat066.lines, ...cat072.lines, ...cat076.lines,
    ...otherNoVat.lines, ...unclassifiedLines,
  ];
  for (const l of allLines) {
    // Structured exports and generated refund records are valid source documents
    // without a local file. A missing filename is only an integrity problem for
    // file-backed invoice scans.
    if (
      l.source_system === 'invoice_scan'
      && (!l.filename || l.filename === 'NO FILENAME' || l.filename === '-')
    ) {
      warnings.push(`${l.document_id}: kein Dateiname vorhanden`);
    }
  }

  return {
    period_start: periodStart,
    period_end: periodEnd,
    created_at: new Date().toISOString(),

    revenue_at: revenueAt,
    revenue_non_eu: revenueNonEu,
    revenue_total_net_minor: revTotalNet,
    revenue_total_vat_minor: revTotalVat,
    revenue_total_gross_minor: revTotalGross,
    revenue_excluded_eu: revenueExcludedEu,

    cat_072: cat072,
    cat_076: cat076,
    cat_065: cat065,
    cat_066: cat066,
    cat_060: cat060,
    cat_061: cat061,

    other_no_vat: otherNoVat,

    total_documents_processed: totalProcessed,
    total_unclassified: unclassifiedLines.length,
    unclassified_lines: unclassifiedLines,
    integrity_warnings: warnings,
  };
}
