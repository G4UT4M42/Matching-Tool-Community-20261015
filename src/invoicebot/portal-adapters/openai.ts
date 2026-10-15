/**
 * OpenAI Platform portal adapter.
 *
 * Deterministic Puppeteer-based adapter — no AI/LLM needed.
 *
 * Flow:
 *  1. Navigate to platform.openai.com login
 *  2. If not logged in → click "Continue with Google" (SSO auto-pick)
 *  3. Navigate to Billing History
 *  4. Parse invoice table (Invoice#, Status, Amount, Created, View link)
 *  5. Filter by requested date range
 *  6. For each matching invoice → open Stripe invoice page → click "Download invoice"
 *  7. Wait for PDF download → collect file
 *
 * The "View" links point to invoice.stripe.com hosted pages that have
 * "Download invoice" and "Download receipt" buttons.
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

const BILLING_HISTORY_URL = 'https://platform.openai.com/settings/organization/billing/history';
const LOGIN_URL = 'https://platform.openai.com/login';
const PLATFORM_HOST = 'platform.openai.com';

/** Check if the URL indicates a login/auth redirect */
function isLoginPage(url: string): boolean {
  return url.includes('/login') || url.includes('/auth') || url.includes('accounts.google.com');
}

/** Parse a German-locale date string like "23. Aug. 2024, 12:21" into a Date */
function parseOpenAIDate(text: string): Date | null {
  if (!text) return null;
  // OpenAI shows dates in the browser's locale. Common formats:
  // German: "23. Aug. 2024, 12:21" or "19. März 2024, 22:37"
  // English: "Aug 23, 2024, 12:21 PM"
  const deMonths: Record<string, number> = {
    'jan': 0, 'feb': 1, 'mär': 2, 'mar': 2, 'apr': 3, 'mai': 4, 'may': 4,
    'jun': 5, 'jul': 6, 'aug': 7, 'sep': 8, 'okt': 9, 'oct': 9,
    'nov': 10, 'dez': 11, 'dec': 11,
  };

  // Try German: "23. Aug. 2024" or "19. März 2024" (Unicode-aware for umlauts)
  const deMatch = text.match(/(\d{1,2})\.\s*([A-Za-z\u00C0-\u024F]{3,})\s*\.?\s*(\d{4})/);
  if (deMatch) {
    const day = parseInt(deMatch[1]);
    const monthKey = deMatch[2].toLowerCase().slice(0, 3);
    const year = parseInt(deMatch[3]);
    const month = deMonths[monthKey];
    if (month !== undefined) return new Date(year, month, day);
  }

  // Try English: "Aug 23, 2024"
  const enMatch = text.match(/([A-Za-z\u00C0-\u024F]{3,})\s+(\d{1,2}),?\s+(\d{4})/);
  if (enMatch) {
    const monthKey = enMatch[1].toLowerCase().slice(0, 3);
    const day = parseInt(enMatch[2]);
    const year = parseInt(enMatch[3]);
    const month = deMonths[monthKey];
    if (month !== undefined) return new Date(year, month, day);
  }

  // Fallback
  const d = new Date(text);
  return isNaN(d.getTime()) ? null : d;
}

/** Check if a date falls within a range (inclusive, date-only comparison) */
function isInRange(date: Date, start: string, end: string): boolean {
  const startDate = new Date(start + 'T00:00:00');
  const endDate = new Date(end + 'T23:59:59');
  return date >= startDate && date <= endDate;
}

interface InvoiceRow {
  invoiceNumber: string;
  status: string;
  amount: string;
  created: string;
  createdDate: Date | null;
  viewUrl: string;
}

export class OpenAIAdapter implements PortalAdapter {
  readonly portalType: PortalType = 'openai' as PortalType;

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

