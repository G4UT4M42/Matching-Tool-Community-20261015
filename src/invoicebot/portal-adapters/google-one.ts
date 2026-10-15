/**
 * Google One / Google Play portal adapter.
 *
 * Deterministic Puppeteer-based — no AI/LLM needed.
 *
 * Google One subscriptions are billed through Google Play.
 * This adapter scrapes the Play Store order history page.
 *
 * Flow:
 *  1. Navigate to https://play.google.com/store/account/orderhistory
 *  2. Parse order list (product name, date, amount)
 *  3. Filter for Google One / Google AI Pro orders in the date range
 *  4. Create documents directly in DB
 *
 * Note: Google Play does not provide downloadable PDF invoices.
 * VAT invoices are only available per individual transaction via payments.google.com,
 * which requires manual per-transaction interaction.
 */
import type {
  PortalConfig, PortalAdapter, SessionCheckResult,
  OpenclawRunResult, OpenclawFileResult, PortalType,
} from '../types.js';
import { connectBrowser, isBrowserReachable, launchVisibleBrowser } from '../openclaw-client.js';
import { BrowserConnectionError } from '../errors.js';
import type { Browser, Page } from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { getDb } from '../../storage/db.js';
import { documentId } from '../../core/ids.js';

const ORDER_HISTORY_URL = 'https://play.google.com/store/account/orderhistory';

interface PlayOrder {
  product: string;   // "Google AI Pro (5 TB)"
  date: string;      // "20 Mar 2026"
  amountStr: string; // "€ 21,99"
  amountCents: number;
  parsedDate: Date | null;
  isRefund: boolean;
}

/** Parse "20 Mar 2026" or "22 Dec 2025" to Date */
function parsePlayDate(text: string): Date | null {
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const m = text.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (!m) return null;
  const month = months[m[2].toLowerCase()];
  if (month === undefined) return null;
  return new Date(parseInt(m[3]), month, parseInt(m[1]));
}

/** Parse "€ 21,99" or "€ 99,99" to cents */
function parsePlayAmount(text: string): number {
  const m = text.match(/€\s*([\d.,]+)/);
  if (!m) return 0;
  // German format: 21,99 → 21.99
  const normalized = m[1].replace(/\./g, '').replace(',', '.');
  return Math.round(parseFloat(normalized) * 100);
}

function isInRange(date: Date, start: string, end: string): boolean {
  return date >= new Date(start + 'T00:00:00') && date <= new Date(end + 'T23:59:59');
}

export class GoogleOneAdapter implements PortalAdapter {
  readonly portalType: PortalType = 'google_one' as PortalType;

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
      await pg.goto(ORDER_HISTORY_URL, { waitUntil: 'networkidle2', timeout: 20_000 });
      await new Promise(r => setTimeout(r, 5000));
      result.portalReachable = true;

      const hasOrders = await pg.evaluate(`
        (() => { return document.body.innerText.includes('Order history'); })()
      `) as boolean;

