/**
 * Bridge between Invoice Bot collected files and the existing invoice recognition pipeline.
 *
 * This is the narrow integration seam:
 *   invoicebot collects files → import-bridge → invoicerec extracts data → Document created
 *
 * Idempotency: files already marked as 'imported' or 'duplicate' are skipped.
 * The invoicerec pipeline has its own hash-based dedup (getScanByHash), providing
 * a second layer of protection against duplicate Document creation.
 */
import type { CollectedFile } from './types.js';
import * as repo from './repository.js';
import { existsSync } from 'fs';
import { getDb } from '../storage/db.js';

export interface ImportResult {
  success: boolean;
  documentId?: string;
  scanId?: string;
  error?: string;
  skipped?: boolean;
}

/**
 * Import a collected file into the invoice recognition pipeline.
 *
 * Idempotency guards:
 * 1. Skips files already marked as imported/duplicate (DB-level)
 * 2. invoicerec's processFile() has its own hash-based dedup (returns duplicate_of)
 */
export async function importCollectedFile(file: CollectedFile): Promise<ImportResult> {
  // Guard: already processed — don't re-import
  if (file.importStatus === 'imported' || file.importStatus === 'duplicate') {
    return { success: true, scanId: file.documentId ?? undefined, skipped: true };
  }

  // MIME guard: only import supported file types
  const ext = file.originalFilename.split('.').pop()?.toLowerCase() ?? '';
  if (!['pdf', 'jpg', 'jpeg', 'png', 'tiff', 'tif'].includes(ext)) {
    repo.updateFileImportStatus(file.id, 'failed');
    return { success: false, error: `Nicht unterstützter Dateityp: .${ext}` };
  }

  if (!existsSync(file.storedPath)) {
    repo.updateFileImportStatus(file.id, 'failed');
    return { success: false, error: `Archivdatei nicht gefunden: ${file.storedPath}` };
  }

  try {
    // Dynamic import to avoid circular dependencies
    const { processFile } = await import('../invoicerec/pipeline.js');

    const result = await processFile(file.storedPath, file.originalFilename);

    if (result.duplicate_of) {
      repo.updateFileImportStatus(file.id, 'duplicate', result.duplicate_of);
      syncExtractedInvoiceStatus(file.sha256, file.portalId, 'skipped_duplicate');
      return { success: true, scanId: result.duplicate_of };
    }

    const scanId = result.scan.scan_id;

    // Auto-confirm: create a Document from the extracted scan so it's
    // immediately available for matching (no manual review needed for bot imports).
    let documentId: string | undefined;
    try {
      const { createDocumentFromScan } = await import('../invoicerec/store.js');
      const { getFields } = await import('../invoicerec/store.js');
      const fields = getFields(scanId);
      if (fields) {
        const docResult = createDocumentFromScan(scanId, fields, result.scan.stored_filename);
        documentId = docResult.primaryDocId;
      }
    } catch (err: any) {
      // Non-fatal: scan exists even without document
      console.log(`[import-bridge] Auto-confirm failed for ${scanId}: ${err.message}`);
    }

    repo.updateFileImportStatus(file.id, 'imported', documentId ?? scanId);
    syncExtractedInvoiceStatus(file.sha256, file.portalId, 'imported', documentId ?? scanId);

    return { success: true, scanId, documentId };
  } catch (err: any) {
    repo.updateFileImportStatus(file.id, 'failed');
    syncExtractedInvoiceStatus(file.sha256, file.portalId, 'failed');
    return { success: false, error: err.message };
  }
}

/**
 * Sync extracted invoice status when file import status changes.
 * Links the extracted invoice record (from worker events) to the import outcome.
 */
function syncExtractedInvoiceStatus(sha256: string, portalId: string,
    status: 'skipped_duplicate' | 'imported' | 'failed', documentId?: string): void {
  try {
    const db = getDb();
    db.prepare(`
      UPDATE invoice_bot_extracted_invoices
      SET import_status = ?, document_id = ?, updated_at = ?
      WHERE sha256 = ? AND portal_id = ? AND import_status = 'pending'
    `).run(status, documentId ?? null, new Date().toISOString(), sha256, portalId);
  } catch { /* non-critical — extracted invoice may not exist for all files */ }
}

/**
 * Import all pending files from a run.
 * Only processes files with importStatus === 'pending'.
 * Returns summary stats.
 */
export async function importRunFiles(runId: string): Promise<{
  imported: number;
  duplicates: number;
  failed: number;
}> {
  const files = repo.listFilesByRun(runId);
  const pending = files.filter(f => f.importStatus === 'pending');

  let imported = 0;
  let duplicates = 0;
  let failed = 0;

  for (const file of pending) {
    // OCR or PDF parsing can stall on a malformed receipt. Do not leave the whole
    // Invoice Bot run in importing state indefinitely because of one file.
    const result = await Promise.race<ImportResult>([
      importCollectedFile(file),
      new Promise<ImportResult>(resolve => setTimeout(() => resolve({
        success: false,
        error: 'Import-Zeitlimit nach 120 Sekunden',
      }), 120_000)),
    ]);
    if (!result.success) repo.updateFileImportStatus(file.id, 'failed');
    if (result.skipped) {
      // Already processed in a prior attempt — count but don't re-process
      continue;
    }
    if (!result.success) {
      failed++;
      continue;
    }
    // Re-read from DB to get the actual importStatus set by importCollectedFile
    const updated = repo.getFile(file.id);
    if (updated?.importStatus === 'duplicate') {
      duplicates++;
    } else {
      imported++;
    }
  }

  return { imported, duplicates, failed };
}