      // Navigate to billing history directly
      try {
        await page.goto(BILLING_HISTORY_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await new Promise(r => setTimeout(r, 2000));
        result.portalReachable = true;
        result.details.push('platform.openai.com erreichbar');
      } catch (err: any) {
        result.message = `OpenAI nicht erreichbar: ${err.message}`;
        return result;
      }

      // Check if we got redirected to login
      if (isLoginPage(page.url())) {
        result.details.push('Nicht eingeloggt, versuche Google SSO...');
        const loginOk = await this.attemptGoogleSSO(page);
        if (loginOk) {
          // Navigate again after login
          await page.goto(BILLING_HISTORY_URL, { waitUntil: 'networkidle2', timeout: 15_000 });
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // Verify we're on billing page
      if (isLoginPage(page.url())) {
        await launchVisibleBrowser();
        result.message = 'Login erforderlich — Chrome-Fenster wurde geöffnet. Bitte bei OpenAI einloggen.';
        return result;
      }

      result.loggedIn = true;
      result.details.push('Eingeloggt bei OpenAI');

      // Check billing history accessible
      if (page.url().includes('billing')) {
        result.invoiceAreaAccessible = true;
        result.details.push('Billing History zugänglich');
      }

      result.message = result.loggedIn && result.invoiceAreaAccessible
        ? 'Verbunden mit OpenAI — bereit für Rechnungssammlung'
        : 'Eingeloggt bei OpenAI, aber Billing History nicht erreichbar';
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

      // Navigate to billing history
      onProgress?.('Öffne OpenAI Billing History...');
      await page.goto(BILLING_HISTORY_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
      await this.waitForCloudflare(page, onProgress);

      // Handle login if redirected
      if (isLoginPage(page.url())) {
        onProgress?.('Login-Umleitung erkannt, versuche Google SSO...');
        const loginOk = await this.attemptGoogleSSO(page);
        if (loginOk) {
          onProgress?.('Google SSO erfolgreich');
          await page.goto(BILLING_HISTORY_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
          await this.waitForCloudflare(page, onProgress);
        }
        if (isLoginPage(page.url())) {
          await launchVisibleBrowser();
          onProgress?.('Login erforderlich — bitte im Browser-Fenster einloggen');
          return { status: 'waiting_for_login', files: [], errorMessage: 'Login erforderlich' };
        }
      }

      // Verify we're on billing history
      const pageTitle = await page.title();
      if (!pageTitle.toLowerCase().includes('billing')) {
        onProgress?.(`Unerwartete Seite: ${pageTitle}`);
        return { status: 'failed', files: [], errorMessage: `Falsche Seite: ${pageTitle}` };
      }

      // Parse invoice table
      onProgress?.('Lese Rechnungstabelle...');
      const invoices = await this.parseInvoiceTable(page);
      onProgress?.(`${invoices.length} Rechnungen gefunden`);

      // Filter by date range
      const matching = invoices.filter(inv => {
        if (!inv.createdDate) return false;
        return isInRange(inv.createdDate, dateRange.start, dateRange.end);
      });

      onProgress?.(`${matching.length} Rechnungen im Zeitraum ${dateRange.start} bis ${dateRange.end}`);

      if (matching.length === 0) {
        // Don't close — reuse the existing page for future runs
        return { status: 'completed', files: [] };
      }

      // Download each matching invoice
      for (let i = 0; i < matching.length; i++) {
        const inv = matching[i];
        onProgress?.(`[${i + 1}/${matching.length}] Lade Rechnung ${inv.invoiceNumber} (${inv.amount})...`);

        try {
          const file = await this.downloadStripeInvoice(page, cdp, inv, downloadDir, onProgress);
          if (file) {
            files.push(file);
          } else {
            onProgress?.(`Warnung: Download für ${inv.invoiceNumber} fehlgeschlagen`);
          }
        } catch (err: any) {
          onProgress?.(`Fehler bei ${inv.invoiceNumber}: ${err.message}`);
        }
      }

      await page.close();

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
      if (err.message?.includes('Session') || err.message?.includes('login')) {
        throw new SessionExpiredError(portal.name);
      }
      return {
        status: files.length > 0 ? 'partial' : 'failed',
        files, errorMessage: err.message,
      };
    } finally {
      if (browser) browser.disconnect();
    }
  }

  // ==================== Google SSO ====================

  /**
   * Attempt Google SSO login.
   * Clicks "Continue with Google" on OpenAI login page.
   * If Google shows an account picker, clicks the first account ("Continue as ...").
   * Returns true if login succeeded.
   */
  private async attemptGoogleSSO(page: Page): Promise<boolean> {
    try {
      // Look for "Continue with Google" button
      const clicked = await page.evaluate(`
        (() => {
          const btns = [...document.querySelectorAll('button')];
          const googleBtn = btns.find(b => b.textContent?.includes('Continue with Google'));
          if (googleBtn) { googleBtn.click(); return true; }
          return false;
        })()
      `) as boolean;

      if (!clicked) return false;

      // Wait for Google to process (may auto-redirect if session exists)
      await new Promise(r => setTimeout(r, 5000));

      // Check if we landed on Google account picker
      if (page.url().includes('accounts.google.com')) {
        // Look for account selector or "Continue as" button
        await new Promise(r => setTimeout(r, 2000));

        const accountClicked = await page.evaluate(`
          (() => {
            // Account picker: click first account (div with data-email)
            const accounts = document.querySelectorAll('div[data-email]');
            if (accounts.length > 0) { accounts[0].click(); return true; }
            // Or "Continue as..." button
            const btns = [...document.querySelectorAll('button')];
            const continueBtn = btns.find(b => b.textContent?.includes('Continue') || b.textContent?.includes('Weiter'));
            if (continueBtn) { continueBtn.click(); return true; }
            // Or li[data-authuser] items
            const items = document.querySelectorAll('li[data-authuser]');
            if (items.length > 0) { items[0].click(); return true; }
            return false;
          })()
        `) as boolean;

        if (accountClicked) {
          // Wait for redirect back to OpenAI
          try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 });
          } catch {
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      }

      // Wait a moment for potential additional redirect
      await new Promise(r => setTimeout(r, 2000));

      // Check if we're back on OpenAI (not login page)
      return !isLoginPage(page.url());
    } catch {
      return false;
    }
  }

  // ==================== Cloudflare / bot-protection wait ====================

  /**
   * Wait for Cloudflare "Just a moment..." challenge to resolve.
   * The visible bot-browser typically has the CF cookie already,
   * but new page navigations may briefly show the interstitial.
   */
  private async waitForCloudflare(page: Page, onProgress?: (msg: string) => void): Promise<void> {
    const maxWaitMs = 30_000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const title = await page.title();
      if (!title.toLowerCase().includes('just a moment')) return;
      onProgress?.('Cloudflare-Check wird abgewartet...');
      await new Promise(r => setTimeout(r, 3000));
    }
    // If still stuck, continue anyway — the caller will detect the wrong page
  }

  // ==================== Invoice table parsing ====================

  private async parseInvoiceTable(page: Page): Promise<InvoiceRow[]> {
    const rawRows = await page.evaluate(`
      (() => {
        const rows = [];
        for (const tr of document.querySelectorAll('table tr')) {
          const cells = [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim());
          if (cells.length === 0) continue;
          const viewLink = tr.querySelector('a');
          const viewUrl = viewLink ? viewLink.href : '';
          rows.push({ cells, viewUrl });
        }
        return rows;
      })()
    `) as Array<{ cells: string[]; viewUrl: string }>;

    return rawRows.map(row => {
      // Table: Invoice | Status | Amount | Created | (View link)
      const [invoiceNumber, status, amount, created] = row.cells;
      return {
        invoiceNumber: invoiceNumber ?? '',
        status: status ?? '',
        amount: amount ?? '',
        created: created ?? '',
        createdDate: parseOpenAIDate(created ?? ''),
        viewUrl: row.viewUrl,
      };
    }).filter(r => r.viewUrl && r.invoiceNumber);
  }

  // ==================== Stripe download ====================

  /**
   * Navigate to the Stripe invoice page and click "Download invoice".
   * Returns the downloaded file info, or null on failure.
   */
  private async downloadStripeInvoice(
    page: Page,
    cdp: any,
    invoice: InvoiceRow,
    downloadDir: string,
    onProgress?: (msg: string) => void,
  ): Promise<OpenclawFileResult | null> {
    // Track files before download
    const filesBefore = new Set(existsSync(downloadDir) ? readdirSync(downloadDir) : []);

    // Navigate to Stripe invoice page
    await page.goto(invoice.viewUrl, { waitUntil: 'networkidle2', timeout: 20_000 });
    await new Promise(r => setTimeout(r, 3000));

    // Click "Download invoice" button
    const clicked = await page.evaluate(`
      (() => {
        const btns = [...document.querySelectorAll('button')];
        const dlBtn = btns.find(b => (b.textContent || '').trim() === 'Download invoice');
        if (dlBtn) { dlBtn.click(); return true; }
        return false;
      })()
    `) as boolean;

    if (!clicked) {
      onProgress?.(`Download-Button nicht gefunden auf Stripe-Seite für ${invoice.invoiceNumber}`);
      return null;
    }

    // Wait for download
    const newFile = await this.waitForDownloadComplete(downloadDir, filesBefore, onProgress);
    if (!newFile) return null;

    const filename = path.basename(newFile);
    return {
      filename,
      localPath: newFile,
      invoiceDate: invoice.createdDate?.toISOString().slice(0, 10),
      supplierHint: 'OpenAI',
    };
  }

  /**
   * Wait for a new file to appear in the download directory.
   * Timeout after 30 seconds (Stripe PDFs are small).
   */
  private async waitForDownloadComplete(
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
