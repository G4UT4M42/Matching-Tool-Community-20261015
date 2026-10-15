/**
 * ChatGPT (chatgpt.com) portal adapter.
 *
 * Deterministic Puppeteer-based — no AI/LLM needed.
 *
 * Flow:
 *  1. Navigate to chatgpt.com → settings → Subscription
 *  2. Click "Manage" (Payment section) → redirects to pay.openai.com (Stripe billing portal)
 *  3. Parse invoice history links from the Stripe portal page
 *  4. Optionally click "View more" for older invoices
 *  5. Filter by date range
 *  6. For each matching invoice → open Stripe invoice page → click "Download invoice"
 *
 * Login: Uses existing Google SSO session (chatgpt.com auto-logs in via Google).
 */
import type {
  PortalConfig, PortalAdapter, SessionCheckResult,
  OpenclawRunResult, OpenclawFileResult, PortalType,
} from '../types.js';
import { connectBrowser, isBrowserReachable, launchVisibleBrowser } from '../openclaw-client.js';
import { BrowserConnectionError, SessionExpiredError } from '../errors.js';
import type { Browser, Page } from 'puppeteer-core';
import { existsSync, readdirSync, mkdirSync, statSync } from 'fs';
import path from 'path';

const CHATGPT_SETTINGS_URL = 'https://chatgpt.com/#settings/Subscription';

interface InvoiceEntry {
  label: string;       // e.g. "Feb 15"
  amount: string;      // e.g. "€19.17"
  status: string;      // e.g. "Paid"
  description: string; // e.g. "ChatGPT Plus Subscription (per seat)"
  viewUrl: string;     // invoice.stripe.com URL
  date: Date | null;   // parsed date
}

/** Parse "Feb 15" or "Mar 15" into a Date for the most recent occurrence */
function parseShortDate(label: string, refYear: number): Date | null {
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    // German
    mär: 2, mai: 4, okt: 9, dez: 11,
  };
  const match = label.match(/([A-Za-zä]{3})\s+(\d{1,2})/);
  if (!match) return null;
  const monthKey = match[1].toLowerCase();
  const day = parseInt(match[2]);
  const month = months[monthKey];
  if (month === undefined) return null;
  // Assume current year; if date is in the future, use last year
  let date = new Date(refYear, month, day);
  if (date > new Date()) date = new Date(refYear - 1, month, day);
  return date;
}

/** Check if a date falls within a range */
function isInRange(date: Date, start: string, end: string): boolean {
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T23:59:59');
  return date >= s && date <= e;
}

export class ChatGPTAdapter implements PortalAdapter {
  readonly portalType: PortalType = 'chatgpt' as PortalType;

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
    result.details.push('Chrome erreichbar');

