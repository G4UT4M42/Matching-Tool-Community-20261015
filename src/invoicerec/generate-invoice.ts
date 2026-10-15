/**
 * Generate outgoing invoices (Ausgangsrechnungen) as PDF.
 *
 * Used for Google Play app revenue where we need to issue
 * a Reverse Charge invoice to Google Ireland Limited.
 */
import PDFDocument from 'pdfkit';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { getDb } from '../storage/db.js';

export interface InvoiceData {
  invoiceNumber: string;   // e.g. "AR/2025/GPlay001"
  invoiceDate: string;     // YYYY-MM-DD
  period: string;          // e.g. "November 2025"

  // Issuer
  issuerName: string;
  issuerAddress: string;
  issuerVatId: string;

  // Recipient
  recipientName: string;
  recipientAddress: string;
  recipientVatId: string;

  // Line items
  items: Array<{
    description: string;
    amount: number;  // in EUR (decimal)
  }>;

  // Totals
  netTotal: number;       // EUR decimal
  vatRate: number;        // 0 for reverse charge
  vatAmount: number;      // EUR decimal
  grossTotal: number;     // EUR decimal

  // Legal notes
  legalNotes: string[];
}

const GOOGLE_PLAY_DEFAULTS: Partial<InvoiceData> = {
  issuerName: 'Fictional Business Demo',
  issuerAddress: 'Mittermühlweg 12/8, 8073 Feldkirchen bei Graz, Austria',
  issuerVatId: 'DEMO_INVALID_TAX_ID',
  recipientName: 'Google Ireland Limited',
  recipientAddress: 'Gordon House, Barrow Street, Dublin 4, Ireland',
  recipientVatId: 'IE6388047V',
  vatRate: 0,
  vatAmount: 0,
  legalNotes: [
    'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge).',
    'Innergemeinschaftliche sonstige Leistung gemäß § 3a Abs. 6 UStG.',
    'Die Umsatzsteuer ist vom Empfänger in Irland abzuführen.',
  ],
};

/** Format EUR amount */
function fmtEur(n: number): string {
  return n.toFixed(2).replace('.', ',') + ' €';
}

