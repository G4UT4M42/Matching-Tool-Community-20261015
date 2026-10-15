/**
 * Spotify portal adapter.
 *
 * Deterministic Puppeteer-based — no AI/LLM needed.
 *
 * Flow:
 *  1. Navigate to https://www.spotify.com/account/subscription/receipt/
 *  2. Check if logged in (redirect to login → needs_manual_login)
 *  3. Parse receipt list (date, amount, receipt link)
 *  4. For each receipt in date range: click → download PDF or take screenshot
 *
 * Login: Uses existing Spotify session (user must be logged in via spotify.com).
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

const RECEIPTS_URL = 'https://www.spotify.com/at/account/order-history/';

interface SpotifyReceipt {
  date: string;       // e.g. "25. Jan. 2025"
  amount: string;     // e.g. "10,99 €"
  amountCents: number;
  link: string;       // URL to individual receipt
  parsedDate: Date | null;
}

function parseSpotifyDate(text: string): Date | null {
  // Format: "25.3.26" (DD.M.YY) or "25.03.2025" (DD.MM.YYYY)
  const m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (m) {
    const day = parseInt(m[1]);
    const month = parseInt(m[2]) - 1; // 0-indexed
    let year = parseInt(m[3]);
    if (year < 100) year += 2000; // 26 → 2026
    return new Date(year, month, day);
  }
  // Fallback: "25. Jan. 2025"
  const monthMap: Record<string, number> = {
    'jan': 0, 'feb': 1, 'mär': 2, 'mar': 2, 'apr': 3, 'mai': 4, 'may': 4,
    'jun': 5, 'jul': 6, 'aug': 7, 'sep': 8, 'okt': 9, 'oct': 9,
    'nov': 10, 'dez': 11, 'dec': 11,
  };
  const m2 = text.match(/(\d{1,2})\.?\s*(\w{3,})\.?\s*(\d{4})/);
  if (m2) {
    const month = monthMap[m2[2].toLowerCase().slice(0, 3)];
    if (month !== undefined) return new Date(parseInt(m2[3]), month, parseInt(m2[1]));
  }
  return null;
}

function parseAmount(text: string): number {
  // "10,99 €" or "€10.99" or "10.99"
  const cleaned = text.replace(/[€$\s]/g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : Math.round(val * 100);
}

function isInRange(date: Date, start: string, end: string): boolean {
  return date >= new Date(start + 'T00:00:00') && date <= new Date(end + 'T23:59:59');
}

export class SpotifyAdapter implements PortalAdapter {
  readonly portalType: PortalType = 'spotify' as PortalType;

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
      await pg.goto(RECEIPTS_URL, { waitUntil: 'networkidle2', timeout: 20_000 });
      await new Promise(r => setTimeout(r, 3000));
      result.portalReachable = true;

      const url = pg.url();
      if (url.includes('/login') || url.includes('accounts.spotify.com')) {
        result.message = 'Nicht eingeloggt — bitte bei spotify.com einloggen.';
      } else {
        result.loggedIn = true;
        result.invoiceAreaAccessible = true;
        result.message = 'Spotify Session aktiv.';
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
      const page = await browser.newPage();

      // Set download behavior
      if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });
      const client = await page.createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
      });

      onProgress?.('Verbindung hergestellt');

      // Navigate to receipts page
      await page.goto(RECEIPTS_URL, { waitUntil: 'networkidle2', timeout: 20_000 });
      await new Promise(r => setTimeout(r, 3000));

      // Check if logged in
      if (page.url().includes('/login') || page.url().includes('accounts.spotify.com')) {
        // Try Google SSO first, then autofill
        const { attemptAutoLogin, attemptGoogleSSOLogin } = await import('./auto-login.js');

        // Check for "Continue with Google" button
        const hasGoogleSSO = await page.evaluate(`
          !!document.querySelector('[data-testid="google-login"], button[data-social="google"], a[href*="google"], span')
          && document.body.innerText.includes('Google')
        `);

        let loginResult;
        if (hasGoogleSSO) {
          onProgress?.('Versuche Google SSO Login...');
          loginResult = await attemptGoogleSSOLogin(page, browser);
          onProgress?.(`Google SSO: ${loginResult.status}`);
        }

        if (!loginResult || loginResult.status === 'needs_manual_login') {
          onProgress?.('Versuche Auto-Login...');
          loginResult = await attemptAutoLogin(page);
          onProgress?.(`Auto-Login: ${loginResult.status}`);
        }

        if (loginResult.status === 'needs_manual_login' || loginResult.status === 'login_failed') {
          throw new Error('Spotify Login erforderlich — bitte manuell bei spotify.com einloggen.');
        }

        await page.goto(RECEIPTS_URL, { waitUntil: 'networkidle2', timeout: 20_000 });
        await new Promise(r => setTimeout(r, 3000));
      }

      onProgress?.('Lade Rechnungsbelege...');

      // Parse receipts from ALL pages (paginate with next button)
      const receipts: Array<{ date: string; amount: string; link: string }> = [];
      const seenDates = new Set<string>();
      let pageNum = 0;
      const MAX_PAGES = 24; // 2 years of monthly receipts

      while (pageNum < MAX_PAGES) {
        pageNum++;
        const pageReceipts = await page.evaluate(`
          (() => {
            var items = [];
            var rows = document.querySelectorAll('[data-testid="invoice-table"] tr, table tr');
            for (var row of rows) {
              var text = row.textContent || '';
              var dateMatch = text.match(/(\\d{1,2}\\.\\d{1,2}\\.\\d{2,4})/);
              var amountMatch = text.match(/€\\s*(\\d+[.,]\\d{2})/);
              if (!amountMatch) amountMatch = text.match(/(\\d+[.,]\\d{2})\\s*€/);
              var linkEl = row.querySelector('a');
              var link = linkEl ? linkEl.href : '';
              if (dateMatch && amountMatch) {
                items.push({ date: dateMatch[1], amount: amountMatch[0], link: link });
              }
            }
            return items;
          })()
        `) as Array<{ date: string; amount: string; link: string }>;

        let newCount = 0;
        for (const r of pageReceipts) {
          if (!seenDates.has(r.date)) {
            seenDates.add(r.date);
            receipts.push(r);
            newCount++;
          }
        }

        if (newCount > 0) {
          onProgress?.(`Seite ${pageNum}: ${newCount} neue Belege (gesamt: ${receipts.length})`);
        }

        // Check if oldest receipt is before our date range start → stop
        const oldestOnPage = pageReceipts.map(r => parseSpotifyDate(r.date)).filter(Boolean) as Date[];
        if (oldestOnPage.length > 0) {
          const oldest = oldestOnPage.reduce((a, b) => a < b ? a : b);
          if (oldest < new Date(dateStart + 'T00:00:00')) {
            onProgress?.('Ältere Belege als Startzeitpunkt erreicht');
            break;
          }
        }

        // Click "Next page" button
        const hasNext = await page.evaluate(`
          (() => {
            var btn = document.querySelector('[data-testid="invoice-pagination-next"]');
            if (btn && !btn.disabled) { btn.click(); return true; }
            return false;
          })()
        `);
        if (!hasNext) {
          onProgress?.('Letzte Seite erreicht');
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      onProgress?.(`${receipts.length} Belege gefunden (${pageNum} Seiten)`);

      // Parse and filter by date range
      const parsed: SpotifyReceipt[] = receipts.map(r => ({
        ...r,
        amountCents: parseAmount(r.amount),
        parsedDate: parseSpotifyDate(r.date),
      }));

      const matching = parsed.filter(r => r.parsedDate && isInRange(r.parsedDate, dateStart, dateEnd));
      onProgress?.(`${matching.length} Belege im Zeitraum ${dateStart} — ${dateEnd}`);

      // Download each receipt (screenshot as fallback)
      for (const receipt of matching) {
        const dateKey = receipt.parsedDate!.toISOString().slice(0, 10);
        const filename = `Spotify-Rechnung-${dateKey}.png`;
        const filePath = path.join(downloadDir, filename);

        if (existsSync(filePath)) {
          onProgress?.(`${dateKey}: bereits vorhanden, übersprungen`);
          continue;
        }

        try {
          if (receipt.link) {
            // Navigate to individual receipt page
            await page.goto(receipt.link, { waitUntil: 'networkidle2', timeout: 15_000 });
            await new Promise(r => setTimeout(r, 2000));
          }

          // Take screenshot as receipt
          await page.screenshot({ path: filePath, fullPage: true });

          files.push({
            filename,
            localPath: filePath,
            invoiceDate: dateKey,
            supplierHint: 'Spotify',
          });
          onProgress?.(`${dateKey}: ${receipt.amount} gespeichert`);
        } catch (err: any) {
          onProgress?.(`${dateKey}: Fehler — ${err.message}`);
        }
      }

      // If no receipt links found, take screenshot of receipts overview
      if (files.length === 0 && matching.length > 0) {
        onProgress?.('Keine individuellen Belege — Screenshot der Übersicht...');
        await page.goto(RECEIPTS_URL, { waitUntil: 'networkidle2', timeout: 15_000 });
        await new Promise(r => setTimeout(r, 2000));

        const dateKey = matching[0].parsedDate!.toISOString().slice(0, 10);
        const filename = `Spotify-Belege-${dateKey}.png`;
        const filePath = path.join(downloadDir, filename);
        await page.screenshot({ path: filePath, fullPage: true });
        files.push({ filename, localPath: filePath, invoiceDate: dateKey, supplierHint: 'Spotify' });
        onProgress?.('Screenshot der Rechnungsübersicht gespeichert');
      }

      await page.close();
    } finally {
      await browser.disconnect();
    }

    return {
      status: 'completed' as const,
      files,
    };
  }
}
