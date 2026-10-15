/**
 * Browser-Use Python Worker Runner.
 *
 * Spawns the Python browser-use worker as a child process,
 * parses structured JSON-line events from stdout,
 * persists results, and relays events to callers.
 */
import { spawn, exec, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import http from 'http';
import type {
  PortalConfig, WorkerEvent, WorkerEventType,
  OpenclawRunResult, OpenclawFileResult,
} from './types.js';
import * as repo from './repository.js';
import { getSetting } from '../storage/settings.js';
import { startSession, endSession, recordCost } from './cost-monitor.js';

const WORKER_SCRIPT = path.resolve('tools', 'browser-use', 'run_task.py');
const VENV_PYTHON_EXE = path.resolve('tools', 'browser-use', 'venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python');
const PYTHON_CMD = existsSync(VENV_PYTHON_EXE) ? VENV_PYTHON_EXE
  : process.platform === 'win32' ? 'python' : 'python3';
const PROFILES_ROOT = path.resolve('data', 'browser-use', 'profiles');
const RUNS_ROOT = path.resolve('data', 'browser-use', 'runs');

export type EventCallback = (event: WorkerEvent) => void;

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/** Check if Chrome CDP is reachable on port 9222 */
function isCdpAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:9222/json/version', { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data.includes('webSocketDebuggerUrl')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Launch Chrome with remote debugging and shared profile if not already running */
async function ensureChromeWithCdp(profileDir: string): Promise<void> {
  if (await isCdpAvailable()) return; // Already running

  let chromePath: string | null = null;
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) { chromePath = p; break; }
  }
  if (!chromePath) {
    console.warn('[browser-use] Chrome not found, worker will launch its own browser');
    return;
  }

  // Launch Chrome headless with remote debugging
  exec(`"${chromePath}" --headless=new --remote-debugging-port=9222 --user-data-dir="${profileDir}" --no-first-run --disable-gpu`, (err) => {
    if (err) console.warn('[browser-use] Chrome launch error:', err.message);
  });

  // Wait for CDP to become available (max 10s)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isCdpAvailable()) return;
  }
  console.warn('[browser-use] Chrome launched but CDP not available after 10s');
}

interface RunnerOptions {
  mode: 'check_session' | 'dry_run' | 'collect_invoices';
  dateRange?: { start: string; end: string };
  headless?: boolean;
  onEvent?: EventCallback;
  modelOverride?: string;
  apiBaseOverride?: string;
}

/**
 * Start the Python browser-use worker for a portal.
 * Returns an OpenclawRunResult compatible with the existing collection service.
 */
