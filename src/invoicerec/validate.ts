/**
 * Validation for extracted invoice fields.
 */
import type { ExtractedFields, ValidationResult, ValidationIssue } from './types.js';
import { getDb } from '../storage/db.js';

export function validateFields(fields: ExtractedFields): ValidationResult {
  const warnings: ValidationIssue[] = [];
  const errors: ValidationIssue[] = [];

  const warn = (code: string, message: string, field?: string) =>
    warnings.push({ code, message, field, severity: 'warning' });
  const err = (code: string, message: string, field?: string) =>
    errors.push({ code, message, field, severity: 'error' });

  // ---- Missing critical fields ----
  if (!fields.invoice_number) warn('MISSING_INVOICE_NUMBER', 'Rechnungsnummer nicht erkannt', 'invoice_number');
  if (fields.invoice_number?.startsWith('INT-')) warn('GENERATED_INVOICE_NUMBER', 'Interne Rechnungsnummer vergeben (keine erkannt)', 'invoice_number');
  if (!fields.invoice_date) warn('MISSING_DATE', 'Rechnungsdatum nicht erkannt', 'invoice_date');
  if (!fields.seller_name) warn('MISSING_SELLER', 'Verkäufer nicht erkannt', 'seller_name');
  if (fields.gross_amount_minor == null) err('MISSING_TOTAL', 'Gesamtbetrag nicht erkannt', 'gross_amount');

  const normalizedSeller = (fields.seller_name ?? '').trim().toLowerCase();
  const normalizedSellerVat = (fields.seller_vat_id ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (/^(?:firma\s+)?michael\s+Fictional$/.test(normalizedSeller)) {
    err('BUYER_AS_SELLER', 'Die eigene Firma wurde als Verkäufer erkannt', 'seller_name');
  }
  if (normalizedSellerVat === 'DEMO_INVALID_TAX_ID') {
    err('BUYER_VAT_AS_SELLER', 'Die eigene UID wurde als Verkäufer-UID erkannt', 'seller_vat_id');
  }
  if (fields.invoice_number && /\b20\d{2}[-./]\d{1,2}[-./]\d{1,2}\b/.test(fields.invoice_number)) {
    warn('DATE_AS_INVOICE_NUMBER', 'Die erkannte Rechnungsnummer enthält offenbar ein Datum', 'invoice_number');
  }
  for (const field of ['invoice_number', 'invoice_date', 'seller_name', 'gross_amount_minor']) {
    const conf = fields.confidence[field] ?? fields.confidence[field.replace(/_minor$/, '')];
    if (conf && conf.value < 0.75) {
      warn('LOW_FIELD_CONFIDENCE', `Niedrige Erkennungssicherheit für ${field}`, field);
    }
  }

  // ---- Netto must not exceed Brutto ----
  if (fields.net_amount_minor != null && fields.gross_amount_minor != null) {
    if (Math.abs(fields.net_amount_minor) > Math.abs(fields.gross_amount_minor)) {
      err('NET_EXCEEDS_GROSS', `Netto (${fields.net_amount_minor}) ist höher als Brutto (${fields.gross_amount_minor})`, 'net_amount');
    }
  }

  // ---- No tax rate → only gross is reliable ----
  if (fields.vat_rate == null && fields.gross_amount_minor != null) {
    if (fields.net_amount_minor != null || fields.vat_amount_minor != null) {
      warn('NO_TAX_RATE', 'Kein eindeutiger Steuersatz erkannt — nur Bruttobetrag wird verwendet', 'vat_rate');
    }
  }

  // ---- Date plausibility ----
  if (fields.invoice_date) {
    const d = new Date(fields.invoice_date);
    const now = new Date();
    if (isNaN(d.getTime())) {
      err('INVALID_DATE', `Ungültiges Datum: ${fields.invoice_date}`, 'invoice_date');
    } else {
      if (d > now) warn('FUTURE_DATE', 'Rechnungsdatum liegt in der Zukunft', 'invoice_date');
      if (d.getFullYear() < 2015) warn('OLD_DATE', 'Rechnungsdatum vor 2015', 'invoice_date');
    }
  }

  // ---- Arithmetic: net + vat = gross ----
  if (fields.net_amount_minor != null && fields.vat_amount_minor != null && fields.gross_amount_minor != null) {
    const computed = fields.net_amount_minor + fields.vat_amount_minor;
    const diff = Math.abs(computed - fields.gross_amount_minor);
    if (diff > 2) { // allow 2 cents rounding tolerance
      warn('ARITHMETIC_MISMATCH',
        `Netto (${fields.net_amount_minor}) + USt (${fields.vat_amount_minor}) = ${computed}, aber Brutto = ${fields.gross_amount_minor} (Diff: ${diff} Cent)`,
        'gross_amount');
    }
  }

  // ---- VAT rate plausibility ----
  if (fields.vat_rate != null) {
    if (fields.vat_rate < 0 || fields.vat_rate > 0.30) {
      warn('VAT_RATE_UNUSUAL', `Ungewöhnlicher USt-Satz: ${Math.round(fields.vat_rate * 100)}%`, 'vat_rate');
    }
  }

  // ---- VAT rate vs amounts consistency ----
  if (fields.vat_rate != null && fields.net_amount_minor != null && fields.vat_amount_minor != null) {
    const expectedVat = Math.round(fields.net_amount_minor * fields.vat_rate);
    const diff = Math.abs(expectedVat - fields.vat_amount_minor);
    if (diff > 5) {
      warn('VAT_CALC_MISMATCH',
        `USt ${Math.round(fields.vat_rate * 100)}% von Netto ${fields.net_amount_minor} = ${expectedVat}, aber USt-Betrag = ${fields.vat_amount_minor}`,
        'vat_amount');
    }
  }

  // ---- Currency consistency ----
  if (fields.currency_code && !['EUR', 'USD', 'CHF', 'GBP'].includes(fields.currency_code)) {
    warn('UNUSUAL_CURRENCY', `Ungewöhnliche Währung: ${fields.currency_code}`, 'currency_code');
  }

  // ---- Duplicate detection ----
  if (fields.invoice_number && fields.seller_name) {
    const db = getDb();
    const existing = db.prepare(`
      SELECT scan_id FROM invoice_extracted_fields
      WHERE invoice_number = ? AND seller_name = ? AND scan_id != ?
    `).get(fields.invoice_number, fields.seller_name, fields.scan_id) as any;

    if (existing) {
      warn('POSSIBLE_DUPLICATE',
        `Mögliches Duplikat: gleiche Rechnungsnummer + Verkäufer (Scan: ${existing.scan_id})`,
        'invoice_number');
    }

    // Also check existing documents table
    const existingDoc = db.prepare(`
      SELECT document_id FROM documents
      WHERE source_document_ref = ? AND supplier_name = ?
    `).get(fields.invoice_number, fields.seller_name) as any;

    if (existingDoc) {
      warn('DUPLICATE_IN_DB',
        `Rechnung existiert bereits in der Datenbank: ${existingDoc.document_id}`,
        'invoice_number');
    }
  }

  return { warnings, errors };
}