    let browser: Browser | null = null;
    try {
      browser = await connectBrowser();
      const pages = await browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();

      await page.goto(CHATGPT_SETTINGS_URL, { waitUntil: 'networkidle2', timeout: 15_000 });
      await this.waitForCloudflare(page);
      result.portalReachable = true;
      result.details.push('chatgpt.com erreichbar');

      // Check if logged in by looking for account email
      const hasAccount = await page.evaluate(`
        (() => {
          const body = document.body.innerText || '';
          return body.includes('@gmail.com') || body.includes('@') && body.includes('Manage');
        })()
      `) as boolean;

      if (hasAccount) {
        result.loggedIn = true;
        result.details.push('Eingeloggt bei ChatGPT');
        result.invoiceAreaAccessible = true;
        result.details.push('Settings zugänglich');
      } else {
        result.message = 'Nicht eingeloggt bei ChatGPT. Bitte im Browser-Fenster einloggen.';
        await launchVisibleBrowser();
      }

      result.message = result.loggedIn
        ? 'Verbunden mit ChatGPT — bereit für Rechnungssammlung'
        : 'Nicht eingeloggt bei ChatGPT';
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
      const pages = await browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();

      // Configure download path via CDP
      const cdp = await page.createCDPSession();
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

      onProgress?.('Verbindung hergestellt');

      // 1. Navigate to ChatGPT settings
      onProgress?.('Öffne ChatGPT Settings...');
      await page.goto(CHATGPT_SETTINGS_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
      await this.waitForCloudflare(page, onProgress);

      // Check if logged in
      const isLoggedIn = await page.evaluate(`
        (() => {
          const body = document.body.innerText || '';
          return body.includes('Manage') && body.includes('Plus');
        })()
      `) as boolean;

      if (!isLoggedIn) {
        await launchVisibleBrowser();
        onProgress?.('Login erforderlich — bitte im Browser-Fenster einloggen');
        return { status: 'waiting_for_login', files: [], errorMessage: 'Login erforderlich' };
      }

      // 2. Click the Payment "Manage" button to go to Stripe billing portal
      onProgress?.('Öffne Stripe Billing Portal...');
      await page.evaluate(`
        (() => {
          const btns = [...document.querySelectorAll('button')];
          const manageBtns = btns.filter(b => b.textContent.trim() === 'Manage');
          // Second "Manage" = Payment section
          if (manageBtns.length >= 2) manageBtns[1].click();
          else if (manageBtns.length === 1) manageBtns[0].click();
        })()
      `);

      // Wait for navigation to pay.openai.com
      await new Promise(r => setTimeout(r, 8000));

      // Verify we're on the Stripe billing page
      const currentUrl = page.url();
      if (!currentUrl.includes('pay.openai.com') && !currentUrl.includes('billing.stripe.com')) {
        onProgress?.(`Unerwartete Seite: ${currentUrl}`);
        return { status: 'failed', files: [], errorMessage: `Stripe Billing Portal nicht erreicht: ${currentUrl}` };
      }

      onProgress?.('Stripe Billing Portal geöffnet');

      // 3. Parse invoice history from the page
      const invoices = await this.parseInvoiceHistory(page);
      onProgress?.(`${invoices.length} Rechnungen gefunden`);

      // 4. Check for "View more" and load additional invoices if needed
      const needsOlder = invoices.length > 0 && invoices.every(inv => {
        if (!inv.date) return false;
        return inv.date > new Date(dateRange.start);
      });
      if (needsOlder) {
        const hasViewMore = await page.evaluate(`
          (() => {
            const btns = [...document.querySelectorAll('button')];
            const viewMore = btns.find(b => b.textContent.trim() === 'View more');
            if (viewMore) { viewMore.click(); return true; }
            return false;
          })()
        `) as boolean;
        if (hasViewMore) {
          onProgress?.('Lade ältere Rechnungen...');
          await new Promise(r => setTimeout(r, 3000));
          const moreInvoices = await this.parseInvoiceHistory(page);
          // Merge, dedup by URL
          const urls = new Set(invoices.map(i => i.viewUrl));
          for (const inv of moreInvoices) {
            if (!urls.has(inv.viewUrl)) invoices.push(inv);
          }
          onProgress?.(`${invoices.length} Rechnungen insgesamt`);
        }
      }

      // 5. Filter by date range, skip €0.00 invoices
      const matching = invoices.filter(inv => {
        if (!inv.date) return false;
        if (inv.amount === '€0.00' || inv.amount === '$0.00') return false;
        return isInRange(inv.date, dateRange.start, dateRange.end);
      });

      onProgress?.(`${matching.length} Rechnungen im Zeitraum ${dateRange.start} bis ${dateRange.end}`);

      if (matching.length === 0) {
        return { status: 'completed', files: [] };
      }

      // 6. Download each matching invoice from Stripe
      for (let i = 0; i < matching.length; i++) {
        const inv = matching[i];
        onProgress?.(`[${i + 1}/${matching.length}] Lade Rechnung ${inv.label} (${inv.amount})...`);

        try {
          const file = await this.downloadStripeInvoice(page, cdp, inv, downloadDir, onProgress);
          if (file) files.push(file);
          else onProgress?.(`Warnung: Download für ${inv.label} fehlgeschlagen`);
        } catch (err: any) {
          onProgress?.(`Fehler bei ${inv.label}: ${err.message}`);
        }
      }

      onProgress?.(`Sammlung abgeschlossen: ${files.length} Datei(en) heruntergeladen`);
      return {
        status: files.length > 0 ? 'completed' : 'failed',
        files,
        errorMessage: files.length === 0 ? 'Keine Rechnungen heruntergeladen' : undefined,
      };
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

  // ==================== Helpers ====================

  private async waitForCloudflare(page: Page, onProgress?: (msg: string) => void): Promise<void> {
    const maxWaitMs = 30_000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const title = await page.title();
      if (!title.toLowerCase().includes('just a moment')) return;
      onProgress?.('Cloudflare-Check wird abgewartet...');
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  private async parseInvoiceHistory(page: Page): Promise<InvoiceEntry[]> {
    const refYear = new Date().getFullYear();
    const raw = await page.evaluate(`
      (() => {
        const results = [];
        // Invoice links go to invoice.stripe.com
        const links = [...document.querySelectorAll('a')];
        for (const a of links) {
          if (!a.href.includes('invoice.stripe.com')) continue;
          const text = (a.textContent || '').trim();
          results.push({ text, href: a.href });
        }
        return results;
      })()
    `) as Array<{ text: string; href: string }>;

    return raw.map(r => {
      // Text pattern: "Feb 15€19.17PaidChatGPT Plus Subscription (per seat)"
      const match = r.text.match(/^([A-Za-zä]{3}\s+\d{1,2})([\s€$\d.,]+)(Paid|Open|Draft|Void)(.*)/);
      if (!match) return null;
      const label = match[1].trim();
      const amount = match[2].trim();
      const status = match[3].trim();
      const description = match[4].trim();
      return {
        label,
        amount,
        status,
        description,
        viewUrl: r.href,
        date: parseShortDate(label, refYear),
      };
    }).filter((e): e is InvoiceEntry => e !== null);
  }

  private async downloadStripeInvoice(
    page: Page, cdp: any, invoice: InvoiceEntry,
    downloadDir: string, onProgress?: (msg: string) => void,
  ): Promise<OpenclawFileResult | null> {
    const filesBefore = new Set(existsSync(downloadDir) ? readdirSync(downloadDir) : []);

    await page.goto(invoice.viewUrl, { waitUntil: 'networkidle2', timeout: 20_000 });
    await new Promise(r => setTimeout(r, 3000));

    const clicked = await page.evaluate(`
      (() => {
        const btns = [...document.querySelectorAll('button')];
        const dlBtn = btns.find(b => (b.textContent || '').trim() === 'Download invoice');
        if (dlBtn) { dlBtn.click(); return true; }
        return false;
      })()
    `) as boolean;

    if (!clicked) {
      onProgress?.(`Download-Button nicht gefunden auf Stripe-Seite`);
      return null;
    }

    const newFile = await this.waitForDownload(downloadDir, filesBefore, onProgress);
    if (!newFile) return null;

    return {
      filename: path.basename(newFile),
      localPath: newFile,
      invoiceDate: invoice.date?.toISOString().slice(0, 10),
      supplierHint: 'OpenAI ChatGPT',
    };
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
            onProgress?.(`Download abgeschlossen: ${f} (${(size / 1024).toFixed(0)} KB)`);
            return filePath;
          }
        } catch {}
      }
    }
    onProgress?.('Download-Timeout (30s)');
    return null;
  }
}
