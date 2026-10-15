import { Router } from 'express';
import { createMatchDecisionRouter } from './match-decisions.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
import type { MatchingState, MatchGroup, ExclusionRule, Disposition } from '../../core/types.js';
import { ingestAndNormalize } from '../../core/pipeline.js';
import { runMatchingEngine, createMatch } from '../../core/matching/engine.js';
import { ALL_RULES } from '../../core/matching/rules/index.js';
import { saveState } from '../../storage/json-store.js';
import { matchGroupId, exclusionId, documentId } from '../../core/ids.js';
import { recordAudit } from '../../observability/audit.js';
import { fromMinor } from '../../core/normalization/amount.js';
import { getTaxCategory } from '../../core/tax-category.js';
import { generateReport } from '../../core/reporting/generate-report.js';
import { exportCsv } from '../../core/reporting/export-csv.js';
import { exportJson } from '../../core/reporting/export-json.js';
import { generateVatReport } from '../../core/reporting/vat-report.js';
import { generateIncomeTaxReport } from '../../core/reporting/income-tax-report.js';
import { importStripeTransactions, generateMonthlyFeeSummaries as generateStripeFeeSummaries } from '../../import/stripe-import.js';
import { importPayPalTransactions, generateMonthlyFeeSummaries as generatePayPalFeeSummaries } from '../../import/paypal-import.js';
import {
  listAspsps, startAuth, createSession, getSession, getBalances,
} from '../../import/enablebanking-api.js';
import { importBankTransactions } from '../../import/bank-import.js';
import { createStatementImportRouter } from './statement-import.js';
import { createStatementPreviewRouter } from './statement-preview.js';
import { importAmazon, linkInvoicePdfs, enrichAmazonDocsFromPdfs } from '../../import/amazon-import.js';
import { importDocumentFile, type DocImportType } from '../../import/document-import.js';
import { getSetting, setSetting, deleteSetting } from '../../storage/settings.js';
import { settingForHttp } from '../settings-security.js';
import { setDisposition, setDispositionBatch, autoMarkPrivateVendors } from '../../storage/disposition.js';
import { getDb } from '../../storage/db.js';
import { createBackup, listBackups } from '../../storage/backup.js';
import { moveToTrash, listTrash, restoreFromTrash, deleteFromTrash, emptyTrash } from '../../storage/trash.js';
import { processBatch, processFile } from '../../invoicerec/pipeline.js';
import * as irStore from '../../invoicerec/store.js';
import { learnTemplate } from '../../invoicerec/template-learn.js';
import { validateFields } from '../../invoicerec/validate.js';
import { applyVendorOverride } from '../../invoicerec/vendor-override.js';
import { listOpenRouterModels } from '../../invoicerec/extract-ai.js';
import { paymentSummary } from '../../payments/candidates.js';
import { PaymentRepository } from '../../payments/repository.js';
import { PaymentService } from '../../payments/service.js';
import { createPaymentsRouter } from './payments.js';

// Multer: store uploaded files in OS temp dir
const upload = multer({ dest: os.tmpdir() });

const DATA_DIR = process.env.DATA_DIR ?? 'legacy/real-data-examples';
const BELEGE_DIR = path.resolve('Belege');

