/**
 * Google Cloud Billing portal adapter.
 *
 * Deterministic Puppeteer-based — no AI/LLM needed.
 *
 * Flow:
 *  1. Navigate to Google Cloud Console billing invoices page
 *  2. Wait for the payments.google.com iframe to load (documentcenter)
 *  3. Parse invoice table from the iframe (Issue date, Type, Number, Amount)
 *  4. Filter by date range, skip €0.00 invoices
 *  5. Create documents directly in DB (Cloud Console PDFs require complex checkbox+download)
 *
 * The invoice data is scraped from the embedded payments.google.com iframe inside
 * the Google Cloud Console billing page.
 */
import type {
  PortalConfig, PortalAdapter, SessionCheckResult,
  OpenclawRunResult, OpenclawFileResult, PortalType,
} from '../types.js';
import { connectBrowser, isBrowserReachable, launchVisibleBrowser } from '../openclaw-client.js';
import { BrowserConnectionError } from '../errors.js';
import type { Browser, Page, Frame } from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { getDb } from '../../storage/db.js';
import { documentId } from '../../core/ids.js';

const INVOICES_URL = 'https://console.cloud.google.com/billing';

interface GCloudInvoice {
  issueDate: string;     // "30 November 2025"
  docType: string;       // "Invoice"
  docNumber: string;     // "5435154086"
  amountStr: string;     // "€25.02"
  amountCents: number;   // 2502
  parsedDate: Date | null;
}

/** Parse "30 November 2025" to Date */
function parseGCloudDate(text: string): Date | null {
  const months: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const m = text.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (!m) return null;
  const month = months[m[2].toLowerCase()];
  if (month === undefined) return null;
  return new Date(parseInt(m[3]), month, parseInt(m[1]));
}

function isInRange(date: Date, start: string, end: string): boolean {
  return date >= new Date(start + 'T00:00:00') && date <= new Date(end + 'T23:59:59');
}

/** Find the payments.google.com documentcenter iframe */
async function findInvoiceFrame(page: Page): Promise<Frame | null> {
  const frames = page.frames();
  for (const frame of frames) {
    if (frame.url().includes('documentcenter')) return frame;
  }
  return null;
}

export class GoogleCloudAdapter implements PortalAdapter {
  readonly portalType: PortalType = 'google_cloud' as PortalType;

  async checkSession(portal: PortalConfig): Promise<SessionCheckResult> {
    const result: SessionCheckResult = {
      browserReachable: false, portalReachable: false,
      loggedIn: false, invoiceAreaAccessible: false,
      message: '', details: [],
    };

    result.browserReachable = await isBrowserReachable();
    if (!result.browserReachable) {
      result.message = 'Chrome nicht erreichbar.';
      return result;
    }

    let browser: Browser | null = null;
    try {
      browser = await connectBrowser();
      const pg = await browser.newPage();
      await pg.goto(INVOICES_URL, { waitUntil: 'networkidle2', timeout: 25_000 });
      await new Promise(r => setTimeout(r, 10_000));
      result.portalReachable = true;

      const frame = await findInvoiceFrame(pg);
      if (frame) {
        result.loggedIn = true;
        result.invoiceAreaAccessible = true;
        result.message = 'Verbunden mit Google Cloud Billing';
      } else {
        result.message = 'Google Cloud Billing nicht zugänglich — bitte einloggen';
        await launchVisibleBrowser();
      }
      await pg.close();
      return result;
    } catch (err: any) {
      result.message = `Fehler: ${err.message}`;
      return result;
    } finally {
      if (browser) browser.disconnect();
    }
  }

