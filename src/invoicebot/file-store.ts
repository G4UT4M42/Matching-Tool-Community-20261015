/**
 * File archive for collected invoice files.
 * Handles SHA256 hashing, deduplication, and stable archive storage.
 *
 * Archive layout: data/invoice-bot/archive/<portalId>/<YYYY>/<MM>/<sha256>.<ext>
 *
 * Extension canonicalization:
 * - Extension is always lowercased
 * - Only known invoice extensions are kept; unknown → .bin
 * - Same file content always maps to the same canonical archive path
 *   (the extension is part of the path, so we canonicalize it deterministically)
 */
import { createHash } from 'crypto';
import { readFileSync, copyFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'fs';
import path from 'path';
import { resolveAccountingPaths, resolveRuntimePath } from '../storage/paths.js';

const ACCOUNTING_PATHS = resolveAccountingPaths();
const ARCHIVE_ROOT = ACCOUNTING_PATHS.mode === 'external-runtime-root'
  ? resolveRuntimePath(ACCOUNTING_PATHS, 'documents', 'invoice-bot', 'archive')
  : resolveRuntimePath(ACCOUNTING_PATHS, 'state', 'invoice-bot', 'archive');

/** Known invoice-related extensions (lowercased, with dot) */
const KNOWN_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.tiff', '.tif', '.gif', '.bmp', '.webp']);

export interface ArchiveResult {
  sha256: string;
  storedPath: string;
  sizeBytes: number;
  isDuplicate: boolean;
}

/** Calculate SHA256 hash of a file */
export function hashFile(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Canonicalize a file extension.
 * - Lowercased
 * - Only known extensions pass through; unknown → '.bin'
 * - Ensures same content with different original names gets the same archive path
 */
export function canonicalExtension(originalFilename: string): string {
  const ext = path.extname(originalFilename).toLowerCase();
  if (!ext) return '.bin';
  return KNOWN_EXTENSIONS.has(ext) ? ext : '.bin';
}

/** Build the canonical archive path for a file */
export function buildArchivePath(
  portalId: string,
  sha256: string,
  originalFilename: string,
  dateHint?: string,
): string {
  const ext = canonicalExtension(originalFilename);
  const year = dateHint?.slice(0, 4) ?? new Date().getFullYear().toString();
  const month = dateHint?.slice(5, 7) ?? (new Date().getMonth() + 1).toString().padStart(2, '0');
  return path.join(ARCHIVE_ROOT, portalId, year, month, `${sha256}${ext}`);
}

/**
 * Check if a file with this SHA256 already exists in the archive.
 * Scans the archive directory for any file whose name starts with the hash.
 * This handles the case where the same content was archived with a different extension.
 */
export function findExistingArchivePath(sha256: string, portalId: string): string | null {
  const portalDir = path.join(ARCHIVE_ROOT, portalId);
  if (!existsSync(portalDir)) return null;

  // Walk year/month directories looking for <sha256>.* files
  try {
    for (const year of readdirSync(portalDir)) {
      const yearDir = path.join(portalDir, year);
      if (!statSync(yearDir).isDirectory()) continue;
      for (const month of readdirSync(yearDir)) {
        const monthDir = path.join(yearDir, month);
        if (!statSync(monthDir).isDirectory()) continue;
        for (const file of readdirSync(monthDir)) {
          if (file.startsWith(sha256)) {
            return path.join(monthDir, file);
          }
        }
      }
    }
  } catch { /* directory read errors are non-fatal */ }
  return null;
}

/** Ensure directory exists */
function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/** Normalize a filename: remove unsafe chars, keep extension */
export function normalizeFilename(filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext)
    .replace(/[^a-zA-Z0-9_\-. äöüÄÖÜß]/g, '_')
    .slice(0, 100);
  return base + ext.toLowerCase();
}

/**
 * Archive a downloaded file.
 * - Calculates SHA256
 * - Checks for duplicates by hash (not just path)
 * - Copies to stable archive path with canonical extension
 * - Returns metadata for DB persistence
 */
export function archiveFile(
  sourcePath: string,
  portalId: string,
  originalFilename: string,
  dateHint?: string,
): ArchiveResult {
  const sha256 = hashFile(sourcePath);
  const size = statSync(sourcePath).size;

  // Check if this hash already exists anywhere in this portal's archive
  const existingPath = findExistingArchivePath(sha256, portalId);
  if (existingPath) {
    return { sha256, storedPath: existingPath, sizeBytes: size, isDuplicate: true };
  }

  // Build canonical archive path and copy
  const archivePath = buildArchivePath(portalId, sha256, originalFilename, dateHint);
  ensureDir(path.dirname(archivePath));
  copyFileSync(sourcePath, archivePath);

  return { sha256, storedPath: archivePath, sizeBytes: size, isDuplicate: false };
}

/** Get the archive root path */
export function getArchiveRoot(): string {
  return ARCHIVE_ROOT;
}
