/**
 * Amazon import service: parses 3 CSV reports (Sendungen, Erstattungen, Abgleich),
 * merges by Bestellnummer, upserts documents into SQLite, and organizes invoice PDFs
 * into per-order folders.
 */

import fs from 'fs';
import path from 'path';
import { getDb } from '../storage/db.js';
import { documentId } from '../core/ids.js';
import { getTaxCategory } from '../core/tax-category.js';
import { normalizeDate } from '../core/normalization/dates.js';

// ============================================================
// Types
// ============================================================

interface AmazonItem {
  orderNumber: string;
  orderDate: string;
  title: string;
  category: string;
  asin: string;
  quantity: number;
  unitPrice: number;      // in euros (float)
  totalPrice: number;     // in euros (float)
  netDeliveryAmount: number; // Nettosumme der Lieferung (float)
  currency: string;
  shipping: number;
  status: string;
  vatCountry: string;     // Land für USt-IdNr des Verkäufers
  sellerName: string;     // Name des Verkäufers
  shippingVat: number;    // Versand-MwSt. (float)
  articleVat: number;     // Artikel-Ust. (float)
}

interface AmazonRefund {
  orderNumber: string;
  refundDate: string;
  title: string;
  category: string;
  asin: string;
  quantity: number;
  refundAmount: number;   // in euros (float, brutto)
  currency: string;
  vatAmount: number;       // legacy: generic vat column
  articleVat: number;      // Erstattung – Artikel-USt
  vatCountry: string;      // Land für USt-IdNr des Verkäufers
  paymentRefId: string;    // Zahlungsreferenz-ID
}

interface AmazonReconciliation {
  orderNumber: string;
  paymentDate: string;
  totalAmount: number;    // in euros (float) — Zahlungsbetrag
  currency: string;
  paymentMethod: string;
  shippingCost: number;
  vatAmount: number;
  transactionType: string; // Transaktionstyp (e.g. "Erstattung")
  paymentRefId: string;    // Zahlungsreferenz-ID
  accountGroup: string;    // Kontengruppe
  feeRecognition: string;  // Gebührenerkennung (e.g. "Visa 1234")
}

export interface AmazonOrder {
  orderNumber: string;
  orderDate: string;
  paymentDate: string;      // from Abgleich (or fallback to orderDate)
  totalAmount: number;       // euros
  currency: string;
  items: AmazonItem[];
  refunds: AmazonRefund[];
  paymentMethod: string;
  shippingCost: number;
  vatAmount: number;
  isRefund: boolean;        // Abgleich Transaktionstyp = "Erstattung"
  title: string;            // first 80 chars of combined item titles
  vatCountry: string;       // seller VAT country
  shippingVat: number;      // Versand-MwSt.
  taxRate: number;          // calculated tax rate as whole number (e.g. 20)
  feeRecognition: string;   // Gebührenerkennung (e.g. "Visa 1234")
  paymentRefId: string;     // stable identity from Abgleich where available
}

export interface AmazonImportResult {
  orders: number;
  refunds: number;
  imported: number;
  skipped: number;
  documents: Array<{
    order_number: string;
    date: string;
    amount: number;
    items: number;
    is_new: boolean;
    is_refund: boolean;
    title: string;
    vat_country: string;
    vat_rate: number;
    shipping_vat: number;
    tax_category: string | null;
  }>;
  invoices_organized: number;
  debug?: Record<string, any>;
}

// ============================================================
// CSV Parsing
// ============================================================

function splitCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function detectDelimiter(headerLine: string): string {
  const tabCount = (headerLine.match(/\t/g) || []).length;
  const semiCount = (headerLine.match(/;/g) || []).length;
  const commaCount = (headerLine.match(/,/g) || []).length;

  // Tab wins if it produces more columns than the others
  if (tabCount >= 2 && tabCount >= semiCount && tabCount >= commaCount) return '\t';
  if (semiCount > commaCount) return ';';
  return ',';
}

function parseCsv(content: string): Record<string, string>[] {
  // Strip BOM and other zero-width chars
  content = content.replace(/^\uFEFF/, '').replace(/\u200B/g, '');

  const lines = content.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  if (lines.length < 2) return [];

  const headerLine = lines[0];
  let delimiter = detectDelimiter(headerLine);
  let headers = splitCsvLine(headerLine, delimiter).map(h => h.trim().replace(/^"/, '').replace(/"$/, ''));

  // If we got too few columns, the delimiter might be wrong — try alternatives
  if (headers.length <= 2) {
    for (const alt of ['\t', ';', ',']) {
      if (alt === delimiter) continue;
      const altHeaders = splitCsvLine(headerLine, alt).map(h => h.trim().replace(/^"/, '').replace(/"$/, ''));
      if (altHeaders.length > headers.length) {
        delimiter = alt;
        headers = altHeaders;
      }
    }
  }

  return lines.slice(1).map(line => {
    const values = splitCsvLine(line, delimiter);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (values[i] || '').trim().replace(/^"/, '').replace(/"$/, '');
    });
    return row;
  });
}

/** Find a column by matching against multiple possible header names (case-insensitive, partial) */
function findColumn(headers: string[], ...patterns: string[]): string | null {
  const normalized = headers.map(h => h.toLowerCase().trim());
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    // Exact match first
    const exactIdx = normalized.indexOf(p);
    if (exactIdx >= 0) return headers[exactIdx];
    // Partial match
    const partialIdx = normalized.findIndex(h => h.includes(p));
    if (partialIdx >= 0) return headers[partialIdx];
  }
  return null;
}

/** Find column whose header contains ALL specified terms */
function findColumnWithInclude(headers: string[], ...mustInclude: string[]): string | null {
  const terms = mustInclude.map(t => t.toLowerCase());
  for (const h of headers) {
    const hl = h.toLowerCase().trim();
    if (terms.every(t => hl.includes(t))) return h;
  }
  return null;
}

/** Parse German or US number format: "1.234,56" → 1234.56, "1,234.56" → 1234.56 */
function parseAmount(text: string): number {
  if (!text || text.trim() === '') return 0;
  let s = text.trim().replace(/[€$\s]/g, '');
  // Detect German format: if there's a comma after the last dot, it's German
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    // German: 1.234,56
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // US: 1,234.56 or plain 1234.56
    s = s.replace(/,/g, '');
  }
  const num = parseFloat(s);
  return isNaN(num) ? 0 : num;
}

/** Parse date from various formats to YYYY-MM-DD */
function parseDate(text: string): string {
  if (!text) return '';
  // Use the central normalizeDate which handles all formats correctly
  const norm = normalizeDate(text.trim());
  // Return date-only portion for consistency
  return norm ? norm.slice(0, 10) + 'T00:00:00+01:00' : '';
}