      if (hasOrders) {
        result.loggedIn = true;
        result.invoiceAreaAccessible = true;
        result.message = 'Verbunden mit Google Play — Order History zugänglich';
      } else {
        result.message = 'Google Play nicht zugänglich — bitte einloggen';
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
      onProgress?.('Öffne Google Play Order History...');
      await page.goto(ORDER_HISTORY_URL, { waitUntil: 'networkidle2', timeout: 20_000 });
      await new Promise(r => setTimeout(r, 5000));

      const hasOrders = await page.evaluate(`
        (() => { return document.body.innerText.includes('Order history'); })()
      `) as boolean;
      if (!hasOrders) {
        await page.close();
        await launchVisibleBrowser();
        return { status: 'waiting_for_login', files: [], errorMessage: 'Google Play nicht zugänglich' };
      }

      // Parse order list from page text
      onProgress?.('Lese Bestellungen...');
      const orders = await this.parseOrders(page);
      // Convert parsedDate from ISO string (from evaluate) to Date objects
      for (const o of orders) {
        if (typeof o.parsedDate === 'string') o.parsedDate = new Date(o.parsedDate);
      }
      onProgress?.(`${orders.length} Bestellungen gefunden`);

      // Filter: Google One / AI Pro / storage subscriptions, in date range
      const matching = orders.filter(o => {
        if (!o.parsedDate) return false;
        if (!isInRange(o.parsedDate as Date, dateRange.start, dateRange.end)) return false;
        if (o.amountCents === 0) return false;
        const prod = o.product.toLowerCase();
        return prod.includes('google') || prod.includes('ai pro') || prod.includes(' tb') || prod.includes('storage');
      });

      onProgress?.(`${matching.length} Google One Bestellungen im Zeitraum`);

      if (matching.length === 0) {
        await page.close();
        return { status: 'completed', files: [] };
      }

      // Create documents in DB
      const db = getDb();
      const now = new Date().toISOString();

      for (const order of matching) {
        const dateKey = order.parsedDate!.toISOString().slice(0, 10);
        const ref = `GPLAY-${dateKey}-${order.amountCents}`;
        const docId = documentId('google_one', ref, dateKey);

        const existing = db.prepare('SELECT document_id FROM documents WHERE document_id = ?').get(docId) as any;
        if (existing) {
          onProgress?.(`${dateKey}: ${order.product} bereits vorhanden`);
          continue;
        }

        // "Refunded" is the status of the original order in Google Play, not a
        // separate credit-note row. Keep the purchase document negative; an actual
        // card credit is imported and reconciled separately when it posts.
        const amountSigned = -order.amountCents;
        const supplierName = 'Google One';
        const meta = JSON.stringify({
          product: order.product,
          source_url: ORDER_HISTORY_URL,
          is_refund: false,
          order_status: order.isRefund ? 'refunded' : 'completed',
        });

        db.prepare(`
          INSERT INTO documents (document_id, source_system, source_document_ref, captured_at,
            document_date, total_amount_minor, currency_code, supplier_name, filename, meta)
          VALUES (?, 'google_one', ?, ?, ?, ?, 'EUR', ?, ?, ?)
        `).run(docId, ref, now, dateKey, amountSigned, supplierName, `GoogleOne-${dateKey}`, meta);

        onProgress?.(`${dateKey}: ${order.product} ${order.amountStr}${order.isRefund ? ' (status: refunded)' : ''} — Dokument erstellt`);

        const filename = `GoogleOne-${dateKey}-${order.amountCents}.txt`;
        const filePath = path.join(downloadDir, filename);
        writeFileSync(filePath, [
          `Google One / Google Play Receipt`,
          `Product: ${order.product}`,
          `Date: ${dateKey}`,
          `Amount: ${order.amountStr}`,
          `Order status: ${order.isRefund ? 'Refunded' : 'Completed'}`,
          `Source: ${ORDER_HISTORY_URL}`,
        ].join('\n'), 'utf-8');
        files.push({ filename, localPath: filePath, invoiceDate: dateKey, supplierHint: 'Google One' });
      }

      await page.close();
      onProgress?.(`Sammlung abgeschlossen: ${files.length} Datei(en)`);
      return { status: 'completed', files };

    } catch (err: any) {
      if (err.message?.includes('Chrome nicht erreichbar')) throw new BrowserConnectionError(err.message);
      return { status: files.length > 0 ? 'partial' : 'failed', files, errorMessage: err.message };
    } finally {
      if (browser) browser.disconnect();
    }
  }

  /** Parse Google Play order history from page text */
  private async parseOrders(page: Page): Promise<PlayOrder[]> {
    return await page.evaluate(`
      (() => {
        var text = document.body.innerText;
        var results = [];
        var lines = text.split('\\n').map(function(l){ return l.trim(); }).filter(function(l){ return l.length > 0; });

        for (var i = 0; i < lines.length; i++) {
          // Pattern: product name line, then date line, then amount line
          var dateLine = lines[i];
          var dateMatch = dateLine.match(/^(\\d{1,2})\\s+(\\w{3})\\s+(\\d{4})$/);
          if (!dateMatch) continue;

          // Product name is the line before the date.
          // Special case: if line before date is 'Refunded', the product is 2 lines before.
          var product = '';
          var isRefund = false;
          if (i > 0 && lines[i-1] === 'Refunded') {
            isRefund = true;
            product = (i > 1) ? lines[i-2] : '';
          } else {
            product = (i > 0) ? lines[i-1] : '';
          }
          // Amount is the line after the date
          var amountLine = '';
          for (var j = i+1; j < Math.min(i+3, lines.length); j++) {
            if (lines[j] === 'Refunded') { isRefund = true; continue; }
            if (lines[j].match(/^[€$]/)) { amountLine = lines[j]; break; }
          }

          if (product && amountLine) {
            var amountMatch = amountLine.match(/[€$]\\s*([\\d.,]+)/);
            var cents = 0;
            if (amountMatch) {
              cents = Math.round(parseFloat(amountMatch[1].replace(/\\./g,'').replace(',','.')) * 100);
            }

            var months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
            var mo = months[dateMatch[2].toLowerCase()];
            var parsedDate = (mo !== undefined) ? new Date(parseInt(dateMatch[3]), mo, parseInt(dateMatch[1])).toISOString() : null;

            results.push({
              product: product,
              date: dateLine,
              amountStr: amountLine,
              amountCents: cents,
              parsedDate: parsedDate,
              isRefund: isRefund,
            });
          }
        }
        return results;
      })()
    `) as PlayOrder[];
  }
}