export async function runBrowserUseWorker(
  portal: PortalConfig,
  runId: string,
  options: RunnerOptions,
): Promise<OpenclawRunResult> {
  // Ensure directories
  const runDir = path.join(RUNS_ROOT, runId);
  const downloadDir = path.join(runDir, 'downloads');
  const evidenceDir = path.join(runDir, 'evidence');
  mkdirSync(downloadDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  // Use shared default profile for all portals (user logs in once via "Bot-Browser starten")
  const sharedProfileDir = path.join(PROFILES_ROOT, '_default');
  mkdirSync(sharedProfileDir, { recursive: true });
  let profile = repo.getProfileForPortal(portal.id);
  if (!profile) {
    profile = repo.createProfile(portal.id, sharedProfileDir);
  } else if (profile.profileDir !== sharedProfileDir) {
    // Migrate to shared profile
    profile.profileDir = sharedProfileDir;
  }

  // Ensure Chrome with CDP is running (auto-launch if needed)
  await ensureChromeWithCdp(sharedProfileDir);

  // Build worker input
  const apiKey = getSetting('invoicebot_api_key') ?? getSetting('openrouter_api_key') ?? '';
  const model = options.modelOverride ?? getSetting('invoicebot_model_browseruse') ?? 'openai/gpt-4o';

  const workerInput = {
    runId,
    portal: {
      id: portal.id,
      name: portal.name,
      baseUrl: portal.baseUrl,
      adapterType: portal.adapterType,
      runStrategy: portal.runStrategy,
      loginStrategy: portal.loginStrategy,
      taskPrompt: portal.taskPrompt ?? '',
      invoicePageHints: portal.invoicePageHints ?? [],
      maxCostPerRun: portal.maxCostPerRun,
      requiresHumanLogin: portal.requiresHumanLogin,
      reviewPolicy: portal.reviewPolicy,
    },
    profile: {
      id: profile.id,
      profileDir: profile.profileDir,
    },
    credentials: null, // TODO: resolve from credential_ref
    options: {
      dateRange: options.dateRange ? { from: options.dateRange.start, to: options.dateRange.end } : null,
      headless: options.headless ?? false,
      workDir: runDir,
      downloadDir,
      evidenceDir,
    },
    mode: options.mode,
    openrouterApiKey: apiKey,
    openrouterModel: model,
    apiBaseUrl: options.apiBaseOverride ?? 'https://openrouter.ai/api/v1',
  };

  return new Promise<OpenclawRunResult>((resolve) => {
    const files: OpenclawFileResult[] = [];
    let finalStatus: OpenclawRunResult['status'] = 'failed';
    let errorMessage: string | undefined;
    let proc: ChildProcess | null = null;
    let totalRunCost = 0;
    let totalRunTokens = 0;
    const maxCost = portal.maxCostPerRun ?? Infinity;

    // Start cost tracking session
    const costSession = startSession('invoicebot-browser-use');

    try {
      // Check Python and worker script exist
      if (!existsSync(WORKER_SCRIPT)) {
        resolve({ status: 'failed', files: [], errorMessage: `Worker script not found: ${WORKER_SCRIPT}` });
        return;
      }

      proc = spawn(PYTHON_CMD, [WORKER_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: path.resolve('tools', 'browser-use'),
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      });

      // Send input
      proc.stdin!.write(JSON.stringify(workerInput));
      proc.stdin!.end();

      // Parse stdout as JSON lines
      const rl = createInterface({ input: proc.stdout! });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let event: WorkerEvent;
        try {
          event = JSON.parse(trimmed);
        } catch {
          // Malformed JSON — log to console (can't persist if run doesn't exist in DB)
          console.warn('[browser-use] Malformed worker output:', trimmed.slice(0, 100));
          return;
        }

        // Validate event structure
        if (!event.type || !event.runId) {
          console.warn('[browser-use] Invalid event structure:', JSON.stringify(event).slice(0, 100));
          return;
        }

        // Relay to callback
        options.onEvent?.(event);

        // Process event — wrapped in try-catch because session checks use
        // non-persisted run IDs that will fail FK constraints
        try {
          handleWorkerEvent(runId, portal.id, event, files);
        } catch (dbErr: any) {
          // FK failure for non-real runs (session checks) is expected
          if (!dbErr.message?.includes('FOREIGN KEY')) {
            console.error('[browser-use] Event handler error:', dbErr.message);
          }
        }

        // Track costs from worker events
        if (event.type === 'cost.update') {
          const cp = event.payload as any;
          const incCost = cp.incrementalCost ?? 0;
          const incTokens = cp.totalTokens ?? 0;
          totalRunCost += incCost;
          totalRunTokens = Math.max(totalRunTokens, incTokens);

          // Record to cost monitor session
          try {
            recordCost({
              model: cp.model ?? 'unknown',
              promptTokens: cp.inputTokens ?? 0,
              completionTokens: cp.outputTokens ?? 0,
              totalTokens: cp.totalTokens ?? 0,
              costUsd: incCost,
              source: 'invoicebot-browser-use',
              context: `Run ${runId}`,
            });
          } catch { /* non-critical */ }

          // Enforce max_cost_per_run
          if (totalRunCost >= maxCost && proc) {
            repo.createEvent(runId, 'warn', 'COST_LIMIT_REACHED',
              `Kostenlimit erreicht: $${totalRunCost.toFixed(4)} >= $${maxCost}`);
            proc.kill('SIGTERM');
            finalStatus = 'failed';
            errorMessage = `Kostenlimit überschritten ($${totalRunCost.toFixed(2)} / $${maxCost})`;
          }
        }

        // Check status events
        if (event.type === 'run.finished') {
          const p = event.payload as any;
          const statusMap: Record<string, OpenclawRunResult['status']> = {
            succeeded: 'completed',
            partial_success: 'partial',
            failed: 'failed',
            waiting_auth: 'waiting_for_login',
          };
          finalStatus = statusMap[p.status] ?? 'failed';
          if (p.status === 'failed') errorMessage = p.summary;
        }

        if (event.type === 'auth.required') {
          finalStatus = 'waiting_for_login';
          errorMessage = (event.payload as any).message;
        }
      });

      // Collect stderr for debugging
      let stderr = '';
      proc.stderr!.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        // End cost session
        try { endSession(); } catch { /* ok */ }
        // Update run cost totals
        try { repo.updateRunCost(runId, totalRunCost, totalRunTokens); } catch { /* ok */ }

        if (code !== 0 && finalStatus !== 'waiting_for_login') {
          finalStatus = 'failed';
          errorMessage = errorMessage ?? `Worker exited with code ${code}`;
          if (stderr.length > 0) {
            repo.createEvent(runId, 'error', 'WORKER_STDERR', stderr.slice(-500));
          }
        }
        resolve({ status: finalStatus, files, errorMessage });
      });

      proc.on('error', (err) => {
        try { endSession(); } catch { /* ok */ }
        resolve({ status: 'failed', files: [], errorMessage: `Worker spawn failed: ${err.message}` });
      });

    } catch (err: any) {
      resolve({ status: 'failed', files: [], errorMessage: err.message });
    }
  });
}

/**
 * Process a single worker event — persist to DB, update counters.
 */