// ============================================================
// Report Parsers
// ============================================================

export interface ParseDebug {
  headers: string[];
  detected: Record<string, any>;
  [key: string]: any;
}

let _lastSendungenDebug: ParseDebug | null = null;
let _lastAbgleichDebug: ParseDebug | null = null;
export function getLastParseDebug() {
  return { sendungen: _lastSendungenDebug, abgleich: _lastAbgleichDebug };
}

export function parseSendungen(content: string): AmazonItem[] {
  const rows = parseCsv(content);
  if (rows.length === 0) return [];

  const headers = Object.keys(rows[0]);
  const colOrder = findColumn(headers, 'bestellnummer', 'bestell-nr', 'order id', 'bestellungs-id');
  const colDate = findColumn(headers, 'bestelldatum', 'order date');
  const colTitle = findColumn(headers, 'titel', 'artikelname', 'product name', 'title', 'artikel');
  const colCategory = findColumn(headers, 'kategorie', 'category');
  const colAsin = findColumn(headers, 'asin', 'isbn');
  const colQty = findColumn(headers, 'menge', 'anzahl', 'quantity');
  const colUnitPrice = findColumn(headers, 'stückpreis', 'einzelpreis', 'unit price');
  const colTotal = findColumn(headers, 'gesamtpreis', 'gesamt', 'total');
  const colCurrency = findColumn(headers, 'währung', 'currency');
  const colShipping = findColumn(headers, 'versand', 'shipping');
  const colStatus = findColumn(headers, 'status');
  // "Land für USt-IdNr des Verkäufers" — must match SELLER column, not Kontobenutzer or Rechnungsaussteller
  const colVatCountry = findColumn(headers,
    'land für umsatzsteuer-identifikationsnummer des verkäufers',
    'land für ust-idnr des verkäufers',
  ) ?? findColumnWithInclude(headers, 'land', 'verkäufer')
    ?? findColumn(headers, 'ust-land', 'vat country');
  const colSenderCountry = findColumn(headers, 'absenderland', 'sender country', 'dispatch country');
  const colSellerName = findColumnWithInclude(headers, 'name', 'verkäufer') ?? findColumn(headers, 'seller name');
  const colShippingVat = findColumn(headers, 'versand-mwst', 'versand mwst', 'shipping vat', 'versandsteuer');
  const colArticleVat = findColumn(headers, 'artikel-ust', 'artikel ust', 'article vat', 'artikelsteuer');
  const colNetDelivery = findColumn(headers, 'nettosumme der lieferung', 'nettosumme', 'net delivery');

  _lastSendungenDebug = {
    headers,
    detected: { order: colOrder, vatCountry: colVatCountry, shippingVat: colShippingVat, articleVat: colArticleVat, netDelivery: colNetDelivery, title: colTitle },
    vatCountry_col_index: colVatCountry ? headers.indexOf(colVatCountry) : -1,
    // Show all headers containing "land" for debugging
    land_headers: headers.filter(h => h.toLowerCase().includes('land')).map(h => `[${headers.indexOf(h)}] ${h}`),
  };

  if (!colOrder) throw new Error('Sendungen: Spalte "Bestellnummer" nicht gefunden. Verfügbare Spalten: ' + headers.join(', '));

  return rows
    .filter(r => r[colOrder]?.trim())
    .map(r => ({
      orderNumber: r[colOrder!].trim(),
      orderDate: parseDate(r[colDate ?? ''] ?? ''),
      title: r[colTitle ?? ''] ?? '',
      category: r[colCategory ?? ''] ?? '',
      asin: r[colAsin ?? ''] ?? '',
      quantity: parseInt(r[colQty ?? ''] ?? '1', 10) || 1,
      unitPrice: parseAmount(r[colUnitPrice ?? ''] ?? '0'),
      totalPrice: parseAmount(r[colTotal ?? ''] ?? '0'),
      netDeliveryAmount: parseAmount(r[colNetDelivery ?? ''] ?? '0'),
      currency: (r[colCurrency ?? ''] ?? 'EUR').toUpperCase(),
      shipping: parseAmount(r[colShipping ?? ''] ?? '0'),
      status: r[colStatus ?? ''] ?? '',
      vatCountry: (r[colVatCountry ?? ''] ?? '').trim() || (r[colSenderCountry ?? ''] ?? '').trim(),
      sellerName: (r[colSellerName ?? ''] ?? '').trim(),
      shippingVat: parseAmount(r[colShippingVat ?? ''] ?? '0'),
      articleVat: parseAmount(r[colArticleVat ?? ''] ?? '0'),
    }));
}

export function parseErstattungen(content: string): AmazonRefund[] {
  const rows = parseCsv(content);
  if (rows.length === 0) return [];

  const headers = Object.keys(rows[0]);
  const colOrder = findColumn(headers, 'bestellnr.', 'bestellnummer', 'bestell-nr', 'order id', 'bestellungs-id');
  const colDate = findColumn(headers, 'gutschriftdatum', 'erstattungsdatum', 'refund date', 'datum');
  const colTitle = findColumn(headers, 'titel', 'artikelname', 'product name', 'title', 'artikel');
  const colCategory = findColumn(headers, 'kategorie', 'category');
  const colAsin = findColumn(headers, 'asin', 'isbn');
  const colQty = findColumn(headers, 'menge', 'anzahl', 'quantity');
  const colRefund = findColumn(headers, 'summe der erstattung inkl', 'erstattungsbetrag', 'refund amount')
    ?? findColumnWithInclude(headers, 'summe', 'erstattung');
  const colCurrency = findColumn(headers, 'währung', 'currency');
  const colVat = findColumn(headers, 'versand-mwst', 'versand mwst', 'mwst', 'ust', 'vat', 'steuer');
  // "Erstattung - Artikel-Ust" — try various dash styles (en-dash, hyphen, space)
  const colArticleVat = findColumn(headers,
    'erstattung – artikel-ust', 'erstattung - artikel-ust', 'erstattung artikel-ust',
    'erstattung – artikel-ust.', 'erstattung - artikel-ust.',
    'artikel-ust', 'article vat');
  const colVatCountry = findColumn(headers,
    'land für ust-idnr des verkäufers', 'land für umsatzsteuer-idnr des verkäufers',
    'ust-land', 'vat country',
  ) ?? findColumnWithInclude(headers, 'land', 'verkäufer')
    ?? findColumn(headers, 'ust-land', 'vat country');
  const colPaymentRef = findColumn(headers, 'zahlungsreferenz-id', 'zahlungsreferenz', 'payment reference', 'payment ref');

  if (!colOrder) throw new Error('Erstattungen: Spalte "Bestellnummer" nicht gefunden. Verfügbare Spalten: ' + headers.join(', '));

  return rows
    .filter(r => r[colOrder]?.trim())
    .map(r => ({
      orderNumber: r[colOrder!].trim(),
      refundDate: parseDate(r[colDate ?? ''] ?? ''),
      title: r[colTitle ?? ''] ?? '',
      category: r[colCategory ?? ''] ?? '',
      asin: r[colAsin ?? ''] ?? '',
      quantity: parseInt(r[colQty ?? ''] ?? '1', 10) || 1,
      refundAmount: parseAmount(r[colRefund ?? ''] ?? '0'),
      currency: (r[colCurrency ?? ''] ?? 'EUR').toUpperCase(),
      vatAmount: parseAmount(r[colVat ?? ''] ?? '0'),
      articleVat: parseAmount(r[colArticleVat ?? ''] ?? '0'),
      paymentRefId: r[colPaymentRef ?? '']?.trim() ?? '',
      vatCountry: r[colVatCountry ?? ''] ?? '',
    }));
}

