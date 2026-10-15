/**
 * Amazon Business portal adapter.
 *
 * Uses the ABA (Amazon Business Analytics) reports page to bulk-download invoices.
 * Flow: open reports → set date range → select all on page → download selected → next page → repeat.
 *
 * Session-first: User must log in manually before running collection.
 * When login is needed, Chrome relaunches with a visible window.
 */
import type {
  PortalConfig, PortalAdapter, SessionCheckResult,
  OpenclawRunResult, OpenclawFileResult, PortalType,
} from '../types.js';
import { connectBrowser, isBrowserReachable, launchVisibleBrowser } from '../openclaw-client.js';
import {
  BrowserConnectionError, SessionExpiredError,
} from '../errors.js';
import { attemptAutoLogin } from './auto-login.js';
import type { Browser, Page } from 'puppeteer-core';
import { existsSync, readdirSync, mkdirSync, statSync } from 'fs';
import path from 'path';

/** Build the ABA reports URL */
function buildAbaUrl(baseUrl: string): string {
  const domain = new URL(baseUrl).hostname;
  return `https://${domain}/b2b/aba/reports?reportType=items_report_1&dateSpanSelection=MONTH_TO_DATE`;
}

/**
 * Choose the best predefined date range that covers the requested range.
 * Returns the option text to click, or null if "Monatsbeginn bis heute" is fine.
 */
function chooseDateRange(start: string, end: string): string | null {
  const now = new Date();
  const startDate = new Date(start);
  const endDate = new Date(end);
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const startYear = startDate.getFullYear();
  const startMonth = startDate.getMonth();

  // Same month as now → "Monatsbeginn bis heute" (default)
  if (
    startYear === currentYear
    && startMonth === currentMonth
    && endDate >= now
  ) return null;
  // Last month only → "Letzter Monat"
  const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1;
  const lastMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;
  const lastMonthEnd = new Date(currentYear, currentMonth, 0);
  if (
    startYear === lastMonthYear
    && startMonth === lastMonth
    && endDate.getFullYear() === lastMonthEnd.getFullYear()
    && endDate.getMonth() === lastMonthEnd.getMonth()
    && endDate.getDate() === lastMonthEnd.getDate()
  ) return 'Letzter Monat';
  // Year-to-date only when the requested end includes today.
  if (
    startYear === currentYear
    && startMonth === 0
    && startDate.getDate() === 1
    && endDate >= now
  ) return 'Jahresbeginn bis heute';
  return 'Benutzerdefinierter Zeitraum';
}

function formatGermanDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

/** Check if the current page URL indicates a login redirect */
function isLoginRedirect(url: string): boolean {
  return url.includes('signin') || url.includes('ap/signin') || url.includes('/ap/') || url.includes('auth-ui');
}

/** Launch visible browser window so user can log in manually */
async function openVisibleForLogin(msg: string, onProgress?: (msg: string) => void): Promise<void> {
  onProgress?.('Login nötig — Chrome-Fenster wird geöffnet...');
  await launchVisibleBrowser();
  onProgress?.(msg);
}

export class AmazonBusinessAdapter implements PortalAdapter {
  readonly portalType: PortalType = 'amazon';

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
      const domain = new URL(portal.baseUrl).hostname;

