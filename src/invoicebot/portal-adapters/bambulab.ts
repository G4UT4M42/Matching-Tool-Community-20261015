/**
 * Bambu Lab EU Store portal adapter.
 *
 * Deterministic Puppeteer-based — no AI/LLM needed.
 *
 * Bambu Lab runs on Shopify. Flow:
 *  1. Navigate to https://eu.store.bambulab.com/account/orders
 *  2. If not logged in → redirect to bambulab.com login → return waiting_for_login
 *  3. Parse order list (order number, date, status, total)
 *  4. For each order in date range → open detail page → click "Download Invoice" if available
 *  5. Wait for PDF download
 *
 * Login: Requires Bambu Lab account (email/password). No Google SSO.
 * User must log in manually in the bot browser first.
 */
import type {
  PortalConfig, PortalAdapter, SessionCheckResult,
  OpenclawRunResult, OpenclawFileResult, PortalType,
} from '../types.js';
import { connectBrowser, isBrowserReachable, launchVisibleBrowser } from '../openclaw-client.js';
import { BrowserConnectionError } from '../errors.js';
import { attemptAutoLogin, attemptGoogleSSOLogin } from './auto-login.js';
import type { Browser, Page } from 'puppeteer-core';
import { existsSync, readdirSync, mkdirSync, statSync } from 'fs';
import path from 'path';

const ORDERS_URL = 'https://eu.store.bambulab.com/account/orders';

interface BambuOrder {
  orderNumber: string;  // e.g. "#EU-12345"
  date: string;         // e.g. "December 28, 2025"
  status: string;       // e.g. "Fulfilled"
  total: string;        // e.g. "€19.25"
  detailUrl: string;    // link to order detail
  parsedDate: Date | null;
  amountCents: number;
}

function isLoginPage(url: string): boolean {
  return url.includes('sign-in') || url.includes('login') || url.includes('signin');
}

function isInRange(date: Date, start: string, end: string): boolean {
  return date >= new Date(start + 'T00:00:00') && date <= new Date(end + 'T23:59:59');
}

/** Parse Shopify date: "December 28, 2025" or "January 5, 2026" */
function parseShopifyDate(text: string): Date | null {
  const months: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const m = text.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const month = months[m[1].toLowerCase()];
  if (month === undefined) return null;
  return new Date(parseInt(m[3]), month, parseInt(m[2]));
}

export class BambuLabAdapter implements PortalAdapter {
  readonly portalType: PortalType = 'bambulab' as PortalType;

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