export function parseAbgleich(content: string): AmazonReconciliation[] {
  const rows = parseCsv(content);
  if (rows.length === 0) return [];

  const headers = Object.keys(rows[0]);
  const colOrder = findColumn(headers, 'bestellnummer', 'bestell-nr', 'order id', 'bestellungs-id');
  const colDate = findColumn(headers, 'zahlungsdatum', 'datum', 'date', 'payment date', 'bestelldatum');
  const colTotal = findColumn(headers, 'gesamtbetrag', 'gesamt', 'total', 'betrag', 'amount');
  const colCurrency = findColumn(headers, 'währung', 'currency');
  const colPayment = findColumn(headers, 'zahlungsmethode', 'zahlungsart', 'payment method', 'payment');
  const colShipping = findColumn(headers, 'versandkosten', 'versand', 'shipping');
  const colVat = findColumn(headers, 'ust', 'mwst', 'vat', 'steuer', 'tax');
  let colTxnType = findColumn(headers, 'transaktionstyp', 'transaction type', 'art der transaktion');
  const colPaymentRef = findColumn(headers, 'zahlungsreferenz-id', 'zahlungsreferenz', 'payment reference', 'payment ref');
  const colAccountGroup = findColumn(headers, 'kontengruppe', 'account group');
  const colFeeRecognition = findColumn(headers, 'gebührenkennung', 'gebührenerkennung', 'gebühren-erkennung', 'fee recognition');

  // Fallback: find Transaktionstyp column by scanning values for "Erstattung" or "Gebühr"
  if (!colTxnType && rows.length > 0) {
    for (const h of headers) {
      const vals = rows.slice(0, 20).map(r => (r[h] ?? '').toLowerCase().trim());
      if (vals.some(v => v === 'erstattung' || v === 'gebühr' || v === 'refund')) {
        colTxnType = h;
        break;
      }
    }
  }

  // More detailed debug: show raw header bytes for troubleshooting
  const headerDebugInfo = headers.map(h => {
    const codes = [...h].map(c => c.charCodeAt(0));
    return { name: h, length: h.length, charCodes: codes.slice(0, 30) };
  });

  _lastAbgleichDebug = {
    headers,
    detected: { order: colOrder, date: colDate, total: colTotal, txnType: colTxnType, feeRecognition: colFeeRecognition, headerDebug: headerDebugInfo },
  };

  if (!colOrder) throw new Error('Abgleich: Spalte "Bestellnummer" nicht gefunden. Verfügbare Spalten: ' + headers.join(', '));

  return rows
    .filter(r => r[colOrder]?.trim())
    .map(r => ({
      orderNumber: r[colOrder!].trim(),
      paymentDate: parseDate(r[colDate ?? ''] ?? ''),
      totalAmount: parseAmount(r[colTotal ?? ''] ?? '0'),
      currency: (r[colCurrency ?? ''] ?? 'EUR').toUpperCase(),
      paymentMethod: r[colPayment ?? ''] ?? '',
      shippingCost: parseAmount(r[colShipping ?? ''] ?? '0'),
      vatAmount: parseAmount(r[colVat ?? ''] ?? '0'),
      transactionType: r[colTxnType ?? ''] ?? '',
      paymentRefId: r[colPaymentRef ?? '']?.trim() ?? '',
      accountGroup: r[colAccountGroup ?? '']?.trim() ?? '',
      feeRecognition: r[colFeeRecognition ?? '']?.trim() ?? '',
    }));
}

// ============================================================
// Merge Data
// ============================================================

// Helper: calculate tax rate from brutto and Ust as whole number
// brutto is the total (incl. tax), ust is the tax portion
// taxRate = ust / (brutto - ust) * 100 = ust / netto * 100
function calcTaxRate(brutto: number, ust: number): number {
  const b = Math.abs(brutto);
  const u = Math.abs(ust);
  if (!b || !u) return 0;
  const netto = b - u;
  if (netto <= 0) return 0;
  return Math.round((u / netto) * 100);
}

/**
 * Abgleich is the AUTHORITATIVE source. Each Abgleich row = exactly one import row.
 * Amount ALWAYS from Abgleich (Zahlungsbetrag).
 * Sendungen/Erstattungen are ONLY used for supplementary tax info:
 * - Gebühr: match Sendungen by Bestellnummer + Nettosumme der Lieferung = Abgleich-Betrag → Versand-MwSt.
 * - Erstattung: match Erstattungen by Zahlungsreferenz-ID → Erstattung – Artikel-USt
 * No product names, descriptions, or item prices are used for the import.
 */