/** Get the next sequential invoice number for Google Play */
export function getNextGPlayInvoiceNumber(year: number): string {
  const db = getDb();
  const prefix = `AR/${year}/GPlay`;
  const existing = db.prepare(
    "SELECT source_document_ref FROM documents WHERE source_document_ref LIKE ? ORDER BY source_document_ref DESC LIMIT 1"
  ).get(`${prefix}%`) as { source_document_ref: string } | undefined;

  let seq = 1;
  if (existing) {
    const match = existing.source_document_ref.match(/GPlay(\d+)$/);
    if (match) seq = parseInt(match[1]) + 1;
  }
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

/**
 * Generate a Google Play revenue invoice PDF.
 * Returns the PDF buffer.
 */
export async function generateGooglePlayInvoice(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);

  const pageWidth = doc.page.width - 100; // margins

  // --- Header ---
  doc.fontSize(20).font('Helvetica-Bold').text('RECHNUNG', { align: 'right' });
  doc.moveDown(0.5);

  // Invoice meta (right-aligned)
  doc.fontSize(10).font('Helvetica');
  const metaX = 350;
  const metaY = doc.y;
  doc.text(`Rechnungsnummer: ${data.invoiceNumber}`, metaX, metaY);
  doc.text(`Rechnungsdatum: ${formatDateDE(data.invoiceDate)}`, metaX);
  doc.text(`Leistungszeitraum: ${data.period}`, metaX);

  // Issuer (left side)
  doc.fontSize(10).font('Helvetica-Bold').text(data.issuerName, 50, metaY);
  doc.font('Helvetica').text(data.issuerAddress);
  doc.text(`UID-Nr.: ${data.issuerVatId}`);
  doc.moveDown(1.5);

  // Recipient
  doc.font('Helvetica').fontSize(9).fillColor('#666').text('Rechnungsempfänger:', 50);
  doc.fillColor('#000').fontSize(10).font('Helvetica-Bold').text(data.recipientName);
  doc.font('Helvetica').text(data.recipientAddress);
  doc.text(`VAT ID: ${data.recipientVatId}`);
  doc.moveDown(2);

  // --- Line items table ---
  const tableTop = doc.y;
  const col1 = 50;
  const col2 = 420;

  // Header row
  doc.font('Helvetica-Bold').fontSize(10);
  doc.rect(col1 - 5, tableTop - 3, pageWidth + 10, 20).fill('#f0f0f0');
  doc.fillColor('#000');
  doc.text('Beschreibung', col1, tableTop, { width: 350 });
  doc.text('Betrag', col2, tableTop, { width: 100, align: 'right' });
  doc.moveDown(0.8);

  // Items
  doc.font('Helvetica').fontSize(10);
  for (const item of data.items) {
    const y = doc.y;
    doc.text(item.description, col1, y, { width: 350 });
    doc.text(fmtEur(item.amount), col2, y, { width: 100, align: 'right' });
    doc.moveDown(0.3);
  }

  // Separator
  doc.moveDown(0.5);
  doc.moveTo(col1, doc.y).lineTo(col1 + pageWidth, doc.y).stroke('#ccc');
  doc.moveDown(0.5);

  // Totals
  const totY = doc.y;
  doc.font('Helvetica').text('Nettobetrag:', col1 + 250, totY);
  doc.text(fmtEur(data.netTotal), col2, totY, { width: 100, align: 'right' });
  doc.moveDown(0.3);

  doc.text(`Umsatzsteuer (${data.vatRate}%):`, col1 + 250);
  doc.text(fmtEur(data.vatAmount), col2, doc.y - 12, { width: 100, align: 'right' });
  doc.moveDown(0.3);

  doc.moveTo(col1 + 250, doc.y).lineTo(col1 + pageWidth, doc.y).stroke('#000');
  doc.moveDown(0.3);

  doc.font('Helvetica-Bold').fontSize(12);
  doc.text('Gesamt:', col1 + 250);
  doc.text(fmtEur(data.grossTotal), col2, doc.y - 14, { width: 100, align: 'right' });

  // --- Legal notes ---
  doc.moveDown(3);
  doc.font('Helvetica').fontSize(8).fillColor('#555');
  doc.text('Hinweis: Google agiert als Merchant of Record. Die Umsatzsteuer für Endkunden wurde von Google einbehalten und abgeführt.', col1, undefined, { width: pageWidth });
  doc.moveDown(0.5);
  doc.text(data.legalNotes.join(' '), col1, undefined, { width: pageWidth });

  // --- Footer (absolute position, enough space for 3 lines) ---
  const footerY = doc.page.height - 100;
  doc.moveTo(50, footerY).lineTo(50 + pageWidth, footerY).stroke('#ccc');
  doc.fontSize(8).fillColor('#888');
  doc.text(`UID-Nummer Österreich: ${data.issuerVatId}  |  UID-Nummer Empfänger (Irland): ${data.recipientVatId}`, 50, footerY + 8, { width: pageWidth });
  doc.text('Ausfuhrlieferungen in das EU Ausland sind von der österreichischen Umsatzsteuer befreit.', 50, undefined, { width: pageWidth });

  doc.end();
  }); // end Promise
}

// ---------------------------------------------------------------------------
// Eigenbeleg (self-created receipt for transactions without invoice)
// ---------------------------------------------------------------------------

export interface EigenbelegData {
  date: string;          // YYYY-MM-DD
  amount: number;        // EUR decimal (positive = expense amount)
  isRefund: boolean;
  vendor: string;
  country: string;       // ISO 2-letter
  description: string;   // e.g. "Google One Teilerstattung"
  transactionRef: string; // e.g. source_system + description
  provisional?: boolean; // true = temporary, needs real receipt later
}

