/**
 * Fiverr portal adapter.
 *
 * Deterministic Puppeteer-based — no AI/LLM needed.
 *
 * Flow:
 *  1. Navigate to https://www.fiverr.com/users/receipts
 *  2. Login via Google SSO if needed
 *  3. Parse receipt list (date, amount, order ID, download link)
 *  4. Paginate through pages to find all receipts in date range
 *  5. Download receipt PDFs
 *
 * Login: Google SSO or existing session.
 */
import type {
  PortalConfig, PortalAdapter, SessionCheckResult,
  OpenclawRunResult, OpenclawFileResult, PortalType,
} from '../types.js';
import { connectBrowser, isBrowserReachable } from '../openclaw-client.js';
import { BrowserConnectionError } from '../errors.js';
import type { Browser, Page } from 'puppeteer-core';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

const RECEIPTS_URL = 'https://www.fiverr.com/users/receipts';

interface FiverrReceipt {
  date: string;
  amount: string;
  amountCents: number;
  orderId: string;
  downloadUrl: string;
  parsedDate: Date | null;
}

function parseFiverrDate(text: string): Date | null {
  // Formats: "Jan 25, 2025", "25 Jan 2025", "2025-01-25", "Jan. 25, 2025"
  const monthMap: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  // "Jan 25, 2025" or "Jan. 25, 2025"
  const m = text.match(/(\w{3})\.?\s+(\d{1,2}),?\s*(\d{4})/);
  if (m) {
    const month = monthMap[m[1].toLowerCase()];
    if (month !== undefined) return new Date(parseInt(m[3]), month, parseInt(m[2]));
  }
  // "25 Jan 2025"
  const m2 = text.match(/(\d{1,2})\s+(\w{3})\.?\s+(\d{4})/);
  if (m2) {
    const month = monthMap[m2[2].toLowerCase()];
    if (month !== undefined) return new Date(parseInt(m2[3]), month, parseInt(m2[1]));
  }
  // "25.01.2025" or "25.1.25"
  const m3 = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (m3) {
    let year = parseInt(m3[3]);
    if (year < 100) year += 2000;
    return new Date(year, parseInt(m3[2]) - 1, parseInt(m3[1]));
  }
  return null;
}