  async collectInvoices(
    portal: PortalConfig,
    dateRange: { start: string; end: string },
    downloadDir: string,
    onProgress?: (msg: string) => void,
  ): Promise<OpenclawRunResult> {
    const files: OpenclawFileResult[] = [];
    if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });

    let browser: Browser | null = null;
    try {
      browser = await connectBrowser();
      const page = await browser.newPage();

      onProgress?.('Verbindung hergestellt');
      onProgress?.('Öffne Google Cloud Billing...');
      await page.goto(INVOICES_URL, { waitUntil: 'networkidle2', timeout: 25_000 });
      await new Promise(r => setTimeout(r, 12_000));

      // Dismiss cookie banner
      await page.evaluate(`
        (() => {
          const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'OK, got it');
          if (b) b.click();
        })()
      `);
      await new Promise(r => setTimeout(r, 3000));

      // Find the invoice iframe
      const invoiceFrame = await findInvoiceFrame(page);
      if (!invoiceFrame) {
        await page.close();
        onProgress?.('Invoice-Frame nicht gefunden — Login erforderlich?');
        await launchVisibleBrowser();
        return { status: 'waiting_for_login', files: [], errorMessage: 'Google Cloud Billing nicht zugänglich' };
      }

      onProgress?.('Invoice-Tabelle gefunden');

      // Parse invoice table from the iframe
      const invoices = await invoiceFrame.evaluate(`
        (() => {
          var rows = [];
          var trs = document.querySelectorAll('tr');
          for (var i = 0; i < trs.length; i++) {
            var cells = Array.from(trs[i].querySelectorAll('td')).map(function(c){ return c.textContent.trim(); });
            if (cells.length >= 5) {
              // cells: [checkbox area, issue date, doc type, doc number, amount, ...]
              var dateText = cells[1] || '';
              var docType = cells[2] || '';
              var docNumber = cells[3] || '';
              var amountText = cells[4] || '';
              if (dateText.match(/\\d{4}/) && docNumber.match(/\\d{5,}/)) {
                rows.push({ issueDate: dateText, docType: docType, docNumber: docNumber, amountStr: amountText });
              }
            }
          }
          return rows;
        })()
      `) as Array<{ issueDate: string; docType: string; docNumber: string; amountStr: string }>;

      onProgress?.(`${invoices.length} Rechnungen in der Tabelle`);

      // Process invoices
      const db = getDb();
      const now = new Date().toISOString();
      let created = 0;

      for (const inv of invoices) {
        const date = parseGCloudDate(inv.issueDate);
        if (!date) continue;
        if (!isInRange(date, dateRange.start, dateRange.end)) continue;

        // Parse amount (€25.02 or €0.00)
        const amountMatch = inv.amountStr.match(/€([\d.,]+)/);
        if (!amountMatch) continue;
        const amountCents = Math.round(parseFloat(amountMatch[1].replace(',', '.')) * 100);
        if (amountCents === 0) continue; // Skip €0.00

        const dateKey = date.toISOString().slice(0, 10);
        const docId = documentId('google_cloud', inv.docNumber, dateKey);

        // Check if already exists
        const existing = db.prepare('SELECT document_id FROM documents WHERE document_id = ?').get(docId) as any;
        if (existing) {
          onProgress?.(`${inv.issueDate}: Invoice ${inv.docNumber} bereits vorhanden`);
          continue;
        }

        // Create document
        const meta = JSON.stringify({
          google_invoice_number: inv.docNumber,
          document_type: inv.docType,
          source_url: INVOICES_URL,
        });
        db.prepare(`
          INSERT INTO documents (document_id, source_system, source_document_ref, captured_at,
            document_date, total_amount_minor, currency_code, supplier_name, filename, meta)
          VALUES (?, 'google_cloud', ?, ?, ?, ?, 'EUR', 'Google Cloud', ?, ?)
        `).run(docId, inv.docNumber, now, dateKey, -amountCents, `GCloud-${inv.docNumber}`, meta);

        created++;
        onProgress?.(`${inv.issueDate}: Invoice ${inv.docNumber}, ${inv.amountStr} — Dokument erstellt`);

        // Save text receipt
        const filename = `GoogleCloud-${dateKey}-${inv.docNumber}.txt`;
        const filePath = path.join(downloadDir, filename);
        writeFileSync(filePath, [
          `Google Cloud Invoice`,
          `Invoice Number: ${inv.docNumber}`,
          `Date: ${dateKey}`,
          `Amount: ${inv.amountStr}`,
          `Type: ${inv.docType}`,
          `Source: ${INVOICES_URL}`,
        ].join('\n'), 'utf-8');
        files.push({ filename, localPath: filePath, invoiceDate: dateKey, supplierHint: 'Google Cloud' });
      }

      await page.close();
      onProgress?.(`${created} neue Dokument(e) erstellt`);
      onProgress?.(`Sammlung abgeschlossen: ${files.length} Datei(en)`);
      return { status: 'completed', files };

    } catch (err: any) {
      if (err.message?.includes('Chrome nicht erreichbar')) throw new BrowserConnectionError(err.message);
      return { status: files.length > 0 ? 'partial' : 'failed', files, errorMessage: err.message };
    } finally {
      if (browser) browser.disconnect();
    }
  }
}
