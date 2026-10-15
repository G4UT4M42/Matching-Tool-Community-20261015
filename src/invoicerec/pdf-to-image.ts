/**
 * Render PDF pages to PNG images.
 * Strategy: Poppler → ImageMagick/Ghostscript. pdfjs-dist is used only to
 * determine the page count; its Node canvas renderer can leave rejected render
 * tasks behind for image-only PDFs and terminate the complete folder import.
 */
import { readFileSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

export interface PageImage {
  page: number;
  buffer: Buffer;
  width: number;
  height: number;
}

export async function pdfToImages(filePath: string, dpi = 200): Promise<PageImage[]> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const fileData = readFileSync(filePath);
  const data = new Uint8Array(fileData);
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const pageCount = doc.numPages;
  await doc.destroy();
  const results = renderWithExternalTool(filePath, pageCount, dpi);

  if (results.length === 0) {
    throw new Error(`Keine Seite konnte gerendert werden (${pageCount} Seiten im PDF)`);
  }

  return results;
}

/** Render PDF pages using ImageMagick (magick) or Ghostscript (gswin64c/gs) as fallback */
function renderWithExternalTool(filePath: string, numPages: number, dpi: number): PageImage[] {
  const results: PageImage[] = [];

  for (let page = 0; page < numPages; page++) {
    // Poppler is deterministic for scan PDFs and avoids the Node-canvas image
    // compatibility issue in recent pdfjs versions.
    try {
      const tmpPrefix = path.join(os.tmpdir(), `pdf-page-${process.pid}-${page + 1}-${Date.now()}`);
      const tmpFile = `${tmpPrefix}.png`;
      execFileSync('pdftoppm', [
        '-f', String(page + 1), '-l', String(page + 1), '-singlefile',
        '-png', '-r', String(dpi), filePath, tmpPrefix,
      ], { maxBuffer: 50 * 1024 * 1024, timeout: 30_000 });
      const pngBuf = readFileSync(tmpFile);
      try { unlinkSync(tmpFile); } catch {}
      const dims = readPngDimensions(pngBuf);
      results.push({
        page: page + 1,
        buffer: Buffer.from(pngBuf),
        width: dims?.width ?? 1654,
        height: dims?.height ?? 2339,
      });
      console.log(`[pdf-to-image] Page ${page + 1} rendered via Poppler (${(pngBuf.length / 1024).toFixed(0)}KB)`);
      continue;
    } catch (err: any) {
      console.log(`[pdf-to-image] Poppler failed for page ${page + 1}: ${err.message?.slice(0, 100)}`);
    }

    // Try ImageMagick first
    try {
      const pngBuf = execFileSync('magick', [
        '-density', String(dpi),
        `${filePath}[${page}]`,
        '-quality', '90',
        '-background', 'white',
        '-alpha', 'remove',
        'png:-',
      ], { maxBuffer: 50 * 1024 * 1024, timeout: 30_000 });

      const dims = readPngDimensions(pngBuf);
      results.push({
        page: page + 1,
        buffer: Buffer.from(pngBuf),
        width: dims?.width ?? 1654,
        height: dims?.height ?? 2339,
      });
      console.log(`[pdf-to-image] Page ${page + 1} rendered via ImageMagick (${(pngBuf.length / 1024).toFixed(0)}KB)`);
      continue;
    } catch (err: any) {
      console.log(`[pdf-to-image] ImageMagick failed for page ${page + 1}: ${err.message?.slice(0, 100)}`);
    }

    // Try Ghostscript — use temp file instead of stdout to avoid header contamination on Windows
    try {
      const gsCmd = process.platform === 'win32' ? 'gswin64c' : 'gs';
      const tmpFile = path.join(os.tmpdir(), `gs-page-${page + 1}-${Date.now()}.png`);
      execFileSync(gsCmd, [
        '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dQUIET',
        '-sDEVICE=png16m',
        `-dFirstPage=${page + 1}`, `-dLastPage=${page + 1}`,
        `-r${dpi}`,
        `-sOutputFile=${tmpFile}`,
        filePath,
      ], { maxBuffer: 50 * 1024 * 1024, timeout: 30_000 });

      const pngBuf = readFileSync(tmpFile);
      try { unlinkSync(tmpFile); } catch {}

      const dims = readPngDimensions(pngBuf);
      results.push({
        page: page + 1,
        buffer: Buffer.from(pngBuf),
        width: dims?.width ?? 1654,
        height: dims?.height ?? 2339,
      });
      console.log(`[pdf-to-image] Page ${page + 1} rendered via Ghostscript (${(pngBuf.length / 1024).toFixed(0)}KB)`);
    } catch (err: any) {
      console.log(`[pdf-to-image] Ghostscript also failed for page ${page + 1}: ${err.message?.slice(0, 100)}`);
    }
  }

  return results;
}

/** Read PNG dimensions from IHDR chunk */
function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG header: 8 bytes, then IHDR chunk: 4 len + 4 "IHDR" + 4 width + 4 height
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}
