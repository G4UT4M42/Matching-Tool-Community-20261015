/**
 * Post.at (Austrian Post) portal adapter.
 *
 * Deterministic Puppeteer-based — no AI/LLM needed.
 *
 * Flow:
 *  1. Navigate to https://services.post.at/store/meine-bestellungen
 *  2. Select year filter for the date range
 *  3. Parse order list (order number, date, amount)
 *  4. For each order: click "Evidence" → modal opens → click PDF download icon
 *  5. Wait for PDF file to download
 *
 * Login: Uses existing Post.at session (user must be logged in via post.at).
 * The "Evidence" button opens a modal with invoice number and PDF download link.
 * The PDF download icon is below the "PDF" text label at approximately y+25 from the text.
 */
import type {
  PortalConfig, PortalAdapter, SessionCheckResult,
  OpenclawRunResult, OpenclawFileResult, PortalType,
} from '../types.js';
import { connectBrowser, isBrowserReachable, launchVisibleBrowser } from '../openclaw-client.js';
import { BrowserConnectionError } from '../errors.js';
import type { Browser, Page } from 'puppeteer-core';
import { existsSync, readdirSync, mkdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';

const ORDERS_URL = 'https://services.post.at/store/meine-bestellungen';

interface PostOrder {
  orderNumber: string;  // "EC-26-06383779"
  date: string;         // "April 5, 2026"
  amount: string;       // "7.57"
  amountCents: number;
  parsedDate: Date | null;
  pageIndex: number;
}

function parsePostDate(text: string): Date | null {
  const numeric = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (numeric) {
    const day = parseInt(numeric[1]);
    const month = parseInt(numeric[2]) - 1;
    const year = parseInt(numeric[3]);
    const parsed = new Date(year, month, day);
    if (
      parsed.getFullYear() === year
      && parsed.getMonth() === month
      && parsed.getDate() === day
    ) {
      return parsed;
    }
    return null;
  }

  const months: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    // German
    jänner: 0, februar: 1, märz: 2, april_de: 3, mai: 4, juni: 5,
    juli: 6, august_de: 7, september_de: 8, oktober: 9, november_de: 10, dezember: 11,
  };
  const m = text.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const month = months[m[1].toLowerCase()] ?? months[m[1].toLowerCase().replace('ä', 'a')];
  if (month === undefined) return null;
  return new Date(parseInt(m[3]), month, parseInt(m[2]));
}