function getNextEigenbelegNumber(year: number): string {
  const db = getDb();
  const prefix = `EB/${year}/`;
  const existing = db.prepare(
    "SELECT source_document_ref FROM documents WHERE source_document_ref LIKE ? ORDER BY source_document_ref DESC LIMIT 1"
  ).get(`${prefix}%`) as { source_document_ref: string } | undefined;

  let seq = 1;
  if (existing) {
    const match = existing.source_document_ref.match(/(\d+)$/);
    if (match) seq = parseInt(match[1]) + 1;
  }
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

export async function generateEigenbeleg(data: EigenbelegData): Promise<{ buffer: Buffer; number: string }> {
  const year = parseInt(data.date.slice(0, 4));
  const number = getNextEigenbelegNumber(year);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), number }));
    doc.on('error', reject);

    const pageWidth = doc.page.width - 100;

    // Header
    doc.fontSize(22).font('Helvetica-Bold').text('EIGENBELEG', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#666').text(
      'Ersatzbeleg gemäß § 132 BAO — kein Originalbeleg vorhanden', { align: 'center' }
    );
    if (data.provisional) {
      doc.moveDown(0.3);
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#c0392b').text(
        'PROVISORISCH — Rechnung muss nachgereicht werden', { align: 'center' }
      );
    }
    doc.moveDown(1.5);

    // Meta
    doc.fillColor('#000').fontSize(11).font('Helvetica');
    const col1 = 50;
    const col2 = 200;

    const row = (label: string, value: string) => {
      const y = doc.y;
      doc.font('Helvetica-Bold').text(label, col1, y, { width: 140 });
      doc.font('Helvetica').text(value, col2, y);
      doc.moveDown(0.4);
    };

    row('Belegnummer:', number);
    row('Datum:', formatDateDE(data.date));
    row('Art:', data.isRefund ? 'Gutschrift / Erstattung' : 'Ausgabe');
    row('Betrag:', fmtEur(data.amount));
    row('Empfänger / Vendor:', data.vendor);
    row('Land:', data.country);
    doc.moveDown(0.5);
    row('Beschreibung:', data.description);
    if (data.transactionRef) {
      row('Buchungsreferenz:', data.transactionRef);
    }

    doc.moveDown(1.5);

    // Reason box
    const boxY = doc.y;
    doc.rect(col1, boxY, pageWidth, 55).fill('#f8f8f8');
    doc.fillColor('#333').fontSize(9);
    doc.text(
      'Dieser Eigenbeleg wurde erstellt, da für die oben genannte Transaktion kein Originalbeleg ' +
      '(Rechnung, Quittung) vom Lieferanten vorliegt. Der Geschäftsvorfall ist durch die ' +
      'Bankbuchung / Kreditkartenabrechnung nachweisbar.',
      col1 + 10, boxY + 8, { width: pageWidth - 20 }
    );

    doc.y = boxY + 65;
    doc.moveDown(2);

    // Signature line
    doc.moveTo(col1, doc.y).lineTo(col1 + 200, doc.y).stroke('#999');
    doc.fontSize(9).fillColor('#666').text('Datum, Unterschrift', col1, doc.y + 4);

    // Footer
    doc.fontSize(8).fillColor('#888');
    doc.text('Fictional Business Demo  |  Mittermühlweg 12/8, 8073 Feldkirchen bei Graz  |  DEMO_INVALID_TAX_ID',
      50, doc.page.height - 60, { width: pageWidth, align: 'center' });

    doc.end();
  });
}

