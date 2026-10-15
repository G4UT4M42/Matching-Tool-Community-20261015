/**
 * Collection service — business workflow for invoice collection runs.
 * Handles the complete lifecycle: queue → execute → archive → import.
 */
import type { CollectionRun, CollectionRunStatus, OpenclawRunResult, RunStats } from './types.js';
import * as repo from './repository.js';
import { archiveFile } from './file-store.js';
import { startCollectionRun } from './openclaw-client.js';
import { importRunFiles } from './import-bridge.js';
import { PortalNotFoundError, RunNotFoundError, InvalidRunStateError } from './errors.js';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

/** Portals that skip invoicerec and store directly to a target folder */
const DIRECT_STORE_PORTALS: Record<string, (year: number) => string> = {
  amazon: (year) => path.resolve(`Belege/${year}/Rechnungen/Amazon-Rechnungen`),
  aliexpress: (year) => path.resolve(`Belege/${year}/Rechnungen/AliExpress-Belege`),
  google_cloud: (year) => path.resolve(`Belege/${year}/Rechnungen/Google-Cloud-Belege`),
  google_one: (year) => path.resolve(`Belege/${year}/Rechnungen/Google-One-Belege`),
};

/**
 * Create and queue a new collection run.
 */
export function queueRun(portalId: string, dateStart: string, dateEnd: string): CollectionRun {
  const portal = repo.getPortal(portalId);
  if (!portal) throw new PortalNotFoundError(portalId);

  const run = repo.createRun({
    portalId,
    requestedStart: dateStart,
    requestedEnd: dateEnd,
  });

  repo.createEvent(run.id, 'info', 'RUN_QUEUED', `Run erstellt für ${portal.name} (${dateStart} — ${dateEnd})`);

  return run;
}

/** Check if a run has been cancelled (re-read from DB) */
function isCancelled(runId: string): boolean {
  const current = repo.getRun(runId);
  return current?.status === 'cancelled';
}

/**
 * Execute a queued run. This is the main workflow.
 * Only starts from 'queued' status — retryRun must reset to 'queued' first.
 * Checks for cancellation between major steps.
 */
