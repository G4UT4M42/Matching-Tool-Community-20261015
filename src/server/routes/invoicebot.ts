/**
 * REST API routes for the Invoice Bot module.
 */
import { Router } from 'express';
import path from 'path';
import { existsSync } from 'fs';
import { getDb } from '../../storage/db.js';
import * as repo from '../../invoicebot/repository.js';
import { startRun, isRunActive, executeRunInBackground } from '../../invoicebot/orchestrator.js';
import { cancelRun, retryRun } from '../../invoicebot/collection-service.js';
import {
  ensureSession, checkSession, isExecutorLocked,
  launchControlledBrowser, launchVisibleBrowser, getBrowserStatus, isOpenclawAvailable,
} from '../../invoicebot/openclaw-client.js';
import { InvoiceBotError, ExecutorBusyError } from '../../invoicebot/errors.js';
import { getBotAiConfig, saveBotAiConfig, deleteBotApiKey } from '../../invoicebot/ai.js';
import {
  getCostSnapshot, getSessionHistory, getSessionEntries,
  startSession, endSession, setCostLimit, approveContinuation,
} from '../../invoicebot/cost-monitor.js';
import type { CreatePortalParams } from '../../invoicebot/types.js';
import { checkPythonSetup } from '../../invoicebot/browser-use-runner.js';
import * as repoFull from '../../invoicebot/repository.js';
import { loadState } from '../../storage/json-store.js';