export function createApiRouter(
  getState: () => MatchingState,
  setState: (s: MatchingState) => void,
  persistMatching?: (before: MatchingState, next: MatchingState, actor: string) => void,
): Router {
  const router = Router();
  router.use('/payments', createPaymentsRouter(new PaymentService()));

  const isInRequestedPeriod = (date: string | undefined, year?: string, quarter?: string): boolean => {
    if (!year) return true;
    if (!date) return false;
    const qNum = quarter ? parseInt(quarter, 10) : null;
    const startMonth = qNum ? (qNum - 1) * 3 + 1 : 1;
    const endMonth = qNum ? qNum * 3 : 12;
    const start = `${year}-${String(startMonth).padStart(2, '0')}-01`;
    const end = `${year}-${String(endMonth).padStart(2, '0')}-${new Date(parseInt(year, 10), endMonth, 0).getDate()}`;
    const datePart = date.slice(0, 10);
    const germanDate = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(datePart);
    const normalizedDate = germanDate ? `${germanDate[3]}-${germanDate[2]}-${germanDate[1]}` : datePart;
    return normalizedDate >= start && normalizedDate <= end;
  };

  const stateForRequestedPeriod = (state: MatchingState, year?: string, quarter?: string): MatchingState => {
    if (!year) return state;
    const transactions = new Map([...state.transactions].filter(([, t]) => isInRequestedPeriod(t.posting_at, year, quarter)));
    const documents = new Map([...state.documents].filter(([, d]) => isInRequestedPeriod(d.document_date, year, quarter)));
    const match_groups = new Map([...state.match_groups].filter(([, group]) =>
      group.transaction_ids.some(id => transactions.has(id)) || group.document_ids.some(id => documents.has(id))
    ));
    return {
      ...state,
      transactions,
      documents,
      match_groups,
      matched_transaction_ids: new Set([...state.matched_transaction_ids].filter(id => transactions.has(id))),
      matched_document_ids: new Set([...state.matched_document_ids].filter(id => documents.has(id))),
      excluded_transaction_ids: new Set([...state.excluded_transaction_ids].filter(id => transactions.has(id))),
    };
  };

  // ===== Pipeline (legacy — re-ingests from Excel files, OVERWRITES current data) =====
  // DISABLED: Use POST /match instead, which only runs rules on existing imported data.
  // Re-ingesting destroys user-imported transaction data.
  router.post('/run', (_req, res) => {
    res.status(400).json({
      ok: false,
      error: 'POST /run ist deaktiviert — verwende POST /match um Matching-Regeln auf bestehende Daten anzuwenden. Daten werden über die Import-Funktionen geladen.',
    });
  });

  // ===== Matching analysis helper =====
  function buildMatchAnalysis(state: MatchingState, newTxn = 0, newDoc = 0) {
    type TxnEntry = { transaction_id: string; posting_at: string; amount_minor: number; description_raw: string; counterparty_name: string; source_system: string; counterparty_iban: string; booking_reference: string; payment_reference: string };
    type CatGroup = { count: number; totalMinor: number; transactions: TxnEntry[] };
    const categories: Record<string, CatGroup> = {};
    const vendorGroups: Record<string, { count: number; totalMinor: number; minDate: string; maxDate: string; transactions: TxnEntry[] }> = {};

    // Load privat dispositions — count as resolved (not unmatched)
    const dbForAnalysis = getDb();
    const privatIdsForAnalysis = new Set<string>();
    const dispRowsForAnalysis = dbForAnalysis.prepare("SELECT transaction_id FROM transaction_dispositions WHERE disposition IN ('privat', 'steuerzahlung', 'ok_no_match')").all() as { transaction_id: string }[];
    for (const r of dispRowsForAnalysis) privatIdsForAnalysis.add(r.transaction_id);

    let matchedOrPrivatCount = 0;
    for (const t of state.transactions.values()) {
      if (state.matched_transaction_ids.has(t.transaction_id) || privatIdsForAnalysis.has(t.transaction_id)) matchedOrPrivatCount++;
    }
    const unmatchedTotal = state.transactions.size - matchedOrPrivatCount;

    for (const t of state.transactions.values()) {
      if (state.matched_transaction_ids.has(t.transaction_id)) continue;
      if (privatIdsForAnalysis.has(t.transaction_id)) continue;
      const src = t.source_system;
      const amt = t.amount_minor;
      const desc = String(t.description_raw ?? '').toLowerCase();
      let cat: string;
      if (src === 'sparkasse' && (desc.includes('umbuchung') || desc.includes('übertrag') || desc.includes('privat'))) cat = 'umbuchungen';
      else if (src === 'sparkasse' && (desc.includes('abschlussbuchung') || desc.includes('kontoführung') || desc.includes('kapitalertrag') || desc.includes('guthaben auf giro') || amt === 0)) cat = 'kontoführung';
      else if (src === 'paypal' && amt > 0) cat = 'offene_zahlungseingänge_paypal';
      else if (src === 'paypal' && amt < 0) cat = 'offene_zahlungen_paypal';
      else if (src === 'stripe') cat = 'offene_stripe';
      else if ((src === 'sparkasse' || src === 'visa') && amt < 0) cat = 'fehlende_rechnungen';
      else if (src === 'sparkasse' && amt > 0) cat = 'offene_eingänge_bank';
      else if (src === 'visa' && amt > 0) cat = 'offene_erstattungen_visa';
      else cat = 'sonstige';

      const entry: TxnEntry = {
        transaction_id: t.transaction_id, posting_at: t.posting_at, amount_minor: amt,
        description_raw: String(t.description_raw ?? '').slice(0, 100),
        counterparty_name: t.counterparty_name ?? '', source_system: src,
        counterparty_iban: t.counterparty_iban ?? '', booking_reference: t.booking_reference ?? '',
        payment_reference: t.payment_reference ?? '',
      };
      if (!categories[cat]) categories[cat] = { count: 0, totalMinor: 0, transactions: [] };
      categories[cat].count++;
      categories[cat].totalMinor += amt;
      categories[cat].transactions.push(entry);

      if (cat === 'fehlende_rechnungen') {
        const rawVendor = (t.counterparty_name ?? String(t.description_raw ?? '').slice(0, 40)).trim();
        if (!rawVendor) continue;
        const vendor = normalizeVendorName(rawVendor);
        if (!vendorGroups[vendor]) vendorGroups[vendor] = { count: 0, totalMinor: 0, minDate: t.posting_at, maxDate: t.posting_at, transactions: [] };
        const vg = vendorGroups[vendor];
        vg.count++; vg.totalMinor += amt;
        if (t.posting_at < vg.minDate) vg.minDate = t.posting_at;
        if (t.posting_at > vg.maxDate) vg.maxDate = t.posting_at;
        vg.transactions.push(entry);
      }
    }

    const categoriesWithPct = Object.entries(categories)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([cat, data]) => ({ category: cat, ...data, percent: unmatchedTotal > 0 ? Math.round((data.count / unmatchedTotal) * 1000) / 10 : 0 }));
    const sortedVendors = Object.entries(vendorGroups)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([vendor, data]) => ({ vendor, ...data }));

    // Load dispositions to count 'privat' as matched
    const db = getDb();
    const privatIds = new Set<string>();
    const dispRows = db.prepare("SELECT transaction_id FROM transaction_dispositions WHERE disposition IN ('privat', 'steuerzahlung', 'ok_no_match')").all() as { transaction_id: string }[];
    for (const r of dispRows) privatIds.add(r.transaction_id);

    const sourceStats: Record<string, { total: number; matched: number; percent: number }> = {};
    for (const t of state.transactions.values()) {
      const src = t.source_system;
      if (!sourceStats[src]) sourceStats[src] = { total: 0, matched: 0, percent: 0 };
      sourceStats[src].total++;
      if (state.matched_transaction_ids.has(t.transaction_id) || privatIds.has(t.transaction_id)) sourceStats[src].matched++;
    }
    for (const d of state.documents.values()) {
      const src = d.source_system;
      if (!sourceStats[src]) sourceStats[src] = { total: 0, matched: 0, percent: 0 };
      sourceStats[src].total++;
      if (state.matched_document_ids.has(d.document_id)) sourceStats[src].matched++;
    }
    for (const s of Object.values(sourceStats)) s.percent = s.total > 0 ? Math.round((s.matched / s.total) * 1000) / 10 : 0;

    const kontenSources = ['sparkasse', 'visa', 'paypal', 'stripe', 'enablebanking'];
    const einnahmenSources = ['income'];
    const rechnungenSources = ['invoice_file', 'extracted_invoice', 'amazon', 'invoice_scan'];
    const aggregate = (sources: string[]) => {
      let total = 0, matched = 0;
      for (const src of sources) { if (sourceStats[src]) { total += sourceStats[src].total; matched += sourceStats[src].matched; } }
      return { total, matched, percent: total > 0 ? Math.round((matched / total) * 1000) / 10 : 0 };
    };

    // Group unmatched expense documents by vendor
    const rechnungenSrc = new Set(rechnungenSources);
    const docVendorGroups: Record<string, { count: number; totalMinor: number; documents: Array<{ document_id: string; document_date: string; total_amount_minor: number; supplier_name: string; source_system: string; filename: string | null }> }> = {};
    for (const d of state.documents.values()) {
      if (state.matched_document_ids.has(d.document_id)) continue;
      if (!rechnungenSrc.has(d.source_system)) continue;
      const vendor = (d.supplier_name ?? 'Unbekannt').trim();
      if (!docVendorGroups[vendor]) docVendorGroups[vendor] = { count: 0, totalMinor: 0, documents: [] };
      const vg = docVendorGroups[vendor];
      vg.count++;
      vg.totalMinor += d.total_amount_minor;
      vg.documents.push({
        document_id: d.document_id, document_date: d.document_date,
        total_amount_minor: d.total_amount_minor, supplier_name: d.supplier_name ?? '',
        source_system: d.source_system, filename: d.filename ?? null,
      });
    }
    const unmatchedDocs = Object.entries(docVendorGroups)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([vendor, data]) => ({ vendor, ...data }));

    // Proposed groups are technical candidates, not accountant-confirmed matches.
    const statusStats: Record<string, { groups: number; transactions: number; documents: number; amountMinor: number }> = {};
    const ruleStats: Record<string, { groups: number; proposed: number; confirmed: number; transactions: number; documents: number; amountMinor: number }> = {};
    const qualityStats: Record<string, number> = {};
    const confirmedTransactionIds = new Set<string>();
    let groupsWithoutDocuments = 0;
    for (const mg of state.match_groups.values()) {
      for (const signal of matchQualitySignals(state, mg)) qualityStats[signal] = (qualityStats[signal] ?? 0) + 1;
      if (!statusStats[mg.status]) statusStats[mg.status] = { groups: 0, transactions: 0, documents: 0, amountMinor: 0 };
      const status = statusStats[mg.status];
      status.groups++;
      status.transactions += mg.transaction_ids.filter(id => state.transactions.has(id)).length;
      status.documents += mg.document_ids.filter(id => state.documents.has(id)).length;
      status.amountMinor += mg.transaction_ids
        .filter(id => state.transactions.has(id))
        .reduce((total, id) => total + (state.transactions.get(id)?.amount_minor ?? 0), 0);

      if (!ruleStats[mg.rule_id]) ruleStats[mg.rule_id] = { groups: 0, proposed: 0, confirmed: 0, transactions: 0, documents: 0, amountMinor: 0 };
      const rule = ruleStats[mg.rule_id];
      rule.groups++;
      rule.proposed += mg.status === 'proposed' ? 1 : 0;
      rule.confirmed += ['accepted', 'confirmed', 'manual'].includes(mg.status) ? 1 : 0;
      rule.transactions += mg.transaction_ids.filter(id => state.transactions.has(id)).length;
      rule.documents += mg.document_ids.filter(id => state.documents.has(id)).length;
      rule.amountMinor += mg.transaction_ids
        .filter(id => state.transactions.has(id))
        .reduce((total, id) => total + (state.transactions.get(id)?.amount_minor ?? 0), 0);

      if (mg.document_ids.length === 0) groupsWithoutDocuments++;
      if (['accepted', 'confirmed', 'manual'].includes(mg.status)) {
        for (const id of mg.transaction_ids) if (state.transactions.has(id)) confirmedTransactionIds.add(id);
      }
    }
    for (const id of privatIds) if (state.transactions.has(id)) confirmedTransactionIds.add(id);
    const confirmedTransactions = confirmedTransactionIds.size;
    const confirmedPercent = state.transactions.size > 0
      ? Math.round((confirmedTransactions / state.transactions.size) * 1000) / 10
      : 0;

    return {
      ok: true,
      totalTransactions: state.transactions.size, totalDocuments: state.documents.size,
      matchedTransactions: matchedOrPrivatCount, matchedDocuments: state.matched_document_ids.size,
      newMatchedTransactions: newTxn, newMatchedDocuments: newDoc,
      matchGroups: state.match_groups.size,
      matchPercent: state.transactions.size > 0 ? Math.round((matchedOrPrivatCount / state.transactions.size) * 1000) / 10 : 0,
      unmatchedTotal, categories: categoriesWithPct, missingInvoices: sortedVendors, unmatchedDocs,
      sourceStats, konten: aggregate(kontenSources), einnahmen: aggregate(einnahmenSources), rechnungen: aggregate(rechnungenSources),
      confirmedTransactions, confirmedPercent, statusStats, ruleStats, qualityStats, groupsWithoutDocuments,
    };
  }

  /** Auto-document rules for Sparkasse recurring expenses */
  const AUTO_DOC_RULES: Array<{
    match: (desc: string, cp: string) => boolean;
    ruleId: string;
    supplier: string;
    category: string;
    refPrefix: string;
  }> = [
    { match: (desc) => desc.includes('kontoführung'), ruleId: 'R-AUTO-BANK_FEE-001', supplier: 'Sparkasse Kontoführung', category: 'bank_fee', refPrefix: 'sparkasse-kontofuehrung' },
    { match: (desc) => desc.includes('abschlussbuchung'), ruleId: 'R-AUTO-BANK_FEE-001', supplier: 'Sparkasse Abschlussbuchung', category: 'bank_fee', refPrefix: 'sparkasse-abschluss' },
    { match: (desc) => desc.includes('kapitalertrag'), ruleId: 'R-AUTO-BANK_FEE-001', supplier: 'Sparkasse Kapitalertragsteuer', category: 'bank_fee', refPrefix: 'sparkasse-kest' },
    { match: (desc) => desc.includes('guthaben auf giro'), ruleId: 'R-AUTO-BANK_FEE-001', supplier: 'Sparkasse Guthabenzinsen', category: 'bank_fee', refPrefix: 'sparkasse-zinsen' },
    { match: (_d, cp) => cp.includes('merkur versicherung'), ruleId: 'R-AUTO-INSURANCE-001', supplier: 'Merkur Versicherung', category: 'versicherung', refPrefix: 'merkur-versicherung' },
    { match: (_d, cp) => cp.includes('sozialversicherungsanstalt'), ruleId: 'R-AUTO-SVA-001', supplier: 'SVA', category: 'sva', refPrefix: 'sva' },
  ];

  /** Dispositions for special transaction types (not matched, but resolved) */
  const AUTO_DISPOSITION_RULES: Array<{
    match: (desc: string, cp: string) => boolean;
    disposition: Disposition;
  }> = [
    { match: (_d, cp) => cp.includes('fa österreich') || cp.includes('finanzamt'), disposition: 'steuerzahlung' },
    { match: (desc) => desc.includes('sb-auszahlung') || desc.includes('sb-eigenerlag') || desc.includes('bareinzahlung') || desc.includes('barauszahlung'), disposition: 'privat' },
    { match: (desc) => /privat/i.test(desc), disposition: 'privat' },
  ];

  function generateBankFeeDocuments(state: MatchingState) {
    const db = getDb();
    const checkDoc = db.prepare('SELECT 1 FROM documents WHERE document_id = ?');
    const insertDoc = db.prepare(`
      INSERT INTO documents (
        document_id, source_system, source_document_ref, captured_at,
        document_date, total_amount_minor, currency_code,
        supplier_name, filename, meta
      ) VALUES (
        @document_id, @source_system, @source_document_ref, @captured_at,
        @document_date, @total_amount_minor, @currency_code,
        @supplier_name, @filename, @meta
      )
    `);
    const insertDocDisp = db.prepare(`
      INSERT OR IGNORE INTO document_dispositions (document_id, disposition, set_by)
      VALUES (?, 'open', 'system')
    `);

    for (const t of state.transactions.values()) {
      if (t.source_system !== 'sparkasse') continue;
      if (state.matched_transaction_ids.has(t.transaction_id)) continue;
      const desc = String(t.description_raw ?? '').toLowerCase();
      const cp = (t.counterparty_name ?? '').toLowerCase();

      // Check disposition rules first (steuerzahlung etc.)
      for (const rule of AUTO_DISPOSITION_RULES) {
        if (rule.match(desc, cp)) {
          const existingDisp = db.prepare('SELECT disposition FROM transaction_dispositions WHERE transaction_id = ?').get(t.transaction_id) as any;
          if (!existingDisp || existingDisp.disposition === 'open') {
            setDisposition(t.transaction_id, rule.disposition, undefined, undefined, 'system');
          }
        }
      }

      // Check auto-document rules
      for (const rule of AUTO_DOC_RULES) {
        if (!rule.match(desc, cp)) continue;

        const dateStr = t.posting_at.slice(0, 10);
        const docRef = `${rule.refPrefix}-${dateStr}`;
        const docId = documentId('bank_fee', docRef);

        if (!checkDoc.get(docId)) {
          insertDoc.run({
            document_id: docId,
            source_system: 'bank_fee',
            source_document_ref: docRef,
            captured_at: new Date().toISOString().slice(0, 10) + 'T00:00:00+01:00',
            document_date: t.posting_at,
            total_amount_minor: t.amount_minor,
            currency_code: 'EUR',
            supplier_name: rule.supplier,
            filename: `${rule.supplier} ${dateStr}`,
            meta: JSON.stringify({ type: rule.category, auto_generated: true }),
          });
          insertDocDisp.run(docId);
        }

        if (!state.documents.has(docId)) {
          state.documents.set(docId, {
            document_id: docId,
            source_system: 'bank_fee',
            source_document_ref: docRef,
            captured_at: new Date().toISOString().slice(0, 10) + 'T00:00:00+01:00',
            document_date: t.posting_at,
            total_amount_minor: t.amount_minor,
            currency_code: 'EUR',
            supplier_name: rule.supplier,
            filename: `${rule.supplier} ${dateStr}`,
            meta: { type: rule.category, auto_generated: true },
          });
        }

        if (!state.matched_transaction_ids.has(t.transaction_id)) {
          createMatch(state, rule.ruleId, [t.transaction_id], [docId], {
            type: rule.category + '_auto',
          });
        }
        break;
      }

      // SPK INSTANT TRANSFER — auto-create transfer document
      if (desc.includes('instant transfer') && cp.includes('paypal')) {
        if (state.matched_transaction_ids.has(t.transaction_id)) continue;
        const dateStr = t.posting_at.slice(0, 10);
        const docRef = `paypal-transfer-${dateStr}-${Math.abs(t.amount_minor)}`;
        const docId = documentId('bank_fee', docRef);

        if (!checkDoc.get(docId)) {
          insertDoc.run({
            document_id: docId,
            source_system: 'bank_fee',
            source_document_ref: docRef,
            captured_at: new Date().toISOString().slice(0, 10) + 'T00:00:00+01:00',
            document_date: t.posting_at,
            total_amount_minor: t.amount_minor,
            currency_code: 'EUR',
            supplier_name: 'PayPal Überweisung',
            filename: `PayPal Transfer ${dateStr}`,
            meta: JSON.stringify({ type: 'paypal_transfer', auto_generated: true }),
          });
          insertDocDisp.run(docId);
        }

        if (!state.documents.has(docId)) {
          state.documents.set(docId, {
            document_id: docId, source_system: 'bank_fee', source_document_ref: docRef,
            captured_at: new Date().toISOString().slice(0, 10) + 'T00:00:00+01:00',
            document_date: t.posting_at, total_amount_minor: t.amount_minor,
            currency_code: 'EUR', supplier_name: 'PayPal Überweisung',
            filename: `PayPal Transfer ${dateStr}`,
            meta: { type: 'paypal_transfer', auto_generated: true },
          });
        }

        createMatch(state, 'R-AUTO-PAYPAL_TRANSFER-001', [t.transaction_id], [docId], {
          type: 'paypal_transfer_auto',
        });
      }
    }
  }

  // GET: read current match status (no changes)
  router.get('/match', (req, res) => {
    try {
      const year = req.query.year as string | undefined;
      const quarter = req.query.quarter as string | undefined;
      res.json(buildMatchAnalysis(stateForRequestedPeriod(getState(), year, quarter)));
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST: re-run matching rules on current state, then return analysis
  router.post('/match', (_req, res) => {
    try {
      const state = getState();

      // Generate monthly fee summary documents from current transactions
      const stripeTxns = [...state.transactions.values()].filter(t => t.source_system === 'stripe');
      if (stripeTxns.length > 0) {
        generateStripeFeeSummaries(stripeTxns);
        loadNewDocsIntoState(getState, 'stripe_fee');
      }
      const paypalTxns = [...state.transactions.values()].filter(t => t.source_system === 'paypal');
      if (paypalTxns.length > 0) {
        generatePayPalFeeSummaries(paypalTxns);
        loadNewDocsIntoState(getState, 'bank_fee');
      }

      // Generate expense documents for Sparkasse "Kontoführung" entries
      generateBankFeeDocuments(state);

      // Load any new/updated documents from DB (Belegerkennung, Invoice Bot, Amazon, etc.)
      loadNewDocsIntoState(getState, 'invoice_scan');
      loadNewDocsIntoState(getState, 'aliexpress');
      loadNewDocsIntoState(getState, 'google_cloud');
      loadNewDocsIntoState(getState, 'google_one');
      loadNewDocsIntoState(getState, 'amazon');

      // Keep user-confirmed special dispositions out of automatic matching.
      // These decisions live in SQLite, while the matching engine works on the
      // in-memory state, so synchronize them immediately before every run.
      recomputeExclusions(state);
      const resolvedRows = getDb().prepare(`
        SELECT transaction_id
        FROM transaction_dispositions
        WHERE disposition IN ('privat', 'steuerzahlung', 'ok_no_match', 'quarterly_aggregate')
      `).all() as { transaction_id: string }[];
      for (const row of resolvedRows) {
        state.excluded_transaction_ids.add(row.transaction_id);
      }

      const beforeMatched = state.matched_transaction_ids.size;
      const beforeMatchedDocs = state.matched_document_ids.size;
      runMatchingEngine(state, ALL_RULES);
      saveState(state);
      setState(state);
      res.json(buildMatchAnalysis(state,
        state.matched_transaction_ids.size - beforeMatched,
        state.matched_document_ids.size - beforeMatchedDocs,
      ));
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ===== Summary / Dashboard =====
  router.get('/summary', (req, res) => {
    const state = getState();
    // Optional year + quarter filter — affects ONLY percentage calculation, not visibility
    const yearParam = req.query.year as string | undefined;
    const quarterParam = req.query.quarter as string | undefined;
    const filterYear = yearParam ? parseInt(yearParam) : null;
    const filterQuarter = quarterParam ? parseInt(quarterParam) : null; // 1-4 or null

    // Load privat dispositions — count as matched
    const summaryDb = getDb();
    const summaryPrivatIds = new Set<string>();
    const summaryDispRows = summaryDb.prepare("SELECT transaction_id FROM transaction_dispositions WHERE disposition IN ('privat', 'steuerzahlung', 'ok_no_match')").all() as { transaction_id: string }[];
    for (const r of summaryDispRows) summaryPrivatIds.add(r.transaction_id);

    /** Check whether a date falls within the selected period (year + optional quarter). */
    const inPeriod = (dateStr: string | undefined): boolean => {
      return isInRequestedPeriod(dateStr, yearParam, quarterParam);
    };

    const txnBySrc: Record<string, { total: number; matched: number; unmatched: number }> = {};
    for (const t of state.transactions.values()) {
      if (!inPeriod(t.posting_at)) continue;
      if (!txnBySrc[t.source_system]) txnBySrc[t.source_system] = { total: 0, matched: 0, unmatched: 0 };
      txnBySrc[t.source_system].total++;
      if (state.matched_transaction_ids.has(t.transaction_id) || summaryPrivatIds.has(t.transaction_id)) {
        txnBySrc[t.source_system].matched++;
      } else {
        txnBySrc[t.source_system].unmatched++;
      }
    }

    const docBySrc: Record<string, { total: number; matched: number; unmatched: number }> = {};
    for (const d of state.documents.values()) {
      if (!inPeriod(d.document_date ?? d.captured_at)) continue;
      if (!docBySrc[d.source_system]) docBySrc[d.source_system] = { total: 0, matched: 0, unmatched: 0 };
      docBySrc[d.source_system].total++;
      if (state.matched_document_ids.has(d.document_id)) {
        docBySrc[d.source_system].matched++;
      } else {
        docBySrc[d.source_system].unmatched++;
      }
    }

    const byRule: Record<string, number> = {};
    for (const mg of state.match_groups.values()) {
      byRule[mg.rule_id] = (byRule[mg.rule_id] ?? 0) + 1;
    }

    // Compute totals from the filtered by_source counts
    const txnTotal = Object.values(txnBySrc).reduce((s, v) => s + v.total, 0);
    const txnMatched = Object.values(txnBySrc).reduce((s, v) => s + v.matched, 0);
    const docTotal = Object.values(docBySrc).reduce((s, v) => s + v.total, 0);
    const docMatched = Object.values(docBySrc).reduce((s, v) => s + v.matched, 0);

    res.json({
      year: filterYear,
      quarter: filterQuarter,
      transactions: {
        total: txnTotal,
        matched: txnMatched,
        unmatched: txnTotal - txnMatched,
        by_source: txnBySrc,
      },
      documents: {
        total: docTotal,
        matched: docMatched,
        unmatched: docTotal - docMatched,
        by_source: docBySrc,
      },
      matches: {
        total: state.match_groups.size,
        by_rule: byRule,
      },
      exclusions: state.exclusion_rules.length,
    });
  });

  // ===== Transactions =====
  router.get('/transactions', (req, res) => {
    const state = getState();
    const source = req.query.source as string | undefined;
    const status = req.query.status as string | undefined;
    const page = parseInt(req.query.page as string ?? '1', 10);
    const limit = parseInt(req.query.limit as string ?? '50', 10);
    const search = (req.query.search as string ?? '').toLowerCase();
    const sortField = (req.query.sort as string) || 'posting_at';
    const sortOrder = (req.query.order as string) === 'asc' ? 1 : -1;

    const year = req.query.year as string | undefined;
    const quarter = req.query.quarter as string | undefined;

    let txns = [...state.transactions.values()];
    if (source) txns = txns.filter((t) => t.source_system === source);
    if (status === 'matched') txns = txns.filter((t) => state.matched_transaction_ids.has(t.transaction_id));
    if (status === 'unmatched') txns = txns.filter((t) => !state.matched_transaction_ids.has(t.transaction_id));
    if (year) {
      const qNum = quarter ? parseInt(quarter) : null;
      const startMonth = qNum ? (qNum - 1) * 3 + 1 : 1;
      const endMonth = qNum ? qNum * 3 : 12;
      const periodStart = `${year}-${String(startMonth).padStart(2, '0')}-01`;
      const endDay = new Date(parseInt(year), endMonth, 0).getDate();
      const periodEnd = `${year}-${String(endMonth).padStart(2, '0')}-${endDay}`;
      txns = txns.filter(t => {
        const d = t.posting_at?.slice(0, 10) ?? '';
        return d >= periodStart && d <= periodEnd;
      });
    }
    if (search) {
      // Support amount search: "64,70" or "64.70" or "-64,70"
      const amountSearch = search.replace(',', '.').replace(/[^\d.\-]/g, '');
      const searchAmount = amountSearch ? Math.round(parseFloat(amountSearch) * 100) : null;

      txns = txns.filter((t) =>
        t.description_raw.toLowerCase().includes(search) ||
        (t.counterparty_name ?? '').toLowerCase().includes(search) ||
        t.transaction_id.toLowerCase().includes(search) ||
        (searchAmount != null && !isNaN(searchAmount) && Math.abs(t.amount_minor) === Math.abs(searchAmount))
      );
    }

    txns.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'posting_at': cmp = a.posting_at.localeCompare(b.posting_at); break;
        case 'description_raw': cmp = a.description_raw.localeCompare(b.description_raw); break;
        case 'counterparty_name': cmp = (a.counterparty_name ?? '').localeCompare(b.counterparty_name ?? ''); break;
        case 'amount_minor': cmp = a.amount_minor - b.amount_minor; break;
        case 'status': {
          const am = state.matched_transaction_ids.has(a.transaction_id) ? 1 : 0;
          const bm = state.matched_transaction_ids.has(b.transaction_id) ? 1 : 0;
          cmp = am - bm;
          break;
        }
        default: cmp = a.posting_at.localeCompare(b.posting_at);
      }
      return cmp * sortOrder;
    });

    // Load dispositions for this page
    const db = getDb();
    const dispMap = new Map<string, { disposition: string; note: string | null }>();
    const allIds = txns.map(t => t.transaction_id);
    const pageIds = txns.slice((page - 1) * limit, (page - 1) * limit + limit).map(t => t.transaction_id);
    if (pageIds.length > 0) {
      const placeholders = pageIds.map(() => '?').join(',');
      const dispRows = db.prepare(`SELECT transaction_id, disposition, note FROM transaction_dispositions WHERE transaction_id IN (${placeholders})`).all(...pageIds) as { transaction_id: string; disposition: string; note: string | null }[];
      for (const r of dispRows) dispMap.set(r.transaction_id, { disposition: r.disposition, note: r.note });
    }

    const total = txns.length;
    const start = (page - 1) * limit;
    const items = txns.slice(start, start + limit).map((t) => {
      const mgId = findMatchGroupForTxn(state, t.transaction_id);
      const mg = mgId ? state.match_groups.get(mgId) : null;
      const linkedDocs = mg
        ? mg.document_ids.map((did) => state.documents.get(did)).filter(Boolean).map((d) => ({
            document_id: d!.document_id,
            filename: d!.filename,
            source_system: d!.source_system,
            source_document_ref: d!.source_document_ref,
            total_amount_minor: d!.total_amount_minor,
          }))
        : [];
      const linkedTxnIds = mg
        ? mg.transaction_ids.filter((id) => id !== t.transaction_id)
        : [];
      return {
        ...t,
        amount: fromMinor(t.amount_minor),
        is_matched: state.matched_transaction_ids.has(t.transaction_id),
        match_group_id: mgId,
        rule_id: mg?.rule_id ?? null,
        linked_docs: linkedDocs,
        linked_txn_ids: linkedTxnIds,
        disposition: dispMap.get(t.transaction_id)?.disposition ?? 'open',
        disposition_note: dispMap.get(t.transaction_id)?.note ?? null,
      };
    });

    res.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
  });

  router.get('/transactions/:id', (req, res) => {
    const state = getState();
    const txn = state.transactions.get(req.params.id);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    const mgId = findMatchGroupForTxn(state, txn.transaction_id);
    res.json({
      ...txn,
      amount: fromMinor(txn.amount_minor),
      is_matched: state.matched_transaction_ids.has(txn.transaction_id),
      match_group_id: mgId,
      match_group: mgId ? state.match_groups.get(mgId) : undefined,
    });
  });

  /**
   * Enrich a PayPal transaction with full API details (on-demand).
   * Calls the PayPal Transaction Search API filtered by transaction_id
   * to fetch payer name, subject, note, cart items, invoice_id, etc.
   * Updates the in-memory state and returns the enriched transaction.
   */
  router.post('/transactions/:id/enrich-paypal', async (req, res) => {
    const state = getState();
    const txn = state.transactions.get(req.params.id);
    if (!txn) return res.status(404).json({ error: 'Transaktion nicht gefunden' });
    if (txn.source_system !== 'paypal') return res.status(400).json({ error: 'Nur für PayPal-Transaktionen' });

    // Need the original PayPal transaction ID (source_row_ref)
    const ppTxnId = txn.source_row_ref;
    if (!ppTxnId) return res.status(400).json({ error: 'Keine PayPal-Transaktions-ID vorhanden' });

    const ppClientId = getSetting('paypal_client_id') || process.env.PAYPAL_CLIENT_ID;
    const ppClientSecret = getSetting('paypal_client_secret') || process.env.PAYPAL_CLIENT_SECRET;
    if (!ppClientId || !ppClientSecret) {
      return res.status(400).json({ error: 'PayPal API-Zugangsdaten nicht konfiguriert' });
    }
    const isSandbox = getSetting('paypal_sandbox') === 'true';

    try {
      const { getPayPalAccessToken, fetchPayPalTransactions } = await import('../../import/paypal-api.js');
      const token = await getPayPalAccessToken(ppClientId, ppClientSecret, isSandbox);

      // Search for this specific transaction by date range (±3 days around posting_at)
      const txnDate = new Date(txn.posting_at);
      const start = new Date(txnDate.getTime() - 3 * 86400000).toISOString().slice(0, 10);
      const end = new Date(txnDate.getTime() + 3 * 86400000).toISOString().slice(0, 10);
      const results = await fetchPayPalTransactions(token, start, end, isSandbox);

      // Find the exact transaction by PayPal transaction_id
      const detail = results.find(r => r.transaction_info.transaction_id === ppTxnId);
      if (!detail) {
        return res.json({ ok: false, error: 'Transaktion nicht in PayPal API gefunden', searched: results.length });
      }

      // Extract all available details
      const info = detail.transaction_info;
      const payer = detail.payer_info;
      const cart = detail.cart_info;

      const enriched: Record<string, any> = {
        ...txn.meta,
        // Payer info
        payer_name: payer?.payer_name?.alternate_full_name
          ?? (`${payer?.payer_name?.given_name ?? ''} ${payer?.payer_name?.surname ?? ''}`.trim()
            || info.payer_name?.alternate_full_name
            || undefined),
        payer_email: payer?.email_address ?? info.payer_email,
        payer_account_id: payer?.account_id,
        // Transaction details
        paypal_txn_id: info.transaction_id,
        paypal_event_code: info.transaction_event_code,
        paypal_status: info.transaction_status,
        subject: info.transaction_subject,
        note: info.transaction_note,
        invoice_id: info.invoice_id,
        // Fee
        fee_minor: info.fee_amount ? Math.round(parseFloat(info.fee_amount.value) * 100) : 0,
        fee_currency: info.fee_amount?.currency_code,
        // Cart items
        cart_items: cart?.item_details?.map(i => ({
          name: i.item_name,
          quantity: i.item_quantity,
          unit_price: i.item_unit_price?.value,
          currency: i.item_unit_price?.currency_code,
        })).filter(i => i.name),
        // Timestamps
        initiated_at: info.transaction_initiation_date,
        updated_at: info.transaction_updated_date,
        // Mark as enriched
        enriched: true,
        enriched_at: new Date().toISOString(),
      };

      // Update transaction in state
      txn.meta = enriched;
      // Also update counterparty_name if we got a better one
      if (enriched.payer_name && (!txn.counterparty_name || txn.counterparty_name === '')) {
        txn.counterparty_name = enriched.payer_name;
      }
      // Update description if it was just "payment"
      const newDesc = [enriched.paypal_type ?? 'payment', enriched.subject, enriched.note, enriched.payer_name]
        .filter(Boolean).join(' - ');
      if (newDesc.length > (txn.description_raw?.length ?? 0)) {
        txn.description_raw = newDesc;
      }

      saveState(state);

      res.json({
        ok: true,
        transaction_id: txn.transaction_id,
        enriched,
        description: txn.description_raw,
        counterparty: txn.counterparty_name,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ===== Documents =====
  router.get('/documents/:id', (req, res) => {
    const state = getState();
    const doc = state.documents.get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json({
      ...doc,
      is_matched: state.matched_document_ids.has(doc.document_id),
    });
  });

  router.get('/documents', (req, res) => {
    const state = getState();
    const source = req.query.source as string | undefined;
    const status = req.query.status as string | undefined;
    const type = req.query.type as string | undefined; // 'expense' | 'income'
    const page = parseInt(req.query.page as string ?? '1', 10);
    const limit = parseInt(req.query.limit as string ?? '50', 10);
    const search = (req.query.search as string ?? '').toLowerCase();
    const sortField = (req.query.sort as string) || 'document_date';
    const sortOrder = (req.query.order as string) === 'asc' ? 1 : -1;

    const year = req.query.year as string | undefined;
    const quarter = req.query.quarter as string | undefined;

    let docs = [...state.documents.values()];
    if (source) docs = docs.filter((d) => d.source_system === source);
    if (type === 'expense') docs = docs.filter((d) => d.source_system !== 'income');
    if (type === 'income') docs = docs.filter((d) => d.source_system === 'income');
    if (status === 'matched') docs = docs.filter((d) => state.matched_document_ids.has(d.document_id));
    if (status === 'unmatched') docs = docs.filter((d) => !state.matched_document_ids.has(d.document_id));
    if (year) docs = docs.filter(d => isInRequestedPeriod(d.document_date, year, quarter));
    if (search) {
      const amountSearch = search.replace(',', '.').replace(/[^\d.\-]/g, '');
      const searchAmount = amountSearch ? Math.round(parseFloat(amountSearch) * 100) : null;

      docs = docs.filter((d) =>
        (d.filename ?? '').toLowerCase().includes(search) ||
        (d.supplier_name ?? '').toLowerCase().includes(search) ||
        d.document_id.toLowerCase().includes(search) ||
        (d.source_document_ref ?? '').toLowerCase().includes(search) ||
        (searchAmount != null && !isNaN(searchAmount) && Math.abs(d.total_amount_minor) === Math.abs(searchAmount))
      );
    }

    docs.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'document_date': cmp = (a.document_date ?? '').localeCompare(b.document_date ?? ''); break;
        case 'total_amount_minor': cmp = a.total_amount_minor - b.total_amount_minor; break;
        case 'supplier_name': cmp = (a.supplier_name ?? '').localeCompare(b.supplier_name ?? ''); break;
        case 'status': {
          const am = state.matched_document_ids.has(a.document_id) ? 1 : 0;
          const bm = state.matched_document_ids.has(b.document_id) ? 1 : 0;
          cmp = am - bm;
          break;
        }
        default: cmp = (a.document_date ?? '').localeCompare(b.document_date ?? '');
      }
      return cmp * sortOrder;
    });

    const total = docs.length;
    const start = (page - 1) * limit;
    const scanLookup = getDb().prepare('SELECT scan_id FROM invoice_scans WHERE document_id = ?');
    const items = docs.slice(start, start + limit).map((d) => {
      const mgId = findMatchGroupForDoc(state, d.document_id);
      const mg = mgId ? state.match_groups.get(mgId) : null;
      const linkedTransactions = mg
        ? mg.transaction_ids.map((tid) => {
            const t = state.transactions.get(tid);
            return t ? { transaction_id: t.transaction_id, source_system: t.source_system, posting_at: t.posting_at, amount: fromMinor(t.amount_minor), amount_minor: t.amount_minor, currency_code: t.currency_code, description_raw: t.description_raw, counterparty_name: t.counterparty_name } : null;
          }).filter(Boolean)
        : [];
      // Extract USt info from meta — for fee summaries, reload from DB to get charges
      let meta = (d.meta ?? {}) as Record<string, any>;
      if (d.source_system === 'stripe_fee' || d.source_system === 'bank_fee') {
        const dbRow = getDb().prepare('SELECT meta FROM documents WHERE document_id = ?').get(d.document_id) as any;
        if (dbRow?.meta) meta = JSON.parse(dbRow.meta);
      }
      const amount = fromMinor(d.total_amount_minor);
      const shippingVat = typeof meta.shipping_vat === 'number' ? meta.shipping_vat : 0;
      const ust = shippingVat ? (amount < 0 ? -Math.abs(shippingVat) : Math.abs(shippingVat)) : null;

      // Tax rate: from meta (Amazon) or from document field (other sources, stored as 0-1 decimal)
      const taxRate = meta.tax_rate ?? (d.vat_rate != null ? Math.round(d.vat_rate * 100) : null);

      // Tax category: compute for all expense documents
      const vatCountry = meta.vat_country ?? null;
      const taxCategory = meta.tax_category ?? getTaxCategory(vatCountry, taxRate);

      // For income docs: construct filename from order_id + belegnummer if not set
      let resolvedFilename = d.filename || null;
      if (!resolvedFilename && d.source_system === 'income' && meta.order_id && d.source_document_ref) {
        resolvedFilename = `WC-${meta.order_id}-Invoice-${d.source_document_ref}.pdf`;
      }

      return {
        ...d,
        meta, // override state meta with DB meta (for fee summaries with charges)
        filename: resolvedFilename,
        amount,
        is_matched: state.matched_document_ids.has(d.document_id),
        match_group_id: mgId,
        rule_id: mg?.rule_id ?? null,
        auto_match_tier: mg?.evidence?.auto_match_tier ?? null,
        linked_transactions: linkedTransactions,
        ust,
        tax_rate: taxRate,
        vat_country: vatCountry,
        tax_category: taxCategory,
        title_short: meta.title ?? null,
        scan_id: d.source_system === 'invoice_scan' ? (scanLookup.get(d.document_id) as any)?.scan_id ?? null : null,
      };
    });

    res.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
  });

  // ===== Match Groups =====
  router.get('/matches', (req, res) => {
    const state = getState();
    const ruleId = req.query.rule_id as string | undefined;
    const status = req.query.status as string | undefined;
    const search = String(req.query.search ?? '').trim().toLowerCase();
    const sort = String(req.query.sort ?? 'created_at');
    const order = req.query.order === 'asc' ? 1 : -1;
    const page = parseInt(req.query.page as string ?? '1', 10);
    const limit = parseInt(req.query.limit as string ?? '50', 10);
    const year = req.query.year as string | undefined;
    const quarter = req.query.quarter as string | undefined;

    let groups = [...state.match_groups.values()];
    if (ruleId) groups = groups.filter((mg) => mg.rule_id === ruleId);
    if (status) groups = groups.filter((mg) => mg.status === status);
    if (year) {
      groups = groups.filter((mg) =>
        mg.transaction_ids.some(id => isInRequestedPeriod(state.transactions.get(id)?.posting_at, year, quarter)) ||
        mg.document_ids.some(id => isInRequestedPeriod(state.documents.get(id)?.document_date, year, quarter))
      );
    }

    if (search) {
      groups = groups.filter((mg) => {
        const txText = mg.transaction_ids.map(id => {
          const t = state.transactions.get(id);
          return `${id} ${t?.description_raw ?? ''} ${t?.counterparty_name ?? ''} ${t?.booking_reference ?? ''}`;
        }).join(' ');
        const docText = mg.document_ids.map(id => {
          const d = state.documents.get(id);
          return `${id} ${d?.supplier_name ?? ''} ${d?.source_document_ref ?? ''} ${d?.filename ?? ''}`;
        }).join(' ');
        return `${mg.match_group_id} ${mg.rule_id} ${txText} ${docText}`.toLowerCase().includes(search);
      });
    }

    const sortableValue = (mg: MatchGroup): string | number => {
      if (sort === 'amount') return mg.amount_total_minor;
      if (sort === 'rule') return mg.rule_id;
      if (sort === 'status') return mg.status;
      if (sort === 'transactions') return mg.transaction_ids.length;
      if (sort === 'documents') return mg.document_ids.length;
      return mg.created_at;
    };
    groups.sort((a, b) => {
      const av = sortableValue(a), bv = sortableValue(b);
      return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))) * order;
    });

    const total = groups.length;
    const start = (page - 1) * limit;
    const items = groups.slice(start, start + limit).map((mg) => expandMatchGroup(state, mg));

    res.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
  });

  router.get('/matches/:id', (req, res) => {
    const state = getState();
    const mg = state.match_groups.get(req.params.id);
    if (!mg) return res.status(404).json({ error: 'Match group not found' });
    res.json(expandMatchGroup(state, mg));
  });

  // Validated review lifecycle; no duplicate legacy mutation handlers.
  router.use(createMatchDecisionRouter(getState, setState, next => {
    const actor = next.audit_events.at(-1)?.actor_id;
    if (!actor) throw new Error('A reviewed matching actor is required');
    if (persistMatching) persistMatching(getState(), next, actor);
    else saveState(next);
  }));

  // ===== Bulk delete documents =====
  router.post('/documents/delete', (req, res) => {
    const { ids } = req.body as { ids: string[] };
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }

    const state = getState();
    const db = getDb();
    let deleted = 0;

    for (const docId of ids) {
      // Remove from any match groups first
      for (const [mgId, mg] of state.match_groups) {
        if (mg.document_ids.includes(docId)) {
          state.match_groups.delete(mgId);
          for (const tid of mg.transaction_ids) {
            if (!isInAnyMatchGroup(state, tid, 'transaction')) {
              state.matched_transaction_ids.delete(tid);
            }
          }
          for (const did of mg.document_ids) {
            if (!isInAnyMatchGroup(state, did, 'document')) {
              state.matched_document_ids.delete(did);
            }
          }
        }
      }

      // Remove from state
      state.documents.delete(docId);
      state.matched_document_ids.delete(docId);

      // Remove linked invoice scan (so re-import is possible)
      const linkedScan = db.prepare('SELECT scan_id FROM invoice_scans WHERE document_id = ?').get(docId) as any;
      if (linkedScan) {
        db.prepare('DELETE FROM invoice_extracted_fields WHERE scan_id = ?').run(linkedScan.scan_id);
        db.prepare('DELETE FROM invoice_review_edits WHERE scan_id = ?').run(linkedScan.scan_id);
        db.prepare('DELETE FROM invoice_scans WHERE scan_id = ?').run(linkedScan.scan_id);
      }

      // Remove from DB
      db.prepare('DELETE FROM document_dispositions WHERE document_id = ?').run(docId);
      db.prepare('DELETE FROM line_items WHERE document_id = ?').run(docId);
      db.prepare('DELETE FROM documents WHERE document_id = ?').run(docId);
      deleted++;
    }

    saveState(state);
    res.json({ ok: true, deleted });
  });

  // ===== Exclusion Rules =====
  router.get('/exclusions', (_req, res) => {
    const state = getState();
    res.json(state.exclusion_rules);
  });

  router.post('/exclusions', (req, res) => {
    const state = getState();
    const { field, operator, value, description } = req.body;
    if (!field || !operator || !value) {
      return res.status(400).json({ error: 'field, operator, and value are required' });
    }

    const rule: ExclusionRule = {
      exclusion_id: exclusionId(field, operator, value),
      field,
      operator,
      value,
      description: description ?? `${field} ${operator} "${value}"`,
      created_at: new Date().toISOString(),
      created_by: 'user',
      enabled: true,
    };

    state.exclusion_rules.push(rule);

    // Apply exclusion
    const excluded = applyExclusion(state, rule);

    recordAudit(state, 'EXCLUSION_CREATED', 'ExclusionRule', rule.exclusion_id, { after: rule as unknown as Record<string, unknown> });
    saveState(state);

    res.json({ ...rule, excluded_count: excluded });
  });

  router.delete('/exclusions/:id', (req, res) => {
    const state = getState();
    const idx = state.exclusion_rules.findIndex((r) => r.exclusion_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Exclusion rule not found' });

    const rule = state.exclusion_rules[idx];
    state.exclusion_rules.splice(idx, 1);
    recomputeExclusions(state);

    recordAudit(state, 'EXCLUSION_DELETED', 'ExclusionRule', rule.exclusion_id, { before: rule as unknown as Record<string, unknown> });
    saveState(state);

    res.json({ ok: true, removed: rule.exclusion_id });
  });

  // ===== Review Queue =====
  router.get('/review-queue', (req, res) => {
    const state = getState();
    const page = parseInt(req.query.page as string ?? '1', 10);
    const limit = parseInt(req.query.limit as string ?? '50', 10);
    const year = req.query.year as string | undefined;
    const quarter = req.query.quarter as string | undefined;

    const unmatched = [...state.transactions.values()].filter((t) =>
      !state.matched_transaction_ids.has(t.transaction_id) &&
      !state.excluded_transaction_ids.has(t.transaction_id) &&
      isInRequestedPeriod(t.posting_at, year, quarter)
    );

    unmatched.sort((a, b) => Math.abs(b.amount_minor) - Math.abs(a.amount_minor));

    const total = unmatched.length;
    const start = (page - 1) * limit;
    const items = unmatched.slice(start, start + limit).map((t) => ({
      ...t,
      amount: fromMinor(t.amount_minor),
    }));

    res.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
  });

  // ===== Audit Trail =====
  router.get('/audit', (req, res) => {
    const state = getState();
    const page = parseInt(req.query.page as string ?? '1', 10);
    const limit = parseInt(req.query.limit as string ?? '50', 10);

    const events = [...state.audit_events];
    events.reverse();

    const total = events.length;
    const start = (page - 1) * limit;
    const items = events.slice(start, start + limit);

    res.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
  });

  // ===== Reports / Exports =====
  router.get('/report/json', (_req, res) => {
    const state = getState();
    const report = generateReport(state);
    const json = exportJson(report);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="report-${state.run_id}.json"`);
    res.send(json);
  });

  router.get('/report/csv', (_req, res) => {
    const state = getState();
    const report = generateReport(state);
    const csv = exportCsv(report);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-${state.run_id}.csv"`);
    res.send(csv);
  });

  router.get('/report/summary', (_req, res) => {
    const state = getState();
    const report = generateReport(state);
    res.json({
      report_id: report.report_id,
      run_id: report.run_id,
      created_at: report.created_at,
      schema_versions: report.schema_versions,
      summary: report.summary,
      currency_totals: report.currency_totals,
      vat_summary: report.vat_summary,
      errors: report.errors,
    });
  });

  // ===== VAT Report (Umsatzsteuer-Bericht Österreich) =====
  router.get('/report/vat', (req, res) => {
    // Reload invoice_scan docs from DB to ensure latest values after rescan/edit
    const state = getState();
    const db = getDb();
    const scanDocs = db.prepare("SELECT * FROM documents WHERE source_system = 'invoice_scan'").all() as any[];
    for (const row of scanDocs) {
      const doc: import('../../core/types.js').Document = {
        document_id: row.document_id, source_system: row.source_system,
        source_document_ref: row.source_document_ref, captured_at: row.captured_at,
        document_date: row.document_date, total_amount_minor: row.total_amount_minor,
        currency_code: row.currency_code, supplier_name: row.supplier_name ?? undefined,
        vat_amount_minor: row.vat_amount_minor ?? undefined, vat_rate: row.vat_rate ?? undefined,
        filename: row.filename ?? undefined, meta: JSON.parse(row.meta || '{}'),
      };
      state.documents.set(doc.document_id, doc);
    }

    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query parameters required (YYYY-MM-DD)' });
    }
    const report = generateVatReport(state, start, end);
    res.json(report);
  });

  router.get('/report/income-tax', (req, res) => {
    const state = getState();
    const db = getDb();
    // Reload invoice_scan docs from DB
    const scanDocs = db.prepare("SELECT * FROM documents WHERE source_system = 'invoice_scan'").all() as any[];
    for (const row of scanDocs) {
      const doc: import('../../core/types.js').Document = {
        document_id: row.document_id, source_system: row.source_system,
        source_document_ref: row.source_document_ref, captured_at: row.captured_at,
        document_date: row.document_date, total_amount_minor: row.total_amount_minor,
        currency_code: row.currency_code, supplier_name: row.supplier_name ?? undefined,
        vat_amount_minor: row.vat_amount_minor ?? undefined, vat_rate: row.vat_rate ?? undefined,
        filename: row.filename ?? undefined, meta: JSON.parse(row.meta || '{}'),
      };
      state.documents.set(doc.document_id, doc);
    }
    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query parameters required (YYYY-MM-DD)' });
    }
    const report = generateIncomeTaxReport(state, start, end);
    res.json(report);
  });

  // ===== EU-OSS summary =====
  router.get('/report/eu-oss', (req, res) => {
    const state = getState();
    const year = req.query.year as string;
    if (!year) return res.status(400).json({ error: 'year required' });

    const result: Record<string, Record<string, { net: number; vat: number; gross: number; count: number }>> = {};
    // Q1-Q4
    for (let q = 1; q <= 4; q++) result[`Q${q}`] = {};

    for (const d of state.documents.values()) {
      if (d.source_system !== 'income') continue;
      const date = d.document_date?.slice(0, 10) ?? '';
      if (!date.startsWith(year)) continue;
      const meta = (d.meta ?? {}) as Record<string, any>;
      const country = meta.land ?? meta.invoice_country ?? '';
      if (!country || country === 'AT') continue; // Skip domestic, only EU/non-EU with VAT

      const vatMinor = d.vat_amount_minor ?? 0;
      if (vatMinor === 0) continue; // Only docs with VAT

      const month = parseInt(date.slice(5, 7));
      const quarter = `Q${Math.ceil(month / 3)}`;
      if (!result[quarter][country]) result[quarter][country] = { net: 0, vat: 0, gross: 0, count: 0 };
      result[quarter][country].net += d.total_amount_minor - vatMinor;
      result[quarter][country].vat += vatMinor;
      result[quarter][country].gross += d.total_amount_minor;
      result[quarter][country].count++;
    }

    res.json({ year, quarters: result });
  });

  // ===== Report PDF export =====
  router.get('/report/vat/pdf', async (req, res) => {
    const state = getState();
    const db = getDb();
    const scanDocs = db.prepare("SELECT * FROM documents WHERE source_system = 'invoice_scan'").all() as any[];
    for (const row of scanDocs) {
      state.documents.set(row.document_id, {
        document_id: row.document_id, source_system: row.source_system,
        source_document_ref: row.source_document_ref, captured_at: row.captured_at,
        document_date: row.document_date, total_amount_minor: row.total_amount_minor,
        currency_code: row.currency_code, supplier_name: row.supplier_name ?? undefined,
        vat_amount_minor: row.vat_amount_minor ?? undefined, vat_rate: row.vat_rate ?? undefined,
        filename: row.filename ?? undefined, meta: JSON.parse(row.meta || '{}'),
      });
    }
    const start = req.query.start as string;
    const end = req.query.end as string;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const report = generateVatReport(state, start, end);
    const { generateVatReportPdf } = await import('../../core/reporting/export-pdf.js');
    const pdf = await generateVatReportPdf(report);
    const year = start.slice(0, 4);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Umsatzsteuererklaerung-${year}.pdf"`);
    res.send(pdf);
  });

  router.get('/report/income-tax/pdf', async (req, res) => {
    const state = getState();
    const start = req.query.start as string;
    const end = req.query.end as string;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const report = generateIncomeTaxReport(state, start, end);
    const { generateIncomeTaxPdf } = await import('../../core/reporting/export-pdf.js');
    const pdf = await generateIncomeTaxPdf(report);
    const year = start.slice(0, 4);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Einkommensteuer-E1a-${year}.pdf"`);
    res.send(pdf);
  });

  // ===== Vendor override propagation (shared by vat-edit + vendor settings) =====
  function propagateVendorOverride(
    vendorKey: string,
    country: string | null | undefined,
    supplierName: string | null | undefined,
    isReverseCharge?: boolean,
    excludeDocId?: string,
  ) {
    const db = getDb();
    const state = getState();

    // Upsert vendor_overrides (COALESCE keeps existing fields when new value is null)
    db.prepare(`
      INSERT INTO vendor_overrides (vendor_key, name, country, is_reverse_charge, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(vendor_key) DO UPDATE SET
        name = COALESCE(excluded.name, vendor_overrides.name),
        country = COALESCE(excluded.country, vendor_overrides.country),
        is_reverse_charge = CASE WHEN excluded.is_reverse_charge IS NOT NULL THEN excluded.is_reverse_charge ELSE vendor_overrides.is_reverse_charge END,
        updated_at = excluded.updated_at
    `).run(vendorKey, supplierName ?? null, country ?? null, isReverseCharge != null ? (isReverseCharge ? 1 : 0) : null);

    // Propagate country + supplier_name to ALL docs from this vendor
    // Use LIKE for Unicode-safe matching (SQLite LOWER() doesn't handle umlauts)
    const siblingDocs = db.prepare(
      'SELECT document_id, meta, source_system, supplier_name FROM documents WHERE supplier_name COLLATE NOCASE = ? OR supplier_name LIKE ?'
    ).all(vendorKey, vendorKey) as any[];

    for (const sib of siblingDocs) {
      if (sib.document_id === excludeDocId) continue;
      const sibMeta = JSON.parse(sib.meta || '{}');
      let changed = false;
      if (country) {
        sibMeta.invoice_country = country;
        sibMeta.seller_country = country;
        sibMeta.country = country;
        if (sibMeta.vat_country !== undefined) sibMeta.vat_country = country;
        changed = true;
      }
      if (changed || supplierName) {
        const sibUpdates: string[] = ['meta = ?'];
        const sibVals: any[] = [JSON.stringify(sibMeta)];
        if (supplierName) {
          sibUpdates.push('supplier_name = ?');
          sibVals.push(supplierName);
        }
        db.prepare(`UPDATE documents SET ${sibUpdates.join(', ')} WHERE document_id = ?`)
          .run(...sibVals, sib.document_id);

        // Update in-memory
        const sibMemDoc = state.documents.get(sib.document_id);
        if (sibMemDoc) {
          sibMemDoc.meta = sibMeta;
          if (supplierName) sibMemDoc.supplier_name = supplierName;
        }
      }

      // Also update invoice_extracted_fields if applicable
      if (sib.source_system === 'invoice_scan') {
        const scan = db.prepare('SELECT scan_id FROM invoice_scans WHERE document_id = ?').get(sib.document_id) as any;
        if (scan) {
          const efUpdates: string[] = [];
          const efVals: any[] = [];
          if (country) { efUpdates.push('seller_country = ?'); efVals.push(country); }
          if (supplierName) { efUpdates.push('seller_name = ?'); efVals.push(supplierName); }
          if (efUpdates.length > 0) {
            db.prepare(`UPDATE invoice_extracted_fields SET ${efUpdates.join(', ')} WHERE scan_id = ?`)
              .run(...efVals, scan.scan_id);
          }
        }
      }
    }
  }

  // ===== Inline VAT report edit =====
  router.put('/documents/:id/vat-edit', (req, res) => {
    const db = getDb();
    const state = getState();
    const docId = req.params.id;
    const { country_code, supplier_name, net_minor, vat_minor, gross_minor, vat_rate, is_reverse_charge, apply_vat_to_vendor, tax_category_kz, details, skip_propagation, cash_payment } = req.body;

    // 1. Load document (DB first, then in-memory state for bot-created docs)
    const docRow = db.prepare('SELECT * FROM documents WHERE document_id = ?').get(docId) as any;
    const memDoc = state.documents.get(docId);
    if (!docRow && !memDoc) return res.status(404).json({ error: 'Document not found' });

    const oldSupplierName = docRow?.supplier_name ?? memDoc?.supplier_name ?? '';
    const meta = docRow ? JSON.parse(docRow.meta || '{}') : { ...(memDoc?.meta ?? {}) };

    // 2. Build updated fields for this specific document
    const updates: Record<string, any> = {};
    if (supplier_name !== undefined) updates.supplier_name = supplier_name;
    if (vat_minor !== undefined) updates.vat_amount_minor = vat_minor;
    if (vat_rate !== undefined) updates.vat_rate = vat_rate;
    if (gross_minor !== undefined) updates.total_amount_minor = gross_minor;
    if (country_code !== undefined) {
      meta.invoice_country = country_code;
      meta.seller_country = country_code;
      meta.country = country_code;
      if (meta.vat_country !== undefined) meta.vat_country = country_code;
    }
    if (tax_category_kz !== undefined) {
      meta.tax_category_kz = tax_category_kz;
    }
    if (details !== undefined) {
      meta.details = details;
    }
    if (cash_payment !== undefined) {
      meta.cash_payment = !!cash_payment;
    }
    if (req.body.issue_accepted !== undefined) {
      meta.issue_accepted = req.body.issue_accepted;
    }
    updates.meta = JSON.stringify(meta);

    // 3. Update documents table (only if doc exists in DB)
    if (docRow) {
      const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE documents SET ${setClauses} WHERE document_id = ?`)
        .run(...Object.values(updates), docId);
    }

    // 4. Update in-memory state
    if (memDoc) {
      if (updates.supplier_name !== undefined) memDoc.supplier_name = updates.supplier_name;
      if (updates.vat_amount_minor !== undefined) memDoc.vat_amount_minor = updates.vat_amount_minor;
      if (updates.vat_rate !== undefined) memDoc.vat_rate = updates.vat_rate;
      if (updates.total_amount_minor !== undefined) memDoc.total_amount_minor = updates.total_amount_minor;
      memDoc.meta = meta;
    }

    // 5. If invoice_scan source: update extracted fields too (amounts are doc-specific)
    const sourceSystem = docRow?.source_system ?? memDoc?.source_system;
    if (sourceSystem === 'invoice_scan') {
      const scan = db.prepare('SELECT scan_id FROM invoice_scans WHERE document_id = ?').get(docId) as any;
      if (scan) {
        const efUpdates: string[] = [];
        const efVals: any[] = [];
        if (supplier_name !== undefined) { efUpdates.push('seller_name = ?'); efVals.push(supplier_name); }
        if (country_code !== undefined) { efUpdates.push('seller_country = ?'); efVals.push(country_code); }
        if (vat_rate !== undefined) { efUpdates.push('vat_rate = ?'); efVals.push(vat_rate); }
        if (vat_minor !== undefined) { efUpdates.push('vat_amount_minor = ?'); efVals.push(vat_minor); }
        if (gross_minor !== undefined) { efUpdates.push('gross_amount_minor = ?'); efVals.push(gross_minor); }
        if (net_minor !== undefined) { efUpdates.push('net_amount_minor = ?'); efVals.push(net_minor); }
        if (efUpdates.length > 0) {
          db.prepare(`UPDATE invoice_extracted_fields SET ${efUpdates.join(', ')} WHERE scan_id = ?`)
            .run(...efVals, scan.scan_id);
        }
      }
    }

    // 6. Vendor override propagation (country + supplier_name + reverse_charge → all docs from same vendor)
    //    Exception: Amazon vendors have different sellers per order — country is NOT propagated globally
    const isAmazonVendor = sourceSystem === 'amazon' || oldSupplierName.toLowerCase().includes('amazon');
    if (!skip_propagation && (country_code !== undefined || supplier_name !== undefined || is_reverse_charge !== undefined) && oldSupplierName) {
      propagateVendorOverride(
        oldSupplierName.trim().toLowerCase(),
        isAmazonVendor ? undefined : country_code,  // skip country propagation for Amazon
        supplier_name,
        is_reverse_charge,
        docId,
      );
    }

    // 7. If apply_vat_to_vendor: propagate vat_rate to all docs from same vendor
    if (apply_vat_to_vendor && vat_rate !== undefined && oldSupplierName) {
      const vendorKey = oldSupplierName.trim().toLowerCase();
      const sibDocs = db.prepare(
        'SELECT document_id, source_system FROM documents WHERE supplier_name COLLATE NOCASE = ? OR supplier_name LIKE ?'
      ).all(vendorKey, vendorKey) as any[];
      for (const sib of sibDocs) {
        if (sib.document_id === docId) continue;
        db.prepare('UPDATE documents SET vat_rate = ? WHERE document_id = ?').run(vat_rate, sib.document_id);
        const memDoc = state.documents.get(sib.document_id);
        if (memDoc) memDoc.vat_rate = vat_rate;
        // Also update invoice_extracted_fields
        if (sib.source_system === 'invoice_scan') {
          const scan = db.prepare('SELECT scan_id FROM invoice_scans WHERE document_id = ?').get(sib.document_id) as any;
          if (scan) {
            db.prepare('UPDATE invoice_extracted_fields SET vat_rate = ? WHERE scan_id = ?').run(vat_rate, scan.scan_id);
          }
        }
      }
    }

    saveState(state);
    res.json({ ok: true });
  });

  // ===== WooCommerce income PDF upload =====
  router.post('/income/upload-wc', upload.any(), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) return res.status(400).json({ error: 'Keine Dateien' });

    const state = getState();
    const results: any[] = [];

    try {
      const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

      for (const f of files) {
        try {
          const data = new Uint8Array(fs.readFileSync(f.path));
          const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
          let fullText = '';
          for (let i = 1; i <= doc.numPages; i++) {
            const pg = await doc.getPage(i);
            const content = await pg.getTextContent();
            for (const item of content.items as any[]) fullText += (item.str ?? '') + ' ';
            fullText += '\n';
          }

          // Parse WooCommerce invoice/refund
          const isRefund = /Refund\s+CN-/i.test(fullText);
          const refMatch = fullText.match(/(?:IN-|CN-)(\d+)/);
          const ref = refMatch ? refMatch[0] : f.originalname.replace(/\.pdf$/i, '');
          const orderMatch = fullText.match(/(?:order|WC-)[\s]*(\d{5,})/i);
          const orderId = orderMatch ? orderMatch[1] : '';

          // Date: "29. August 2025" or "24. September 2025"
          const dateMatch = fullText.match(/(?:Invoice|Refund)\s+[Dd]ate\s*(\d{1,2})\.\s*(\w+)\s+(\d{4})/);
          let docDate = '';
          if (dateMatch) {
            const months: Record<string, string> = { january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12',
              januar:'01',februar:'02',märz:'03',mai:'05',juni:'06',juli:'07',oktober:'10',dezember:'12' };
            const m = months[dateMatch[2].toLowerCase()] ?? '01';
            docDate = `${dateMatch[3]}-${m}-${dateMatch[1].padStart(2, '0')}`;
          }

          // Customer name: lines after "Austria" and before "WC-" or "IN-"
          const custMatch = fullText.match(/Austria\s+(.+?)(?=\s+(?:WC-|IN-|CN-))/s);
          const customerName = custMatch ? custMatch[1].replace(/\s+/g, ' ').trim().split(/\s{2,}/)[0] : '';

          // VAT rate: "VAT 19 % DE (19%)" or "VAT 20 % AT (20%)"
          const vatRateMatch = fullText.match(/VAT\s+(\d+)\s*%/);
          const vatRatePercent = vatRateMatch ? parseInt(vatRateMatch[1]) : 0;
          const vatRate = vatRatePercent / 100;

          // Country from VAT line: "DE (19%)" or "AT (20%)"
          const countryMatch = fullText.match(/VAT\s+\d+\s*%\s*(\w{2})/);
          const country = countryMatch ? countryMatch[1].toUpperCase() : '';

          let grossMinor: number;
          let vatMinor: number;
          let netMinor: number;

          if (isRefund) {
            // Refund: extract refund amount (e.g. "Refund: -10,00 €")
            const refundMatch = fullText.match(/Refund:\s*-?([\d.,]+)\s*€/);
            grossMinor = refundMatch ? -Math.round(parseFloat(refundMatch[1].replace('.', '').replace(',', '.')) * 100) : 0;
            // Compute net/vat from gross using the VAT rate
            if (vatRate > 0) {
              netMinor = Math.round(grossMinor / (1 + vatRate));
              vatMinor = grossMinor - netMinor;
            } else {
              netMinor = grossMinor;
              vatMinor = 0;
            }
          } else {
            // Invoice: Total line
            const totalMatch = fullText.match(/Total:\s*([\d.,]+)\s*€/);
            grossMinor = totalMatch ? Math.round(parseFloat(totalMatch[1].replace('.', '').replace(',', '.')) * 100) : 0;
            const vatMatch = fullText.match(/Includes\s+([\d.,]+)\s*€\s*VAT/);
            vatMinor = vatMatch ? Math.round(parseFloat(vatMatch[1].replace('.', '').replace(',', '.')) * 100) : 0;
            netMinor = grossMinor - vatMinor;
          }

          // Store file
          const year = docDate.slice(0, 4) || new Date().getFullYear().toString();
          const targetDir = path.resolve(`Belege/${year}/Einkuenfte`);
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          const storedName = `WC-${orderId}-${isRefund ? 'refund' : 'Invoice'}-${ref}.pdf`;
          const targetPath = path.join(targetDir, storedName);
          fs.copyFileSync(f.path, targetPath);

          // Create/update document
          const { documentId: docIdFn } = await import('../../core/ids.js');
          const docId = docIdFn('income', ref);
          const db = getDb();
          const exists = db.prepare('SELECT 1 FROM documents WHERE document_id = ?').get(docId);

          const meta = JSON.stringify({
            type: isRefund ? 'wc_refund' : 'wc_invoice',
            order_id: orderId,
            customer_name: customerName,
            land: country || undefined,
            vat_rate_percent: vatRatePercent,
          });

          if (exists) {
            db.prepare('UPDATE documents SET total_amount_minor = ?, vat_amount_minor = ?, vat_rate = ?, document_date = ?, supplier_name = ?, filename = ?, meta = ? WHERE document_id = ?')
              .run(grossMinor, vatMinor, vatRate, docDate, customerName, storedName, meta, docId);
          } else {
            db.prepare(`INSERT INTO documents (document_id, source_system, source_document_ref, captured_at, document_date, total_amount_minor, currency_code, supplier_name, vat_amount_minor, vat_rate, filename, meta)
              VALUES (?, 'income', ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?)`)
              .run(docId, ref, new Date().toISOString(), docDate, grossMinor, customerName, vatMinor, vatRate, storedName, meta);
          }

          // Add to state
          state.documents.set(docId, {
            document_id: docId, source_system: 'income' as any, source_document_ref: ref,
            captured_at: new Date().toISOString(), document_date: docDate,
            total_amount_minor: grossMinor, currency_code: 'EUR',
            supplier_name: customerName, vat_amount_minor: vatMinor, vat_rate: vatRate,
            filename: storedName, meta: JSON.parse(meta),
          });

          results.push({
            filename: f.originalname, documentId: docId, ref, isRefund,
            customer: customerName, date: docDate, gross: grossMinor / 100, vat: vatMinor / 100, net: netMinor / 100,
            vatRate: vatRatePercent, country, stored: storedName,
          });
        } catch (err: any) {
          results.push({ filename: f.originalname, error: err.message });
        }
      }

      // Run matching
      const { runMatchingEngine } = await import('../../core/matching/engine.js');
      const { ALL_RULES } = await import('../../core/matching/rules/index.js');
      runMatchingEngine(state, ALL_RULES);
      saveState(state);

      res.json({ ok: true, results });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ===== Eigenbeleg =====
  router.post('/documents/eigenbeleg', async (req, res) => {
    try {
      const { transaction_id, vendor, country, description, provisional } = req.body;
      if (!transaction_id) return res.status(400).json({ error: 'transaction_id required' });

      const state = getState();
      const txn = state.transactions.get(transaction_id);
      if (!txn) return res.status(404).json({ error: 'Transaction not found' });

      if (!vendor || !country) {
        return res.status(400).json({ error: 'vendor and country required' });
      }

      const { createEigenbeleg } = await import('../../invoicerec/generate-invoice.js');
      const amount = Math.abs(txn.amount_minor) / 100;
      const isRefund = txn.amount_minor > 0;
      const date = txn.posting_at.slice(0, 10);
      const transactionRef = `${txn.source_system}: ${String(txn.description_raw ?? '').slice(0, 60)}`;

      const result = await createEigenbeleg({
        date,
        amount,
        isRefund,
        vendor,
        country,
        description: description || (isRefund ? `Erstattung ${vendor}` : `Zahlung ${vendor}`),
        transactionRef,
        provisional: !!provisional,
      });

      // Load into state + match
      loadNewDocsIntoState(getState, 'invoice_scan');
      const matchState = getState();
      const { createMatch: cm } = await import('../../core/matching/engine.js');
      cm(matchState, 'MANUAL_DROP', [transaction_id], [result.documentId], { type: 'eigenbeleg' });
      saveState(matchState);

      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ===== Eigenbeleg receipt upload =====
  router.post('/documents/eigenbeleg/upload', upload.single('files'), (req, res) => {
    const db = getDb();
    const docId = req.body.document_id;
    if (!docId) return res.status(400).json({ error: 'document_id required' });
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const doc = db.prepare('SELECT * FROM documents WHERE document_id = ?').get(docId) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Move file to Belege folder
    const year = doc.document_date?.slice(0, 4) ?? new Date().getFullYear().toString();
    const targetDir = path.resolve(`Belege/${year}/Rechnungen`);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const ext = path.extname(file.originalname);
    const targetName = `${doc.source_document_ref.replace(/\//g, '-')}${ext}`;
    const targetPath = path.join(targetDir, targetName);
    fs.copyFileSync(file.path, targetPath);

    // Update document: set filename, clear needs_receipt
    const meta = JSON.parse(doc.meta || '{}');
    meta.needs_receipt = false;
    db.prepare('UPDATE documents SET filename = ?, meta = ? WHERE document_id = ?')
      .run(targetName, JSON.stringify(meta), docId);

    // Update in-memory state
    const state = getState();
    const memDoc = state.documents.get(docId);
    if (memDoc) {
      memDoc.filename = targetName;
      memDoc.meta = meta;
    }
    saveState(state);

    res.json({ ok: true, filename: targetName });
  });

  // ===== Settings =====
  router.get('/settings/:key', (req, res) => {
    // Deny sensitive data by default. Never include even a key prefix in JSON.
    res.json(settingForHttp(req.params.key, getSetting(req.params.key)));
  });

  router.put('/settings/:key', (req, res) => {
    const { value } = req.body;
    if (!value) return res.status(400).json({ ok: false, error: 'value is required' });
    setSetting(req.params.key, value);
    res.json({ ok: true });
  });

  router.delete('/settings/:key', (req, res) => {
    deleteSetting(req.params.key);
    res.json({ ok: true });
  });

  // ===== Dispositions =====
  router.post('/transactions/:id/disposition', (req, res) => {
    const { disposition, note } = req.body;
    if (!disposition) return res.status(400).json({ error: 'disposition is required' });
    setDisposition(req.params.id, disposition, note, undefined, 'user');

    // For PayPal: also set the counterpart transaction (same date, inverted amount)
    const state = getState();
    // For PayPal: also set/reset the counterpart transaction (±1 day, inverted amount)
    const txn = state.transactions.get(req.params.id);
    const alsoSet: string[] = [];
    if (txn && txn.source_system === 'paypal' && (disposition === 'privat' || disposition === 'open')) {
      const targetAmount = -txn.amount_minor;
      const txnMs = new Date(txn.posting_at.slice(0, 10)).getTime();
      for (const t of state.transactions.values()) {
        if (t.transaction_id === txn.transaction_id) continue;
        if (t.source_system !== 'paypal') continue;
        if (t.amount_minor !== targetAmount) continue;
        const diffDays = Math.abs(new Date(t.posting_at.slice(0, 10)).getTime() - txnMs) / 86400000;
        if (diffDays > 1) continue;
        setDisposition(t.transaction_id, disposition, note, undefined, 'user');
        alsoSet.push(t.transaction_id);
      }
    }

    res.json({ ok: true, also_set: alsoSet });
  });

  // Mark all transactions of a vendor as privat + add vendor to private list
  router.post('/private-vendors', (req, res) => {
    const state = getState();
    const { vendor_name } = req.body;
    if (!vendor_name) return res.status(400).json({ error: 'vendor_name is required' });

    const db = getDb();
    // Add to private vendors list
    db.prepare(
      'INSERT OR IGNORE INTO private_vendors (vendor_name) VALUES (?)'
    ).run(vendor_name);

    // Mark all existing transactions from this vendor as privat
    const txnIds: string[] = [];
    const counterpartIds: string[] = [];
    for (const t of state.transactions.values()) {
      if (t.counterparty_name && t.counterparty_name.toLowerCase() === vendor_name.toLowerCase()) {
        txnIds.push(t.transaction_id);

        // For PayPal: also mark counterpart (inverted amount, same date ±1 day)
        if (t.source_system === 'paypal') {
          const targetAmount = -t.amount_minor;
          const txnMs = new Date(t.posting_at.slice(0, 10)).getTime();
          for (const c of state.transactions.values()) {
            if (c.transaction_id === t.transaction_id) continue;
            if (c.source_system !== 'paypal') continue;
            if (c.amount_minor !== targetAmount) continue;
            const diffDays = Math.abs(new Date(c.posting_at.slice(0, 10)).getTime() - txnMs) / 86400000;
            if (diffDays > 1) continue;
            if (!txnIds.includes(c.transaction_id) && !counterpartIds.includes(c.transaction_id)) {
              counterpartIds.push(c.transaction_id);
            }
          }
        }
      }
    }
    const allIds = [...txnIds, ...counterpartIds];
    if (allIds.length > 0) {
      setDispositionBatch(allIds, 'privat', `Vendor "${vendor_name}" als privat markiert`);
    }

    res.json({ ok: true, vendor: vendor_name, marked_count: allIds.length });
  });

  router.get('/private-vendors', (_req, res) => {
    const db = getDb();
    const vendors = db.prepare('SELECT vendor_name, added_at FROM private_vendors ORDER BY vendor_name').all();
    res.json(vendors);
  });

  // Open email compose in Betterbird
  router.post('/compose-email', (req, res) => {
    const { to, subject, body } = req.body;
    const betterbirdPath = 'C:\\Program Files\\Betterbird\\betterbird.exe';
    // Use mailto: URL — Betterbird handles it natively with correct encoding
    const mailto = `mailto:${to || ''}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
    const cmd = `"${betterbirdPath}" -osint -compose "${mailto}"`;
    console.log('[compose-email] to:', to);
    exec(cmd, (err) => {
      if (err) {
        console.log('[compose-email] error:', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json({ ok: true });
    });
  });

  // Look up vendor email from existing invoice scans + overrides
  router.get('/vendor-email', (req, res) => {
    const vendor = (req.query.vendor as string ?? '').trim().toLowerCase();
    if (!vendor) return res.json({ email: null });
    const db = getDb();

    // Normalize: remove spaces, punctuation for comparison
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const vendorNorm = normalize(vendor);
    const stopWords = new Set(['gmbh', 'mbh', 'ltd', 'inc', 'sarl', 'sca', 'sro', 'the', 'und', 'and', 'für', 'for', 'inkl', 'von']);
    const vendorWords = vendor.replace(/[^a-zäöü0-9\s]/gi, '').toLowerCase().split(/\s+/)
      .filter(w => w.length >= 4 && !stopWords.has(w));

    // 1. Check manual overrides — exact, then normalized
    const overrides = db.prepare("SELECT vendor_key, email FROM vendor_overrides WHERE email IS NOT NULL AND email != ''").all() as any[];
    for (const o of overrides) {
      if (o.vendor_key === vendor || normalize(o.vendor_key) === vendorNorm) {
        return res.json({ email: o.email });
      }
    }
    // Override fuzzy: any significant word matches
    for (const o of overrides) {
      const oWords = normalize(o.vendor_key);
      if (vendorWords.some(w => oWords.includes(w))) {
        return res.json({ email: o.email });
      }
    }

    // 2. Search in invoice_extracted_fields
    const scanRows = db.prepare(`
      SELECT seller_name, meta FROM invoice_extracted_fields
      WHERE meta LIKE '%seller_email%' AND seller_name IS NOT NULL
    `).all() as { seller_name: string; meta: string }[];

    // Exact match
    for (const row of scanRows) {
      if (row.seller_name.toLowerCase() === vendor || normalize(row.seller_name) === vendorNorm) {
        try { const m = JSON.parse(row.meta); if (m.seller_email) return res.json({ email: m.seller_email }); } catch {}
      }
    }
    // Fuzzy: any significant word from query matches seller_name
    for (const row of scanRows) {
      const sellerNorm = normalize(row.seller_name);
      if (vendorWords.some(w => sellerNorm.includes(w))) {
        try { const m = JSON.parse(row.meta); if (m.seller_email) return res.json({ email: m.seller_email }); } catch {}
      }
    }

    res.json({ email: null });
  });

  // Aggregated vendor directory from all invoice scans
  router.get('/vendors', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT seller_name, seller_country, seller_vat_id, meta
      FROM invoice_extracted_fields
      WHERE seller_name IS NOT NULL AND seller_name != ''
    `).all() as { seller_name: string; seller_country: string | null; seller_vat_id: string | null; meta: string }[];

    // Aggregate: for each field, pick the most frequent non-null value
    const vendors = new Map<string, {
      name: string;
      country: Map<string, number>;
      vat_id: Map<string, number>;
      email: Map<string, number>;
      count: number;
    }>();

    for (const row of rows) {
      const key = row.seller_name.trim().toLowerCase();
      if (!vendors.has(key)) {
        vendors.set(key, { name: row.seller_name.trim(), country: new Map(), vat_id: new Map(), email: new Map(), count: 0 });
      }
      const v = vendors.get(key)!;
      v.count++;
      // Use the casing from the most recent entry
      v.name = row.seller_name.trim();
      if (row.seller_country) v.country.set(row.seller_country, (v.country.get(row.seller_country) ?? 0) + 1);
      if (row.seller_vat_id) v.vat_id.set(row.seller_vat_id, (v.vat_id.get(row.seller_vat_id) ?? 0) + 1);
      try {
        const meta = JSON.parse(row.meta || '{}');
        if (meta.seller_email) v.email.set(meta.seller_email, (v.email.get(meta.seller_email) ?? 0) + 1);
      } catch {}
    }

    const pick = (m: Map<string, number>): string | null => {
      if (m.size === 0) return null;
      let best: string | null = null, bestCount = 0;
      for (const [val, count] of m) { if (count > bestCount) { best = val; bestCount = count; } }
      return best;
    };

    // Load manual overrides
    const overrides = new Map<string, { name?: string; country?: string; address?: string; vat_id?: string; email?: string; is_reverse_charge?: number; tax_category_kz?: string }>();
    const overrideRows = db.prepare('SELECT vendor_key, name, country, address, vat_id, email, is_reverse_charge, tax_category_kz FROM vendor_overrides').all() as any[];
    for (const o of overrideRows) overrides.set(o.vendor_key, o);

    const result = [...vendors.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(v => {
        const key = v.name.toLowerCase();
        const ov = overrides.get(key);
        return {
          name: ov?.name || v.name,
          country: ov?.country ?? pick(v.country),
          address: ov?.address ?? null,
          vat_id: ov?.vat_id ?? pick(v.vat_id),
          email: ov?.email ?? pick(v.email),
          invoice_count: v.count,
          has_override: !!ov,
          is_reverse_charge: !!(ov?.is_reverse_charge),
          tax_category_kz: ov?.tax_category_kz ?? null,
        };
      });

    res.json(result);
  });

  // Update vendor override — single source of truth, propagates to all documents
  router.put('/vendors/:name', (req, res) => {
    const db = getDb();
    const vendorKey = req.params.name.trim().toLowerCase();
    const { name, country, address, vat_id, email, is_reverse_charge, tax_category_kz } = req.body;
    // Full upsert (Settings page sends all fields)
    db.prepare(`
      INSERT INTO vendor_overrides (vendor_key, name, country, address, vat_id, email, is_reverse_charge, tax_category_kz, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(vendor_key) DO UPDATE SET
        name = excluded.name, country = excluded.country, address = excluded.address, vat_id = excluded.vat_id,
        email = excluded.email, is_reverse_charge = excluded.is_reverse_charge,
        tax_category_kz = excluded.tax_category_kz, updated_at = excluded.updated_at
    `).run(vendorKey, name || null, country || null, address || null, vat_id || null, email || null, is_reverse_charge ? 1 : 0, tax_category_kz || null);

    // Propagate country + name to all documents from this vendor
    if (country || name || is_reverse_charge !== undefined) {
      propagateVendorOverride(vendorKey, country || undefined, name || undefined, is_reverse_charge);
      saveState(getState());
    }
    res.json({ ok: true });
  });

  router.delete('/private-vendors/:name', (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM private_vendors WHERE vendor_name = ?').run(req.params.name);
    res.json({ ok: true });
  });

  // ===== File Open / Serve =====
  // Resolves a filename to the actual file on disk and serves it
  router.get('/files/open/:filename(*)', (req, res) => {
    const p = req.params as Record<string, string>;
    const filename = decodeURIComponent(p['filename'] ?? p['filename(*)'] ?? p[0] ?? '');
    if (!filename || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    // Base directory: 001-Buchhaltung (parent of MATCHING-TOOL-V2)
    const buchhaltungDir = path.resolve(DATA_DIR, '../../..');
    // Search directories where invoice/income files may live
    const searchDirs: string[] = [];
    // Add year-based directories dynamically
    for (const year of ['2024', '2025', '2026']) {
      searchDirs.push(
        path.join(buchhaltungDir, year, 'Q1-Q2', 'extracted_invoices'),
        path.join(buchhaltungDir, year, 'Q1-Q2', 'income_invoices'),
        path.join(buchhaltungDir, year, 'Q3-Q4', 'extracted_invoices'),
        path.join(buchhaltungDir, year, 'Q3-Q4', 'income_invoices'),
        path.join(buchhaltungDir, year, 'Ablage-Rechnungen'),
        path.join(buchhaltungDir, year, 'Einkuenfte'),
        path.join(buchhaltungDir, year, 'Rechnungen'),
      );
    }
    searchDirs.push(path.join(buchhaltungDir, 'Amazon-Rechnungen'));

    // Add all Belege year directories
    try {
      const belegeYears = fs.readdirSync(BELEGE_DIR).filter(e =>
        /^\d{4}$/.test(e) && fs.statSync(path.join(BELEGE_DIR, e)).isDirectory()
      );
      for (const y of belegeYears) {
        searchDirs.push(path.join(BELEGE_DIR, y, 'Einkuenfte'));
        searchDirs.push(path.join(BELEGE_DIR, y, 'Rechnungen'));
        searchDirs.push(path.join(BELEGE_DIR, y, 'Rechnungen', 'Amazon-Rechnungen'));
      }
    } catch {}

    // Also check setting for custom file directories
    const customDirs = getSetting('file_search_dirs');
    if (customDirs) {
      for (const d of customDirs.split(';')) {
        if (d.trim()) searchDirs.push(d.trim());
      }
    }

    for (const dir of searchDirs) {
      const filePath = path.join(dir, filename);
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          exec(`explorer "${filePath.replace(/\//g, '\\\\')}"`);
          return res.type('html').send(`<!DOCTYPE html><html><head><title>Ordner geöffnet</title></head><body style="font-family:system-ui;padding:40px;text-align:center"><h2 style="color:#27ae60">Ordner geöffnet</h2><p style="color:#666">${filename}</p><p style="font-size:13px;color:#999">Der Ordner wurde im Explorer geöffnet. Du kannst diesen Tab schließen.</p></body></html>`);
        }
        return res.sendFile(filePath);
      }
    }

    // Fallback: recursive search from Buchhaltung base
    const found = findFileRecursive(buchhaltungDir, filename, 4);
    if (found) {
      const stat = fs.statSync(found);
      if (stat.isDirectory()) {
        exec(`explorer "${found.replace(/\//g, '\\\\')}"`);
        return res.type('html').send(`<!DOCTYPE html><html><head><title>Ordner geöffnet</title></head><body style="font-family:system-ui;padding:40px;text-align:center"><h2 style="color:#27ae60">Ordner geöffnet</h2><p style="color:#666">${filename}</p><p style="font-size:13px;color:#999">Der Ordner wurde im Explorer geöffnet. Du kannst diesen Tab schließen.</p></body></html>`);
      }
      return res.sendFile(found);
    }

    res.status(404).type('html').send(`<!DOCTYPE html><html><head><title>Datei nicht gefunden</title></head><body style="font-family:system-ui;padding:40px;text-align:center"><h2 style="color:#e74c3c">Datei nicht gefunden</h2><p style="color:#666">${filename}</p><p style="font-size:13px;color:#999">Die Datei existiert nicht im Dateisystem.</p></body></html>`);
  });

  // ===== Stripe Import =====
  router.post('/import/stripe', async (req, res) => {
    try {
      const { start_date, end_date, api_key } = req.body;

      if (!start_date || !end_date) {
        return res.status(400).json({ ok: false, error: 'start_date and end_date are required' });
      }

      // Priority: request body → saved setting → env var
      let stripeKey = api_key || getSetting('stripe_api_key') || process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) {
        return res.status(400).json({ ok: false, error: 'Stripe API key required' });
      }

      // Save the key for future use if provided in the request
      if (api_key) {
        setSetting('stripe_api_key', api_key);
      }

      const result = await importStripeTransactions(stripeKey, start_date, end_date);
      loadNewTxnsIntoState(getState, 'stripe');
      saveState(getState());
      autoMarkPrivateVendors();

      res.json({
        ok: true,
        ...result,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ===== PayPal Import =====
  router.post('/import/paypal', async (req, res) => {
    try {
      const { start_date, end_date, client_id, client_secret, sandbox } = req.body;

      if (!start_date || !end_date) {
        return res.status(400).json({ ok: false, error: 'start_date and end_date are required' });
      }

      const ppClientId = client_id || getSetting('paypal_client_id') || process.env.PAYPAL_CLIENT_ID;
      const ppClientSecret = client_secret || getSetting('paypal_client_secret') || process.env.PAYPAL_CLIENT_SECRET;
      if (!ppClientId || !ppClientSecret) {
        return res.status(400).json({ ok: false, error: 'PayPal Client ID and Client Secret required' });
      }

      if (client_id) setSetting('paypal_client_id', client_id);
      if (client_secret) setSetting('paypal_client_secret', client_secret);

      const isSandbox = sandbox ?? (getSetting('paypal_sandbox') === 'true');

      const result = await importPayPalTransactions(ppClientId, ppClientSecret, start_date, end_date, isSandbox);
      loadNewTxnsIntoState(getState, 'paypal');
      saveState(getState());
      autoMarkPrivateVendors();

      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ===== Enable Banking (Bank Import) =====

  // List available banks for a country
  router.get('/import/bank/aspsps', async (req, res) => {
    try {
      const country = (req.query.country as string) ?? 'AT';
      const aspsps = await listAspsps(country);
      // Filter by search query if provided
      const q = (req.query.q as string ?? '').toLowerCase();
      const filtered = q ? aspsps.filter(a => a.name.toLowerCase().includes(q)) : aspsps;
      res.json({ banks: filtered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Start bank authorization (redirect flow)
  router.post('/import/bank/connect', async (req, res) => {
    try {
      const { aspsp_name, aspsp_country } = req.body;
      if (!aspsp_name) return res.status(400).json({ error: 'aspsp_name required' });

      const country = aspsp_country ?? 'AT';
      const callbackBase = getSetting('eb_callback_url') ?? 'https://www.example.com';
      const redirectUrl = `${callbackBase}/api/import/bank/callback`;
      const state = crypto.randomUUID();

      setSetting('eb_auth_state', state);
      setSetting('eb_aspsp_name', aspsp_name);
      setSetting('eb_aspsp_country', country);

      const result = await startAuth(aspsp_name, country, redirectUrl, state);

      res.json({ ok: true, redirect_url: result.url });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Handle redirect callback from bank
  router.get('/import/bank/callback', async (req, res) => {
    try {
      const code = req.query.code as string;
      if (!code) {
        const err = req.query.error as string ?? 'no_code';
        return res.redirect(`/import?error=${encodeURIComponent(err)}`);
      }

      const session = await createSession(code);
      setSetting('eb_session_id', session.session_id);

      // Store account UIDs
      const accountUids = session.accounts.map(a => a.uid);
      setSetting('eb_account_uids', JSON.stringify(accountUids));

      res.redirect('/import?bank=connected');
    } catch (err: any) {
      res.redirect(`/import?error=${encodeURIComponent(err.message)}`);
    }
  });

  // Connection status + accounts
  router.get('/import/bank/status', async (_req, res) => {
    try {
      const appId = getSetting('eb_application_id');
      if (!appId) {
        return res.json({ connected: false, configured: false });
      }

      const sessionId = getSetting('eb_session_id');
      if (!sessionId) {
        return res.json({ connected: false, configured: true });
      }

      const session = await getSession(sessionId);
      const bankName = getSetting('eb_aspsp_name') ?? session.aspsp?.name ?? 'Bank';

      // Get balances for each account
      const accounts = [];
      for (const acc of session.accounts) {
        const uid = typeof acc === 'string' ? acc : acc.uid;
        try {
          const balances = await getBalances(uid);
          const mainBalance = balances[0];
          accounts.push({
            uid,
            iban: typeof acc === 'object' ? acc.account_id?.iban : null,
            name: typeof acc === 'object' ? acc.name : null,
            currency: typeof acc === 'object' ? acc.currency : mainBalance?.balance_amount?.currency ?? 'EUR',
            balance: mainBalance ? parseFloat(mainBalance.balance_amount.amount) : 0,
          });
        } catch {
          accounts.push({
            uid,
            iban: typeof acc === 'object' ? acc.account_id?.iban : null,
            name: typeof acc === 'object' ? acc.name : null,
            currency: typeof acc === 'object' ? acc.currency : 'EUR',
            balance: 0,
          });
        }
      }

      res.json({
        connected: true,
        configured: true,
        bank_name: bankName,
        session_status: session.status,
        accounts,
      });
    } catch (err: any) {
      // Session expired or invalid
      if (err.message?.includes('404') || err.message?.includes('401')) {
        deleteSetting('eb_session_id');
        return res.json({ connected: false, configured: true, expired: true });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Import transactions
  router.post('/import/bank/transactions', async (req, res) => {
    try {
      const { account_uids, start_date, end_date } = req.body;
      if (!start_date || !end_date) {
        return res.status(400).json({ error: 'start_date and end_date required' });
      }
      if (!account_uids?.length) {
        return res.status(400).json({ error: 'account_uids required' });
      }

      // Import from each account and merge results
      let totalFetched = 0, totalImported = 0, totalSkipped = 0;
      const allTxns: any[] = [];

      for (const uid of account_uids) {
        const result = await importBankTransactions(uid, start_date, end_date);
        totalFetched += result.fetched;
        totalImported += result.imported;
        totalSkipped += result.skipped;
        allTxns.push(...result.transactions);
      }

      loadNewTxnsIntoState(getState, 'bank');
      saveState(getState());

      res.json({
        ok: true,
        fetched: totalFetched,
        imported: totalImported,
        skipped: totalSkipped,
        date_range: { start: start_date, end: end_date },
        transactions: allTxns,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ===== Document Import (Income / Invoice XLS/CSV) =====
  router.post('/import/documents', upload.single('file'), (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'Keine Datei hochgeladen' });
      }

      const type = req.body.type as string;
      if (type !== 'income' && type !== 'invoice') {
        fs.unlinkSync(file.path);
        return res.status(400).json({ error: 'type muss "income" oder "invoice" sein' });
      }

      const ext = path.extname(file.originalname).toLowerCase();
      const tmpPath = file.path + ext;
      fs.renameSync(file.path, tmpPath);

      try {
        const result = importDocumentFile(tmpPath, type as DocImportType, file.originalname);

        // Add imported documents to in-memory state
        loadNewDocsIntoState(getState, type === 'income' ? 'income' : undefined);
        saveState(getState());

        res.json({ ok: true, ...result });
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ===== Invoice generation (Ausgangsrechnungen) =====

  /** Generate a Google Play revenue invoice (Reverse Charge to Google Ireland) */
  router.post('/invoices/generate/google-play', async (req, res) => {
    try {
      const { amount, period, invoice_date } = req.body;
      if (!amount || !period) {
        return res.status(400).json({ error: 'amount (EUR) und period (z.B. "November 2025") erforderlich' });
      }
      const date = invoice_date || new Date().toISOString().slice(0, 10);

      const { createGooglePlayInvoice } = await import('../../invoicerec/generate-invoice.js');
      const result = await createGooglePlayInvoice(parseFloat(amount), period, date);

      // Load into state
      loadNewDocsIntoState(getState, 'income');
      saveState(getState());

      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Generate Google Play invoices for all unmatched GG transactions */
  router.post('/invoices/generate/google-play/auto', async (_req, res) => {
    try {
      const state = getState();
      const { createGooglePlayInvoice } = await import('../../invoicerec/generate-invoice.js');

      const months = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni',
        'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

      const results: Array<{ txnId: string; invoiceNumber: string; amount: number }> = [];

      // Find all unmatched Sparkasse transactions starting with "GG" (Google Gutschrift)
      for (const txn of state.transactions.values()) {
        if (txn.source_system !== 'sparkasse') continue;
        if (state.matched_transaction_ids.has(txn.transaction_id)) continue;
        const desc = String(txn.description_raw ?? '');
        if (!desc.startsWith('GG')) continue;
        if (txn.amount_minor <= 0) continue;

        const amount = txn.amount_minor / 100;
        const txnDate = new Date(txn.posting_at);
        const period = `${months[txnDate.getMonth()]} ${txnDate.getFullYear()}`;
        const invoiceDate = txn.posting_at.slice(0, 10);

        const result = await createGooglePlayInvoice(amount, period, invoiceDate);
        results.push({ txnId: txn.transaction_id, invoiceNumber: result.invoiceNumber, amount });
      }

      // Reload state to pick up new income documents
      loadNewDocsIntoState(getState, 'income');
      saveState(getState());

      // Re-run matching to link the new invoices
      if (results.length > 0) {
        const matchState = getState();
        const { runMatchingEngine } = await import('../../core/matching/engine.js');
        const { ALL_RULES } = await import('../../core/matching/rules/index.js');
        runMatchingEngine(matchState, ALL_RULES);
        saveState(matchState);
      }

      res.json({ ok: true, generated: results.length, invoices: results });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ===== Belege directory info =====
  router.get('/belege/info', (_req, res) => {
    // Collect all year directories
    const years: Record<string, { einkuenfte: number; rechnungen: number }> = {};

    const countFiles = (dir: string): number => {
      try {
        return fs.readdirSync(dir).filter(f => {
          try { return fs.statSync(path.join(dir, f)).isFile() && f !== '.gitkeep'; } catch { return false; }
        }).length;
      } catch { return 0; }
    };

    try {
      const entries = fs.readdirSync(BELEGE_DIR);
      for (const e of entries) {
        if (/^\d{4}$/.test(e) && fs.statSync(path.join(BELEGE_DIR, e)).isDirectory()) {
          years[e] = {
            einkuenfte: countFiles(path.join(BELEGE_DIR, e, 'Einkuenfte')),
            rechnungen: countFiles(path.join(BELEGE_DIR, e, 'Rechnungen')),
          };
        }
      }
    } catch {}

    res.json({ base_path: BELEGE_DIR, years });
  });

  // ===== Open Belege folder =====
  router.post('/belege/open', (req, res) => {
    const { folder, year } = req.body;
    let target = BELEGE_DIR;
    if (year) {
      target = path.join(BELEGE_DIR, String(year));
      if (folder === 'einkuenfte') target = path.join(target, 'Einkuenfte');
      else if (folder === 'rechnungen') target = path.join(target, 'Rechnungen');
    }

    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    exec(`explorer "${target.replace(/\//g, '\\\\')}"`);
    res.json({ ok: true, path: target });
  });

  // ===== Amazon Import (3 CSV files) =====
  router.post('/import/amazon', upload.fields([
    { name: 'sendungen', maxCount: 1 },
    { name: 'erstattungen', maxCount: 1 },
    { name: 'abgleich', maxCount: 1 },
  ]), async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]>;
    const tmpFiles: string[] = [];
    try {
      if (!files?.sendungen?.[0]) {
        return res.status(400).json({ error: 'Sendungen-Datei fehlt' });
      }
      if (!files?.abgleich?.[0]) {
        return res.status(400).json({ error: 'Abgleich-Datei fehlt' });
      }

      // Rename with extensions
      const sendungenFile = files.sendungen[0];
      const sendungenPath = sendungenFile.path + path.extname(sendungenFile.originalname);
      fs.renameSync(sendungenFile.path, sendungenPath);
      tmpFiles.push(sendungenPath);

      const abgleichFile = files.abgleich[0];
      const abgleichPath = abgleichFile.path + path.extname(abgleichFile.originalname);
      fs.renameSync(abgleichFile.path, abgleichPath);
      tmpFiles.push(abgleichPath);

      let erstattungenPath: string | null = null;
      if (files?.erstattungen?.[0]) {
        const erstattungenFile = files.erstattungen[0];
        erstattungenPath = erstattungenFile.path + path.extname(erstattungenFile.originalname);
        fs.renameSync(erstattungenFile.path, erstattungenPath);
        tmpFiles.push(erstattungenPath);
      }

      const result = importAmazon(sendungenPath, erstattungenPath, abgleichPath);

      // Add imported documents to in-memory state
      loadNewDocsIntoState(getState, 'amazon');
      saveState(getState());

      // Auto-link Amazon invoice PDFs to documents by extracting amounts
      let linkResult = null;
      try {
        linkResult = await linkInvoicePdfs();
        if (linkResult.matched > 0) {
          console.log(`[amazon] Auto-linked ${linkResult.matched} PDFs to documents`);
          refreshDocFilenames(getState, 'amazon');
          saveState(getState());
        }
      } catch (err: any) {
        console.log(`[amazon] Link error: ${err.message}`);
      }

      // Enrich docs without country/tax from invoice PDFs
      let enrichResult = null;
      try {
        enrichResult = await enrichAmazonDocsFromPdfs();
        if (enrichResult.enriched > 0) {
          console.log(`[amazon] Enriched ${enrichResult.enriched}/${enrichResult.checked} docs from PDFs`);
          loadNewDocsIntoState(getState, 'amazon');
          saveState(getState());
        }
      } catch (err: any) {
        console.log(`[amazon] Enrich error: ${err.message}`);
      }

      res.json({ ok: true, ...result, auto_linked: linkResult, pdf_enriched: enrichResult });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    } finally {
      for (const f of tmpFiles) {
        try { fs.unlinkSync(f); } catch {}
      }
      // Clean up unrenamed originals if rename failed
      for (const key of ['sendungen', 'erstattungen', 'abgleich']) {
        const f = files?.[key]?.[0];
        if (f) try { fs.unlinkSync(f.path); } catch {}
      }
    }
  });

  // ===== Amazon PDF ↔ Document Linking =====
  router.post('/import/amazon/link-pdfs', async (_req, res) => {
    try {
      const result = await linkInvoicePdfs();
      // Sync updated filenames from DB into in-memory state
      refreshDocFilenames(getState, 'amazon');
      saveState(getState());
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Reviewed, authenticated and recoverable offline statement ingestion.
  router.use(createStatementImportRouter(getState, setState));
  router.use(createStatementPreviewRouter(getState, setState));

  // ===== Invoice Recognition =====
  // Timeout for processing a single file (60s)
  const FILE_PROCESS_TIMEOUT = 60_000;

  function withFileTimeout<T>(promise: Promise<T>, ms: number, filename: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout: ${filename} nach ${ms / 1000}s abgebrochen`)), ms);
      promise.then(v => { clearTimeout(timer); resolve(v); }, err => { clearTimeout(timer); reject(err); });
    });
  }

  /** Move file to Belege/YYYY/importiert or Belege/YYYY/Fehlgeschlagen.
   *  YYYY is derived from the invoice date (not the import date). */
  function moveToResultFolder(originalPath: string, originalName: string, success: boolean, invoiceDate?: string | null) {
    try {
      // Use invoice date year, fallback to current year
      let year = new Date().getFullYear().toString();
      if (invoiceDate && /^\d{4}/.test(invoiceDate)) {
        year = invoiceDate.slice(0, 4);
      }
      const subfolder = success ? 'importiert' : 'Fehlgeschlagen';
      const destDir = path.resolve('Belege', year, subfolder);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      const ext = path.extname(originalName);
      const base = path.basename(originalName, ext);
      let destPath = path.join(destDir, originalName);
      let counter = 1;
      while (fs.existsSync(destPath)) {
        destPath = path.join(destDir, `${base} (${counter})${ext}`);
        counter++;
      }

      // Try rename (same volume = instant), fallback to copy+delete
      try {
        fs.renameSync(originalPath, destPath);
      } catch {
        fs.copyFileSync(originalPath, destPath);
        try { fs.unlinkSync(originalPath); } catch {}
      }
    } catch (err: any) {
      console.error(`[invoicerec] [move] Failed: ${originalName}: ${err.message}`);
    }
  }

  router.post('/invoicerec/upload', upload.any(), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Keine Dateien hochgeladen' });
    }

    // Check if client wants SSE streaming (Accept: text/event-stream)
    const wantSSE = req.headers.accept?.includes('text/event-stream');

    const fileInfos = files.map(f => {
      const ext = path.extname(f.originalname).toLowerCase();
      const tmpPath = f.path + ext;
      fs.renameSync(f.path, tmpPath);
      return { path: tmpPath, originalname: f.originalname };
    });

    if (wantSSE) {
      // SSE mode: stream progress per file
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      const send = (event: string, data: any) => {
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          if (typeof (res as any).flush === 'function') (res as any).flush();
          if (res.socket) { res.socket.cork(); res.socket.uncork(); }
        } catch { /* connection may be closed */ }
      };

      const results: any[] = [];
      let totalTokens = 0;
      let totalCost = 0;
      let failed = 0;

      for (let i = 0; i < fileInfos.length; i++) {
        const fi = fileInfos[i];
        send('progress', {
          index: i, total: fileInfos.length,
          filename: fi.originalname, status: 'processing',
        });

        try {
          const result = await withFileTimeout(
            processFile(fi.path, fi.originalname),
            FILE_PROCESS_TIMEOUT,
            fi.originalname,
          );
          results.push(result);
          const aiTokens = (result.fields.meta as any)?.ai_tokens ?? 0;
          const aiCost = (result.fields.meta as any)?.ai_cost_usd ?? 0;
          totalTokens += aiTokens;
          totalCost += aiCost;
          moveToResultFolder(fi.path, fi.originalname, true, result.fields.invoice_date);
          send('file_done', {
            index: i, total: fileInfos.length,
            filename: fi.originalname,
            scan_id: result.scan.scan_id,
            seller: result.fields.seller_name,
            gross: result.fields.gross_amount_minor,
            ai_used: !!result.fields.meta?.ai_used,
            ai_tokens: aiTokens,
            ai_cost_usd: aiCost,
            template_matched: result.template_matched,
            duplicate: !!result.duplicate_of,
          });
        } catch (err: any) {
          failed++;
          moveToResultFolder(fi.path, fi.originalname, false);
          send('file_error', { index: i, filename: fi.originalname, error: err.message });
          // Reset OCR worker if it might be stuck
          try {
            const { resetOcrWorker } = await import('../../invoicerec/extract-ocr.js');
            await resetOcrWorker();
          } catch { /* ignore */ }
        }
        try { fs.unlinkSync(fi.path); } catch {}
      }

      send('complete', {
        count: results.length,
        failed,
        total_tokens: totalTokens,
        total_cost_usd: totalCost,
      });
      res.write('event: done\ndata: {}\n\n');
      res.end();
    } else {
      // Non-SSE fallback (for backward compatibility)
      try {
        const results = await processBatch(fileInfos);
        for (const fi of fileInfos) {
          try { fs.unlinkSync(fi.path); } catch {}
        }
        res.json({ ok: true, results });
      } catch (err: any) {
        for (const f of files) {
          try { fs.unlinkSync(f.path); } catch {}
        }
        res.status(500).json({ ok: false, error: err.message });
      }
    }
  });

  // ===== Upload + auto-confirm + match in one step (drag-and-drop from Konten page) =====
  router.post('/invoicerec/upload-and-match', upload.any(), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const transactionId = req.body.transaction_id as string;

    if (!files.length) return res.status(400).json({ error: 'Keine Dateien hochgeladen' });
    if (!transactionId) return res.status(400).json({ error: 'transaction_id fehlt' });

    const state = getState();
    if (!state.transactions.has(transactionId)) {
      return res.status(400).json({ error: `Transaktion ${transactionId} nicht gefunden` });
    }

    const results: Array<{ filename: string; scanId?: string; documentId?: string; matchGroupId?: string; error?: string; warning?: string; docAmount?: number; txnAmount?: number }> = [];

    try {
      const { processFile } = await import('../../invoicerec/pipeline.js');
      const irStore = await import('../../invoicerec/store.js');

      for (const f of files) {
        const ext = path.extname(f.originalname).toLowerCase();
        const tmpPath = f.path + ext;
        fs.renameSync(f.path, tmpPath);

        try {
          // 1. Process through Belegerkennung
          const pipelineResult = await processFile(tmpPath, f.originalname);

          if (pipelineResult.duplicate_of) {
            const dupScanId = pipelineResult.duplicate_of;
            // Check if the existing scan has a matched document
            const dupScan = irStore.getScan(dupScanId);
            const dupDocId = dupScan?.document_id;
            const dupDocMatched = dupDocId ? state.matched_document_ids.has(dupDocId) : false;

            if (dupDocMatched && dupDocId) {
              // Existing doc is matched → return match info so user can decide
              const matchInfo: any[] = [];
              for (const mg of state.match_groups.values()) {
                if (mg.document_ids.includes(dupDocId)) {
                  matchInfo.push({
                    match_group_id: mg.match_group_id,
                    rule_id: mg.rule_id,
                    transaction_ids: mg.transaction_ids,
                    document_ids: mg.document_ids,
                  });
                }
              }
              results.push({
                filename: f.originalname,
                scanId: dupScanId,
                documentId: dupDocId,
                error: 'Duplikat — bereits gematcht',
                matchInfo,
              } as any);
              continue;
            }

            // Existing doc is NOT matched → reuse it and match with current transaction
            if (dupDocId) {
              // Doc exists but unmatched — just match it
              const txn = state.transactions.get(transactionId)!;
              const mgId = matchGroupId([transactionId], [dupDocId], 'MANUAL_DROP');
              const mg: MatchGroup = {
                match_group_id: mgId, status: 'confirmed', created_at: new Date().toISOString(),
                created_by: 'user', rule_id: 'MANUAL_DROP',
                transaction_ids: [transactionId], document_ids: [dupDocId],
                amount_total_minor: txn.amount_minor, currency_code: txn.currency_code ?? 'EUR',
                evidence: { type: 'manual_drop', filename: f.originalname, reused_duplicate: true },
                reason_codes: ['manual_drop'],
              };
              state.match_groups.set(mgId, mg);
              state.matched_transaction_ids.add(transactionId);
              state.matched_document_ids.add(dupDocId);
              saveState(state);
              results.push({ filename: f.originalname, scanId: dupScanId, documentId: dupDocId, matchGroupId: mgId });
              continue;
            }

            // No doc from scan yet → create one and match
            const fields = irStore.getFields(dupScanId);
            if (fields && dupScan) {
              const docResult = irStore.createDocumentFromScan(dupScanId, fields, dupScan.stored_filename);
              const docId = docResult.primaryDocId;
              for (const { doc } of docResult.documents) state.documents.set(doc.document_id, doc);
              const txn = state.transactions.get(transactionId)!;
              const mgId = matchGroupId([transactionId], [docId], 'MANUAL_DROP');
              const mg: MatchGroup = {
                match_group_id: mgId, status: 'confirmed', created_at: new Date().toISOString(),
                created_by: 'user', rule_id: 'MANUAL_DROP',
                transaction_ids: [transactionId], document_ids: [docId],
                amount_total_minor: txn.amount_minor, currency_code: txn.currency_code ?? 'EUR',
                evidence: { type: 'manual_drop', filename: f.originalname, reused_duplicate: true },
                reason_codes: ['manual_drop'],
              };
              state.match_groups.set(mgId, mg);
              state.matched_transaction_ids.add(transactionId);
              state.matched_document_ids.add(docId);
              saveState(state);
              results.push({ filename: f.originalname, scanId: dupScanId, documentId: docId, matchGroupId: mgId });
              continue;
            }

            results.push({ filename: f.originalname, scanId: dupScanId, error: 'Duplikat — kein Beleg vorhanden' });
            continue;
          }

          const scanId = pipelineResult.scan.scan_id;

          // 2. Auto-confirm: create Document immediately
          const fields = irStore.getFields(scanId);
          if (!fields) {
            results.push({ filename: f.originalname, scanId, error: 'Keine Felder extrahiert' });
            continue;
          }
          const docResult = irStore.createDocumentFromScan(scanId, fields, pipelineResult.scan.stored_filename);
          const docId = docResult.primaryDocId;

          // Add documents to in-memory state
          for (const { doc } of docResult.documents) {
            state.documents.set(doc.document_id, doc);
          }

          // 3. Check amount mismatch
          const txn = state.transactions.get(transactionId)!;
          const doc = docResult.documents[0]?.doc;
          const docAmountMinor = doc?.total_amount_minor ?? 0;
          const txnAmountMinor = txn.amount_minor;
          let warning: string | undefined;
          if (docAmountMinor !== 0 && Math.abs(docAmountMinor) !== Math.abs(txnAmountMinor)) {
            const docEur = (Math.abs(docAmountMinor) / 100).toFixed(2);
            const txnEur = (Math.abs(txnAmountMinor) / 100).toFixed(2);
            warning = `Betrag weicht ab: Beleg ${docEur} EUR vs. Buchung ${txnEur} EUR`;
          }

          // 4. Create match: transaction ↔ document
          const mgId = matchGroupId([transactionId], [docId], 'MANUAL_DROP');
          const mg: MatchGroup = {
            match_group_id: mgId,
            status: 'confirmed',
            created_at: new Date().toISOString(),
            created_by: 'user',
            rule_id: 'MANUAL_DROP',
            transaction_ids: [transactionId],
            document_ids: [docId],
            amount_total_minor: txn.amount_minor,
            currency_code: txn.currency_code ?? 'EUR',
            evidence: { type: 'manual_drop', filename: f.originalname, amount_mismatch: !!warning },
            reason_codes: warning ? ['manual_drop', 'amount_mismatch'] : ['manual_drop'],
          };
          state.match_groups.set(mgId, mg);
          state.matched_transaction_ids.add(transactionId);
          state.matched_document_ids.add(docId);
          recordAudit(state, 'MATCH_CREATED_MANUAL', 'MatchGroup', mgId, { after: mg as unknown as Record<string, unknown> });

          results.push({ filename: f.originalname, scanId, documentId: docId, matchGroupId: mgId, warning, docAmount: docAmountMinor, txnAmount: txnAmountMinor });
        } catch (err: any) {
          results.push({ filename: f.originalname, error: err.message });
        }
      }

      saveState(state);
      setState(state);
      res.json({ ok: true, results });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ===== Folder-based import (SSE) — reads files from a local directory =====
  router.get('/invoicerec/import-folder', async (req, res) => {
    const folderPath = (req.query.path as string) || path.resolve('Belege', 'Import');
    const resolved = path.resolve(folderPath);

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.status(400).json({ error: `Ordner nicht gefunden: ${resolved}` });
    }

    // List supported files in folder (non-recursive)
    const allEntries = fs.readdirSync(resolved);
    const supportedExts = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
    const files = allEntries
      .filter(f => supportedExts.has(path.extname(f).toLowerCase()))
      .map(f => ({ name: f, fullPath: path.join(resolved, f) }))
      .filter(f => fs.statSync(f.fullPath).isFile());

    if (files.length === 0) {
      return res.status(400).json({ error: `Keine PDF/JPG/PNG Dateien in ${resolved}` });
    }

    // SSE response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const send = (event: string, data: any) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (typeof (res as any).flush === 'function') (res as any).flush();
        if (res.socket) { res.socket.cork(); res.socket.uncork(); }
      } catch { /* connection closed */ }
    };

    let successCount = 0;
    let failedCount = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let aborted = false;

    // Detect client disconnect
    req.on('close', () => { aborted = true; });

    send('start', { total: files.length, folder: resolved });

    for (let i = 0; i < files.length; i++) {
      if (aborted) break;

      const file = files[i];
      send('progress', { index: i, total: files.length, filename: file.name, status: 'processing' });

      // Let the event loop breathe between files (allows SSE flush + GC)
      await new Promise(r => setTimeout(r, 10));

      try {
        const result = await withFileTimeout(
          processFile(file.fullPath, file.name),
          FILE_PROCESS_TIMEOUT,
          file.name,
        );
        const aiTokens = (result.fields.meta as any)?.ai_tokens ?? 0;
        const aiCost = (result.fields.meta as any)?.ai_cost_usd ?? 0;
        totalTokens += aiTokens;
        totalCost += aiCost;
        successCount++;

        moveToResultFolder(file.fullPath, file.name, true, result.fields.invoice_date);

        send('file_done', {
          index: i, total: files.length,
          filename: file.name,
          scan_id: result.scan.scan_id,
          seller: result.fields.seller_name,
          gross: result.fields.gross_amount_minor,
          ai_used: !!result.fields.meta?.ai_used,
          ai_tokens: aiTokens,
          ai_cost_usd: aiCost,
          template_matched: result.template_matched,
          duplicate: !!result.duplicate_of,
        });
      } catch (err: any) {
        failedCount++;
        moveToResultFolder(file.fullPath, file.name, false);
        send('file_error', { index: i, total: files.length, filename: file.name, error: err.message });

        // After timeout/error: force-kill OCR worker so next file starts clean
        try {
          const { resetOcrWorker } = await import('../../invoicerec/extract-ocr.js');
          resetOcrWorker();  // synchronous force-kill
        } catch {}

        // Give the system time to clean up killed worker
        await new Promise(r => setTimeout(r, 100));
      }
    }

    send('complete', {
      count: successCount,
      failed: failedCount,
      total_tokens: totalTokens,
      total_cost_usd: totalCost,
    });
    res.write('event: done\ndata: {}\n\n');
    res.end();
  });

  router.get('/invoicerec/scans', (req, res) => {
    const status = req.query.status as string | undefined;
    const page = parseInt(req.query.page as string ?? '1', 10);
    const limit = parseInt(req.query.limit as string ?? '50', 10);
    const offset = (page - 1) * limit;

    const validStatuses = ['pending', 'extracted', 'reviewed', 'confirmed', 'rejected', 'error'];
    const filterStatus = status && validStatuses.includes(status) ? status as any : undefined;

    const { items, total } = irStore.listScans(filterStatus, limit, offset);

    // Attach fields and payment summaries for each scan
    const paymentRepo = new PaymentRepository();
    const enriched = items.map(scan => {
      const fields = irStore.getFields(scan.scan_id);
      const candidate = scan.document_id
        ? paymentRepo.getCandidateByDocumentId(scan.document_id)
        : null;
      return {
        ...scan,
        fields_summary: fields ? {
          invoice_number: fields.invoice_number,
          invoice_date: fields.invoice_date,
          seller_name: fields.seller_name,
          seller_country: fields.seller_country,
          gross_amount_minor: fields.gross_amount_minor,
          currency_code: fields.currency_code,
          vat_rate: fields.vat_rate,
          original_currency: (fields.meta as any)?.original_currency ?? null,
          original_amount_minor: (fields.meta as any)?.original_amount_minor ?? null,
          carrier_eust_split: (fields.meta as any)?.carrier_eust_split ?? false,
          eust_amount_minor: (fields.meta as any)?.eust_amount_minor ?? null,
          expense_category: (fields.meta as any)?.expense_category ?? null,
          is_refund: !!(fields.meta as any)?.is_refund,
          validation_errors: fields.validation.errors.length,
          validation_warnings: fields.validation.warnings.length,
        } : null,
        payment_summary: paymentSummary(
          candidate,
          candidate ? paymentRepo.findActiveBatchStatus(candidate.documentId) : null,
        ),
      };
    });

    res.json({ items: enriched, total, page, limit, pages: Math.ceil(total / limit) });
  });

  router.get('/invoicerec/scans/:id', (req, res) => {
    const scan = irStore.getScan(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan nicht gefunden' });
    const fields = irStore.getFields(scan.scan_id);
    const edits = irStore.getReviewEdits(scan.scan_id);
    const paymentCandidate = scan.document_id
      ? new PaymentRepository().getCandidateByDocumentId(scan.document_id)
      : null;
    res.json({ scan, fields, edits, payment_candidate: paymentCandidate });
  });

  router.put('/invoicerec/scans/:id/fields', (req, res) => {
    const scan = irStore.getScan(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan nicht gefunden' });

    const existing = irStore.getFields(scan.scan_id);
    if (!existing) return res.status(404).json({ error: 'Keine extrahierten Felder vorhanden' });

    const updates = req.body;
    const editableFields = [
      'invoice_number', 'invoice_date', 'seller_name', 'seller_address',
      'seller_country', 'seller_vat_id', 'buyer_name', 'buyer_vat_id',
      'currency_code', 'net_amount_minor', 'vat_amount_minor', 'vat_rate',
      'gross_amount_minor',
    ];

    for (const field of editableFields) {
      if (field in updates && updates[field] !== (existing as any)[field]) {
        irStore.insertReviewEdit(scan.scan_id, field, String((existing as any)[field] ?? ''), String(updates[field] ?? ''));
        (existing as any)[field] = updates[field];
        existing.confidence[field] = { value: 1.0, source: 'user_corrected' };
      }
    }

    if ('tax_lines' in updates) existing.tax_lines = updates.tax_lines;
    if ('line_items' in updates) existing.line_items = updates.line_items;
    if ('field_regions' in updates && typeof updates.field_regions === 'object') {
      existing.field_regions = { ...existing.field_regions, ...updates.field_regions };
    }
    if ('meta' in updates && typeof updates.meta === 'object') {
      existing.meta = { ...existing.meta, ...updates.meta };
    }

    // Re-validate
    existing.validation = validateFields(existing);

    irStore.upsertFields(existing);
    irStore.updateScanStatus(scan.scan_id, 'reviewed');

    // If scan has a confirmed document, sync updated fields to it
    if (scan.document_id) {
      const state = getState();
      const docDb = getDb();
      const isRefund = !!(existing.meta as any)?.is_refund;
      const isUsd = (existing.meta as any)?.original_currency === 'USD' || existing.currency_code === 'USD';
      const grossMinor = isUsd ? 0
        : existing.gross_amount_minor != null
          ? (isRefund ? Math.abs(existing.gross_amount_minor) : -Math.abs(existing.gross_amount_minor))
          : 0;
      const vatMinor = isUsd ? null
        : existing.vat_amount_minor != null
          ? (isRefund ? Math.abs(existing.vat_amount_minor) : -Math.abs(existing.vat_amount_minor))
          : null;
      const usdMeta = isUsd ? {
        original_currency: 'USD',
        original_amount_minor: (existing.meta as any)?.original_amount_minor ?? existing.gross_amount_minor ?? 0,
      } : {};
      docDb.prepare(`
        UPDATE documents SET
          supplier_name = ?, document_date = ?, total_amount_minor = ?,
          vat_amount_minor = ?, vat_rate = ?, source_document_ref = ?, currency_code = ?, meta = ?
        WHERE document_id = ?
      `).run(
        existing.seller_name ?? null,
        existing.invoice_date ?? null,
        grossMinor,
        vatMinor,
        isUsd ? null : existing.vat_rate ?? null,
        existing.invoice_number ?? scan.scan_id,
        isUsd ? 'USD' : 'EUR',
        JSON.stringify({ ...JSON.parse((docDb.prepare('SELECT meta FROM documents WHERE document_id = ?').get(scan.document_id) as any)?.meta || '{}'), ...usdMeta }),
        scan.document_id,
      );
      const doc = state.documents.get(scan.document_id);
      if (doc) {
        doc.supplier_name = existing.seller_name ?? undefined;
        doc.document_date = existing.invoice_date ?? doc.document_date;
        doc.total_amount_minor = grossMinor;
        doc.vat_amount_minor = vatMinor ?? undefined;
        doc.vat_rate = isUsd ? undefined : existing.vat_rate ?? undefined;
        doc.source_document_ref = existing.invoice_number ?? scan.scan_id;
        doc.currency_code = isUsd ? 'USD' : 'EUR';
        doc.meta = { ...doc.meta, ...usdMeta };
      }
      saveState(state);
    }

    res.json({ ok: true, fields: existing });
  });

  // Deterministic reparse: no external service, no AI and no cost.
  router.post('/invoicerec/scans/:id/reparse', async (req, res) => {
    const scan = irStore.getScan(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan nicht gefunden' });
    if (!scan.raw_text) return res.status(400).json({ error: 'Kein extrahierter Text vorhanden' });

    const { parseFields } = await import('../../invoicerec/parse-fields.js');
    const { findMatchingTemplate, applyTemplate } = await import('../../invoicerec/template-match.js');
    const existing = irStore.getFields(scan.scan_id);
    let reparsed = parseFields(scan.scan_id, scan.raw_text, scan.extraction_method === 'pdf_text' ? 'pdf_text' : 'ocr');
    const words = (scan.meta as any)?.document_words ?? (scan.meta as any)?.ocr_words ?? [];
    const match = findMatchingTemplate(scan.raw_text, words);
    if (match) {
      const templateFields = applyTemplate(scan.scan_id, scan.raw_text, match.template, words);
      reparsed = { ...reparsed, ...templateFields, scan_id: scan.scan_id } as any;
      reparsed.confidence = { ...reparsed.confidence, ...(templateFields.confidence ?? {}) };
      reparsed.meta = { ...reparsed.meta, ...((templateFields as any).meta ?? {}) };
      irStore.updateScanTemplateId(scan.scan_id, match.template.template_id);
    }
    if (existing) {
      for (const [key, confidence] of Object.entries(existing.confidence ?? {})) {
        if ((confidence as any).source === 'user_corrected' && (existing as any)[key] != null) {
          (reparsed as any)[key] = (existing as any)[key];
          reparsed.confidence[key] = confidence as any;
        }
      }
      reparsed.field_regions = existing.field_regions ?? {};
      reparsed.meta = { ...reparsed.meta, ...existing.meta };
    }
    applyVendorOverride(scan.raw_text, reparsed);
    reparsed.validation = validateFields(reparsed);
    irStore.upsertFields(reparsed);
    if (scan.status !== 'confirmed') irStore.updateScanStatus(scan.scan_id, 'extracted');
    res.json({ ok: true, fields: reparsed, template: match?.template.template_id ?? null });
  });

  router.post('/invoicerec/scans/:id/confirm', (req, res) => {
    const state = getState();
    const scan = irStore.getScan(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan nicht gefunden' });

    const fields = irStore.getFields(scan.scan_id);
    if (!fields) return res.status(400).json({ error: 'Keine extrahierten Felder' });
    fields.validation = validateFields(fields);
    if (fields.validation.errors.length > 0) {
      return res.status(422).json({
        error: 'Beleg enthält kritische Erkennungsfehler und kann noch nicht bestätigt werden',
        validation: fields.validation,
      });
    }

    // Create document(s) in DB — may create 2 for carrier EUSt split
    const createResult = irStore.createDocumentFromScan(scan.scan_id, fields, scan.stored_filename);
    irStore.updateScanDocumentId(scan.scan_id, createResult.primaryDocId);

    // Add to in-memory state so it appears in Rechnungen immediately
    for (const { doc } of createResult.documents) {
      state.documents.set(doc.document_id, doc);
    }
    saveState(state);
    const docId = createResult.primaryDocId;

    // Learn template if requested (default: yes if no template was matched)
    const shouldLearn = req.body.learn_template ?? !scan.template_id;
    let tmpl = null;
    if (shouldLearn && fields.seller_name && scan.raw_text) {
      const regions = Object.keys(fields.field_regions).length > 0 ? fields.field_regions : undefined;
      const words = (scan.meta as any)?.document_words ?? (scan.meta as any)?.ocr_words ?? [];
      tmpl = learnTemplate(fields, scan.raw_text, regions, words);
      irStore.updateScanTemplateId(scan.scan_id, tmpl.template_id);
    }

    res.json({
      ok: true,
      document_id: docId,
      template: tmpl ? { template_id: tmpl.template_id, vendor_name: tmpl.vendor_name } : null,
    });
  });

  // Rescan with fallback (stronger) AI model
  router.post('/invoicerec/scans/:id/rescan', async (req, res) => {
    const scan = irStore.getScan(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan nicht gefunden' });

    try {
      const { extractWithAi } = await import('../../invoicerec/extract-ai.js');
      const { parseFields } = await import('../../invoicerec/parse-fields.js');

      let rawText = scan.raw_text ?? '';

      // If no text stored, try to re-extract from the stored file (OCR)
      if (rawText.length < 10) {
        const year = scan.created_at.slice(0, 4);
        const filePath = path.resolve('Belege', year, 'Rechnungen', scan.stored_filename);
        if (!fs.existsSync(filePath)) {
          return res.status(400).json({ error: 'Originaldatei nicht gefunden — Rescan nicht möglich' });
        }

        try {
          if (scan.file_type === 'jpeg' || scan.file_type === 'png') {
            const { ocrImage } = await import('../../invoicerec/extract-ocr.js');
            const imgBuf = fs.readFileSync(filePath);
            const ocrResult = await withFileTimeout(ocrImage(imgBuf), 45_000, scan.original_filename);
            rawText = ocrResult.text;
          } else {
            // PDF — try text extraction first, then OCR on rendered pages
            try {
              const { extractPdfText } = await import('../../invoicerec/extract-pdf-text.js');
              const pdfResult = await withFileTimeout(extractPdfText(filePath), 15_000, 'PDF-Text');
              if (pdfResult.hasText && pdfResult.text.length > 30) {
                rawText = pdfResult.text;
              }
            } catch { /* PDF text failed, try OCR */ }

            if (rawText.length < 10) {
              const { pdfToImages } = await import('../../invoicerec/pdf-to-image.js');
              const { ocrImage } = await import('../../invoicerec/extract-ocr.js');
              const images = await withFileTimeout(pdfToImages(filePath), 60_000, 'PDF-Render');
              const texts: string[] = [];
              for (const img of images) {
                const ocr = await withFileTimeout(ocrImage(img.buffer), 60_000, 'OCR');
                texts.push(ocr.text);
              }
              rawText = texts.join('\n\n');
            }
          }

          // Update stored raw_text so future rescans don't need to re-OCR
          if (rawText.length > 10) {
            const db = (await import('../../storage/db.js')).getDb();
            db.prepare('UPDATE invoice_scans SET raw_text = ?, extraction_method = ? WHERE scan_id = ?')
              .run(rawText, 'ocr', scan.scan_id);
          }
        } catch (ocrErr: any) {
          return res.status(500).json({ error: `Text-Extraktion fehlgeschlagen: ${ocrErr.message}` });
        }
      }

      if (rawText.length < 10) {
        return res.status(400).json({ error: 'Kein Text extrahierbar — weder PDF-Text noch OCR' });
      }

      // Force fallback model by temporarily swapping settings
      const fallbackModel = getSetting('openrouter_fallback_model') ?? 'anthropic/claude-sonnet-4';
      const originalModel = getSetting('openrouter_model');
      setSetting('openrouter_model', fallbackModel);

      try {
        // Load existing fields to preserve user/template corrections
        const existingFields = irStore.getFields(scan.scan_id);
        const protectedSources = new Set(['user_corrected', 'template_rule']);

        // Re-run regex extraction
        const regexFields = parseFields(
          scan.scan_id,
          rawText,
          scan.extraction_method === 'pdf_text' ? 'pdf_text' : 'ocr',
        );

        // Force AI extraction with fallback model
        const aiResult = await extractWithAi(rawText, scan.scan_id);

        // Merge: AI overrides regex, but preserve EUSt + Alibaba detection from regex
        const regexEustMeta = {
          carrier_eust_split: (regexFields.meta as any)?.carrier_eust_split,
          eust_amount_minor: (regexFields.meta as any)?.eust_amount_minor,
          eust_expense_category: (regexFields.meta as any)?.eust_expense_category,
          service_amount_minor: (regexFields.meta as any)?.service_amount_minor,
          service_vat_minor: (regexFields.meta as any)?.service_vat_minor,
          expense_category: (regexFields.meta as any)?.expense_category,
        };
        const regexAlibabaMeta = {
          is_alibaba: (regexFields.meta as any)?.is_alibaba,
          alibaba_eur_paid: (regexFields.meta as any)?.alibaba_eur_paid,
          alibaba_order_date: (regexFields.meta as any)?.alibaba_order_date,
        };
        const regexSellerName = (regexFields.meta as any)?.is_alibaba ? regexFields.seller_name : null;
        const regexTaxLines = regexFields.tax_lines?.length ? regexFields.tax_lines : [];

        if (aiResult?.fields) {
          for (const [key, val] of Object.entries(aiResult.fields)) {
            if (val != null) (regexFields as any)[key] = val;
          }
          for (const [key, conf] of Object.entries(aiResult.confidence)) {
            regexFields.confidence[key] = conf;
          }
          regexFields.meta = {
            ...regexFields.meta,
            ai_model: aiResult.model_used, ai_used: true, ai_fallback: true, rescan: true,
            ai_tokens: aiResult.usage.total_tokens,
            ai_cost_usd: aiResult.usage.cost_usd ?? 0,
          };
        }

        // Restore EUSt detection from regex if AI didn't detect it
        if (regexEustMeta.carrier_eust_split && !(regexFields.meta as any)?.carrier_eust_split) {
          Object.assign(regexFields.meta as any, regexEustMeta);
          // Restore tax_lines if AI didn't provide them or provided fewer
          if (regexTaxLines.length > (regexFields.tax_lines?.length ?? 0)) {
            regexFields.tax_lines = regexTaxLines;
          }
        }

        // Preserve fields that were set by user correction or template learning
        if (existingFields) {
          for (const [key, conf] of Object.entries(existingFields.confidence ?? {})) {
            if (protectedSources.has((conf as any).source) && (existingFields as any)[key] != null) {
              (regexFields as any)[key] = (existingFields as any)[key];
              regexFields.confidence[key] = conf as any;
            }
          }
          // Preserve meta flags (EUSt, USD, etc.) from user edits
          if (existingFields.meta) {
            const keepKeys = ['carrier_eust_split', 'eust_amount_minor', 'original_currency', 'original_amount_minor', 'is_refund', 'seller_email'];
            for (const k of keepKeys) {
              if ((existingFields.meta as any)[k] != null) {
                (regexFields.meta as any)[k] = (existingFields.meta as any)[k];
              }
            }
          }
          // Preserve field_regions
          if (Object.keys(existingFields.field_regions ?? {}).length > 0) {
            regexFields.field_regions = existingFields.field_regions;
          }
        }

        // Alibaba seller override — FINAL precedence, after ALL other merges
        if (regexAlibabaMeta.is_alibaba) {
          Object.assign(regexFields.meta as any, regexAlibabaMeta);
          regexFields.seller_name = 'Alibaba.com';
          regexFields.confidence.seller_name = { value: 0.99, source: 'alibaba_rule' as any };
        }

        // A manually maintained supplier is authoritative over an address the
        // OCR/AI may have picked from the delivery section of the invoice.
        applyVendorOverride(rawText, regexFields);

        // Owner-name fix: if seller matches buyer's own name, find counterparty
        const OWNER_NAMES = ['Fictional Business Demo', 'firma Fictional Business Demo'];
        if (regexFields.seller_name && OWNER_NAMES.some(n => regexFields.seller_name!.toLowerCase().includes(n))) {
          const companyRe = /\b(GmbH|AG|KG|OG|Ltd|Inc|LLC|e\.U\.|SE|S\.A\.|S\.à\.?r\.l|B\.V\.|S\.r\.l)\b/i;
          const textLines = rawText.split(/\n/).map((l: string) => l.trim()).filter((l: string) => l.length > 3 && l.length < 120);
          let counterparty: string | null = null;
          for (const line of textLines) {
            if (/^(rechnung|invoice|datum|date|seite|page|nr\.|zwischensumme|ust|mwst)/i.test(line)) continue;
            if (OWNER_NAMES.some(n => line.toLowerCase().includes(n))) continue;
            if (companyRe.test(line)) {
              const m = line.match(/^(.{3,60}?\b(?:GmbH|AG|KG|OG|Ltd|Inc|LLC|e\.U\.|SE|S\.A\.|S\.à\.?r\.l|B\.V\.|S\.r\.l))\b/i);
              counterparty = m ? m[1].replace(/^[-–\s]+/, '').trim() : line.slice(0, 80).trim();
              break;
            }
          }
          regexFields.seller_name = counterparty;
        }

        // Re-validate
        regexFields.validation = validateFields(regexFields);

        const existingSnapshot = existingFields;
        const changedFields = ['invoice_number', 'invoice_date', 'seller_name', 'seller_address',
          'seller_country', 'seller_vat_id', 'buyer_name', 'buyer_vat_id', 'currency_code',
          'net_amount_minor', 'vat_amount_minor', 'vat_rate', 'gross_amount_minor']
          .filter(key => (existingSnapshot as any)?.[key] !== (regexFields as any)[key])
          .map(key => ({ field: key, old_value: (existingSnapshot as any)?.[key] ?? null, new_value: (regexFields as any)[key] ?? null }));

        // Default is a non-mutating proposal. Only an explicit apply=true (used
        // by a user-confirmed bulk action) may write the AI result directly.
        if (req.body?.apply !== true) {
          return res.json({ ok: true, preview: true, fields: regexFields, changes: changedFields });
        }

        irStore.upsertFields(regexFields);
        irStore.updateScanStatus(scan.scan_id, 'extracted');

        // If scan had a confirmed document, update it with new field values
        if (scan.document_id) {
          const state = getState();
          const docDb = getDb();
          const isRefund = !!(regexFields.meta as any)?.is_refund;
          const isUsd = (regexFields.meta as any)?.original_currency === 'USD' || regexFields.currency_code === 'USD';
          const grossMinor = isUsd ? 0
            : regexFields.gross_amount_minor != null
              ? (isRefund ? Math.abs(regexFields.gross_amount_minor) : -Math.abs(regexFields.gross_amount_minor))
              : 0;
          const vatMinor = isUsd ? null
            : regexFields.vat_amount_minor != null
              ? (isRefund ? Math.abs(regexFields.vat_amount_minor) : -Math.abs(regexFields.vat_amount_minor))
              : null;
          const usdMeta = isUsd ? {
            original_currency: 'USD',
            original_amount_minor: (regexFields.meta as any)?.original_amount_minor ?? regexFields.gross_amount_minor ?? 0,
          } : {};
          // For Alibaba: use alibaba_order_date and alibaba_eur_paid if available
          const aliMeta = regexFields.meta as any;
          const effectiveDate = aliMeta?.alibaba_order_date ?? regexFields.invoice_date ?? null;
          const aliEurPaid = aliMeta?.alibaba_eur_paid as number | undefined;
          const useAliEur = aliMeta?.is_alibaba && aliEurPaid != null && aliEurPaid > 0;
          const effectiveGross = useAliEur ? -Math.abs(aliEurPaid) : grossMinor;
          const effectiveCurrency = useAliEur ? 'EUR' : (isUsd ? 'USD' : 'EUR');

          docDb.prepare(`
            UPDATE documents SET
              supplier_name = ?, document_date = ?, total_amount_minor = ?,
              vat_amount_minor = ?, vat_rate = ?, source_document_ref = ?, currency_code = ?, meta = ?
            WHERE document_id = ?
          `).run(
            regexFields.seller_name ?? null,
            effectiveDate,
            effectiveGross,
            vatMinor,
            isUsd ? null : regexFields.vat_rate ?? null,
            regexFields.invoice_number ?? scan.scan_id,
            effectiveCurrency,
            JSON.stringify({ ...JSON.parse((docDb.prepare('SELECT meta FROM documents WHERE document_id = ?').get(scan.document_id) as any)?.meta || '{}'), ...usdMeta, ...(aliMeta?.is_alibaba ? { is_alibaba: true, alibaba_eur_paid: aliEurPaid, alibaba_order_date: aliMeta.alibaba_order_date } : {}) }),
            scan.document_id,
          );
          // Update in-memory state
          const doc = state.documents.get(scan.document_id);
          if (doc) {
            doc.supplier_name = regexFields.seller_name ?? undefined;
            doc.document_date = effectiveDate ?? doc.document_date;
            doc.total_amount_minor = effectiveGross;
            doc.vat_amount_minor = vatMinor ?? undefined;
            doc.vat_rate = isUsd ? undefined : regexFields.vat_rate ?? undefined;
            doc.currency_code = effectiveCurrency;
            doc.source_document_ref = regexFields.invoice_number ?? scan.scan_id;
            doc.meta = { ...doc.meta, ...usdMeta, ...(aliMeta?.is_alibaba ? { is_alibaba: true, alibaba_eur_paid: aliEurPaid, alibaba_order_date: aliMeta.alibaba_order_date } : {}) };
          }
          saveState(state);
        }

        res.json({ ok: true, fields: regexFields });
      } finally {
        // Restore original model
        if (originalModel) setSetting('openrouter_model', originalModel);
        else deleteSetting('openrouter_model');
      }
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/invoicerec/scans/:id/reject', (req, res) => {
    const scan = irStore.getScan(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan nicht gefunden' });

    irStore.updateScanStatus(scan.scan_id, 'rejected');
    res.json({ ok: true });
  });

  router.delete('/invoicerec/scans/:id', (req, res) => {
    const state = getState();
    const scan = irStore.getScan(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan nicht gefunden' });

    // Move scan to trash
    const fields = irStore.getFields(scan.scan_id);
    moveToTrash('invoice_scan', scan.scan_id, { ...scan, fields });

    // If confirmed, also move the linked document to trash + remove from state
    if (scan.document_id) {
      const doc = state.documents.get(scan.document_id);
      if (doc) moveToTrash('document', doc.document_id, doc, `Von Scan ${scan.scan_id}`);
      state.documents.delete(scan.document_id);
      const db = getDb();
      db.prepare('DELETE FROM document_dispositions WHERE document_id = ?').run(scan.document_id);
      db.prepare('DELETE FROM documents WHERE document_id = ?').run(scan.document_id);
      saveState(state);
    }

    // Delete scan from DB
    const db = getDb();
    db.prepare('DELETE FROM invoice_extracted_fields WHERE scan_id = ?').run(scan.scan_id);
    db.prepare('DELETE FROM invoice_review_edits WHERE scan_id = ?').run(scan.scan_id);
    db.prepare('DELETE FROM invoice_scans WHERE scan_id = ?').run(scan.scan_id);

    res.json({ ok: true });
  });

  router.get('/invoicerec/scans/:id/preview', (req, res) => {
    const scan = irStore.getScan(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan nicht gefunden' });

    const year = scan.created_at.slice(0, 4);
    const filePath = path.resolve('Belege', year, 'Rechnungen', scan.stored_filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Datei nicht gefunden' });
    }

    const mimeTypes: Record<string, string> = {
      pdf_text: 'application/pdf', pdf_image: 'application/pdf',
      jpeg: 'image/jpeg', png: 'image/png',
    };
    res.setHeader('Content-Type', mimeTypes[scan.file_type] ?? 'application/octet-stream');
    res.sendFile(filePath);
  });

  // ===== Page image endpoint (renders PDF page as PNG, serves images directly) =====
  router.get('/invoicerec/scans/:id/page/:page', async (req, res) => {
    const scan = irStore.getScan(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan nicht gefunden' });

    const pageNum = parseInt(req.params.page);
    if (isNaN(pageNum) || pageNum < 1) return res.status(400).json({ error: 'Ungültige Seitennummer' });

    const year = scan.created_at.slice(0, 4);
    const filePath = path.resolve('Belege', year, 'Rechnungen', scan.stored_filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Datei nicht gefunden' });

    if (scan.file_type === 'jpeg' || scan.file_type === 'png') {
      // Image files — serve directly (only page 1)
      if (pageNum !== 1) return res.status(404).json({ error: 'Nur Seite 1 verfügbar' });
      try {
        const sharp = (await import('sharp')).default;
        const meta = await sharp(filePath).metadata();
        res.setHeader('X-Page-Width', String(meta.width ?? 0));
        res.setHeader('X-Page-Height', String(meta.height ?? 0));
      } catch { /* ignore metadata errors */ }
      res.setHeader('Content-Type', scan.file_type === 'jpeg' ? 'image/jpeg' : 'image/png');
      return res.sendFile(filePath);
    }

    // PDF — render page to PNG, cache on disk
    const cacheDir = path.resolve('data', 'page-cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, `${scan.scan_id}-p${pageNum}.png`);

    if (fs.existsSync(cachePath)) {
      try {
        const sharp = (await import('sharp')).default;
        const meta = await sharp(cachePath).metadata();
        res.setHeader('X-Page-Width', String(meta.width ?? 0));
        res.setHeader('X-Page-Height', String(meta.height ?? 0));
      } catch { /* ignore */ }
      res.setHeader('Content-Type', 'image/png');
      return res.sendFile(cachePath);
    }

    try {
      const { pdfToImages } = await import('../../invoicerec/pdf-to-image.js');
      const images = await pdfToImages(filePath);
      // Cache all rendered pages
      for (const img of images) {
        const imgCache = path.join(cacheDir, `${scan.scan_id}-p${img.page}.png`);
        fs.writeFileSync(imgCache, img.buffer);
      }
      const requested = images.find(i => i.page === pageNum);
      if (!requested) return res.status(404).json({ error: `Seite ${pageNum} nicht gefunden` });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Page-Width', String(requested.width));
      res.setHeader('X-Page-Height', String(requested.height));
      return res.send(requested.buffer);
    } catch (err: any) {
      return res.status(500).json({ error: `Rendering fehlgeschlagen: ${err.message}` });
    }
  });

  // ===== OCR words endpoint =====
  router.get('/invoicerec/scans/:id/words', async (req, res) => {
    const scan = irStore.getScan(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan nicht gefunden' });
    let words = (scan.meta as any)?.document_words ?? (scan.meta as any)?.ocr_words ?? [];
    // Backfill coordinates lazily for text PDFs created before coordinate
    // persistence existed. Opening the review tool is enough to migrate them.
    if (words.length === 0 && scan.file_type === 'pdf_text') {
      const filePath = path.resolve('Belege', scan.created_at.slice(0, 4), 'Rechnungen', scan.stored_filename);
      if (fs.existsSync(filePath)) {
        try {
          const { extractPdfText } = await import('../../invoicerec/extract-pdf-text.js');
          const result = await extractPdfText(filePath);
          words = result.words;
          if (words.length > 0) {
            const meta = { ...scan.meta, document_words: words };
            getDb().prepare('UPDATE invoice_scans SET meta = ? WHERE scan_id = ?').run(JSON.stringify(meta), scan.scan_id);
          }
        } catch (error: any) {
          console.warn(`[invoicerec] Coordinate backfill failed for ${scan.scan_id}: ${error.message}`);
        }
      }
    }
    res.json({ words, source: scan.extraction_method });
  });

  // ===== Learn template from corrections + rescan same-vendor invoices =====
  router.post('/invoicerec/scans/:id/learn-and-rescan', async (req, res) => {
    const scan = irStore.getScan(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan nicht gefunden' });

    const fields = irStore.getFields(scan.scan_id);
    if (!fields) return res.status(400).json({ error: 'Keine extrahierten Felder' });
    if (!fields.seller_name || !scan.raw_text) {
      return res.status(400).json({ error: 'Verkäufername und Text erforderlich' });
    }

    // 1. Learn template with spatial regions
    const regions = Object.keys(fields.field_regions).length > 0 ? fields.field_regions : undefined;
    const words = (scan.meta as any)?.document_words ?? (scan.meta as any)?.ocr_words ?? [];
    const tmpl = learnTemplate(fields, scan.raw_text, regions, words);
    irStore.updateScanTemplateId(scan.scan_id, tmpl.template_id);

    // 2. Find other scans from same vendor
    // Match by: vendor anchors in raw_text, OR same seller_name in existing fields
    const { items: allScans } = irStore.listScans(undefined, 9999, 0);
    const vendorAnchors = tmpl.patterns.vendor_anchors.map(a => a.toLowerCase());
    const rescanned: string[] = [];

    console.log(`[learn-rescan] Template: ${tmpl.vendor_name}, anchors: [${vendorAnchors.join(', ')}]`);
    console.log(`[learn-rescan] Searching ${allScans.length} scans for matches...`);

    for (const other of allScans) {
      if (other.scan_id === scan.scan_id) continue;
      if (other.status === 'confirmed' || other.status === 'error') continue;

      // Match method 1: vendor anchors in raw_text
      let matched = false;
      if (other.raw_text && other.raw_text.length > 10) {
        const textLower = other.raw_text.toLowerCase();
        matched = vendorAnchors.every(a => textLower.includes(a));
      }

      // Match method 2: existing extracted seller_name matches
      if (!matched) {
        const otherFields = irStore.getFields(other.scan_id);
        if (otherFields?.seller_name) {
          const otherSeller = otherFields.seller_name.toLowerCase();
          matched = vendorAnchors.some(a => otherSeller.includes(a) || a.includes(otherSeller));
        }
      }

      if (!matched) continue;
      console.log(`[learn-rescan] Match: ${other.original_filename} (${other.scan_id})`);

      // Re-apply template + re-parse
      try {
        const { applyTemplate } = await import('../../invoicerec/template-match.js');
        const { parseFields } = await import('../../invoicerec/parse-fields.js');
        const rawText = other.raw_text ?? '';
        const ocrWords = (other.meta as any)?.document_words ?? (other.meta as any)?.ocr_words ?? [];
        const { layoutFingerprint } = await import('../../invoicerec/template-learn.js');
        const expectedLayout = (tmpl.meta as any)?.layout_fingerprint;
        if (expectedLayout && expectedLayout !== layoutFingerprint(rawText, ocrWords)) {
          console.log(`[learn-rescan] Skipped different layout: ${other.original_filename}`);
          continue;
        }

        // Get existing fields to preserve user edits
        const existingFields = irStore.getFields(other.scan_id);

        const tmplFields = applyTemplate(other.scan_id, rawText, tmpl, ocrWords);
        const genericFields = rawText.length > 10
          ? parseFields(other.scan_id, rawText, other.extraction_method === 'pdf_text' ? 'pdf_text' : 'ocr')
          : existingFields;

        // Merge: generic → template → preserve user-corrected fields
        const merged = { ...genericFields, ...tmplFields, scan_id: other.scan_id } as any;
        merged.confidence = { ...(genericFields?.confidence ?? {}), ...(tmplFields.confidence ?? {}) };
        // Merge meta from template (EUSt, currency flags) into existing meta
        merged.meta = { ...(genericFields?.meta ?? {}), ...(existingFields?.meta ?? {}), ...((tmplFields as any).meta ?? {}) };

        // Don't overwrite fields the user already corrected
        if (existingFields) {
          for (const [key, conf] of Object.entries(existingFields.confidence ?? {})) {
            if ((conf as any).source === 'user_corrected' && (existingFields as any)[key] != null) {
              (merged as any)[key] = (existingFields as any)[key];
              merged.confidence[key] = conf;
            }
          }
        }

        applyVendorOverride(rawText, merged);
        merged.validation = validateFields(merged);
        irStore.upsertFields(merged);
        irStore.updateScanTemplateId(other.scan_id, tmpl.template_id);
        if (other.status === 'pending') irStore.updateScanStatus(other.scan_id, 'extracted');
        rescanned.push(other.scan_id);
        console.log(`[learn-rescan] Updated: ${other.original_filename} → seller=${merged.seller_name}, country=${merged.seller_country}`);
      } catch (err: any) {
        console.error(`[learn-rescan] Failed: ${other.scan_id}: ${err.message}`);
      }
    }

    console.log(`[learn-rescan] Done: ${rescanned.length} scans updated`);

    res.json({
      ok: true,
      template: { template_id: tmpl.template_id, vendor_name: tmpl.vendor_name },
      rescanned_count: rescanned.length,
      rescanned_scan_ids: rescanned,
    });
  });

  router.get('/invoicerec/templates', (_req, res) => {
    const templates = irStore.listTemplates();
    res.json(templates);
  });

  router.delete('/invoicerec/templates/:id', (req, res) => {
    const deleted = irStore.deleteTemplate(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Template nicht gefunden' });
    res.json({ ok: true });
  });

  // ===== OpenRouter AI Settings =====
  router.get('/invoicerec/ai/models', async (_req, res) => {
    try {
      const models = await listOpenRouterModels();
      const currentModel = getSetting('openrouter_model') ?? 'google/gemini-2.0-flash-001';
      res.json({ models, current_model: currentModel });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/invoicerec/ai/status', (_req, res) => {
    const apiKey = getSetting('openrouter_api_key');
    const model = getSetting('openrouter_model') ?? 'google/gemini-2.0-flash-001';
    const fallbackModel = getSetting('openrouter_fallback_model') ?? 'anthropic/claude-sonnet-4';
    res.json({
      enabled: !!apiKey,
      model,
      fallback_model: fallbackModel,
      masked_key: apiKey ? '[configured]' : null,
    });
  });

  router.put('/invoicerec/ai/config', (req, res) => {
    const { api_key, model, fallback_model } = req.body;
    if (api_key) setSetting('openrouter_api_key', api_key);
    if (model) setSetting('openrouter_model', model);
    if (fallback_model) setSetting('openrouter_fallback_model', fallback_model);
    res.json({ ok: true });
  });

  router.delete('/invoicerec/ai/config', (_req, res) => {
    deleteSetting('openrouter_api_key');
    res.json({ ok: true });
  });

  // ===== Backup =====
  router.get('/backups', (_req, res) => {
    res.json(listBackups());
  });

  router.post('/backups', async (req, res) => {
    try {
      const label = req.body?.label as string | undefined;
      const backup = await createBackup(label);
      res.json({ ok: true, backup });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // An active SQLite handle and WAL make in-app restore unsafe.
  // Keep the old backup until an offline, validated restore workflow exists.
  router.post('/backups/:name/restore', (_req, res) => {
    res.status(409).json({
      ok: false,
      code: 'OFFLINE_RESTORE_REQUIRED',
      error: 'Restore requires a verified offline maintenance procedure. No data was changed.',
    });
  });

  router.delete('/backups/:name', (_req, res) => {
    res.status(403).json({
      ok: false,
      code: 'OWNER_MAINTENANCE_REQUIRED',
      error: 'Backup deletion is disabled until owner authorization is available.',
    });
  });

  // ===== Papierkorb / Trash =====
  router.get('/trash', (req, res) => {
    const type = req.query.type as string | undefined;
    res.json(listTrash(type));
  });

  router.post('/trash/:id/restore', (req, res) => {
    const state = getState();
    const item = restoreFromTrash(req.params.id);
    if (!item) return res.status(404).json({ error: 'Nicht im Papierkorb gefunden' });

    // Re-insert into the correct place
    const db = getDb();
    if (item.entity_type === 'document') {
      const doc = item.entity_data;
      db.prepare(`
        INSERT OR IGNORE INTO documents (
          document_id, source_system, source_document_ref, captured_at,
          document_date, total_amount_minor, currency_code,
          supplier_name, vat_amount_minor, vat_rate, file_hash, filename, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        doc.document_id, doc.source_system, doc.source_document_ref, doc.captured_at,
        doc.document_date, doc.total_amount_minor, doc.currency_code,
        doc.supplier_name ?? null, doc.vat_amount_minor ?? null, doc.vat_rate ?? null,
        doc.file_hash ?? null, doc.filename ?? null, JSON.stringify(doc.meta ?? {}),
      );
      state.documents.set(doc.document_id, doc);
      saveState(state);
    } else if (item.entity_type === 'match_group') {
      const mg = item.entity_data;
      state.match_groups.set(mg.match_group_id, mg);
      for (const id of mg.transaction_ids) state.matched_transaction_ids.add(id);
      for (const id of mg.document_ids) state.matched_document_ids.add(id);
      saveState(state);
    } else if (item.entity_type === 'invoice_scan') {
      const scan = item.entity_data;
      db.prepare(`
        INSERT OR IGNORE INTO invoice_scans (
          scan_id, created_at, original_filename, stored_filename, file_hash,
          file_type, page_count, extraction_method, ocr_confidence, status,
          template_id, document_id, raw_text, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scan.scan_id, scan.created_at, scan.original_filename, scan.stored_filename,
        scan.file_hash, scan.file_type, scan.page_count, scan.extraction_method,
        scan.ocr_confidence, 'extracted', scan.template_id, null, scan.raw_text,
        JSON.stringify(scan.meta ?? {}),
      );
    }

    res.json({ ok: true, restored: item.entity_type, entity_id: item.entity_id });
  });

  router.delete('/trash/:id', (req, res) => {
    const deleted = deleteFromTrash(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ ok: true });
  });

  router.delete('/trash', (req, res) => {
    const type = req.query.type as string | undefined;
    const count = emptyTrash(type);
    res.json({ ok: true, deleted: count });
  });

  return router;
}

// --- Helpers ---

function findMatchGroupForTxn(state: MatchingState, txnId: string): string | null {
  for (const mg of state.match_groups.values()) {
    if (mg.transaction_ids.includes(txnId)) return mg.match_group_id;
  }
  return null;
}

function findMatchGroupForDoc(state: MatchingState, docId: string): string | null {
  for (const mg of state.match_groups.values()) {
    if (mg.document_ids.includes(docId)) return mg.match_group_id;
  }
  return null;
}

function expandMatchGroup(state: MatchingState, mg: MatchGroup) {
  return {
    ...mg,
    amount_total: fromMinor(mg.amount_total_minor),
    quality_signals: matchQualitySignals(state, mg),
    transactions: mg.transaction_ids.map((id) => {
      const t = state.transactions.get(id);
      return t ? { ...t, amount: fromMinor(t.amount_minor) } : null;
    }).filter(Boolean),
    documents: mg.document_ids.map((id) => {
      const d = state.documents.get(id);
      return d ? { ...d, amount: fromMinor(d.total_amount_minor) } : null;
    }).filter(Boolean),
  };
}

function matchQualitySignals(state: MatchingState, mg: MatchGroup): string[] {
  const signals = new Set<string>();
  const transactions = mg.transaction_ids.map(id => state.transactions.get(id)).filter(Boolean);
  const documents = mg.document_ids.map(id => state.documents.get(id)).filter(Boolean);

  if (documents.length === 0) signals.add('NO_DOCUMENT');
  if (!mg.evidence || Object.keys(mg.evidence).length === 0) signals.add('MISSING_EVIDENCE');

  if (transactions.length === 1 && documents.length === 1) {
    const transaction = transactions[0]!;
    const document = documents[0]!;
    if (transaction.currency_code === document.currency_code && Math.abs(transaction.amount_minor - document.total_amount_minor) > 1) {
      signals.add('AMOUNT_MISMATCH');
    }
    const transactionTime = Date.parse(transaction.posting_at);
    const documentTime = Date.parse(document.document_date);
    if (Number.isFinite(transactionTime) && Number.isFinite(documentTime)) {
      const days = Math.round(Math.abs(transactionTime - documentTime) / 86_400_000);
      if (days > 45) signals.add('LONG_DATE_GAP');
    }
  }

  if (mg.rule_id === 'R-BANK-SPK_PAYPAL-001') {
    const paypalLegs = transactions.filter(transaction => transaction!.source_system === 'paypal');
    if (paypalLegs.some(transaction => String(transaction!.meta?.paypal_event_code ?? '') !== 'T0300')) {
      signals.add('PAYPAL_EVENT_NOT_T0300');
    }
  }

  const hashes = new Set(documents.map(document => document!.file_hash).filter((hash): hash is string => Boolean(hash)));
  if (hashes.size > 0) {
    const reused = [...state.match_groups.values()].some(other => other.match_group_id !== mg.match_group_id &&
      other.document_ids.some(id => {
        const hash = state.documents.get(id)?.file_hash;
        return Boolean(hash && hashes.has(hash));
      }));
    if (reused) signals.add('PHYSICAL_EVIDENCE_REUSED');
  }

  return [...signals];
}

function isInAnyMatchGroup(state: MatchingState, id: string, type: 'transaction' | 'document'): boolean {
  for (const mg of state.match_groups.values()) {
    if (type === 'transaction' && mg.transaction_ids.includes(id)) return true;
    if (type === 'document' && mg.document_ids.includes(id)) return true;
  }
  return false;
}

function applyExclusion(state: MatchingState, rule: ExclusionRule): number {
  let count = 0;
  for (const t of state.transactions.values()) {
    if (matchesExclusionRule(t, rule)) {
      state.excluded_transaction_ids.add(t.transaction_id);
      count++;
    }
  }
  return count;
}

function recomputeExclusions(state: MatchingState): void {
  state.excluded_transaction_ids.clear();
  for (const rule of state.exclusion_rules) {
    if (!rule.enabled) continue;
    applyExclusion(state, rule);
  }
}

/**
 * Normalize vendor names so different spellings of the same vendor are grouped together.
 * E.g. "aliexpress", "www.aliexpress.com", "ALIEXPRESS.COM", "ALIEXPRESSCOM" → "AliExpress"
 */
const VENDOR_ALIASES: Array<{ canonical: string; patterns: string[] }> = [
  { canonical: 'AliExpress', patterns: ['aliexpress', 'aliexpresscom', 'www.aliexpress'] },
  { canonical: 'Alibaba.com', patterns: ['alibaba', 'alibabacom'] },
  { canonical: 'Amazon', patterns: ['amazon', 'amzn'] },
  { canonical: 'Apple', patterns: ['apple.com/bill', 'apple.com'] },
  { canonical: 'Google One', patterns: ['google*google one', 'google one'] },
  { canonical: 'Google Cloud', patterns: ['google*cloud'] },
  { canonical: 'Google Workspace', patterns: ['google*gsuite'] },
  { canonical: 'OpenAI', patterns: ['openai', 'chatgpt'] },
  { canonical: 'DHL Express', patterns: ['dhl express'] },
  { canonical: 'Meta/Oculus', patterns: ['oculus', 'meta.com'] },
];

function normalizeVendorName(raw: string): string {
  const lower = raw.toLowerCase().replace(/[^a-z0-9.*/ ]/g, '');
  for (const { canonical, patterns } of VENDOR_ALIASES) {
    if (patterns.some(p => lower.includes(p))) return canonical;
  }
  return raw;
}

function matchesExclusionRule(t: { counterparty_name?: string; description_raw: string; source_system: string; meta: Record<string, unknown> }, rule: ExclusionRule): boolean {
  const fieldValue = (() => {
    switch (rule.field) {
      case 'counterparty_name': return t.counterparty_name ?? '';
      case 'description_raw': return String(t.description_raw ?? '');
      case 'source_system': return t.source_system;
      default: return String((t as any)[rule.field] ?? '');
    }
  })();

  switch (rule.operator) {
    case 'contains': return fieldValue.toLowerCase().includes(rule.value.toLowerCase());
    case 'equals': return fieldValue.toLowerCase() === rule.value.toLowerCase();
    case 'starts_with': return fieldValue.toLowerCase().startsWith(rule.value.toLowerCase());
    case 'regex': return new RegExp(rule.value, 'i').test(fieldValue);
    default: return false;
  }
}

/** Recursively search for a file by name, up to maxDepth levels */
/** Load new transactions from SQLite into in-memory state */
function loadNewTxnsIntoState(getState: () => MatchingState, sourceFilter?: string): void {
  const state = getState();
  const db = getDb();
  const where = sourceFilter ? `WHERE source_system = '${sourceFilter}'` : '';
  const rows = db.prepare(`SELECT * FROM transactions ${where}`).all() as any[];
  for (const row of rows) {
    if (!state.transactions.has(row.transaction_id)) {
      state.transactions.set(row.transaction_id, {
        transaction_id: row.transaction_id,
        source_system: row.source_system,
        source_account_id: row.source_account_id,
        source_row_ref: row.source_row_ref,
        posting_at: row.posting_at,
        value_at: row.value_at ?? undefined,
        amount_minor: row.amount_minor,
        currency_code: row.currency_code,
        description_raw: row.description_raw,
        counterparty_name: row.counterparty_name ?? undefined,
        counterparty_iban: row.counterparty_iban ?? undefined,
        booking_reference: row.booking_reference ?? undefined,
        payment_reference: row.payment_reference ?? undefined,
        tags: JSON.parse(row.tags || '[]'),
        meta: JSON.parse(row.meta || '{}'),
        ...(row.fx_original_amount_minor != null ? {
          fx: {
            original_amount_minor: row.fx_original_amount_minor,
            original_currency_code: row.fx_original_currency_code,
            rate: row.fx_rate,
            rate_source: row.fx_rate_source ?? 'unknown',
            fx_fee_minor: row.fx_fee_minor ?? undefined,
          },
        } : {}),
      });
    }
  }
}

/** Sync filenames from DB back into in-memory state (for docs that were updated in DB) */
function refreshDocFilenames(getState: () => MatchingState, sourceFilter?: string): void {
  const state = getState();
  const db = getDb();
  const where = sourceFilter ? `WHERE source_system = '${sourceFilter}'` : '';
  const rows = db.prepare(`SELECT document_id, filename FROM documents ${where}`).all() as any[];
  for (const row of rows) {
    const doc = state.documents.get(row.document_id);
    if (doc && row.filename && doc.filename !== row.filename) {
      doc.filename = row.filename;
    }
  }
}

/** Load new documents from SQLite into in-memory state (for docs not yet in state) */
function loadNewDocsIntoState(getState: () => MatchingState, sourceFilter?: string): void {
  const state = getState();
  const db = getDb();
  const where = sourceFilter ? `WHERE source_system = '${sourceFilter}'` : '';
  const rows = db.prepare(`SELECT * FROM documents ${where}`).all() as any[];
  for (const row of rows) {
    const doc = {
      document_id: row.document_id,
      source_system: row.source_system,
      source_document_ref: row.source_document_ref,
      captured_at: row.captured_at,
      document_date: row.document_date,
      total_amount_minor: row.total_amount_minor,
      currency_code: row.currency_code,
      supplier_name: row.supplier_name ?? undefined,
      vat_amount_minor: row.vat_amount_minor ?? undefined,
      vat_rate: row.vat_rate ?? undefined,
      filename: row.filename ?? undefined,
      meta: JSON.parse(row.meta || '{}'),
    };
    state.documents.set(row.document_id, doc);
  }
}

function findFileRecursive(baseDir: string, filename: string, maxDepth: number): string | null {
  if (maxDepth < 0) return null;
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name === filename) {
        return path.join(baseDir, entry.name);
      }
    }
    // Then recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const found = findFileRecursive(path.join(baseDir, entry.name), filename, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {
    // Permission error or similar — skip
  }
  return null;
}