function handleWorkerEvent(
  runId: string, portalId: string, event: WorkerEvent, files: OpenclawFileResult[],
): void {
  const p = event.payload as any;
  const type = event.type;

  switch (type) {
    case 'run.started':
      repo.createEvent(runId, 'info', 'BU_RUN_STARTED', `Browser-Use Run gestartet`);
      break;

    case 'run.progress':
      repo.createEvent(runId, 'info', 'BU_PROGRESS', p.message ?? p.step);
      break;

    case 'auth.required':
      repo.createEvent(runId, 'warn', 'BU_AUTH_REQUIRED', p.message ?? 'Login erforderlich');
      break;

    case 'browser.url':
      repo.createEvent(runId, 'info', 'BU_URL', p.url);
      break;

    case 'browser.screenshot':
      if (p.path) {
        repo.createArtifact({
          runId, type: 'screenshot', localPath: p.path,
          mimeType: 'image/png', label: p.label,
        });
      }
      break;

    case 'browser.message':
      repo.createEvent(runId, p.level === 'error' ? 'error' : 'info', 'BU_MESSAGE', p.message);
      break;

    case 'file.detected':
      repo.createEvent(runId, 'info', 'BU_FILE_DETECTED', p.filename ?? p.sourceUrl ?? 'file detected');
      break;

    case 'file.downloaded':
      // Alibaba creates a new PDF (and therefore a new SHA-256 hash) on every
      // download of the same receipt. Use the stable order number in its
      // generated filename to avoid importing the same receipt repeatedly.
      const receiptMatch = /^Receipt_(.+)_\d{10,}\.pdf$/i.exec(p.filename ?? '');
      const downloadKey = receiptMatch ? `alibaba:${receiptMatch[1]}` : (p.filename ?? '').toLowerCase();
      const isDuplicateDownload = files.some(file => {
        const existingMatch = /^Receipt_(.+)_\d{10,}\.pdf$/i.exec(file.filename);
        const existingKey = existingMatch ? `alibaba:${existingMatch[1]}` : file.filename.toLowerCase();
        return existingKey === downloadKey;
      });
      if (isDuplicateDownload) {
        repo.createEvent(runId, 'info', 'BU_FILE_DUPLICATE', `Mehrfachdownload übersprungen: ${p.filename}`);
        break;
      }
      files.push({
        filename: p.filename,
        localPath: p.path,
        invoiceDate: undefined,
        supplierHint: undefined,
      });
      if (p.path) {
        repo.createArtifact({
          runId, type: 'download', localPath: p.path,
          mimeType: p.mimeType, sha256: p.sha256,
          sizeBytes: p.sizeBytes, sourceUrl: p.sourceUrl,
        });
      }
      repo.incrementRunCounters(runId, 'files_downloaded_count');
      repo.createEvent(runId, 'info', 'BU_FILE_DOWNLOADED',
        `${p.filename} (${p.sha256?.slice(0, 12)}...)`, { sha256: p.sha256, size: p.sizeBytes });
      break;

    case 'invoice.extracted':
      repo.createExtractedInvoice({
        runId, portalId,
        downloadedFilename: p.downloadedFilename,
        sha256: p.sha256 ?? '',
        supplierName: p.supplierName,
        invoiceNumber: p.invoiceNumber,
        invoiceDate: p.invoiceDate,
        currency: p.currency,
        grossTotalMinor: p.grossTotal ? Math.round(p.grossTotal * 100) : undefined,
        portalReference: p.portalReference,
        extractionConfidence: p.extractionConfidence,
        requiresReview: p.requiresReview ?? true,
        sourceUrl: p.sourceUrl,
      });
      repo.incrementRunCounters(runId, 'invoices_found_count');
      break;

    case 'cost.update':
      if (p.totalCost != null || p.totalTokens != null) {
        repo.updateRunCost(runId, p.totalCost ?? 0, p.totalTokens ?? 0);
      }
      break;

    case 'run.warning':
      repo.createEvent(runId, 'warn', p.code ?? 'BU_WARNING', p.message);
      repo.incrementRunCounters(runId, 'warnings_count');
      break;

    case 'run.error':
      repo.createEvent(runId, 'error', p.code ?? 'BU_ERROR', p.message);
      break;

    case 'run.finished':
      repo.createEvent(runId, 'info', 'BU_RUN_FINISHED', p.summary ?? 'Run beendet');
      break;
  }
}

/** Check if Python and browser-use are available */
export async function checkPythonSetup(): Promise<{ available: boolean; python: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_CMD, ['-c', 'import browser_use; print("ok")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', d => { stdout += d; });
    proc.stderr!.on('data', d => { stderr += d; });
    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('ok')) {
        resolve({ available: true, python: PYTHON_CMD });
      } else {
        resolve({ available: false, python: PYTHON_CMD, error: stderr.slice(0, 200) || `exit code ${code}` });
      }
    });
    proc.on('error', (err) => {
      resolve({ available: false, python: PYTHON_CMD, error: `Python not found: ${err.message}` });
    });
  });
}