function parseAmount(text: string): number {
  const cleaned = text.replace(/[€$\s,]/g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : Math.round(val * 100);
}

function isInRange(date: Date, start: string, end: string): boolean {
  return date >= new Date(start + 'T00:00:00') && date <= new Date(end + 'T23:59:59');
}

export class FiverrAdapter implements PortalAdapter {
  readonly portalType: PortalType = 'fiverr' as PortalType;

  async checkSession(portal: PortalConfig): Promise<SessionCheckResult> {
    const result: SessionCheckResult = {
      browserReachable: false, portalReachable: false,
      loggedIn: false, invoiceAreaAccessible: false,
      message: '', details: [],
    };
    result.browserReachable = await isBrowserReachable();
    if (!result.browserReachable) { result.message = 'Chrome nicht erreichbar.'; return result; }

    let browser: Browser | null = null;
    try {
      browser = await connectBrowser();
      const pg = await browser.newPage();
      await pg.goto(RECEIPTS_URL, { waitUntil: 'networkidle2', timeout: 20_000 });
      await new Promise(r => setTimeout(r, 3000));
      result.portalReachable = true;
      const url = pg.url();
      if (url.includes('/login') || url.includes('sign_in') || !url.includes('receipts')) {
        result.message = 'Nicht eingeloggt — bitte bei fiverr.com einloggen.';
      } else {
        result.loggedIn = true;
        result.invoiceAreaAccessible = true;
        result.message = 'Fiverr Session aktiv.';
      }
      await pg.close();
    } catch (err: any) {
      result.message = `Fehler: ${err.message}`;
    } finally {
      if (browser) await browser.disconnect();
    }
    return result;
  }

  async collectInvoices(
    portal: PortalConfig,
    dateRange: { start: string; end: string },
    downloadDir: string,
    onProgress?: (msg: string) => void,
  ): Promise<OpenclawRunResult> {
    const dateStart = dateRange.start;
    const dateEnd = dateRange.end;
    const files: OpenclawFileResult[] = [];

    if (!await isBrowserReachable()) throw new BrowserConnectionError('Chrome nicht erreichbar');
    const browser = await connectBrowser();

    try {
      let page = await browser.newPage();
      if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });

      // Set download behavior
      const client = await page.createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
      });

      onProgress?.('Verbindung hergestellt');

      // Fiverr blocks new Puppeteer pages (PerimeterX bot detection).
      // Use an existing tab or ask user to navigate to receipts page manually.
      const pages = await browser.pages();
      let existingFiverr = pages.find(p => p.url().includes('fiverr.com'));

      if (existingFiverr) {
        onProgress?.('Verwende existierenden Fiverr-Tab');
        await existingFiverr.bringToFront();
        if (!existingFiverr.url().includes('receipts')) {
          // Navigate within existing tab (less likely to trigger bot detection)
          await existingFiverr.evaluate(`window.location.href = '${RECEIPTS_URL}'`);
          await new Promise(r => setTimeout(r, 5000));
        }
        // Use existing tab instead of new page
        await page.close();
        page = existingFiverr;
      } else {
        onProgress?.('Kein Fiverr-Tab gefunden — bitte fiverr.com/users/receipts in Chrome öffnen');
        await page.goto(RECEIPTS_URL, { waitUntil: 'networkidle2', timeout: 20_000 });
        await new Promise(r => setTimeout(r, 3000));
      }

      // Check if blocked by bot detection
      const bodyText = await page.evaluate('document.body.innerText.slice(0, 200)') as string;
      if (bodyText.includes('human touch') || bodyText.includes('PXCR')) {
        throw new Error('Fiverr Bot-Schutz aktiv — bitte manuell https://www.fiverr.com/users/receipts in Chrome öffnen und dann erneut starten.');
      }

      // Check if logged in
      const currentUrl = page.url();
      if (!currentUrl.includes('receipts') || currentUrl.includes('login') || currentUrl.includes('sign_in')) {
        throw new Error('Fiverr Login erforderlich — bitte manuell bei fiverr.com einloggen und die Receipts-Seite öffnen.');
      }

      onProgress?.('Lade Rechnungsbelege...');

      // Collect receipts across all pages
      const allReceipts: FiverrReceipt[] = [];
      const seenIds = new Set<string>();
      let pageNum = 0;
      const MAX_PAGES = 20;

      while (pageNum < MAX_PAGES) {
        pageNum++;

        const pageReceipts = await page.evaluate(`
          (() => {
            var items = [];
            // Fiverr receipts page: table rows or list items with order info
            var rows = document.querySelectorAll('tr, .receipt-row, [class*="receipt"], [class*="order"]');
            for (var row of rows) {
              var text = row.textContent || '';
              // Look for date patterns
              var dateMatch = text.match(/(\\w{3}\\.?\\s+\\d{1,2},?\\s*\\d{4})|(\\d{1,2}\\.\\d{1,2}\\.\\d{2,4})/);
              // Look for amount: $XX.XX or €XX.XX or XX,XX €
              var amountMatch = text.match(/[\\$€]\\s*([\\d,.]+)|([\\d,.]+)\\s*[\\$€]/);
              // Look for order ID: FI + alphanumeric
              var idMatch = text.match(/FI[A-Z0-9]{10,}/i) || text.match(/(#?\\w{10,})/);
              // Look for download link
              var downloadEl = row.querySelector('a[href*="receipt"], a[href*="download"], a[href*="invoice"], a[href*="pdf"]');
              var downloadUrl = downloadEl ? downloadEl.href : '';

              if (dateMatch && amountMatch) {
                items.push({
                  date: (dateMatch[1] || dateMatch[2] || '').trim(),
                  amount: amountMatch[0],
                  orderId: idMatch ? idMatch[0] : '',
                  downloadUrl: downloadUrl,
                });
              }
            }

            // Fallback: scan text line by line
            if (items.length === 0) {
              var body = document.body.innerText;
              var lines = body.split('\\n').filter(function(l) { return l.trim(); });
              for (var i = 0; i < lines.length; i++) {
                var dm = lines[i].match(/(\\w{3}\\.?\\s+\\d{1,2},?\\s*\\d{4})/);
                if (dm) {
                  var context = lines.slice(Math.max(0, i-1), i+3).join(' ');
                  var am = context.match(/[\\$€]\\s*([\\d,.]+)|([\\d,.]+)\\s*[\\$€]/);
                  if (am) {
                    items.push({ date: dm[1], amount: am[0], orderId: '', downloadUrl: '' });
                  }
                }
              }
            }
            return items;
          })()
        `) as Array<{ date: string; amount: string; orderId: string; downloadUrl: string }>;

        let newCount = 0;
        for (const r of pageReceipts) {
          const key = r.date + r.amount;
          if (!seenIds.has(key)) {
            seenIds.add(key);
            allReceipts.push({
              ...r,
              amountCents: parseAmount(r.amount),
              parsedDate: parseFiverrDate(r.date),
            });
            newCount++;
          }
        }

        if (newCount > 0) {
          onProgress?.(`Seite ${pageNum}: ${newCount} neue Belege (gesamt: ${allReceipts.length})`);
        }

        // Check if oldest is before date range
        const datesOnPage = pageReceipts.map(r => parseFiverrDate(r.date)).filter(Boolean) as Date[];
        if (datesOnPage.length > 0) {
          const oldest = datesOnPage.reduce((a, b) => a < b ? a : b);
          if (oldest < new Date(dateStart + 'T00:00:00')) {
            onProgress?.('Ältere Belege als Startzeitpunkt erreicht');
            break;
          }
        }

        // No new items → probably last page
        if (newCount === 0) {
          onProgress?.('Keine neuen Belege — letzte Seite');
          break;
        }

        // Try pagination: next button
        const hasNext = await page.evaluate(`
          (() => {
            var btns = [...document.querySelectorAll('a, button')];
            var next = btns.find(function(b) {
              var t = (b.textContent || '').trim().toLowerCase();
              var aria = (b.getAttribute('aria-label') || '').toLowerCase();
              return t === 'next' || t === '>' || t === '›' || t === '→' ||
                     aria.includes('next') || b.getAttribute('rel') === 'next';
            });
            if (next && !next.disabled && next.offsetHeight > 0) { next.click(); return true; }
            // Try page number links
            var pageLinks = [...document.querySelectorAll('a[href*="page="], a[href*="offset="]')];
            var current = document.querySelector('[aria-current="page"], .active, .current');
            if (current) {
              var nextSibling = current.nextElementSibling;
              if (nextSibling && nextSibling.tagName === 'A') { nextSibling.click(); return true; }
            }
            return false;
          })()
        `);

        if (!hasNext) {
          onProgress?.('Keine weitere Seite');
          break;
        }
        await new Promise(r => setTimeout(r, 3000));
      }

      onProgress?.(`${allReceipts.length} Belege gefunden (${pageNum} Seiten)`);

      // Filter by date range
      const matching = allReceipts.filter(r => r.parsedDate && isInRange(r.parsedDate, dateStart, dateEnd));
      onProgress?.(`${matching.length} Belege im Zeitraum ${dateStart} — ${dateEnd}`);

      // Download each receipt
      for (const receipt of matching) {
        const dateKey = receipt.parsedDate!.toISOString().slice(0, 10);
        const filename = `Fiverr-${dateKey}-${receipt.orderId || receipt.amountCents}.png`;
        const filePath = path.join(downloadDir, filename);

        if (existsSync(filePath)) {
          onProgress?.(`${dateKey}: bereits vorhanden`);
          continue;
        }

        try {
          // Try to download PDF if link available
          if (receipt.downloadUrl && receipt.downloadUrl.includes('http')) {
            await page.goto(receipt.downloadUrl, { waitUntil: 'networkidle2', timeout: 15_000 });
            await new Promise(r => setTimeout(r, 2000));
          }

          // Screenshot as receipt
          await page.screenshot({ path: filePath, fullPage: true });
          files.push({ filename, localPath: filePath, invoiceDate: dateKey, supplierHint: 'Fiverr' });
          onProgress?.(`${dateKey}: ${receipt.amount} gespeichert`);
        } catch (err: any) {
          onProgress?.(`${dateKey}: Fehler — ${err.message}`);
        }
      }

      // If no individual receipts, screenshot overview
      if (files.length === 0 && matching.length > 0) {
        await page.goto(RECEIPTS_URL, { waitUntil: 'networkidle2', timeout: 15_000 });
        await new Promise(r => setTimeout(r, 2000));
        const dateKey = matching[0].parsedDate!.toISOString().slice(0, 10);
        const filename = `Fiverr-Belege-${dateKey}.png`;
        const filePath = path.join(downloadDir, filename);
        await page.screenshot({ path: filePath, fullPage: true });
        files.push({ filename, localPath: filePath, invoiceDate: dateKey, supplierHint: 'Fiverr' });
        onProgress?.('Screenshot der Übersicht gespeichert');
      }

      await page.close();
    } finally {
      await browser.disconnect();
    }

    return { status: 'completed', files };
  }
}