export async function executeRun(runId: string): Promise<CollectionRun> {
  const run = repo.getRun(runId);
  if (!run) throw new RunNotFoundError(runId);
  if (run.status !== 'queued') {
    throw new InvalidRunStateError(runId, run.status, 'execute');
  }

  const portal = repo.getPortal(run.portalId);
  if (!portal) throw new PortalNotFoundError(run.portalId);

  const stats: RunStats = { found: 0, downloaded: 0, imported: 0, duplicates: 0, failed: 0 };

  try {
    // 1. Mark as running
    repo.updateRunStatus(runId, 'running');
    repo.createEvent(runId, 'info', 'RUN_STARTED', `Sammlung gestartet für ${portal.name}`);

    // 2. Try OpenClaw first, fall back to puppeteer adapter
    const progressCb = (msg: string) => {
      repo.createEvent(runId, 'info', 'COLLECTION_PROGRESS', msg);
    };

    // Use puppeteer adapter directly — more reliable than AI-driven navigation
    const result = await startCollectionRun(portal, {
      start: run.requestedStart, end: run.requestedEnd,
    }, progressCb, runId);

    // Check for cancellation after async call
    if (isCancelled(runId)) {
      repo.createEvent(runId, 'info', 'RUN_CANCELLED_DURING_EXEC', 'Run wurde während der Ausführung abgebrochen');
      return repo.getRun(runId)!;
    }

    // 3. Handle session-required state
    if (result.status === 'waiting_for_login') {
      repo.updateRunStatus(runId, 'waiting_for_login', {
        errorMessage: result.errorMessage,
      });
      repo.createEvent(runId, 'warn', 'SESSION_REQUIRED', result.errorMessage ?? 'Login erforderlich');
      return repo.getRun(runId)!;
    }

    // 4. Process collected files
    stats.found = result.files.length;
    const directStoreFn: ((year: number) => string) | undefined = DIRECT_STORE_PORTALS[portal.portalType];

    if (result.files.length > 0) {
      repo.updateRunStatus(runId, 'downloading', { stats });
      repo.createEvent(runId, 'info', 'FILES_FOUND', `${result.files.length} Datei(en) gefunden`);

      for (const fileResult of result.files) {
        if (isCancelled(runId)) {
          repo.createEvent(runId, 'info', 'RUN_CANCELLED_DURING_DOWNLOAD', 'Download abgebrochen');
          return repo.getRun(runId)!;
        }

        try {
          // Archive the file (dedup via sha256)
          const archived = archiveFile(
            fileResult.localPath, portal.id, fileResult.filename, fileResult.invoiceDate,
          );

          const existingForRun = repo.getFilesBySha256(archived.sha256).filter(f => f.runId === runId);
          if (existingForRun.length > 0) { stats.duplicates++; continue; }

          if (archived.isDuplicate) {
            stats.duplicates++;
            try {
              const file = repo.createFile({
                runId, portalId: portal.id, originalFilename: fileResult.filename,
                storedPath: archived.storedPath, sha256: archived.sha256,
                invoiceDate: fileResult.invoiceDate, supplierHint: fileResult.supplierHint,
              });
              repo.updateFileImportStatus(file.id, 'duplicate');
            } catch {}
            repo.createEvent(runId, 'info', 'FILE_DUPLICATE',
              `Duplikat: ${fileResult.filename}`, { sha256: archived.sha256 });
            continue;
          }

          stats.downloaded++;

          // Direct-store portals: copy to target folder instead of invoicerec import
          let storedPath = archived.storedPath;
          if (directStoreFn) {
            const invoiceYear = fileResult.invoiceDate
              ? parseInt(fileResult.invoiceDate.slice(0, 4))
              : new Date().getFullYear();
            const targetDir = directStoreFn(invoiceYear);
            if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
            const targetPath = path.join(targetDir, fileResult.filename);
            if (!existsSync(targetPath)) {
              copyFileSync(archived.storedPath, targetPath);
              repo.createEvent(runId, 'info', 'FILE_STORED_DIRECT',
                `Direkt gespeichert: ${targetPath}`);
            }
            storedPath = targetPath;
          }

          try {
            repo.createFile({
              runId, portalId: portal.id, originalFilename: fileResult.filename,
              storedPath, sha256: archived.sha256,
              invoiceDate: fileResult.invoiceDate, supplierHint: fileResult.supplierHint,
            });
          } catch (err: any) {
            if (err.message?.includes('UNIQUE')) { stats.duplicates++; continue; }
            throw err;
          }

          // Mark as imported for direct-store portals (skip invoicerec)
          if (directStoreFn != null) {
            const files = repo.getFilesBySha256(archived.sha256).filter(f => f.runId === runId);
            if (files.length > 0) repo.updateFileImportStatus(files[0].id, 'imported');
            stats.imported++;
          }

          repo.createEvent(runId, 'info', 'FILE_ARCHIVED',
            `Datei archiviert: ${fileResult.filename}`,
            { sha256: archived.sha256.slice(0, 16), size: archived.sizeBytes });
        } catch (err: any) {
          stats.failed++;
          repo.createEvent(runId, 'error', 'FILE_ARCHIVE_FAILED',
            `Fehler beim Archivieren: ${fileResult.filename}: ${err.message}`);
        }
      }
    }

    if (isCancelled(runId)) {
      repo.createEvent(runId, 'info', 'RUN_CANCELLED_BEFORE_IMPORT', 'Import übersprungen — Run abgebrochen');
      return repo.getRun(runId)!;
    }

    // 5. Import phase — only for portals WITHOUT direct-store (skip for Amazon etc.)
    if (directStoreFn == null) {
      repo.updateRunStatus(runId, 'importing', { stats });
      try {
        const importResult = await importRunFiles(runId);
        stats.imported = importResult.imported;
        stats.duplicates += importResult.duplicates;
        stats.failed += importResult.failed;
      } catch (err: any) {
        repo.createEvent(runId, 'error', 'IMPORT_FAILED', `Import-Fehler: ${err.message}`);
      }
    }

    // 6. Re-run matching to pick up newly imported documents
    if (stats.imported > 0) {
      try {
        repo.createEvent(runId, 'info', 'MATCHING_STARTED', 'Matching-Regeln werden auf neue Belege angewendet...');
        const matchResult = await triggerMatching();
        repo.createEvent(runId, 'info', 'MATCHING_COMPLETED',
          `Matching abgeschlossen: ${matchResult.newMatches} neue Matches`);
      } catch (err: any) {
        repo.createEvent(runId, 'warn', 'MATCHING_FAILED', `Matching-Fehler: ${err.message}`);
      }
    }

    // 7. Determine final status
    let finalStatus: CollectionRunStatus;
    if (result.status === 'failed') {
      finalStatus = 'failed';
    } else if (stats.failed > 0 && stats.downloaded > 0) {
      finalStatus = 'partial';
    } else if (stats.failed > 0 && stats.downloaded === 0) {
      finalStatus = 'failed';
    } else {
      finalStatus = 'completed';
    }

    repo.updateRunStatus(runId, finalStatus, {
      stats,
      errorMessage: result.errorMessage,
    });

    // Explicit zero-result message (not a failure)
    if (stats.found === 0) {
      repo.createEvent(runId, 'info', 'RUN_COMPLETED_EMPTY',
        `Keine Rechnungen im Zeitraum ${run.requestedStart} — ${run.requestedEnd} gefunden`);
    } else {
      repo.createEvent(runId, 'info', 'RUN_COMPLETED',
        `Run abgeschlossen: ${stats.downloaded} heruntergeladen, ${stats.imported} importiert, ${stats.duplicates} Duplikate, ${stats.failed} fehlgeschlagen`);
    }

    return repo.getRun(runId)!;
  } catch (err: any) {
    // Guard: don't try to mark cancelled runs as failed
    if (!isCancelled(runId)) {
      // Classify the error for better diagnostics
      const errCode = (err as any).code ?? 'RUN_FAILED';
      const level = errCode === 'EXECUTOR_BUSY' ? 'warn' as const : 'error' as const;
      try {
        repo.updateRunStatus(runId, 'failed', { errorMessage: err.message, stats });
      } catch { /* transition may be invalid if already in terminal state */ }
      repo.createEvent(runId, level, errCode, err.message);
    }
    return repo.getRun(runId)!;
  }
}

