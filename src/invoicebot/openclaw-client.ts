/**
 * Browser executor client — connects to a running Chrome instance via CDP.
 *
 * Architecture:
 * - User starts Chrome with: --remote-debugging-port=9222 --user-data-dir=<profile>
 * - User logs into portals manually in that Chrome
 * - This client connects via puppeteer-core to the running Chrome
 * - Portal adapters use the browser page to navigate and download invoices
 *
 * Exclusivity (single-process, single-browser):
 * - Only one collection run can use the browser at a time
 * - Session checks are blocked while a collection run is active
 * - This is enforced via in-memory lock, NOT distributed locking
 *
 * This file is the ONLY place that knows about CDP / puppeteer.
 */
import puppeteer, { type Browser } from 'puppeteer-core';
import { mkdirSync, existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { execFile } from 'child_process';
import path from 'path';
import type { PortalConfig, SessionCheckResult, OpenclawRunResult } from './types.js';
import { getAdapter } from './portal-adapters/index.js';
import { ExecutorBusyError } from './errors.js';
import { resolveAccountingPaths, resolveRuntimePath } from '../storage/paths.js';

export interface ExecutorConfig {
  /** Chrome CDP endpoint URL */
  cdpUrl: string;
  /** CDP port number (extracted from cdpUrl) */
  cdpPort: number;
  /** Connection timeout in ms */
  connectTimeoutMs: number;
  /** Base directory for downloads */
  downloadBaseDir: string;
  /** Path to Chrome/Chromium executable */
  chromePath: string;
  /** Dedicated bot browser profile directory */
  profileDir: string;
  /** URL to open when launching browser (optional) */
  startUrl: string;
}

/** Platform-specific Chrome executable search paths */
const CHROME_CANDIDATES: string[] = process.platform === 'win32'
  ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.PROGRAMFILES ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ]
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];

function findChrome(): string {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return '';
}

const ACCOUNTING_PATHS = resolveAccountingPaths();
const DEFAULT_CONFIG: ExecutorConfig = {
  cdpUrl: 'http://localhost:9222',
  cdpPort: 9222,
  connectTimeoutMs: 10_000,
  downloadBaseDir: resolveRuntimePath(ACCOUNTING_PATHS, 'state', 'invoice-bot', 'downloads'),
  chromePath: findChrome(),
  profileDir: ACCOUNTING_PATHS.mode === 'external-runtime-root'
    ? resolveRuntimePath(ACCOUNTING_PATHS, 'cache', 'invoice-bot', 'chrome-profile')
    : resolveRuntimePath(ACCOUNTING_PATHS, 'state', 'invoice-bot', 'chrome-profile'),
  startUrl: 'about:blank',
};

let cachedConfig: ExecutorConfig = { ...DEFAULT_CONFIG };

export function setExecutorConfig(config: Partial<ExecutorConfig>): void {
  cachedConfig = { ...cachedConfig, ...config };
  // Keep cdpPort in sync with cdpUrl
  if (config.cdpUrl) {
    try { cachedConfig.cdpPort = parseInt(new URL(config.cdpUrl).port) || 9222; } catch {}
  }
}

export function getExecutorConfig(): ExecutorConfig {
  return { ...cachedConfig };
}

// ==================== Executor lock (single-process) ====================

let executorLock: { runId: string; portalId: string; since: string } | null = null;

/** Acquire exclusive browser access for a collection run. Throws if already locked. */
export function acquireExecutorLock(runId: string, portalId: string): void {
  if (executorLock) {
    throw new ExecutorBusyError();
  }
  executorLock = { runId, portalId, since: new Date().toISOString() };
  console.log(`[invoicebot] [executor] Lock acquired: run=${runId}`);
}

/** Release the executor lock. */
export function releaseExecutorLock(runId: string): void {
  if (executorLock?.runId === runId) {
    console.log(`[invoicebot] [executor] Lock released: run=${runId}`);
    executorLock = null;
  }
}

/** Check if the executor is currently locked. */
export function isExecutorLocked(): { locked: boolean; runId?: string; since?: string } {
  if (!executorLock) return { locked: false };
  return { locked: true, runId: executorLock.runId, since: executorLock.since };
}