export function mergeAmazonData(
  sendungen: AmazonItem[],
  erstattungen: AmazonRefund[],
  abgleich: AmazonReconciliation[],
): Map<string, AmazonOrder> {
  const orders = new Map<string, AmazonOrder>();

  // Index Sendungen by order number
  const sendungenByOrder = new Map<string, AmazonItem[]>();
  for (const item of sendungen) {
    const list = sendungenByOrder.get(item.orderNumber) ?? [];
    list.push(item);
    sendungenByOrder.set(item.orderNumber, list);
  }

  // Index Erstattungen by paymentRefId (primary) and by orderNumber (fallback)
  const erstattungenByPayRef = new Map<string, AmazonRefund[]>();
  const erstattungenByOrder = new Map<string, AmazonRefund[]>();
  for (const ref of erstattungen) {
    if (ref.paymentRefId) {
      const list = erstattungenByPayRef.get(ref.paymentRefId) ?? [];
      list.push(ref);
      erstattungenByPayRef.set(ref.paymentRefId, list);
    }
    const list = erstattungenByOrder.get(ref.orderNumber) ?? [];
    list.push(ref);
    erstattungenByOrder.set(ref.orderNumber, list);
  }

  // Each Abgleich row → one document. Unique key per row.
  const orderOccurrence = new Map<string, number>();
  for (const a of abgleich) {
    const txnType = (a.transactionType ?? '').trim().toLowerCase();
    const isRefund = txnType === 'erstattung' || txnType.includes('erstattung') || txnType === 'refund';
    const occ = (orderOccurrence.get(a.orderNumber) ?? 0) + 1;
    orderOccurrence.set(a.orderNumber, occ);
    const mapKey = occ === 1 ? a.orderNumber : `${a.orderNumber}#${occ}`;

    // Amount ALWAYS from Abgleich
    const totalAmount = a.totalAmount;

    // Supplementary: find tax + title from Sendungen/Erstattungen
    let ust = 0;
    let vatCountry = '';
    let title = a.accountGroup; // default: Kontengruppe from Abgleich
    const items = sendungenByOrder.get(a.orderNumber) ?? [];

    if (isRefund) {
      // Erstattung: search Erstattungen by Zahlungsreferenz-ID, fallback by orderNumber
      const refsByPayRef = a.paymentRefId ? (erstattungenByPayRef.get(a.paymentRefId) ?? []) : [];
      const refunds = refsByPayRef.length > 0 ? refsByPayRef : (erstattungenByOrder.get(a.orderNumber) ?? []);
      // Tax from "Erstattung - Artikel-Ust" column (articleVat only, no fallback to vatAmount)
      ust = refunds.reduce((sum, r) => sum + r.articleVat, 0);
      vatCountry = refunds.find(r => r.vatCountry)?.vatCountry ?? '';
      // Title from Erstattungen "Titel" column
      const refTitle = refunds.map(r => r.title).filter(Boolean).join('; ');
      if (refTitle) title = refTitle.length > 80 ? refTitle.slice(0, 77) + '...' : refTitle;
      // Fallback: title + vatCountry from Sendungen
      if (!refTitle && items.length > 0) {
        const itemTitle = items.map(i => i.title).filter(Boolean).join('; ');
        if (itemTitle) title = itemTitle.length > 80 ? itemTitle.slice(0, 77) + '...' : itemTitle;
      }
      if (!vatCountry && items.length > 0) {
        vatCountry = items.find(i => i.vatCountry)?.vatCountry ?? '';
      }
    } else {
      // Gebühr: search Sendungen by Bestellnummer + Nettosumme der Lieferung = Abgleich-Betrag
      const abgleichAmt = Math.abs(totalAmount);
      const matchedItem = items.find(i =>
        Math.abs(Math.abs(i.netDeliveryAmount) - abgleichAmt) < 0.02
      ) ?? items.find(i =>
        Math.abs(Math.abs(i.totalPrice) - abgleichAmt) < 0.02
      );
      if (matchedItem) {
        ust = matchedItem.shippingVat;
        vatCountry = matchedItem.vatCountry;
        // Title from Sendungen "Titel" column
        if (matchedItem.title) title = matchedItem.title.length > 80 ? matchedItem.title.slice(0, 77) + '...' : matchedItem.title;
      } else if (items.length > 0) {
        // Fallback: no exact amount match — take country/title from first Sendungen item for this order
        vatCountry = items.find(i => i.vatCountry)?.vatCountry ?? '';
        ust = items.reduce((s, i) => s + i.shippingVat, 0);
        const itemTitle = items.map(i => i.title).filter(Boolean).join('; ');
        if (itemTitle) title = itemTitle.length > 80 ? itemTitle.slice(0, 77) + '...' : itemTitle;
      }
    }

    // Last resort: infer country from seller name if still empty
    if (!vatCountry && items.length > 0) {
      const sellerName = items.find(i => i.sellerName)?.sellerName ?? '';
      if (sellerName) {
        // GmbH without Austrian indicators → DE, Salzburg/Wien/Graz → AT, Ltd → GB/US, SRL → IT/RO, S.L. → ES
        const sl = sellerName.toLowerCase();
        if (/\bgmbh\b/i.test(sellerName) && !/(salzburg|wien|graz|innsbruck|linz|österreich|austria)/i.test(sellerName)) {
          vatCountry = 'DE';
        } else if (/(salzburg|wien|graz|innsbruck|linz|österreich|austria)/i.test(sellerName)) {
          vatCountry = 'AT';
        }
      }
    }

    const taxRate = calcTaxRate(totalAmount, ust);

    orders.set(mapKey, {
      orderNumber: a.orderNumber,
      orderDate: a.paymentDate,
      paymentDate: a.paymentDate,
      totalAmount,
      currency: a.currency || 'EUR',
      items,
      refunds: [],
      paymentMethod: a.paymentMethod,
      shippingCost: a.shippingCost,
      vatAmount: a.vatAmount,
      isRefund,
      title,
      vatCountry,
      shippingVat: ust,
      taxRate,
      feeRecognition: a.feeRecognition,
      paymentRefId: a.paymentRefId,
    });
  }

  return orders;
}

// ============================================================
// Import to SQLite
// ============================================================