      if (isLoginPage(pg.url())) {
        // Try auto-login with saved credentials
        await pg.evaluate(`(() => { var cb = document.querySelector('input[name="argee"], input[type="checkbox"]'); if (cb && !cb.checked) cb.click(); })()`);
        await new Promise(r => setTimeout(r, 500));
        const loginResult = await attemptAutoLogin(pg);
        if (loginResult.status === 'login_successful') {
          await pg.goto(ORDERS_URL, { waitUntil: 'networkidle2', timeout: 20_000 });
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      if (isLoginPage(pg.url())) {
        result.message = 'Nicht eingeloggt bei Bambu Lab. Auto-Login fehlgeschlagen. Bitte im Bot-Browser einloggen.';
        await launchVisibleBrowser();
      } else {
        result.loggedIn = true;
        result.invoiceAreaAccessible = true;
        result.message = 'Verbunden mit Bambu Lab Store';
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

      // Configure download
      const cdp = await page.createCDPSession();
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

      onProgress?.('Verbindung hergestellt');
      onProgress?.('Öffne Bambu Lab Bestellungen...');
      await page.goto(ORDERS_URL, { waitUntil: 'networkidle2', timeout: 20_000 });
      await new Promise(r => setTimeout(r, 5000));

      if (isLoginPage(page.url())) {
        onProgress?.('Login-Seite erkannt, versuche Auto-Login...');

        // Accept cookies + terms checkbox
        await page.evaluate(`
          (() => {
            var btns = Array.from(document.querySelectorAll('button'));
            var accept = btns.find(function(b){ return b.textContent.trim() === 'Accept All'; });
            if (accept) accept.click();
          })()
        `);
        await new Promise(r => setTimeout(r, 1000));
        await page.evaluate(`
          (() => {
            var cb = document.querySelector('input[name="argee"], input[type="checkbox"]');
            if (cb && !cb.checked) cb.click();
          })()
        `);
        await new Promise(r => setTimeout(r, 500));

        // Try 1: Chrome autofill (saved passwords)
        let loginResult = await attemptAutoLogin(page);

        // Try 2: Google SSO if autofill failed
        if (loginResult.status !== 'login_successful' && loginResult.status !== 'already_logged_in') {
          onProgress?.('Autofill fehlgeschlagen, versuche Google SSO...');
          loginResult = await attemptGoogleSSOLogin(page, browser!);
        }

        if (loginResult.status === 'login_successful' || loginResult.status === 'already_logged_in') {
          onProgress?.(`Login erfolgreich: ${'message' in loginResult ? loginResult.message : 'OK'}`);
          await page.goto(ORDERS_URL, { waitUntil: 'networkidle2', timeout: 20_000 });
          await new Promise(r => setTimeout(r, 5000));
        }

        // Still on login page? → open visible browser for manual login
        if (isLoginPage(page.url())) {
          await page.close();
          await launchVisibleBrowser();
          onProgress?.(`Login erforderlich — ${loginResult.status === 'needs_manual_login' ? loginResult.message : 'bitte im Browser-Fenster einloggen'}`);
          return { status: 'waiting_for_login', files: [], errorMessage: loginResult.status === 'needs_manual_login' ? loginResult.message : 'Login erforderlich' };
        }
      }

      // Parse order list
      onProgress?.('Lese Bestellungen...');
      const orders = await this.parseOrders(page);
      onProgress?.(`${orders.length} Bestellungen gefunden`);

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

      // For each order, open detail page and try to download invoice
      for (let i = 0; i < matching.length; i++) {
        const order = matching[i];
        const dateKey = order.parsedDate!.toISOString().slice(0, 10);
        onProgress?.(`[${i + 1}/${matching.length}] ${order.orderNumber} (${order.total})...`);

        if (!order.detailUrl) continue;

        const filesBefore = new Set(existsSync(downloadDir) ? readdirSync(downloadDir) : []);

        await page.goto(order.detailUrl, { waitUntil: 'networkidle2', timeout: 15_000 });
        await new Promise(r => setTimeout(r, 3000));

        // Look for "Download Invoice" link/button
        const downloadClicked = await page.evaluate(`
          (() => {
            var els = Array.from(document.querySelectorAll('a, button'));
            for (var i = 0; i < els.length; i++) {
              var t = (els[i].textContent || '').trim().toLowerCase();
              if (t.includes('download invoice') || t.includes('invoice') && t.includes('download')) {
                els[i].click();
                return 'clicked: ' + els[i].textContent.trim();
              }
            }
            // Also try links with 'invoice' in href
            var links = document.querySelectorAll('a[href*=invoice], a[href*=Invoice]');
            if (links.length > 0) { links[0].click(); return 'clicked href: ' + links[0].href; }
            return null;
          })()
        `) as string | null;

        if (downloadClicked) {
          onProgress?.(`  ${downloadClicked}`);
          // Wait for download
          const newFile = await this.waitForDownload(downloadDir, filesBefore, onProgress);
          if (newFile) {
            files.push({
              filename: path.basename(newFile),
              localPath: newFile,
              invoiceDate: dateKey,
              supplierHint: 'Bambu Lab',
            });
          }
        } else {
          onProgress?.(`  Kein Download-Button gefunden für ${order.orderNumber}`);
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

  /** Parse order list from Bambu Lab Shopify account page */
  private async parseOrders(page: Page): Promise<BambuOrder[]> {
    const raw = await page.evaluate(`
      (() => {
        var results = [];
        // Shopify order list: typically <table> or list of order cards
        // Try table rows first
        var rows = document.querySelectorAll('tr');
        for (var i = 0; i < rows.length; i++) {
          var cells = Array.from(rows[i].querySelectorAll('td'));
          if (cells.length >= 3) {
            var link = rows[i].querySelector('a');
            results.push({
              text: cells.map(function(c){ return c.textContent.trim(); }),
              href: link ? link.href : '',
            });
          }
        }
        // If no table, try order cards / list items
        if (results.length === 0) {
          var links = document.querySelectorAll('a[href*="/orders/"]');
          for (var j = 0; j < links.length; j++) {
            var parent = links[j].closest('div, li, tr') || links[j].parentElement;
            results.push({
              text: [(parent ? parent.textContent : links[j].textContent).trim()],
              href: links[j].href,
            });
          }
        }
        // Also try the generic Shopify pattern: look for order numbers
        if (results.length === 0) {
          var body = document.body.innerText;
          var orderBlocks = body.split(/(?=#[A-Z]*-?\\d{4,})/);
          for (var k = 0; k < orderBlocks.length; k++) {
            var numMatch = orderBlocks[k].match(/(#[A-Z]*-?\\d{4,})/);
            if (numMatch) {
              results.push({ text: [orderBlocks[k].slice(0, 200)], href: '' });
            }
          }
        }
        return results;
      })()
    `) as Array<{ text: string[]; href: string }>;

    return raw.map(r => {
      const fullText = r.text.join(' ');
      const orderMatch = fullText.match(/(#[A-Z]*-?\d{4,})/);
      const dateMatch = fullText.match(/(\w+\s+\d{1,2},?\s+\d{4})/);
      const amountMatch = fullText.match(/€([\d.,]+)/);
      const statusMatch = fullText.match(/(Fulfilled|Unfulfilled|Cancelled|Refunded|Paid|Pending)/i);

      const orderNumber = orderMatch ? orderMatch[1] : '';
      const dateStr = dateMatch ? dateMatch[1] : '';
      const amountStr = amountMatch ? `€${amountMatch[1]}` : '';
      const amountCents = amountMatch
        ? Math.round(parseFloat(amountMatch[1].replace(',', '.')) * 100)
        : 0;

      return {
        orderNumber,
        date: dateStr,
        status: statusMatch ? statusMatch[1] : '',
        total: amountStr,
        detailUrl: r.href,
        parsedDate: parseShopifyDate(dateStr),
        amountCents,
      };
    }).filter(o => o.orderNumber && o.parsedDate);
  }

  private async waitForDownload(
    downloadDir: string, filesBefore: Set<string>,
    onProgress?: (msg: string) => void,
  ): Promise<string | null> {
    const maxWaitMs = 30_000;
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
    onProgress?.('  Download-Timeout (30s)');
    return null;
  }
}