/**
 * Trigger matching engine via the API server.
 * Loads new invoice_scan documents into state and re-runs all matching rules.
 */
async function triggerMatching(): Promise<{ newMatches: number }> {
  const port = parseInt(process.env.PORT ?? '3000', 10);
  const res = await fetch(`http://localhost:${port}/api/match`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/match returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json() as any;
  return { newMatches: (body.newMatchedTransactions ?? 0) + (body.newMatchedDocuments ?? 0) };
}

/**
 * Cancel a running or queued run.
 */
export function cancelRun(runId: string): CollectionRun {
  const run = repo.getRun(runId);
  if (!run) throw new RunNotFoundError(runId);

  const cancellable: CollectionRunStatus[] = ['queued', 'running', 'waiting_for_login', 'downloading', 'importing'];
  if (!cancellable.includes(run.status)) {
    throw new InvalidRunStateError(runId, run.status, 'cancel');
  }

  repo.updateRunStatus(runId, 'cancelled');
  repo.createEvent(runId, 'info', 'RUN_CANCELLED', 'Run wurde abgebrochen');

  return repo.getRun(runId)!;
}

/**
 * Retry a failed run. Resets status to queued.
 */
export function retryRun(runId: string): CollectionRun {
  const run = repo.getRun(runId);
  if (!run) throw new RunNotFoundError(runId);

  if (run.status !== 'failed' && run.status !== 'waiting_for_login') {
    throw new InvalidRunStateError(runId, run.status, 'retry');
  }

  repo.updateRunStatus(runId, 'queued', {
    errorMessage: undefined,
  });
  repo.createEvent(runId, 'info', 'RUN_RETRIED', 'Run wird erneut versucht');

  return repo.getRun(runId)!;
}