// ==================== Browser launch ====================

export type BrowserLaunchStatus =
  | 'launched'           // Chrome was just started
  | 'already_running'    // Chrome already running on configured CDP port
  | 'not_found'          // Chrome executable not found at configured path
  | 'not_configured'     // Chrome path is empty / not set
  | 'launch_failed';     // execFile failed

export interface BrowserLaunchResult {
  status: BrowserLaunchStatus;
  message: string;
  chromePath?: string;
  profileDir?: string;
  cdpPort?: number;
}

/**
 * Launch the controlled Chrome browser with the bot's dedicated profile.
 *
 * This is NOT a session check. It simply starts Chrome so the user can:
 * - log into portals manually
 * - save credentials in Chrome Password Manager
 * - maintain the browser profile
 *
 * Safe to call repeatedly: detects if Chrome is already running.
 * The launched Chrome process is independent — the app does NOT own its lifecycle.
 */
export async function launchControlledBrowser(): Promise<BrowserLaunchResult> {
  const config = cachedConfig;

  // 1. Check if already running
  const alreadyRunning = await isBrowserReachable();
  if (alreadyRunning) {
    console.log('[invoicebot] [browser] Chrome already running on CDP port');
    return {
      status: 'already_running',
      message: `Chrome läuft bereits auf Port ${config.cdpPort} (headless).`,
      cdpPort: config.cdpPort,
      profileDir: config.profileDir,
    };
  }

  // 2. Launch Chrome headless directly (no OpenClaw dependency)
  return launchChromeDirect(false);
}

/**
 * Launch Chrome with a VISIBLE window for manual user actions (login, CAPTCHA, etc.).
 * Kills any running headless instance first, then relaunches with GUI.
 */
