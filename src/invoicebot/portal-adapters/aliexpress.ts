/**
 * AliExpress portal adapter.
 *
 * Deterministic Puppeteer-based — no AI/LLM needed.
 *
 * AliExpress does NOT provide downloadable invoice PDFs for regular orders.
 * Instead, this adapter:
 *  1. Navigates to the order list page
 *  2. Paginates through all pages (Next button)
 *  3. Parses order data: date, order ID, total amount, status
 *  4. Filters by requested date range, skips cancelled orders
 *  5. Groups orders by date (multiple orders may be paid as one Visa charge)
 *  6. Takes a screenshot of each order as receipt evidence
 *  7. Returns the screenshots + structured order data as files
 *
 * The collection-service then imports these through the invoicerec pipeline,
 * and the matching engine matches them against Visa/bank transactions.
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

const ORDERS_URL = 'https://www.aliexpress.com/p/order/index.html';

interface AliOrder {
  status: string;
  date: string;       // e.g. "Feb 10, 2026"
  orderId: string;
  totalEur: number;    // in cents
  totalStr: string;    // original string e.g. "11.18"
  parsedDate: Date | null;
}

/** Parse AliExpress date format: "Feb 10, 2026" or "Nov 2, 2025" */
function parseAliDate(text: string): Date | null {
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const m = text.match(/(\w{3})\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const month = months[m[1].toLowerCase()];
  if (month === undefined) return null;
  return new Date(parseInt(m[3]), month, parseInt(m[2]));
}

function isInRange(date: Date, start: string, end: string): boolean {
  return date >= new Date(start + 'T00:00:00') && date <= new Date(end + 'T23:59:59');
}

/** Parse EUR amount string like "111.70" to cents */
function eurToCents(s: string): number {
  return Math.round(parseFloat(s.replace(',', '.')) * 100);
}

export class AliExpressAdapter implements PortalAdapter {
  readonly portalType: PortalType = 'aliexpress' as PortalType;

  async checkSession(portal: PortalConfig): Promise<SessionCheckResult> {
    const result: SessionCheckResult = {
      browserReachable: false, portalReachable: false,
      loggedIn: false, invoiceAreaAccessible: false,
      message: '', details: [],
    };

    result.browserReachable = await isBrowserReachable();
    if (!result.browserReachable) {
      result.message = 'Chrome nicht erreichbar. Bitte Bot-Browser starten.';
      return result;
    }

    let browser: Browser | null = null;
    try {
      browser = await connectBrowser();
      const pages = await browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();

      await page.goto(ORDERS_URL, { waitUntil: 'networkidle2', timeout: 15_000 });
      await new Promise(r => setTimeout(r, 3000));
      result.portalReachable = true;

      if (page.url().includes('login')) {
        result.message = 'Nicht eingeloggt bei AliExpress. Bitte im Bot-Browser einloggen.';
        await launchVisibleBrowser();
        return result;
      }

      result.loggedIn = true;
      result.invoiceAreaAccessible = true;
      result.message = 'Verbunden mit AliExpress — bereit für Bestellungserfassung';
      return result;
    } catch (err: any) {
      result.message = `Session-Prüfung fehlgeschlagen: ${err.message}`;
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
      // Always create a new page for AliExpress (existing pages may have stale state)
      const page = await browser.newPage();

      onProgress?.('Verbindung hergestellt');

      // Navigate to orders page
      onProgress?.('Öffne AliExpress Bestellungen...');
      await page.goto(ORDERS_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
      await new Promise(r => setTimeout(r, 5000));

      if (page.url().includes('login')) {
        await launchVisibleBrowser();
        onProgress?.('Login erforderlich');
        return { status: 'waiting_for_login', files: [], errorMessage: 'Login erforderlich' };
      }

      // Load all orders by clicking "View orders" button repeatedly
      const allOrders: AliOrder[] = [];
      const seenOrderIds = new Set<string>();
      const startDate = new Date(dateRange.start + 'T00:00:00');

      for (let click = 0; click < 20; click++) {
        const pageOrders = await this.parseOrdersOnPage(page);

        let newCount = 0;
        for (const o of pageOrders) {
          // parsedDate comes as ISO string from evaluate, convert to Date
          if (typeof o.parsedDate === 'string') o.parsedDate = new Date(o.parsedDate);
          if (!seenOrderIds.has(o.orderId)) {
            seenOrderIds.add(o.orderId);
            allOrders.push(o);
            newCount++;
          }
        }

        if (click === 0 || newCount > 0) {
          onProgress?.(`${allOrders.length} Bestellungen geladen...`);
        }

        // Check if we've passed our date range
        const oldestVisible = pageOrders
          .map(o => o.parsedDate).filter((d): d is Date => d !== null)
          .sort((a, b) => a.getTime() - b.getTime())[0];
        if (oldestVisible && oldestVisible < startDate) {
          onProgress?.('Alle relevanten Bestellungen erfasst');
          break;
        }

        // Click "View orders" button to load more
        const hasMore = await page.evaluate(`
          (() => {
            const btn = document.querySelector('.order-more button');
            if (!btn) return false;
            btn.scrollIntoView({block:'center'});
            return true;
          })()
        `) as boolean;

        if (!hasMore) {
          onProgress?.('Keine weiteren Bestellungen');
          break;
        }

        await new Promise(r => setTimeout(r, 1000));
        const rect = await page.evaluate(`
          (() => {
            const btn = document.querySelector('.order-more button');
            if (!btn) return null;
            const r = btn.getBoundingClientRect();
            return {x: r.x + r.width/2, y: r.y + r.height/2};
          })()
        `) as { x: number; y: number } | null;

        if (!rect) { onProgress?.('View-orders Button nicht klickbar'); break; }
        await page.mouse.click(rect.x, rect.y);
        onProgress?.('Lade weitere Bestellungen...');
        await new Promise(r => setTimeout(r, 6000));
      }

      onProgress?.(`${allOrders.length} Bestellungen insgesamt erfasst`);

      // Filter by date range — include cancelled orders (payment still went through)
      const matching = allOrders.filter(o => {
        if (!o.parsedDate) return false;
        return isInRange(o.parsedDate, dateRange.start, dateRange.end);
      });
      const cancelled = matching.filter(o => o.status === 'Canceled' || o.status === 'Cancelled');

      onProgress?.(`${matching.length} Bestellungen im Zeitraum ${dateRange.start} bis ${dateRange.end}`);

      if (matching.length === 0) {
        return { status: 'completed', files: [] };
      }

      // Create documents directly in DB (AliExpress has no downloadable PDFs)
      const db = getDb();
      const now = new Date().toISOString();

      for (const order of matching) {
        const dateKey = order.parsedDate!.toISOString().slice(0, 10);
        const docId = documentId('aliexpress', order.orderId, dateKey);

        // Check if already exists
        const existing = db.prepare('SELECT document_id FROM documents WHERE document_id = ?').get(docId) as any;
        if (existing) {
          onProgress?.(`${dateKey}: Bestellung ${order.orderId} bereits vorhanden, übersprungen`);
          continue;
        }

        // Insert document
        const meta = JSON.stringify({
          aliexpress_order_id: order.orderId,
          order_url: `https://www.aliexpress.com/p/order/detail.html?orderId=${order.orderId}`,
          order_status: order.status,
        });
        db.prepare(`
          INSERT INTO documents (document_id, source_system, source_document_ref, captured_at,
            document_date, total_amount_minor, currency_code, supplier_name, filename, meta)
          VALUES (?, 'aliexpress', ?, ?, ?, ?, 'EUR', 'AliExpress', ?, ?)
        `).run(docId, order.orderId, now, dateKey, -Math.abs(order.totalEur), `AliExpress-${order.orderId}`, meta);

        onProgress?.(`${dateKey}: Bestellung ${order.orderId}, EUR ${order.totalStr} — Dokument erstellt`);

        // Also save a text receipt as backup file
        const filename = `AliExpress-${dateKey}-${order.orderId}.txt`;
        const filePath = path.join(downloadDir, filename);
        writeFileSync(filePath, [
          `AliExpress Bestellbeleg`,
          `Bestellung: ${order.orderId}`,
          `Datum: ${dateKey}`,
          `Betrag: EUR ${order.totalStr}`,
          `Status: ${order.status}`,
          `Quelle: https://www.aliexpress.com/p/order/detail.html?orderId=${order.orderId}`,
        ].join('\n'), 'utf-8');

        files.push({
          filename,
          localPath: filePath,
          invoiceDate: dateKey,
          supplierHint: 'AliExpress',
        });
      }

      // Phase 2: Check order detail pages for refunds
      // Only check orders within date range — for each, open detail page and look for
      // "Refund completed €XX.XX" text. Create a refund document if found.
      onProgress?.('Prüfe Bestellungen auf Rückerstattungen...');
      let refundCount = 0;
      for (const order of matching) {
        const dateKey = order.parsedDate!.toISOString().slice(0, 10);
        const refundDocId = documentId('aliexpress', `REFUND-${order.orderId}`, dateKey);

        // Skip if refund doc already exists
        const existingRefund = db.prepare('SELECT document_id FROM documents WHERE document_id = ?').get(refundDocId) as any;
        if (existingRefund) continue;

        // Open order detail page
        await page.goto(
          `https://www.aliexpress.com/p/order/detail.html?orderId=${order.orderId}`,
          { waitUntil: 'networkidle2', timeout: 15_000 },
        );
        await new Promise(r => setTimeout(r, 3000));

        // Check for "Refund complete(d), Refund amount: €XX.XX" text
        const refundInfo = await page.evaluate(`
          (() => {
            var body = document.body.innerText;
            var m = body.match(/Refund\\s+(?:complete|completed)[^€$]*[€$]([\\d.,]+)/i);
            if (m) return { amount: m[1].replace(',', '.') };
            var m2 = body.match(/Refund\\s+amount[:\\s]*[€$]([\\d.,]+)/i);
            if (m2) return { amount: m2[1].replace(',', '.') };
            return null;
          })()
        `) as { amount: string } | null;

        if (refundInfo) {
          const refundCents = Math.round(parseFloat(refundInfo.amount) * 100);
          const meta = JSON.stringify({
            aliexpress_order_id: order.orderId,
            type: 'refund',
            original_order_total: order.totalEur,
            order_url: `https://www.aliexpress.com/p/order/detail.html?orderId=${order.orderId}`,
          });
          db.prepare(`
            INSERT INTO documents (document_id, source_system, source_document_ref, captured_at,
              document_date, total_amount_minor, currency_code, supplier_name, filename, meta)
            VALUES (?, 'aliexpress', ?, ?, ?, ?, 'EUR', 'AliExpress Refund', ?, ?)
          `).run(refundDocId, `REFUND-${order.orderId}`, now, dateKey, refundCents, `AliExpress-REFUND-${order.orderId}`, meta);

          refundCount++;
          onProgress?.(`${dateKey}: Rückerstattung EUR ${refundInfo.amount} für Bestellung ${order.orderId}`);

          // Take screenshot as proof/receipt
          const screenshotName = `AliExpress-REFUND-${dateKey}-${order.orderId}.png`;
          const screenshotPath = path.join(downloadDir, screenshotName);
          try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            // Update filename in DB to point to screenshot
            db.prepare('UPDATE documents SET filename = ? WHERE document_id = ?')
              .run(screenshotName, refundDocId);
            files.push({ filename: screenshotName, localPath: screenshotPath, invoiceDate: dateKey, supplierHint: 'AliExpress' });
          } catch {
            // Fallback: text file
            const filename = `AliExpress-REFUND-${dateKey}-${order.orderId}.txt`;
            const filePath = path.join(downloadDir, filename);
            writeFileSync(filePath, [
              `AliExpress Rückerstattungsbeleg`,
              `Bestellung: ${order.orderId}`,
              `Datum: ${dateKey}`,
              `Rückerstattung: EUR ${refundInfo.amount}`,
              `Originalbetrag: EUR ${order.totalStr}`,
              `Quelle: https://www.aliexpress.com/p/order/detail.html?orderId=${order.orderId}`,
            ].join('\n'), 'utf-8');
            files.push({ filename, localPath: filePath, invoiceDate: dateKey, supplierHint: 'AliExpress' });
          }
        }
      }
      if (refundCount > 0) {
        onProgress?.(`${refundCount} Rückerstattung(en) gefunden`);
      } else {
        onProgress?.('Keine Rückerstattungen gefunden');
      }

      // Phase 3: Screenshot cancelled orders — payment went through but no receipt available
      // Take a screenshot of the .order-detail-item section as proof of the original charge
      if (cancelled.length > 0) {
        onProgress?.(`${cancelled.length} stornierte Bestellung(en) — mache Screenshots...`);
        for (const order of cancelled) {
          const dateKey = order.parsedDate!.toISOString().slice(0, 10);
          const screenshotFilename = `AliExpress-CANCELLED-${dateKey}-${order.orderId}.png`;
          const screenshotPath = path.join(downloadDir, screenshotFilename);

          // Skip if already exists
          if (existsSync(screenshotPath)) continue;

          try {
            await page.goto(
              `https://www.aliexpress.com/p/order/detail.html?orderId=${order.orderId}`,
              { waitUntil: 'networkidle2', timeout: 15_000 },
            );
            await new Promise(r => setTimeout(r, 3000));

            // Screenshot the .order-detail-item section (contains product + total)
            const element = await page.$('.order-detail-item');
            if (element) {
              await element.screenshot({ path: screenshotPath });
              onProgress?.(`${dateKey}: Screenshot für stornierte Bestellung ${order.orderId}`);
              files.push({ filename: screenshotFilename, localPath: screenshotPath, invoiceDate: dateKey, supplierHint: 'AliExpress' });
            } else {
              // Fallback: full page screenshot
              await page.screenshot({ path: screenshotPath, fullPage: false });
              onProgress?.(`${dateKey}: Vollbild-Screenshot für ${order.orderId}`);
              files.push({ filename: screenshotFilename, localPath: screenshotPath, invoiceDate: dateKey, supplierHint: 'AliExpress' });
            }
          } catch (err: any) {
            onProgress?.(`Screenshot fehlgeschlagen für ${order.orderId}: ${err.message?.slice(0, 60)}`);
          }
        }
      }

      await page.close();
      onProgress?.(`Sammlung abgeschlossen: ${files.length} Datei(en)`);
      return { status: 'completed', files };

    } catch (err: any) {
      if (err.message?.includes('Chrome nicht erreichbar') || err.message?.includes('CDP')) {
        throw new BrowserConnectionError(err.message);
      }
      return {
        status: files.length > 0 ? 'partial' : 'failed',
        files, errorMessage: err.message,
      };
    } finally {
      if (browser) browser.disconnect();
    }
  }

  /** Parse all orders visible on the current page */
  private async parseOrdersOnPage(page: Page): Promise<AliOrder[]> {
    return await page.evaluate(`
      (() => {
        const results = [];
        const text = document.body.innerText;

        // Split by order status headers that precede each order block
        const blocks = text.split(/(?=(?:Completed|Canceled|Cancelled|To pay|To ship|Shipped|Awaiting delivery|Processing)\\nOrder date:)/);

        for (const block of blocks) {
          const dateMatch = block.match(/Order date:\\s*(.+?)\\n/);
          const idMatch = block.match(/Order ID:\\s*(\\d+)/);
          const totalMatch = block.match(/Total:\\s*[€$]([\\d.,]+)/);
          const statusMatch = block.match(/^(Completed|Canceled|Cancelled|To pay|To ship|Shipped|Awaiting delivery|Processing)/);

          if (dateMatch && idMatch && totalMatch) {
            const dateStr = dateMatch[1].trim();
            // Parse date: "Feb 10, 2026" → Date components
            const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
            const dm = dateStr.match(/(\\w{3})\\s+(\\d{1,2}),?\\s+(\\d{4})/);
            let parsedDate = null;
            if (dm) {
              const month = months[dm[1].toLowerCase()];
              if (month !== undefined) {
                parsedDate = new Date(parseInt(dm[3]), month, parseInt(dm[2])).toISOString();
              }
            }

            const totalStr = totalMatch[1].replace(',', '.');
            results.push({
              status: statusMatch ? statusMatch[1] : 'unknown',
              date: dateStr,
              orderId: idMatch[1],
              totalEur: Math.round(parseFloat(totalStr) * 100),
              totalStr,
              parsedDate,
            });
          }
        }
        return results;
      })()
    `) as AliOrder[];
  }
}