      // Portal reachable?
      try {
        await page.goto(`https://${domain}/`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        result.portalReachable = true;
        result.details.push(`${domain} erreichbar`);
      } catch (err: any) {
        result.message = `Amazon nicht erreichbar: ${err.message}`;
        return result;
      }

      // Login check
      const accountText = await page.evaluate(`
        (() => {
          const el = document.querySelector('#nav-link-accountList-nav-line-1');
          return el ? el.textContent.trim() : '';
        })()
      `) as string;

      if (accountText && !accountText.includes('Anmelden') && !accountText.includes('Sign in')) {
        result.loggedIn = true;
        result.details.push(`Eingeloggt als: ${accountText}`);
      } else {
        // Try auto-login
        result.details.push('Nicht eingeloggt, versuche Auto-Login...');
        await page.goto(`https://${domain}/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2F${domain}%2F`, {
          waitUntil: 'domcontentloaded', timeout: 15_000,
        });
        const loginResult = await attemptAutoLogin(page);
        if (loginResult.status === 'login_successful' || loginResult.status === 'already_logged_in') {
          result.loggedIn = true;
          result.details.push('Auto-Login erfolgreich');
        } else {
          await openVisibleForLogin('Bitte im Browser-Fenster einloggen.');
          result.message = loginResult.message + ' — Chrome-Fenster wurde geöffnet.';
          result.details.push(loginResult.message);
          return result;
        }
      }

      // Check ABA page accessible
      try {
        await page.goto('https://' + domain + '/b2b/aba/reports?reportType=items_report_1', {
          waitUntil: 'domcontentloaded', timeout: 15_000,
        });
        if (isLoginRedirect(page.url())) {
          result.message = 'Session abgelaufen — bitte erneut einloggen';
          result.loggedIn = false;
          return result;
        }
        const title = await page.title();
        if (title.includes('Beschaffungsanalysen') || title.includes('Analytics')) {
          result.invoiceAreaAccessible = true;
          result.details.push('Beschaffungsanalysen zugänglich');
        } else {
          result.details.push(`Unerwartete Seite: ${title}`);
        }
      } catch {
        result.details.push('Beschaffungsanalysen nicht erreichbar');
      }

      result.message = result.loggedIn && result.invoiceAreaAccessible
        ? `Verbunden mit ${domain} — bereit für Rechnungssammlung`
        : `Eingeloggt bei ${domain}, aber Beschaffungsanalysen nicht erreichbar`;
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
      const page = await browser.newPage();

      // Configure download path
      const cdp = await page.createCDPSession();
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

      onProgress?.('Verbindung hergestellt');

      // Navigate to ABA reports page
      const abaUrl = buildAbaUrl(portal.baseUrl);
      onProgress?.(`Öffne Beschaffungsanalysen...`);
      await page.goto(abaUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
      await new Promise(r => setTimeout(r, 3000));

      // Check for login redirect
      if (isLoginRedirect(page.url())) {
        onProgress?.('Login-Umleitung erkannt, versuche Auto-Login...');
        const loginResult = await attemptAutoLogin(page);
        if (loginResult.status === 'login_successful' || loginResult.status === 'already_logged_in') {
          await page.goto(abaUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
          await new Promise(r => setTimeout(r, 3000));
        }
        if (isLoginRedirect(page.url())) {
          await openVisibleForLogin('Bitte im Browser-Fenster bei Amazon einloggen.', onProgress);
          return { status: 'waiting_for_login', files: [], errorMessage: 'Login erforderlich' };
        }
      }

      // Verify we're on the ABA page
      const title = await page.title();
      if (!title.includes('Beschaffungsanalysen') && !title.includes('Analytics')) {
        onProgress?.(`Unerwartete Seite: ${title}`);
        return { status: 'failed', files: [], errorMessage: `Falsche Seite: ${title}` };
      }

      // Select the right date range
      const targetRange = chooseDateRange(dateRange.start, dateRange.end);
      if (targetRange) {
        onProgress?.(`Wähle Zeitraum: ${targetRange}...`);
        // Open date dropdown
        await page.evaluate(`document.getElementById('date_range_selector__range')?.click()`);
        await new Promise(r => setTimeout(r, 1000));
        // Click the target option
        const rangeClicked = await page.evaluate(`
          (() => {
            const target = '${targetRange}';
            const links = [...document.querySelectorAll('a')];
            const opt = links.find(a => a.textContent.trim() === target);
            if (opt) { opt.click(); return true; }
            return false;
          })()
        `) as boolean;
        if (rangeClicked) {
          if (targetRange === 'Benutzerdefinierter Zeitraum') {
            await new Promise(r => setTimeout(r, 500));
            const textInputs = await page.$$('input[type="text"]');
            const dateInputs = [];
            for (const input of textInputs) {
              const isDateInput = await input.evaluate(
                element => element.offsetParent !== null && element.id !== 'twotabsearchtextbox',
              );
              if (isDateInput) dateInputs.push(input);
            }
            const applyButton = await page.$('button[data-testid="submit-button"]');
            if (dateInputs.length < 2 || !applyButton) {
              return {
                status: 'failed',
                files: [],
                errorMessage: 'Benutzerdefinierter Datumsbereich konnte nicht gesetzt werden',
              };
            }
            const values = [
              formatGermanDate(dateRange.start),
              formatGermanDate(dateRange.end),
            ];
            for (let i = 0; i < 2; i++) {
              await dateInputs[i].focus();
              await page.keyboard.down('Control');
              await page.keyboard.press('A');
              await page.keyboard.up('Control');
              await page.keyboard.press('Backspace');
              await dateInputs[i].type(values[i]);
              await dateInputs[i].press('Tab');
            }
            const typedValues = await Promise.all(
              dateInputs.slice(0, 2).map(input => input.evaluate(element => element.value)),
            );
            if (typedValues[0] !== values[0] || typedValues[1] !== values[1]) {
              return {
                status: 'failed',
                files: [],
                errorMessage: `Benutzerdefinierter Datumsbereich wurde nicht übernommen (${typedValues.join(' — ')})`,
              };
            }
            // React DatePicker commits typed values asynchronously. Give both
            // blur handlers time to update state, then click the current button
            // handle rather than the one captured before the re-renders.
            await new Promise(r => setTimeout(r, 1500));
            const currentApplyButton = await page.$('button[data-testid="submit-button"]');
            if (!currentApplyButton) {
              return {
                status: 'failed',
                files: [],
                errorMessage: 'Übernehmen-Button für benutzerdefinierten Zeitraum nicht mehr verfügbar',
              };
            }
            await currentApplyButton.click();
          }
          await new Promise(r => setTimeout(r, 3000)); // Wait for page to reload with new range
        } else {
          onProgress?.(`Zeitraum "${targetRange}" nicht gefunden, verwende Standard`);
        }
      }

      const dateInfo = await page.evaluate(`
        (() => {
          const btn = document.getElementById('date_range_selector__range');
          return btn ? btn.textContent.trim() : '';
        })()
      `) as string;
      onProgress?.(`Datumsbereich: ${dateInfo}`);
      if (targetRange === 'Benutzerdefinierter Zeitraum') {
        const firstOrderDate = await page.evaluate(`
          (() => {
            const match = document.body.innerText.match(/\\b(\\d{2})\\/(\\d{2})\\/(\\d{4})\\b/);
            return match ? match[3] + '-' + match[2] + '-' + match[1] : null;
          })()
        `) as string | null;
        if (firstOrderDate && (
          firstOrderDate < dateRange.start || firstOrderDate > dateRange.end
        )) {
          return {
            status: 'failed',
            files: [],
            errorMessage: `Amazon lieferte ${firstOrderDate} außerhalb des angeforderten Zeitraums`,
          };
        }
      }

      // Process pages
      let pageNum = 0;
      let hasNextPage = true;

      while (hasNextPage) {
        pageNum++;
        onProgress?.(`Seite ${pageNum}...`);

        // Wait for table to load
        await new Promise(r => setTimeout(r, 2000));

        // Count items on page
        const itemCount = await page.evaluate(`
          (() => {
            const cbs = document.querySelectorAll('input[type="checkbox"]');
            // Subtract non-row checkboxes (header checkbox, filter checkboxes)
            let count = 0;
            for (const cb of cbs) {
              const id = cb.id || '';
              if (id.startsWith('aba_ui__checkbox__')) count++;
            }
            return count;
          })()
        `) as number;

        if (itemCount === 0) {
          onProgress?.('Keine Bestellungen auf dieser Seite');
          break;
        }

        onProgress?.(`${itemCount} Einträge gefunden, markiere alle...`);

        // Click the "select all" checkbox in the header (first aba_ui checkbox)
        await page.evaluate(`
          (() => {
            const cbs = document.querySelectorAll('input[type="checkbox"]');
            for (const cb of cbs) {
              if ((cb.id || '').startsWith('aba_ui__checkbox__')) {
                if (!cb.checked) cb.click();
                return true;
              }
            }
            return false;
          })()
        `);
        await new Promise(r => setTimeout(r, 1000));

        // Verify selection count
        const selectedCount = await page.evaluate(`
          (() => {
            const el = document.querySelector('#download-order-documents-dropdown');
            if (!el) return -1;
            // Click to open dropdown
            el.click();
            return 0;
          })()
        `) as number;

        if (selectedCount === -1) {
          onProgress?.('Download-Button nicht gefunden');
          break;
        }

        await new Promise(r => setTimeout(r, 1000));

        // Find and read the "Ausgewählte herunterladen (N)" text to see count
        const dropdownInfo = await page.evaluate(`
          (() => {
            const links = [...document.querySelectorAll('a')];
            const selected = links.find(a => (a.textContent || '').includes('Ausgewählte herunterladen'));
            return selected ? selected.textContent.trim() : '';
          })()
        `) as string;
        onProgress?.(`Dropdown: "${dropdownInfo}"`);

        // Click "Ausgewählte herunterladen"
        const clicked = await page.evaluate(`
          (() => {
            const links = [...document.querySelectorAll('a')];
            const selected = links.find(a => (a.textContent || '').includes('Ausgewählte herunterladen'));
            if (selected && !selected.textContent.includes('(0)')) {
              selected.click();
              return true;
            }
            return false;
          })()
        `) as boolean;

        if (!clicked) {
          onProgress?.('Keine Bestellungen zum Herunterladen ausgewählt');
          // Close dropdown
          await page.evaluate(`document.body.click()`);
          break;
        }

        onProgress?.('Download gestartet, warte auf Abschluss...');

        // Track files before download
        const filesBefore = new Set(existsSync(downloadDir) ? readdirSync(downloadDir) : []);

        // Wait for the new file to appear in download dir
        const newFile = await this.waitForDownloadComplete(downloadDir, filesBefore, onProgress);
        if (newFile) {
          const filename = path.basename(newFile);
          files.push({ filename, localPath: newFile, supplierHint: 'Amazon' });
        }

        // Check if there's a next page
        hasNextPage = await page.evaluate(`
          (() => {
            const buttons = [...document.querySelectorAll('button')];
            const next = buttons.find(b => (b.textContent || '').includes('Nächste Seite'));
            const enabled = next
              && !next.disabled
              && next.getAttribute('aria-disabled') !== 'true'
              && next.getAttribute('status') !== 'disabled';
            if (enabled) {
              next.click();
              return true;
            }
            return false;
          })()
        `) as boolean;

        if (hasNextPage) {
          onProgress?.('Nächste Seite...');
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      await page.close();

      onProgress?.(`Sammlung abgeschlossen: ${files.length} Datei(en) heruntergeladen`);
      return { status: files.length > 0 ? 'completed' : 'completed', files };

    } catch (err: any) {
      if (err.message?.includes('Chrome nicht erreichbar') || err.message?.includes('CDP')) {
        throw new BrowserConnectionError(err.message);
      }
      if (err.message?.includes('Session') || err.message?.includes('signin')) {
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

  /**
   * Wait for a new file to appear in the download directory.
   * Amazon generates a ZIP and Chrome downloads it — we just wait for the file.
   * Timeout after 90 seconds.
   */
  private async waitForDownloadComplete(
    downloadDir: string, filesBefore: Set<string>,
    onProgress?: (msg: string) => void,
  ): Promise<string | null> {
    const maxWaitMs = 90_000;
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

      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed % 15 === 0) {
        onProgress?.(`Warte auf Download... (${elapsed}s)`);
      }
    }

    onProgress?.('Download-Timeout (90s) — fahre fort');
    return null;
  }
}

// ==================== Helpers ====================

function parseAmazonDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const deMonths: Record<string, number> = {
    januar: 0, februar: 1, märz: 2, april: 3, mai: 4, juni: 5,
    juli: 6, august: 7, september: 8, oktober: 9, november: 10, dezember: 11,
  };
  const deMatch = dateStr.match(/(\d{1,2})\.\s*(\w+)\s+(\d{4})/);
  if (deMatch) {
    const month = deMonths[deMatch[2].toLowerCase()];
    if (month !== undefined) return new Date(parseInt(deMatch[3]), month, parseInt(deMatch[1]));
  }
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}