export async function launchVisibleBrowser(): Promise<BrowserLaunchResult> {
  // Kill existing Chrome on our CDP port (headless or visible)
  if (await isBrowserReachable()) {
    try {
      const browser = await connectBrowser();
      // browser.process() is null when connected via CDP (not launched by us)
      // Use Browser.close() which sends CDP command to shut down Chrome
      await browser.close();
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return launchChromeDirect(true);
}

/**
 * Internal: launch Chrome either headless or visible.
 */
async function launchChromeDirect(visible: boolean): Promise<BrowserLaunchResult> {
  const config = cachedConfig;

  if (!config.chromePath) {
    return { status: 'not_configured', message: 'Chrome-Pfad nicht konfiguriert.' };
  }
  if (!existsSync(config.chromePath)) {
    return { status: 'not_found', message: `Chrome nicht gefunden unter: ${config.chromePath}`, chromePath: config.chromePath };
  }

  if (!existsSync(config.profileDir)) mkdirSync(config.profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    ...(visible ? [] : ['--headless=new']),
    config.startUrl,
  ];

  const mode = visible ? 'sichtbar' : 'headless';
  console.log(`[invoicebot] [browser] Launching Chrome (${mode}): ${config.chromePath}`);

  return new Promise((resolve) => {
    try {
      const child = execFile(config.chromePath, args, {
        detached: true, windowsHide: !visible,
      } as any, (err) => {
        if (err) console.error(`[invoicebot] [browser] Chrome process error: ${err.message}`);
      });
      child.unref();

      setTimeout(async () => {
        const reachable = await isBrowserReachable();
        resolve({
          status: reachable ? 'launched' : 'launched',
          message: reachable
            ? visible
              ? `Chrome-Fenster gestartet. Bitte dort beim Portal einloggen.`
              : `Chrome headless gestartet auf Port ${config.cdpPort}.`
            : `Chrome wird gestartet... CDP-Port ${config.cdpPort} antwortet noch nicht.`,
          chromePath: config.chromePath,
          profileDir: config.profileDir,
          cdpPort: config.cdpPort,
        });
      }, 2500);
    } catch (err: any) {
      resolve({ status: 'launch_failed', message: `Chrome-Start fehlgeschlagen: ${err.message}`, chromePath: config.chromePath });
    }
  });
}

/**
 * Get current browser status (running/not running + config info).
 * Independent of session state.
 */
export async function getBrowserStatus(): Promise<{
  running: boolean;
  cdpPort: number;
  chromePath: string;
  chromeFound: boolean;
  profileDir: string;
}> {
  const config = cachedConfig;
  return {
    running: await isBrowserReachable(),
    cdpPort: config.cdpPort,
    chromePath: config.chromePath,
    chromeFound: !!config.chromePath && existsSync(config.chromePath),
    profileDir: config.profileDir,
  };
}

// ==================== Connection management ====================

export async function connectBrowser(): Promise<Browser> {
  const wsEndpoint = await getWebSocketEndpoint(cachedConfig.cdpUrl, cachedConfig.connectTimeoutMs);
  return puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
}

async function getWebSocketEndpoint(cdpUrl: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cdpUrl}/json/version`, { signal: controller.signal });
    if (!res.ok) throw new Error(`CDP responded with ${res.status}`);
    const data = await res.json() as any;
    const ws = data.webSocketDebuggerUrl;
    if (!ws) throw new Error('No webSocketDebuggerUrl in CDP response');
    return ws;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`Chrome nicht erreichbar unter ${cdpUrl} (Timeout ${timeoutMs}ms). Bitte Chrome starten mit: chrome --remote-debugging-port=9222`);
    }
    throw new Error(`Chrome-Verbindung fehlgeschlagen: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function isBrowserReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${cachedConfig.cdpUrl}/json/version`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ==================== Session check ====================

/**
 * Check session status for a portal.
 * BLOCKED if a collection run is currently active (to avoid tab conflicts).
 */
export async function checkSession(portal: PortalConfig): Promise<SessionCheckResult> {
  const lock = isExecutorLocked();
  if (lock.locked) {
    return {
      browserReachable: true,
      portalReachable: false,
      loggedIn: false,
      invoiceAreaAccessible: false,
      message: `Browser wird gerade von einer Sammlung verwendet (seit ${lock.since?.slice(11, 19)}). Session-Prüfung erst nach Abschluss möglich.`,
      details: ['Executor ist exklusiv gesperrt'],
    };
  }

  const result: SessionCheckResult = {
    browserReachable: false, portalReachable: false,
    loggedIn: false, invoiceAreaAccessible: false,
    message: '', details: [],
  };

  result.browserReachable = await isBrowserReachable();
  if (!result.browserReachable) {
    result.message = 'Chrome nicht erreichbar. Bitte starten mit: chrome --remote-debugging-port=9222';
    result.details.push(`CDP-Endpoint ${cachedConfig.cdpUrl} antwortet nicht`);
    return result;
  }
  result.details.push('Chrome erreichbar');

  const adapter = getAdapter(portal.portalType);
  if (!adapter) {
    result.message = `Kein Adapter für Portal-Typ "${portal.portalType}" verfügbar`;
    result.details.push('Unterstützte Typen: amazon');
    return result;
  }

  try {
    return await adapter.checkSession(portal);
  } catch (err: any) {
    result.message = `Session-Prüfung fehlgeschlagen: ${err.message}`;
    result.details.push(err.message);
    return result;
  }
}

// ==================== Collection ====================

/**
 * Run invoice collection with exclusive browser lock.
 */
export async function startCollectionRun(
  portal: PortalConfig,
  dateRange: { start: string; end: string },
  onProgress?: (msg: string) => void,
  runId?: string,
): Promise<OpenclawRunResult> {
  // Try adapter by portalType first, then by adapterType (browser_use portals may have generic portalType)
  const adapter = getAdapter(portal.portalType) ?? getAdapter(portal.adapterType as any);
  if (!adapter) {
    return { status: 'failed', files: [], errorMessage: `Kein Adapter für Portal-Typ "${portal.portalType}" / "${portal.adapterType}"` };
  }

  // Acquire exclusive lock
  const lockRunId = runId ?? `anon-${Date.now()}`;
  acquireExecutorLock(lockRunId, portal.id);

  const downloadDir = path.join(cachedConfig.downloadBaseDir, `run-${Date.now()}`);
  if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });

  try {
    // For browser_use adapter, use the dedicated runner with real runId
    if (portal.adapterType === 'browser_use' || portal.portalType === 'browser_use') {
      // run_strategy gates execution behavior
      if (portal.runStrategy === 'manual') {
        onProgress?.('Manueller Modus — keine automatische Sammlung');
        return { status: 'completed', files: [], errorMessage: undefined };
      }

      const { runBrowserUseWorker } = await import('./browser-use-runner.js');
      return await runBrowserUseWorker(portal, lockRunId, {
        mode: 'collect_invoices',
        dateRange,
        headless: portal.runStrategy === 'deterministic', // deterministic = headless for stability
        onEvent: (event) => {
          if (event.type === 'run.progress' || event.type === 'browser.message') {
            onProgress?.((event.payload as any).message ?? (event.payload as any).step);
          }
        },
      });
    }
    return await adapter.collectInvoices(portal, dateRange, downloadDir, onProgress);
  } finally {
    releaseExecutorLock(lockRunId);
  }
}

// ==================== OpenClaw CLI Integration ====================

/**
 * Node 22 path for running OpenClaw CLI.
 * OpenClaw requires Node >= 22, but our app runs on Node 20.
 * We call OpenClaw as a separate process using the Node 22 binary.
 */
const NODE22_PATH = process.platform === 'win32'
  ? path.join(process.env.APPDATA ?? '', '..', 'Local', 'nvm', 'v22.16.0', 'node.exe')
  : '/usr/local/bin/node'; // adjust for your system

const OPENCLAW_SCRIPT = path.resolve('node_modules', 'openclaw', 'openclaw.mjs');
const OPENCLAW_WORKSPACE = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.openclaw', 'workspace');
const OPENCLAW_DOWNLOAD_ROOT = path.join(OPENCLAW_WORKSPACE, 'invoice_collector', 'downloads');
const OPENCLAW_RUNS_ROOT = path.join(OPENCLAW_WORKSPACE, 'invoice_collector', 'runs');

export interface OpenclawRunReport {
  siteId: string;
  siteName: string;
  runTimestamp: string;
  dateRange: { start: string; end: string };
  loginStatus: string;
  invoicesFound: number;
  invoicesDownloaded: number;
  skippedEntries: any[];
  failures: any[];
  downloadedFiles: Array<{ originalName: string; finalPath: string; invoiceDate?: string }>;
}

/**
 * Check if OpenClaw is available (Node 22 + openclaw installed).
 */
export function isOpenclawAvailable(): boolean {
  return existsSync(NODE22_PATH) && existsSync(OPENCLAW_SCRIPT);
}

/**
 * Run OpenClaw agent with a message/task.
 * Uses Node 22 to execute the OpenClaw CLI.
 * Returns the agent's output.
 */
export async function runOpenclawAgent(message: string, timeoutMs = 300_000): Promise<string> {
  if (!isOpenclawAvailable()) {
    throw new Error('OpenClaw nicht verfügbar. Node 22 oder OpenClaw nicht gefunden.');
  }

  const timeoutSec = Math.ceil(timeoutMs / 1000);
  // Use a fresh session per call to avoid stale context from previous runs
  const sessionId = `invoicebot-${Date.now()}`;
  return new Promise((resolve, reject) => {
    execFile(NODE22_PATH, [
      OPENCLAW_SCRIPT,
      'agent',
      '--agent', 'main',
      '--session-id', sessionId,
      '--message', message,
      '--json',
      '--timeout', String(timeoutSec),
    ], {
      timeout: timeoutMs + 10_000, // extra buffer over agent timeout
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
      },
    }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[openclaw] Agent error: ${err.message}`);
        if (stderr) console.error(`[openclaw] stderr: ${stderr.slice(0, 500)}`);
        // Even on exit code 1, stdout may contain the JSON result (gateway fallback)
        if (stdout && stdout.includes('"payloads"')) {
          resolve(stdout);
          return;
        }
        reject(new Error(`OpenClaw Agent Fehler: ${err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Run invoice collection via OpenClaw for a specific site and date range.
 * The OpenClaw agent uses the invoice_collector skill to navigate the portal,
 * download invoices, and write a run report.
 */
/**
 * Resolve the OpenClaw site ID for a portal.
 * First checks sites.json for a matching baseUrl, falls back to portal name slug.
 */
export function resolveOpenclawSiteId(portal: PortalConfig): string | null {
  try {
    const sitesFile = path.join(OPENCLAW_WORKSPACE, 'invoice_collector', 'sites.json');
    if (!existsSync(sitesFile)) {
      console.log(`[openclaw] sites.json not found at ${sitesFile}`);
      return null;
    }
    const data = JSON.parse(readFileSync(sitesFile, 'utf8'));
    const sites = data.sites as Array<{ id: string; baseUrl: string; enabled: boolean }>;
    // Match by baseUrl hostname
    const portalHostname = new URL(portal.baseUrl).hostname;
    const match = sites.find(s => {
      if (!s.enabled) return false;
      try {
        return new URL(s.baseUrl).hostname === portalHostname;
      } catch { return false; }
    });
    if (match) {
      console.log(`[openclaw] Resolved portal ${portal.id} (${portal.baseUrl}) → site ${match.id}`);
      return match.id;
    }
    console.log(`[openclaw] No matching site for portal ${portal.id} (${portalHostname}). Available: ${sites.map(s => s.id).join(', ')}`);
  } catch (err: any) {
    console.error(`[openclaw] resolveOpenclawSiteId error: ${err.message}`);
  }
  return null;
}

export async function openclawCollectInvoices(
  siteId: string,
  startDate: string,
  endDate: string,
  onProgress?: (msg: string) => void,
): Promise<OpenclawRunReport | null> {
  // Safety: never pass internal DB IDs (PRT-xxx) to the agent
  if (siteId.startsWith('PRT-')) {
    throw new Error(`BUG: openclawCollectInvoices received DB portal ID "${siteId}" instead of OpenClaw site ID. Call resolveOpenclawSiteId() first.`);
  }
  console.log(`[openclaw] openclawCollectInvoices called with siteId="${siteId}", range=${startDate}..${endDate}`);
  onProgress?.('OpenClaw Agent wird gestartet...');

  const message = `Use the invoice_collector skill. Collect invoices from site "${siteId}" for the date range ${startDate} to ${endDate}. Follow the SKILL.md instructions exactly.`;

  try {
    const output = await runOpenclawAgent(message, 600_000); // 10 min timeout
    onProgress?.(`OpenClaw Agent abgeschlossen`);

    // Find the latest run report for this site
    const report = findLatestRunReport(siteId);
    if (report) {
      onProgress?.(`Bericht: ${report.invoicesDownloaded} Rechnungen heruntergeladen`);
    }
    return report;
  } catch (err: any) {
    onProgress?.(`OpenClaw Fehler: ${err.message}`);
    throw err;
  }
}

/**
 * Find the latest run report JSON for a site.
 */
function findLatestRunReport(siteId: string): OpenclawRunReport | null {
  if (!existsSync(OPENCLAW_RUNS_ROOT)) return null;

  try {
    const files = (readdirSync(OPENCLAW_RUNS_ROOT) as string[])
      .filter((f: string) => f.includes(siteId) && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    const content = readFileSync(path.join(OPENCLAW_RUNS_ROOT, files[0]), 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Get downloaded files from OpenClaw workspace for a site.
 */
export function getOpenclawDownloads(siteId: string): string[] {
  const siteDir = path.join(OPENCLAW_DOWNLOAD_ROOT, siteId);
  if (!existsSync(siteDir)) return [];

  const results: string[] = [];
  try {
    // Walk year-month subdirs
    for (const yearMonth of readdirSync(siteDir) as string[]) {
      const ymDir = path.join(siteDir, yearMonth);
      if (!statSync(ymDir).isDirectory()) continue;
      for (const file of readdirSync(ymDir) as string[]) {
        results.push(path.join(ymDir, file));
      }
    }
  } catch {}
  return results;
}

// ==================== Legacy exports ====================

export async function getRunStatus(_runId: string): Promise<{ status: 'running' | 'completed' | 'failed'; progress?: number }> {
  return { status: 'completed' };
}

export async function cancelRun(_runId: string): Promise<void> {}

export async function ensureSession(portal: PortalConfig): Promise<{ reachable: boolean; sessionVerified: boolean; message: string }> {
  const result = await checkSession(portal);
  return { reachable: result.browserReachable, sessionVerified: result.loggedIn, message: result.message };
}