export function importAmazonOrders(orders: Map<string, AmazonOrder>): AmazonImportResult {
  const db = getDb();

  const checkDoc = db.prepare(`
    SELECT document_id, document_date, total_amount_minor, meta
    FROM documents
    WHERE document_id = ?
  `);
  const insertDoc = db.prepare(`
    INSERT INTO documents (
      document_id, source_system, source_document_ref, captured_at,
      document_date, total_amount_minor, currency_code,
      supplier_name, vat_amount_minor, vat_rate, filename, meta
    ) VALUES (
      @document_id, @source_system, @source_document_ref, @captured_at,
      @document_date, @total_amount_minor, @currency_code,
      @supplier_name, @vat_amount_minor, @vat_rate, @filename, @meta
    )
  `);
  const upsertDoc = db.prepare(`
    UPDATE documents SET
      total_amount_minor = @total_amount_minor,
      document_date = @document_date,
      vat_amount_minor = @vat_amount_minor,
      vat_rate = @vat_rate,
      meta = @meta,
      captured_at = @captured_at
    WHERE document_id = @document_id
  `);
  const deleteLineItems = db.prepare('DELETE FROM line_items WHERE document_id = ?');
  const insertLineItem = db.prepare(`
    INSERT INTO line_items (document_id, description, amount_minor, quantity)
    VALUES (@document_id, @description, @amount_minor, @quantity)
  `);
  const insertDocDisp = db.prepare(`
    INSERT OR IGNORE INTO document_dispositions (document_id, disposition, set_by)
    VALUES (?, 'open', 'system')
  `);

  let imported = 0;
  let skipped = 0;
  let refundCount = 0;
  const resultDocs: AmazonImportResult['documents'] = [];

  const run = db.transaction(() => {
    for (const [mapKey, order] of orders) {
      // Use mapKey as docRef — includes #2, #3 suffix for duplicate order numbers
      // Erstattung → positive (Gutschrift), Gebühr → negative (expense)
      const absMinor = Math.round(Math.abs(order.totalAmount) * 100);
      const totalMinor = order.isRefund ? absMinor : -absMinor;
      let docRef = mapKey;
      let docId = documentId('amazon', docRef);
      let exists = checkDoc.get(docId) as {
        document_id: string;
        document_date: string | null;
        total_amount_minor: number;
        meta: string | null;
      } | undefined;

      // Partial or reordered Amazon exports can reuse the unsuffixed order key for
      // a different payment/refund. Never overwrite an existing historical document
      // when both its date and amount identify another event.
      if (exists) {
        let existingMeta: Record<string, unknown> = {};
        try {
          existingMeta = JSON.parse(exists.meta ?? '{}') as Record<string, unknown>;
        } catch {
          // Malformed legacy metadata is handled by the conservative date/amount check.
        }
        const existingPaymentRef = String(existingMeta.payment_reference_id ?? '');
        const samePaymentRef = Boolean(
          order.paymentRefId
          && existingPaymentRef
          && order.paymentRefId === existingPaymentRef,
        );
        const sameDate = Boolean(
          exists.document_date
          && order.paymentDate
          && exists.document_date.slice(0, 10) === order.paymentDate.slice(0, 10),
        );
        const sameAmount = exists.total_amount_minor === totalMinor;

        if (!samePaymentRef && !sameDate && !sameAmount) {
          const fallbackIdentity = (order.paymentRefId || [
            order.isRefund ? 'refund' : 'charge',
            (order.paymentDate || order.orderDate || 'unknown-date').slice(0, 10),
            absMinor,
          ].join('-')).replace(/[^A-Za-z0-9_-]+/g, '-');
          docRef = `${order.orderNumber}#${fallbackIdentity}`;
          docId = documentId('amazon', docRef);
          exists = checkDoc.get(docId) as typeof exists;
        }
      }

      const taxCategory = getTaxCategory(order.vatCountry, order.taxRate);

      // Compute VAT fields — for refunds, inherit tax_rate from the matching order
      let effectiveTaxRate = order.taxRate;
      if (order.isRefund && effectiveTaxRate === 0) {
        // Find the order with same base ref (without #2/#3 suffix)
        const baseRef = docRef.replace(/#\d+$/, '');
        for (const [key, other] of orders) {
          if (key !== mapKey && key.startsWith(baseRef) && !other.isRefund && other.taxRate > 0) {
            effectiveTaxRate = other.taxRate;
            break;
          }
        }
        // Also check reverse: if refund has the base ref, order might have #2
        if (effectiveTaxRate === 0) {
          for (const [key, other] of orders) {
            if (key !== mapKey && key.replace(/#\d+$/, '') === baseRef && !other.isRefund && other.taxRate > 0) {
              effectiveTaxRate = other.taxRate;
              break;
            }
          }
        }
        // Default to 20% only for confirmed AT refunds
        if (effectiveTaxRate === 0 && taxCategory === 'AT') effectiveTaxRate = 20;
      }
      // Default non-refund AT orders without explicit tax to 20% (Austrian standard rate)
      if (!order.isRefund && effectiveTaxRate === 0 && taxCategory === 'AT') {
        effectiveTaxRate = 20;
      }
      const vatRate = effectiveTaxRate > 0 ? effectiveTaxRate / 100 : (taxCategory === 'IGL' ? 0 : null);
      let vatAmountMinor: number | null = null;
      if (order.shippingVat != null && order.shippingVat !== 0) {
        // shippingVat contains the actual VAT amount (from Sendungen/Erstattungen)
        vatAmountMinor = order.isRefund
          ? Math.round(Math.abs(order.shippingVat) * 100)   // refund: positive VAT credit
          : -Math.round(Math.abs(order.shippingVat) * 100);  // expense: negative VAT
      } else if (vatRate && absMinor > 0) {
        // Infer VAT from gross amount: vat = gross * rate / (1 + rate)
        const grossEur = absMinor / 100;
        const vatEur = grossEur * vatRate / (1 + vatRate);
        vatAmountMinor = order.isRefund
          ? Math.round(vatEur * 100)
          : -Math.round(vatEur * 100);
      }

      const docData = {
        document_id: docId,
        source_system: 'amazon',
        source_document_ref: docRef,
        captured_at: new Date().toISOString(),
        document_date: order.paymentDate || order.orderDate,
        total_amount_minor: totalMinor,
        currency_code: order.currency,
        supplier_name: order.isRefund ? 'Amazon (Erstattung)' : 'Amazon',
        vat_amount_minor: vatAmountMinor,
        vat_rate: vatRate,
        filename: docRef,
        meta: JSON.stringify({
          order_date: order.orderDate,
          payment_date: order.paymentDate,
          payment_method: order.paymentMethod,
          title: order.title,
          vat_country: order.vatCountry,
          shipping_vat: order.shippingVat,
          tax_rate: order.taxRate,
          tax_category: taxCategory,
          is_refund: order.isRefund,
          fee_recognition: order.feeRecognition || undefined,
          payment_reference_id: order.paymentRefId || undefined,
        }),
      };

      if (exists) {
        upsertDoc.run(docData);
        skipped++;
      } else {
        insertDoc.run(docData);
        insertDocDisp.run(docId);
        imported++;
      }

      // No product-level line items — Abgleich row = one document
      deleteLineItems.run(docId);

      if (order.isRefund) refundCount++;
      resultDocs.push({
        order_number: order.orderNumber,
        date: order.paymentDate || order.orderDate,
        amount: Math.abs(order.totalAmount),
        items: 1,
        is_new: !exists,
        is_refund: order.isRefund,
        title: order.title,
        vat_country: order.vatCountry,
        vat_rate: order.taxRate,
        shipping_vat: order.shippingVat,
        tax_category: taxCategory,
      });
    }
  });

  run();

  return {
    orders: orders.size,
    refunds: refundCount,
    imported,
    skipped,
    documents: resultDocs.sort((a, b) => a.date.localeCompare(b.date)),
    invoices_organized: 0,
  };
}

// ============================================================
// Invoice File Organization
// ============================================================

/**
 * Extract Amazon order number from a filename.
 * Handles patterns like:
 *   20251229_Tax Invoice_028-5015663-5601965.pdf
 *   20251229_Tax Invoice_028-5015663-5601965_1.pdf (multiple invoices)
 *   028-5015663-5601965.pdf
 *   D01-1234567-7654321.pdf
 */
function extractOrderFromFilename(filename: string): { orderNumber: string; suffix: string; year: string } | null {
  // Amazon order patterns: NNN-NNNNNNN-NNNNNNN or D01-NNNNNNN-NNNNNNN
  const match = filename.match(/(\d{3}-\d{7}-\d{7}|D\d{2}-\d{7}-\d{7}|62-I-\d{10,})/);
  if (!match) return null;

  const orderNumber = match[1];
  // Check for _N suffix after the order number
  const afterOrder = filename.slice(match.index! + orderNumber.length);
  const suffixMatch = afterOrder.match(/^(_\d+)/);
  const suffix = suffixMatch ? suffixMatch[1] : '';

  // Extract year from date prefix (YYYYMMDD) if present
  const datePrefix = filename.match(/^(\d{4})\d{4}/);
  const year = datePrefix ? datePrefix[1] : new Date().getFullYear().toString();

  return { orderNumber, suffix, year };
}

export interface OrganizeInvoicesResult {
  scanned: number;
  organized: number;
  skipped: number;
  folders_created: number;
  files: Array<{
    original: string;
    order_number: string;
    new_name: string;
    is_new: boolean;
  }>;
}

/**
 * Organize Amazon invoice PDFs into Belege/{year}/Rechnungen/Amazon-Rechnungen/{orderNumber}/.
 * Source: a flat directory of files like "20251229_Tax Invoice_028-5015663-5601965.pdf"
 * Target: Belege/{year}/Rechnungen/Amazon-Rechnungen/{028-5015663-5601965}/{028-5015663-5601965}.pdf
 */
export function organizeInvoiceFiles(sourceDir: string): OrganizeInvoicesResult {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Quellverzeichnis nicht gefunden: ${sourceDir}`);
  }

  const belegeBase = path.resolve('Belege');
  const entries = fs.readdirSync(sourceDir);
  const files = entries.filter(e => {
    const full = path.join(sourceDir, e);
    return fs.statSync(full).isFile();
  });

  let organized = 0;
  let skippedCount = 0;
  const foldersCreated = new Set<string>();
  const resultFiles: OrganizeInvoicesResult['files'] = [];

  for (const file of files) {
    const parsed = extractOrderFromFilename(file);
    if (!parsed) {
      skippedCount++;
      continue;
    }

    const { orderNumber, suffix, year } = parsed;
    const ext = path.extname(file);
    const newName = `${orderNumber}${suffix}${ext}`;
    const folderPath = path.join(belegeBase, year, 'Rechnungen', 'Amazon-Rechnungen', orderNumber);

    // Create folder
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
      foldersCreated.add(orderNumber);
    }

    const destPath = path.join(folderPath, newName);
    const sourcePath = path.join(sourceDir, file);

    // Skip if already exists at destination
    if (fs.existsSync(destPath)) {
      resultFiles.push({ original: file, order_number: orderNumber, new_name: newName, is_new: false });
      skippedCount++;
      continue;
    }

    fs.renameSync(sourcePath, destPath);
    organized++;
    resultFiles.push({ original: file, order_number: orderNumber, new_name: newName, is_new: true });
  }

  return {
    scanned: files.length,
    organized,
    skipped: skippedCount,
    folders_created: foldersCreated.size,
    files: resultFiles,
  };
}

// ============================================================
// Combined import function (called by API)
// ============================================================

export function importAmazon(
  sendungenPath: string,
  erstattungenPath: string | null,
  abgleichPath: string,
): AmazonImportResult {
  const sendungenContent = fs.readFileSync(sendungenPath, 'utf-8');
  const abgleichContent = fs.readFileSync(abgleichPath, 'utf-8');
  const erstattungenContent = erstattungenPath ? fs.readFileSync(erstattungenPath, 'utf-8') : '';

  const sendungen = parseSendungen(sendungenContent);
  const erstattungen = erstattungenContent ? parseErstattungen(erstattungenContent) : [];
  const abgleich = parseAbgleich(abgleichContent);

  const orders = mergeAmazonData(sendungen, erstattungen, abgleich);
  const result = importAmazonOrders(orders);

  // Attach debug info about detected columns
  const parseDebug = getLastParseDebug();
  const abgleichRefundCount = abgleich.filter(a => {
    const t = (a.transactionType ?? '').trim().toLowerCase();
    return t === 'erstattung' || t.includes('erstattung');
  }).length;
  // Show first few unique transactionType values for debugging
  const txnTypeValues = [...new Set(abgleich.map(a => a.transactionType).filter(Boolean))].slice(0, 10);
  // Count how many orders are marked as refund in the final result
  const finalRefundCount = [...orders.values()].filter(o => o.isRefund).length;

  result.debug = {
    abgleich_columns: parseDebug.abgleich?.headers ?? [],
    abgleich_txn_type_col: parseDebug.abgleich?.detected.txnType ?? null,
    abgleich_fee_recognition_col: (parseDebug.abgleich?.detected as any)?.feeRecognition ?? null,
    abgleich_refund_count: abgleichRefundCount,
    abgleich_txn_type_values: txnTypeValues,
    abgleich_header_debug: (parseDebug.abgleich?.detected as any)?.headerDebug ?? [],
    abgleich_total_rows: abgleich.length,
    orders_total: orders.size,
    orders_refund_count: finalRefundCount,
    sendungen_columns: parseDebug.sendungen?.headers ?? [],
    sendungen_vat_country_col: parseDebug.sendungen?.detected.vatCountry ?? null,
    sendungen_vat_country_col_index: (parseDebug.sendungen as any)?.vatCountry_col_index ?? -1,
    sendungen_land_headers: (parseDebug.sendungen as any)?.land_headers ?? [],
    sendungen_shipping_vat_col: parseDebug.sendungen?.detected.shippingVat ?? null,
    sendungen_article_vat_col: parseDebug.sendungen?.detected.articleVat ?? null,
    // Sample: first 5 unique vatCountry values from parsed Sendungen
    sendungen_country_samples: [...new Set(sendungen.map(s => s.vatCountry).filter(Boolean))].slice(0, 10),
    sendungen_empty_country_count: sendungen.filter(s => !s.vatCountry).length,
    sendungen_total: sendungen.length,
    // Show a few sample Abgleich rows with their transactionType
    abgleich_samples: abgleich.slice(0, 5).map(a => ({
      order: a.orderNumber,
      txnType: a.transactionType,
      amount: a.totalAmount,
      feeRecognition: a.feeRecognition,
    })),
  };

  return result;
}

// ============================================================
// PDF ↔ Document Amount Matching
// ============================================================

/**
 * Extract the total amount from an Amazon invoice PDF using text extraction.
 * No AI/OCR needed — Amazon PDFs have a text layer.
 */
async function extractAmountFromPdf(pdfPath: string): Promise<number | null> {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

    let fullText = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items = content.items as any[];
      let lastY: number | null = null;
      for (const item of items) {
        const str = item.str ?? '';
        if (str === '') continue;
        const y = item.transform ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) fullText += '\n';
        fullText += str + ' ';
        if (y !== null) lastY = y;
      }
      fullText += '\n';
    }

    // Try to find the total amount with German number format
    const patterns = [
      /Rechnungssumme[:\s]*([0-9.,]+)\s*€/i,
      /Gesamtbetrag[:\s]*([0-9.,]+)\s*€/i,
      /Zahlbetrag[:\s]*([0-9.,]+)\s*€/i,
      /Total[:\s]*€?\s*([0-9.,]+)/i,
      /Endbetrag[:\s]*([0-9.,]+)\s*€/i,
      /Rechnungssumme[:\s]*€?\s*([0-9.,]+)/i,
      /Gesamtbetrag[:\s]*€?\s*([0-9.,]+)/i,
    ];

    for (const re of patterns) {
      const m = re.exec(fullText);
      if (m) {
        const numStr = m[1].replace(/\./g, '').replace(',', '.');
        const val = parseFloat(numStr);
        if (!isNaN(val) && val > 0) return Math.round(val * 100);
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract VAT info (country, rate, amounts) from an Amazon invoice PDF.
 * Amazon PDFs have a text layer — no OCR needed.
 */
async function extractVatInfoFromPdf(pdfPath: string): Promise<{
  country: string | null;
  vatRate: number | null;   // decimal 0-1
  netMinor: number | null;
  vatMinor: number | null;
  grossMinor: number | null;
} | null> {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

    let fullText = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items = content.items as any[];
      let lastY: number | null = null;
      for (const item of items) {
        const str = item.str ?? '';
        if (str === '') continue;
        const y = item.transform ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) fullText += '\n';
        fullText += str + ' ';
        if (y !== null) lastY = y;
      }
      fullText += '\n';
    }

    const parseEur = (s: string): number | null => {
      const n = s.replace(/\./g, '').replace(',', '.');
      const v = parseFloat(n);
      return isNaN(v) ? null : Math.round(v * 100);
    };

    // Extract country from VAT IDs in the PDF
    // Amazon invoices contain DEMO_INVALID_TAX_ID (Amazon entity) and DEMO_INVALID_TAX_ID (buyer)
    // Third-party invoices contain the seller's VAT ID
    let country: string | null = null;
    const BUYER_VAT_IDS = ['DEMO_INVALID_TAX_ID']; // Known buyer VAT IDs to skip
    const vatIds = fullText.match(/[A-Z]{2}[A-Z]?\d{7,12}/g) ?? [];
    for (const vid of vatIds) {
      if (BUYER_VAT_IDS.some(b => vid.includes(b))) continue;
      country = vid.slice(0, 2);
      break;
    }

    let netMinor: number | null = null;
    let vatMinor: number | null = null;
    let grossMinor: number | null = null;
    let vatRate: number | null = null;

    // Amazon PDF structured format: "USt. 20.0%   65,28 €   13,00 €"
    const ustLine = fullText.match(/USt\.?\s*(\d+[.,]\d+)\s*%\s+([0-9.,]+)\s*€\s+([0-9.,]+)\s*€/);
    if (ustLine) {
      vatRate = parseFloat(ustLine[1].replace(',', '.')) / 100;
      netMinor = parseEur(ustLine[2]);
      vatMinor = parseEur(ustLine[3]);
    }

    // Gross from Rechnungssumme
    const grossMatch = fullText.match(/(?:Rechnungssumme|Gesamtbetrag|Zahlbetrag|Total)[:\s]*€?\s*([0-9.,]+)/i);
    if (grossMatch) grossMinor = parseEur(grossMatch[1]);

    // Fallback: standalone rate pattern
    if (vatRate == null) {
      const rateMatch = fullText.match(/(\d+[.,]\d+)\s*%/);
      if (rateMatch) vatRate = parseFloat(rateMatch[1].replace(',', '.')) / 100;
    }

    // Derive missing values
    if (grossMinor != null && netMinor != null && vatMinor == null) vatMinor = grossMinor - netMinor;
    if (grossMinor != null && vatMinor != null && netMinor == null) netMinor = grossMinor - vatMinor;
    if (vatRate == null && netMinor != null && vatMinor != null && netMinor !== 0) {
      vatRate = Math.round(Math.abs(vatMinor) / Math.abs(netMinor) * 100) / 100;
    }

    if (!country && !vatRate && !vatMinor) return null;
    return { country, vatRate, netMinor, vatMinor, grossMinor };
  } catch {
    return null;
  }
}

/**
 * Post-import: fill missing vat_country/tax_rate from invoice PDFs for Amazon documents.
 */
export async function enrichAmazonDocsFromPdfs(): Promise<{ enriched: number; checked: number }> {
  const db = getDb();
  const docs = db.prepare(`
    SELECT document_id, source_document_ref, filename, meta
    FROM documents WHERE source_system = 'amazon'
    AND (json_extract(meta, '$.vat_country') = '' OR json_extract(meta, '$.vat_country') IS NULL)
  `).all() as any[];

  const belegeBase = path.resolve('Belege');
  const update = db.prepare('UPDATE documents SET vat_rate = ?, vat_amount_minor = ?, meta = ? WHERE document_id = ?');
  let enriched = 0;
  let checked = 0;

  for (const doc of docs) {
    const orderNum = doc.source_document_ref.replace(/#\d+$/, '');
    const docYear = doc.document_date?.slice(0, 4) ?? new Date().getFullYear().toString();
    // Search in multiple year folders
    let folder = '';
    for (const y of [docYear, '2025', '2024', '2026']) {
      const candidate = path.join(belegeBase, y, 'Rechnungen', 'Amazon-Rechnungen', orderNum);
      if (fs.existsSync(candidate)) { folder = candidate; break; }
    }
    if (!folder) continue;

    const pdfs = fs.readdirSync(folder).filter((f: string) => f.endsWith('.pdf'));
    if (pdfs.length === 0) continue;
    checked++;

    const pdfPath = path.join(folder, pdfs[0]);
    const info = await extractVatInfoFromPdf(pdfPath);
    if (!info) continue;

    const meta = JSON.parse(doc.meta || '{}');
    let changed = false;

    if (info.country && !meta.vat_country) {
      meta.vat_country = info.country;
      changed = true;
    }
    if (info.vatRate != null && (meta.tax_rate == null || meta.tax_rate === 0)) {
      meta.tax_rate = Math.round(info.vatRate * 100);
      changed = true;
    }

    if (changed) {
      const vatRate = info.vatRate ?? null;
      const vatMinor = info.vatMinor != null ? -Math.abs(info.vatMinor) : null; // expenses are negative
      update.run(vatRate, vatMinor, JSON.stringify(meta), doc.document_id);
      enriched++;
    }
  }

  return { enriched, checked };
}

export interface LinkInvoicesResult {
  matched: number;
  unmatched: number;
  details: Array<{
    order_number: string;
    pdf_file: string;
    amount_minor: number | null;
    doc_id: string | null;
    status: 'matched' | 'unmatched' | 'single';
  }>;
}

/**
 * Link Amazon invoice PDFs to their corresponding database documents by extracting
 * amounts from the PDFs and matching against document amounts with the same order number.
 *
 * Searches flat directories for PDFs whose filenames contain Amazon order numbers.
 * No subfolder organization needed.
 */
export async function linkInvoicePdfs(): Promise<LinkInvoicesResult> {
  const belegeBase = path.resolve('Belege');
  const db = getDb();
  let matched = 0;
  let unmatched = 0;
  const details: LinkInvoicesResult['details'] = [];

  // Collect all Amazon invoice PDFs from known flat directories
  const searchDirs: string[] = [];
  const { getSetting } = await import('../storage/settings.js');
  const customDir = getSetting('amazon_invoice_source_dir');
  if (customDir) searchDirs.push(customDir);

  for (const year of ['2024', '2025', '2026']) {
    searchDirs.push(path.join(belegeBase, year, 'Rechnungen', 'Amazon-Rechnungen'));
    searchDirs.push(path.join(belegeBase, year, 'Rechnungen'));
  }
  searchDirs.push(path.resolve('..', 'Amazon-Rechnungen'));

  // Build index: orderNumber → [{ file, fullPath }]
  const orderRe = /(\d{3}-\d{7}-\d{7}|D\d{2}-\d{7}-\d{7})/;
  const pdfsByOrder = new Map<string, Array<{ file: string; fullPath: string }>>();

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }

    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.pdf')) continue;
      const m = orderRe.exec(entry);
      if (!m) continue;
      const orderNum = m[1];
      const fullPath = path.join(dir, entry);
      try { if (!fs.statSync(fullPath).isFile()) continue; } catch { continue; }

      if (!pdfsByOrder.has(orderNum)) pdfsByOrder.set(orderNum, []);
      pdfsByOrder.get(orderNum)!.push({ file: entry, fullPath });
    }

    // Also check subdirectories (one level deep, e.g. order-number folders)
    for (const entry of entries) {
      const subDir = path.join(dir, entry);
      try { if (!fs.statSync(subDir).isDirectory()) continue; } catch { continue; }
      let subEntries: string[];
      try { subEntries = fs.readdirSync(subDir); } catch { continue; }
      for (const subEntry of subEntries) {
        if (!subEntry.toLowerCase().endsWith('.pdf')) continue;
        const sm = orderRe.exec(subEntry) ?? orderRe.exec(entry);
        if (!sm) continue;
        const orderNum = sm[1];
        const fullPath = path.join(subDir, subEntry);
        try { if (!fs.statSync(fullPath).isFile()) continue; } catch { continue; }

        if (!pdfsByOrder.has(orderNum)) pdfsByOrder.set(orderNum, []);
        pdfsByOrder.get(orderNum)!.push({ file: `${entry}/${subEntry}`, fullPath });
      }
    }
  }

  console.log(`[amazon-link] Found PDFs for ${pdfsByOrder.size} order numbers`);

  // Match PDFs to DB documents
  for (const [orderNum, pdfs] of pdfsByOrder) {
    const docs = db.prepare(
      "SELECT document_id, total_amount_minor, filename FROM documents WHERE source_system = 'amazon' AND source_document_ref LIKE ?"
    ).all(`%${orderNum}%`) as any[];

    if (docs.length === 0) continue;

    if (pdfs.length === 1 && docs.length === 1) {
      // Simple: one PDF, one doc
      db.prepare('UPDATE documents SET filename = ? WHERE document_id = ?').run(pdfs[0].file, docs[0].document_id);
      matched++;
      details.push({ order_number: orderNum, pdf_file: pdfs[0].file, amount_minor: docs[0].total_amount_minor, doc_id: docs[0].document_id, status: 'single' });
    } else {
      // Multiple PDFs or docs → extract amounts from PDFs and match
      const pdfAmounts: Array<{ file: string; fullPath: string; amount: number | null }> = [];
      for (const pdf of pdfs) {
        const amount = await extractAmountFromPdf(pdf.fullPath);
        pdfAmounts.push({ ...pdf, amount });
      }

      const usedDocs = new Set<string>();
      for (const pa of pdfAmounts) {
        if (pa.amount == null) {
          unmatched++;
          details.push({ order_number: orderNum, pdf_file: pa.file, amount_minor: null, doc_id: null, status: 'unmatched' });
          continue;
        }

        const matchDoc = docs.find(d =>
          !usedDocs.has(d.document_id) && Math.abs(d.total_amount_minor) === pa.amount
        );

        if (matchDoc) {
          db.prepare('UPDATE documents SET filename = ? WHERE document_id = ?').run(pa.file, matchDoc.document_id);
          usedDocs.add(matchDoc.document_id);
          matched++;
          details.push({ order_number: orderNum, pdf_file: pa.file, amount_minor: pa.amount, doc_id: matchDoc.document_id, status: 'matched' });
        } else {
          unmatched++;
          details.push({ order_number: orderNum, pdf_file: pa.file, amount_minor: pa.amount, doc_id: null, status: 'unmatched' });
        }
      }

      // Single-PDF orders where amount extraction failed: link anyway
      for (const doc of docs) {
        if (!usedDocs.has(doc.document_id) && pdfs.length === 1) {
          db.prepare('UPDATE documents SET filename = ? WHERE document_id = ?').run(pdfs[0].file, doc.document_id);
          matched++;
        }
      }
    }
  }

  console.log(`[amazon-link] Matched: ${matched}, Unmatched: ${unmatched}`);
  return { matched, unmatched, details };
}