export async function createEigenbeleg(data: EigenbelegData): Promise<{
  eigenbelegNumber: string; filePath: string; documentId: string;
}> {
  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}/.test(data.date)) {
    throw new Error(`Ungültiges Datum: ${data.date} (erwartet YYYY-MM-DD)`);
  }
  const { buffer, number } = await generateEigenbeleg(data);
  const year = parseInt(data.date.slice(0, 4));

  // Save PDF
  const dir = path.resolve(`Belege/${year}/Rechnungen`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filename = `${number.replace(/\//g, '-')}.pdf`;
  const filePath = path.join(dir, filename);
  const { writeFileSync } = await import('fs');
  writeFileSync(filePath, buffer);

  // Create Document in DB
  const db = getDb();
  const { documentId } = await import('../core/ids.js');
  const docId = documentId('invoice_scan', `eigenbeleg-${number.replace(/\//g, '-')}`);
  const now = new Date().toISOString();
  const amountMinor = data.isRefund ? Math.round(data.amount * 100) : -Math.round(data.amount * 100);

  const meta = JSON.stringify({
    type: data.provisional ? 'provisional' : 'eigenbeleg',
    eigenbeleg_number: number,
    invoice_country: data.country,
    seller_country: data.country,
    is_refund: data.isRefund,
    transaction_ref: data.transactionRef,
    needs_receipt: !!data.provisional,
  });

  db.prepare(`
    INSERT OR REPLACE INTO documents (document_id, source_system, source_document_ref, captured_at,
      document_date, total_amount_minor, currency_code, supplier_name, vat_amount_minor, vat_rate, filename, meta)
    VALUES (?, 'invoice_scan', ?, ?, ?, ?, 'EUR', ?, 0, 0, ?, ?)
  `).run(docId, number, now, data.date, amountMinor, data.vendor, filename, meta);

  return { eigenbelegNumber: number, filePath, documentId: docId };
}

/**
 * Create a Google Play invoice for a specific amount/period.
 * Generates the PDF, stores it in Belege, and creates a Document record.
 */
export async function createGooglePlayInvoice(
  amount: number,  // EUR decimal (positive)
  period: string,  // e.g. "November 2025"
  invoiceDate: string,  // YYYY-MM-DD
): Promise<{ invoiceNumber: string; filePath: string; documentId: string }> {
  const year = parseInt(invoiceDate.slice(0, 4));
  const invoiceNumber = getNextGPlayInvoiceNumber(year);

  const data: InvoiceData = {
    ...GOOGLE_PLAY_DEFAULTS as InvoiceData,
    invoiceNumber,
    invoiceDate,
    period,
    items: [{
      description: `Bereitstellung digitaler Inhalte (App-Umsätze) über den Google Play Store.\nZeitraum: ${period}`,
      amount,
    }],
    netTotal: amount,
    vatRate: 0,
    vatAmount: 0,
    grossTotal: amount,
  };

  const pdfBuffer = await generateGooglePlayInvoice(data);

  // Save PDF
  const dir = path.resolve(`Belege/${year}/Einkuenfte`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filename = `${invoiceNumber.replace(/\//g, '-')}.pdf`;
  const filePath = path.join(dir, filename);
  const { writeFileSync } = await import('fs');
  writeFileSync(filePath, pdfBuffer);

  // Create Document record in DB
  const db = getDb();
  const docId = `DOC-GPLAY-${invoiceNumber.replace(/\//g, '-')}`;
  const now = new Date().toISOString();
  const meta = JSON.stringify({
    type: 'outgoing_invoice',
    vendor: 'google_play',
    period,
    reverse_charge: true,
    recipient_vat_id: GOOGLE_PLAY_DEFAULTS.recipientVatId,
    land: 'IE',
  });

  db.prepare(`
    INSERT OR REPLACE INTO documents (document_id, source_system, source_document_ref, captured_at,
      document_date, total_amount_minor, currency_code, supplier_name, vat_amount_minor, vat_rate, filename, meta)
    VALUES (?, 'income', ?, ?, ?, ?, 'EUR', 'Google Ireland Limited', 0, 0, ?, ?)
  `).run(docId, invoiceNumber, now, invoiceDate, Math.round(amount * 100), filename, meta);

  return { invoiceNumber, filePath, documentId: docId };
}

function formatDateDE(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}