function isInRange(date: Date, start: string, end: string): boolean {
  return date >= new Date(start + 'T00:00:00') && date <= new Date(end + 'T23:59:59');
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class PostAtAdapter implements PortalAdapter {
  readonly portalType: PortalType = 'post_at' as PortalType;

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
      await pg.goto(ORDERS_URL, { waitUntil: 'networkidle2', timeout: 20_000 });
      await new Promise(r => setTimeout(r, 5000));
      result.portalReachable = true;

      const hasOrders = await pg.evaluate(`
        (() => {
          var text = document.body.innerText;
          return text.includes('My Orders') || text.includes('Meine Bestellungen') || text.includes('Order number');
        })()
      `) as boolean;

      if (hasOrders) {
        result.loggedIn = true;
        result.invoiceAreaAccessible = true;
        result.message = 'Verbunden mit Post.at — Bestellungen zugänglich';
      } else {
        result.message = 'Nicht eingeloggt bei Post.at';
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

      const cdp = await page.createCDPSession();
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

      onProgress?.('Verbindung hergestellt');
      onProgress?.('Öffne Post.at Bestellungen...');
      await page.goto(ORDERS_URL, { waitUntil: 'networkidle2', timeout: 20_000 });
      await new Promise(r => setTimeout(r, 8000));

      const hasOrders = await page.evaluate(`
        (() => { return document.body.innerText.includes('Order number') || document.body.innerText.includes('Bestellnummer'); })()
      `) as boolean;

      if (!hasOrders) {
        await page.close();
        await launchVisibleBrowser();
        onProgress?.('Login erforderlich');
        return { status: 'waiting_for_login', files: [], errorMessage: 'Post.at Login erforderlich' };
      }

      // Determine which years to scan (may span year boundary)
      const startYear = parseInt(dateRange.start.slice(0, 4));
      const endYear = parseInt(dateRange.end.slice(0, 4));
      const yearsToScan = new Set<number>();
      for (let y = startYear; y <= endYear; y++) yearsToScan.add(y);

      const allOrders: PostOrder[] = [];

      for (const year of yearsToScan) {
        onProgress?.(`Setze Filter auf ${year}...`);
        await page.evaluate(`
          (() => {
            var selects = document.querySelectorAll('select');
            for (var i = 0; i < selects.length; i++) {
              var opts = selects[i].querySelectorAll('option');
              for (var j = 0; j < opts.length; j++) {
                if (opts[j].value === '${year}' || opts[j].textContent.trim() === '${year}') {
                  selects[i].value = opts[j].value;
                  selects[i].dispatchEvent(new Event('change', {bubbles:true}));
                  return true;
                }
              }
            }
            return false;
          })()
        `);
        await new Promise(r => setTimeout(r, 5000));

        // Click "Mehr laden" to load all orders for this year
        for (let click = 0; click < 10; click++) {
          const loaded = await page.evaluate(`
            (() => {
              var links = document.querySelectorAll('a');
              for (var i = 0; i < links.length; i++) {
                if (links[i].textContent.trim() === 'Mehr laden' || links[i].textContent.trim() === 'Load more') {
                  links[i].click();
                  return true;
                }
              }
              return false;
            })()
          `) as boolean;
          if (!loaded) break;
          await new Promise(r => setTimeout(r, 3000));
        }

        const yearOrders = await this.parseOrders(page);
        onProgress?.(`${yearOrders.length} Bestellungen in ${year}`);
        allOrders.push(...yearOrders);
      }

      // Deduplicate by order number
      const seen = new Set<string>();
      const orders = allOrders.filter(o => {
        if (seen.has(o.orderNumber)) return false;
        seen.add(o.orderNumber);
        return true;
      });
      onProgress?.(`${orders.length} Bestellungen insgesamt`);

      // Filter by date range
      const matching = orders.filter(o => {
        if (!o.parsedDate) return false;
        return isInRange(o.parsedDate, dateRange.start, dateRange.end);
      });
      onProgress?.(`${matching.length} Bestellungen im Zeitraum`);

      if (matching.length === 0) {
        await page.close();
        return { status: 'completed', files: [] };
      }

      // For each order: click Evidence → modal → click PDF download
      for (let i = 0; i < matching.length; i++) {
        const order = matching[i];
        onProgress?.(`[${i + 1}/${matching.length}] ${order.orderNumber} (€${order.amount})...`);

        try {
          const file = await this.downloadEvidence(page, order.pageIndex, order, downloadDir, onProgress);
          if (file) files.push(file);
        } catch (err: any) {
          onProgress?.(`  Fehler: ${err.message}`);
        }
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

  private async parseOrders(page: Page): Promise<PostOrder[]> {
    const raw = await page.evaluate(`
      (() => {
        var text = document.body.innerText;
        var results = [];
        var blocks = text.split(/(?=(?:Order number|Bestellnummer)\\s*:)/i);
        for (var i = 0; i < blocks.length; i++) {
          var numMatch = blocks[i].match(/(?:Order number|Bestellnummer)\\s*:\\s*(\\S+)/i);
          var dateMatch = blocks[i].match(/(?:Order date|Bestelldatum)\\s*:\\s*(.+?)(?:\\n|$)/i);
          var amountMatch = blocks[i].match(/[€]\\s*([\\d.,]+)/);
          if (numMatch) {
            results.push({
              orderNumber: numMatch[1],
              date: dateMatch ? dateMatch[1].trim() : '',
              amount: amountMatch ? amountMatch[1].replace(',', '.') : '0',
            });
          }
        }
        return results;
      })()
    `) as Array<{ orderNumber: string; date: string; amount: string }>;

    return raw.map((r, pageIndex) => ({
      ...r,
      amountCents: Math.round(parseFloat(r.amount) * 100),
      parsedDate: parsePostDate(r.date),
      pageIndex,
    }));
  }

  /**
   * Download evidence PDF for a specific order.
   * Clicks the nth "Evidence" link, waits for modal, clicks the PDF download icon.
   */
  private async downloadEvidence(
    page: Page, orderIndex: number, order: PostOrder,
    downloadDir: string, onProgress?: (msg: string) => void,
  ): Promise<OpenclawFileResult | null> {
    const filesBefore = new Set(existsSync(downloadDir) ? readdirSync(downloadDir) : []);

    // Click the receipts link for this order. The German portal labels it
    // "Belege"; older/English variants use "Nachweis" or "Evidence".
    const evidenceClicked = await page.evaluate(`
      (() => {
        var indexed = document.getElementById('link-documents-${orderIndex}');
        if (indexed && indexed.offsetParent !== null) {
          indexed.click();
          return true;
        }
        var links = document.querySelectorAll('a');
        var evidenceLinks = [];
        for (var i = 0; i < links.length; i++) {
          var text = (links[i].textContent||'').trim();
          if (text === 'Belege' || text === 'Evidence' || text === 'Nachweis') {
            evidenceLinks.push(links[i]);
          }
        }
        if (evidenceLinks.length > ${orderIndex}) {
          evidenceLinks[${orderIndex}].click();
          return true;
        }
        return false;
      })()
    `) as boolean;

    if (!evidenceClicked) {
      onProgress?.(`  Kein Evidence-Button für ${order.orderNumber}`);
      return null;
    }

    await new Promise(r => setTimeout(r, 3000));

    // Click the actual download link in the modal. Older portal versions only
    // exposed a PDF label, so retain the coordinate fallback below.
    const directLinkAvailable = await page.evaluate(`
      (() => {
        var links = document.querySelectorAll(
          '[role="dialog"] a.download-icon, [role="dialog"] a[id^="link-download-doc-"]'
        );
        for (var i = 0; i < links.length; i++) {
          if (links[i].offsetParent !== null) return true;
        }
        return false;
      })()
    `) as boolean;

    // The current portal obtains the PDF via an authenticated API request and
    // then opens a blob URL. Capture the GET response itself; it is the source
    // PDF and avoids relying on Chrome's PDF viewer/download preferences.
    const pdfResponse = directLinkAvailable
      ? page.waitForResponse(
          response => response.request().method() === 'GET'
            && response.url().includes('/attachments/')
            && response.url().includes(`/${order.orderNumber}/`)
            && response.status() === 200,
          { timeout: 20_000 },
        ).catch(() => null)
      : Promise.resolve(null);

    const directDownloadClicked = directLinkAvailable && await page.evaluate(`
      (() => {
        window.open = function() { return null; };
        var links = document.querySelectorAll(
          '[role="dialog"] a.download-icon, [role="dialog"] a[id^="link-download-doc-"]'
        );
        for (var i = 0; i < links.length; i++) {
          if (links[i].offsetParent !== null) {
            links[i].click();
            return true;
          }
        }
        return false;
      })()
    `) as boolean;

    const pdfRect = directLinkAvailable ? null : await page.evaluate(`
      (() => {
        var fonts = document.querySelectorAll('font');
        for (var i = 0; i < fonts.length; i++) {
          if (fonts[i].textContent.trim() === 'PDF' && fonts[i].offsetParent !== null) {
            var r = fonts[i].getBoundingClientRect();
            // The download icon is approximately 25px below the PDF text
            return {x: r.x + r.width / 2, y: r.y + r.height + 15};
          }
        }
        return null;
      })()
    `) as { x: number; y: number } | null;

    if (!directDownloadClicked && !pdfRect) {
      // Close modal and continue
      await page.evaluate(`
        (() => {
          var btns = document.querySelectorAll('button, a');
          for (var i = 0; i < btns.length; i++) {
            if ((btns[i].textContent||'').trim() === 'Cancel' || (btns[i].textContent||'').trim() === 'CLOSE') {
              btns[i].click(); return;
            }
          }
        })()
      `);
      await new Promise(r => setTimeout(r, 1000));
      onProgress?.(`  Kein PDF-Download im Modal für ${order.orderNumber}`);
      return null;
    }

    if (pdfRect) {
      await page.mouse.click(pdfRect.x, pdfRect.y);
    }

    let newFile: string | null = null;
    if (directDownloadClicked) {
      try {
        const response = await pdfResponse;
        if (response) {
          const pdf = await response.buffer();
          const safeOrder = order.orderNumber.replace(/[^a-zA-Z0-9_-]/g, '_');
          newFile = path.join(downloadDir, `post-${safeOrder}-${Date.now()}.pdf`);
          writeFileSync(newFile, pdf);
          onProgress?.(`  Download: ${path.basename(newFile)} (${(statSync(newFile).size / 1024).toFixed(0)} KB)`);
        } else {
          onProgress?.('  PDF-API-Download-Timeout');
        }
      } catch {
        onProgress?.('  PDF-API-Download fehlgeschlagen, versuche Browser-Download');
      }
    }
    if (!newFile) {
      newFile = await this.waitForDownload(downloadDir, filesBefore, onProgress);
    }

    // Close the modal
    await page.evaluate(`
      (() => {
        var exact = document.querySelector(
          '.ReactModal__Content--after-open #belege-abbrechen-btn, ' +
          '.ReactModal__Content--after-open .ReactModalContent__closeDesktop'
        );
        if (exact) exact.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));

    if (!newFile) return null;

    const dateKey = formatLocalDate(order.parsedDate!);
    return {
      filename: path.basename(newFile),
      localPath: newFile,
      invoiceDate: dateKey,
      supplierHint: 'Post.at',
    };
  }

  private async waitForDownload(
    downloadDir: string, filesBefore: Set<string>,
    onProgress?: (msg: string) => void,
  ): Promise<string | null> {
    const maxWaitMs = 20_000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, 2000));
      if (!existsSync(downloadDir)) continue;
      for (const f of readdirSync(downloadDir)) {
        if (filesBefore.has(f)) continue;
        if (f.endsWith('.crdownload') || f.endsWith('.tmp') || f.endsWith('.part')) continue;
        const filePath = path.join(downloadDir, f);
        try {
          const size = statSync(filePath).size;
          if (size > 0) {
            onProgress?.(`  Download: ${f} (${(size / 1024).toFixed(0)} KB)`);
            return filePath;
          }
        } catch {}
      }
    }
    onProgress?.('  Download-Timeout');
    return null;
  }
}