export function createInvoiceBotRouter(): Router {
  const router = Router();

  // Error wrapper with classified error codes
  function handleError(res: any, err: unknown) {
    if (err instanceof InvoiceBotError) {
      const statusMap: Record<string, number> = {
        PORTAL_NOT_FOUND: 404,
        RUN_NOT_FOUND: 404,
        EXECUTOR_BUSY: 409,
        INVALID_RUN_STATE: 400,
      };
      const status = statusMap[err.code] ?? 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
    return res.status(500).json({ error: message });
  }

  // ==================== Browser / Executor ====================

  router.get('/executor/status', (_req, res) => {
    const lock = isExecutorLocked();
    res.json(lock);
  });

  /** Get browser status (running, config) + OpenClaw availability. */
  router.get('/browser/status', async (_req, res) => {
    try {
      const status = await getBrowserStatus();
      res.json({ ...status, openclawAvailable: isOpenclawAvailable() });
    } catch (err) {
      handleError(res, err);
    }
  });

  /** Launch Chrome headless (default for bot operations). */
  router.post('/browser/launch', async (_req, res) => {
    try {
      const result = await launchControlledBrowser();
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  /** Launch Chrome with visible window (for manual login). */
  router.post('/browser/launch-visible', async (_req, res) => {
    try {
      const result = await launchVisibleBrowser();
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  /** Launch Chrome visible with browser-use profile for manual login. */
  router.post('/browser/launch-profile', async (req, res) => {
    try {
      const { portalId } = req.body;
      const portal = portalId ? repo.getPortal(portalId) : null;

      // Always use shared _default profile (user logs in once, all portals reuse)
      const profilesRoot = path.resolve('data', 'browser-use', 'profiles');
      const profileDir = path.join(profilesRoot, '_default');

      if (!existsSync(profileDir)) {
        const { mkdirSync } = await import('fs');
        mkdirSync(profileDir, { recursive: true });
      }

      // Ensure profile record exists in DB
      if (portal) {
        const existing = repoFull.getProfileForPortal(portal.id);
        if (!existing) {
          repoFull.createProfile(portal.id, profileDir);
        }
      }

      // Find Chrome executable
      const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.CHROME_PATH,
      ].filter(Boolean) as string[];

      let chromePath: string | null = null;
      for (const p of chromePaths) {
        if (existsSync(p)) { chromePath = p; break; }
      }

      if (!chromePath) {
        return res.status(400).json({ error: 'Chrome nicht gefunden' });
      }

      // Kill any existing headless Chrome on port 9222 first, then launch visible
      const url = portal?.baseUrl ?? 'about:blank';
      const { exec: execCmd } = await import('child_process');
      // Check if CDP is already running — if so, kill it first (may be headless)
      try {
        const http = await import('http');
        await new Promise<void>((resolve) => {
          const req = http.get('http://localhost:9222/json/version', { timeout: 1000 }, () => {
            // CDP active — kill all Chrome first
            execCmd('taskkill /F /IM chrome.exe', () => {
              setTimeout(resolve, 1000);
            });
          });
          req.on('error', () => resolve()); // Not running, proceed
          req.on('timeout', () => { req.destroy(); resolve(); });
        });
      } catch { /* ok */ }

      execCmd(`"${chromePath}" --remote-debugging-port=9222 --user-data-dir="${profileDir}" "${url}"`, (err) => {
        if (err) console.log('[browser-launch] Chrome start error:', err.message);
      });

      res.json({
        status: 'launched',
        message: portal
          ? `Chrome geöffnet mit Profil für "${portal.name}". Bitte einloggen und Fenster offen lassen.`
          : 'Chrome geöffnet mit Standard-Profil.',
        profileDir,
        portalName: portal?.name,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ==================== Vendor Portal Lookup ====================

  /** Find portal by vendor name (fuzzy match) or create a new one for Invoice Bot auto-entry */
  router.get('/portals/by-vendor', (req, res) => {
    const vendor = (req.query.vendor as string ?? '').trim();
    if (!vendor) return res.json({ portal: null });

    const portals = repo.listPortals();
    const vendorLower = vendor.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const vendorWords = vendorLower.split(/\s+/).filter(w => w.length >= 3);

    // Fuzzy match: any significant word from vendor appears in portal name or vice versa
    const stopWords = new Set(['inc', 'gmbh', 'ltd', 'inkl', 'kurs']);
    const match = portals.find(p => {
      const nameLower = p.name.toLowerCase().replace(/[^a-z0-9\s]/g, '');
      const nameWords = nameLower.split(/\s+/).filter(w => w.length >= 3);
      return vendorWords.some(vw => !stopWords.has(vw) && nameLower.includes(vw)) ||
             nameWords.some(nw => !stopWords.has(nw) && vendorLower.includes(nw));
    });

    res.json({ portal: match ?? null });
  });

  /** Auto-create a browser_use portal for a vendor with exploratory settings */
  router.post('/portals/auto-create', (req, res) => {
    try {
      const { vendorName, baseUrl, dateFrom, dateTo, amountHint, currencyHint } = req.body;
      if (!vendorName) return res.status(400).json({ error: 'vendorName required' });

      const taskPrompt = [
        `Go to ${baseUrl || 'the vendor website'}. You should already be logged in via the shared browser profile.`,
        `Inspect the site navigation to find invoices, billing, orders, or payment history.`,
        `Do NOT guess URLs — only follow links visible on the page.`,
        dateFrom && dateTo ? `Look for invoices in the date range ${dateFrom} to ${dateTo}.` : '',
        amountHint ? `The target invoice amount is approximately ${amountHint}.` : '',
        `Download any matching invoice PDFs.`,
        `If invoices are in USD but the booking is in EUR, also look for payment receipts, order confirmations, or transaction documents that show the EUR amount or payment method.`,
      ].filter(Boolean).join(' ');

      const portal = repo.createPortal({
        name: vendorName,
        baseUrl: baseUrl || `https://www.google.com/search?q=${encodeURIComponent(vendorName + ' billing portal login')}`,
        portalType: 'browser_use',
        adapterType: 'browser_use',
        runStrategy: 'agentic',
        loginStrategy: 'existing_session',
        requiresHumanLogin: false,
        reviewPolicy: 'always_review',
        maxCostPerRun: 5.0, // Exploratory limit
        taskPrompt,
      });

      res.json(portal);
    } catch (err) {
      handleError(res, err);
    }
  });

  // ==================== Portals ====================

  router.get('/portals', (_req, res) => {
    const portals = repo.listPortals();
    res.json(portals);
  });

  router.post('/portals', (req, res) => {
    const body = req.body as CreatePortalParams;
    if (!body.name || !body.baseUrl) {
      return res.status(400).json({ error: 'Name und URL erforderlich' });
    }
    try {
      const portal = repo.createPortal(body);
      res.status(201).json(portal);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.put('/portals/:id', (req, res) => {
    try {
      const portal = repo.updatePortal(req.params.id, req.body);
      if (!portal) return res.status(404).json({ error: 'Portal nicht gefunden' });
      res.json(portal);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete('/portals/:id', (req, res) => {
    try {
      const db = getDb();
      const id = req.params.id;
      const portal = repo.getPortal(id);
      if (!portal) return res.status(404).json({ error: 'Portal nicht gefunden' });

      // Delete in FK order: events → artifacts → extracted invoices → files → runs → profiles → portal
      db.prepare('DELETE FROM invoice_bot_events WHERE run_id IN (SELECT id FROM invoice_bot_runs WHERE portal_id = ?)').run(id);
      db.prepare('DELETE FROM invoice_bot_artifacts WHERE run_id IN (SELECT id FROM invoice_bot_runs WHERE portal_id = ?)').run(id);
      db.prepare('DELETE FROM invoice_bot_extracted_invoices WHERE portal_id = ?').run(id);
      db.prepare('DELETE FROM invoice_bot_files WHERE portal_id = ?').run(id);
      db.prepare('DELETE FROM invoice_bot_runs WHERE portal_id = ?').run(id);
      db.prepare('DELETE FROM invoice_bot_profiles WHERE portal_id = ?').run(id);
      db.prepare('DELETE FROM invoice_bot_portals WHERE id = ?').run(id);

      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/portals/:id/runs', (req, res) => {
    let { start, end } = req.body;

    // Auto-detect date range from unmatched transactions if not provided
    if (!start || !end) {
      const portal = repo.getPortal(req.params.id);
      if (!portal) return res.status(404).json({ error: 'Portal nicht gefunden' });
      const detected = detectDateRangeForPortal(portal.name);
      if (!detected) {
        return res.status(400).json({
          error: 'Kein Zeitraum angegeben und keine offenen Buchungen für dieses Portal gefunden',
        });
      }
      start = detected.start;
      end = detected.end;
    }

    try {
      const run = startRun(req.params.id, start, end);
      res.status(201).json(run);
    } catch (err) {
      handleError(res, err);
    }
  });

  /** Suggest date range based on unmatched transactions for a portal */
  router.get('/portals/:id/suggest-daterange', (req, res) => {
    const portal = repo.getPortal(req.params.id);
    if (!portal) return res.status(404).json({ error: 'Portal nicht gefunden' });
    const detected = detectDateRangeForPortal(portal.name);
    if (!detected) {
      return res.json({ found: false, message: 'Keine offenen Buchungen für dieses Portal gefunden' });
    }
    res.json({ found: true, ...detected });
  });

  router.post('/portals/:id/connect-session', async (req, res) => {
    try {
      const portal = repo.getPortal(req.params.id);
      if (!portal) return res.status(404).json({ error: 'Portal nicht gefunden' });
      const result = await checkSession(portal);
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  // ==================== Runs ====================

  router.get('/runs', (req, res) => {
    const portalId = req.query.portalId as string | undefined;
    const limit = parseInt(req.query.limit as string ?? '50', 10);
    const offset = parseInt(req.query.offset as string ?? '0', 10);
    const result = repo.listRuns(portalId, limit, offset);
    res.json(result);
  });

  router.get('/runs/:id', (req, res) => {
    const run = repo.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run nicht gefunden' });
    res.json({ ...run, isActive: isRunActive(run.id) });
  });

  router.get('/runs/:id/files', (req, res) => {
    const run = repo.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run nicht gefunden' });
    const files = repo.listFilesByRun(req.params.id);
    res.json(files);
  });

  /** Serve a collected file by its DB id (opens PDF in browser) */
  router.get('/files/:fileId/open', (req, res) => {
    const file = repo.getFile(req.params.fileId);
    if (!file) return res.status(404).json({ error: 'Datei nicht gefunden' });
    const { existsSync } = require('fs');
    const filePath = file.storedPath;
    if (!filePath || !existsSync(filePath)) {
      return res.status(404).json({ error: `Datei nicht auf Disk: ${filePath}` });
    }
    res.sendFile(filePath);
  });

  router.get('/runs/:id/events', (req, res) => {
    const run = repo.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run nicht gefunden' });
    const events = repo.listEventsByRun(req.params.id);
    res.json(events);
  });

  router.post('/runs/:id/retry', (req, res) => {
    try {
      const run = retryRun(req.params.id);
      // Re-start execution via orchestrator (has double-execution guard)
      setImmediate(() => {
        executeRunInBackground(run.id).catch(err => {
          console.error(`[invoicebot] Retry execution failed for ${run.id}:`, err.message);
        });
      });
      res.json(run);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/runs/:id/cancel', (req, res) => {
    try {
      const run = cancelRun(req.params.id);
      res.json(run);
    } catch (err) {
      handleError(res, err);
    }
  });

  // ==================== Cost Monitor ====================

  router.get('/costs/snapshot', (_req, res) => {
    res.json(getCostSnapshot());
  });

  router.get('/costs/history', (req, res) => {
    const limit = parseInt(req.query.limit as string ?? '50', 10);
    res.json(getSessionHistory(limit));
  });

  router.get('/costs/sessions/:id/entries', (req, res) => {
    res.json(getSessionEntries(req.params.id));
  });

  router.post('/costs/session/start', (_req, res) => {
    const session = startSession('manual');
    res.json(session);
  });

  router.post('/costs/session/end', (_req, res) => {
    const session = endSession();
    res.json(session ?? { message: 'Keine aktive Session' });
  });

  router.put('/costs/limit', (req, res) => {
    const { limit_usd } = req.body;
    setCostLimit(typeof limit_usd === 'number' ? limit_usd : null);
    res.json({ ok: true, limit_usd: typeof limit_usd === 'number' && limit_usd > 0 ? limit_usd : null });
  });

  router.post('/costs/continue', (_req, res) => {
    approveContinuation();
    res.json({ ok: true });
  });

  // ==================== AI Settings ====================

  router.get('/ai/config', (_req, res) => {
    const config = getBotAiConfig();
    res.json(config);
  });

  router.put('/ai/config', (req, res) => {
    const { api_key, simple, standard, advanced } = req.body;
    saveBotAiConfig({ apiKey: api_key, simple, standard, advanced });
    res.json(getBotAiConfig());
  });

  router.delete('/ai/config', (_req, res) => {
    deleteBotApiKey();
    res.json({ ok: true });
  });

  // ==================== Browser-Use specific ====================

  // Check Python + browser-use availability
  router.get('/browser-use/status', async (_req, res) => {
    try {
      const result = await checkPythonSetup();
      res.json(result);
    } catch (err: any) {
      res.json({ available: false, error: err.message });
    }
  });

  // List artifacts for a run
  router.get('/runs/:id/artifacts', (req, res) => {
    try {
      const artifacts = repoFull.listArtifactsByRun(req.params.id);
      res.json(artifacts);
    } catch (err) { handleError(res, err); }
  });

  // List extracted invoices for a run
  router.get('/runs/:id/invoices', (req, res) => {
    try {
      const invoices = repoFull.listExtractedInvoicesByRun(req.params.id);
      res.json(invoices);
    } catch (err) { handleError(res, err); }
  });

  // Serve artifact file (screenshot, etc.)
  router.get('/artifacts/:id/view', (req, res) => {
    try {
      const db = getDb();
      const row = db.prepare('SELECT * FROM invoice_bot_artifacts WHERE id = ?').get(req.params.id) as any;
      if (!row) return res.status(404).json({ error: 'Artifact not found' });
      if (!existsSync(row.local_path)) return res.status(404).json({ error: 'File not found' });
      res.sendFile(path.resolve(row.local_path));
    } catch (err) { handleError(res, err); }
  });

  return router;
}

// ==================== Auto date range detection ====================

/**
 * Vendor aliases: maps portal names to patterns found in bank transaction descriptions.
 * Used to find unmatched transactions that belong to a specific portal.
 */
const VENDOR_PATTERNS: Record<string, string[]> = {
  openai: ['OPENAI', 'CHATGPT'],
  chatgpt: ['OPENAI', 'CHATGPT'],
  amazon: ['AMAZON', 'AMZN'],
  alibaba: ['ALIBABA'],
  aliexpress: ['ALIEXPRESS', 'ALIEXPRESSCOM'],
  'open router': ['OPENROUTER'],
  openrouter: ['OPENROUTER'],
  stripe: ['STRIPE'],
  paypal: ['PAYPAL'],
  'google cloud': ['GOOGLE*CLOUD'],
  'google one': ['GOOGLE*GOOGLE ONE', 'GOOGLE ONE', 'GOOGLE AI PRO'],
  'google workspace': ['GOOGLE*GSUITE'],
  'bambu lab': ['BAMBULAB', 'EU.STORE.BAMBULAB'],
  bambulab: ['BAMBULAB', 'EU.STORE.BAMBULAB'],
  'post.at': ['POST EC-'],
  postat: ['POST EC-'],
  spotify: ['SPOTIFY', 'SPOTI'],
  fiverr: ['FIVERR'],
};

/**
 * Detect date range from unmatched bank transactions for a given portal.
 * Returns min/max dates of unmatched transactions matching the portal's vendor pattern,
 * padded by 5 days on each end.
 */
function detectDateRangeForPortal(portalName: string): { start: string; end: string; count: number; transactions: Array<{ date: string; amount: number; description: string }> } | null {
  const state = loadState();
  if (!state) return null;

  // Build search patterns from portal name
  const nameLower = portalName.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const patterns: string[] = [];

  // Check known vendor patterns
  for (const [key, pats] of Object.entries(VENDOR_PATTERNS)) {
    if (nameLower.includes(key)) {
      patterns.push(...pats);
    }
  }
  // Fallback: use portal name words as patterns
  if (patterns.length === 0) {
    const words = nameLower.split(/\s+/).filter(w => w.length >= 4);
    patterns.push(...words.map(w => w.toUpperCase()));
  }
  if (patterns.length === 0) return null;

  // Find unmatched transactions matching vendor patterns
  const matched: Array<{ date: string; amount: number; description: string }> = [];

  // Also load dispositions to exclude privat/steuerzahlung
  const db = getDb();
  const dispRows = db.prepare("SELECT transaction_id FROM transaction_dispositions WHERE disposition IN ('privat', 'steuerzahlung', 'ok_no_match')").all() as { transaction_id: string }[];
  const disposedIds = new Set(dispRows.map(r => r.transaction_id));

  for (const txn of state.transactions.values()) {
    if (state.matched_transaction_ids.has(txn.transaction_id)) continue;
    if (disposedIds.has(txn.transaction_id)) continue;

    const desc = String(txn.description_raw ?? '').toUpperCase();
    const counterparty = String(txn.counterparty_name ?? '').toUpperCase();
    const haystack = desc + ' ' + counterparty;

    if (patterns.some(p => haystack.includes(p))) {
      const date = txn.posting_at?.slice(0, 10) ?? '';
      if (date) {
        matched.push({ date, amount: txn.amount_minor, description: String(txn.description_raw ?? '') });
      }
    }
  }

  if (matched.length === 0) return null;

  // Calculate date range with 5-day padding
  const dates = matched.map(m => m.date).sort();
  const minDate = new Date(dates[0]);
  const maxDate = new Date(dates[dates.length - 1]);
  minDate.setDate(minDate.getDate() - 5);
  maxDate.setDate(maxDate.getDate() + 5);

  return {
    start: minDate.toISOString().slice(0, 10),
    end: maxDate.toISOString().slice(0, 10),
    count: matched.length,
    transactions: matched,
  };
}
