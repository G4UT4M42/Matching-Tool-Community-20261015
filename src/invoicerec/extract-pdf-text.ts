/**
 * Extract text layer from PDF using pdfjs-dist directly.
 * No dependency on pdf-parse — pdfjs-dist handles both text extraction and rendering.
 */
import { readFileSync } from 'fs';
import type { StoredOcrWord } from './types.js';

export interface PdfTextResult {
  text: string;
  pageCount: number;
  hasText: boolean;
  /** Native PDF words in the same normalized coordinate system as OCR words. */
  words: StoredOcrWord[];
}

export async function extractPdfText(filePath: string): Promise<PdfTextResult> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

  const pages: string[] = [];
  const words: StoredOcrWord[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });

    // Group text items into lines by Y-coordinate
    const items = content.items as any[];
    if (items.length === 0) { pages.push(''); continue; }

    let lastY: number | null = null;
    const lineChunks: string[] = [];
    for (const item of items) {
      const str = item.str ?? '';
      if (str === '') continue;
      const y = item.transform ? item.transform[5] : null;
      // If Y changes significantly, it's a new line
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) {
        lineChunks.push('\n');
      }
      lineChunks.push(str + ' ');
      if (y !== null) lastY = y;

      if (item.transform && viewport.width > 0 && viewport.height > 0) {
        const tokens = String(str).trim().split(/\s+/).filter(Boolean);
        const itemWidth = Math.max(Number(item.width) || 0, 1);
        const itemHeight = Math.max(Number(item.height) || Math.abs(Number(item.transform[3])) || 8, 1);
        const totalChars = Math.max(tokens.reduce((sum: number, token: string) => sum + token.length, 0), 1);
        let cursorX = Number(item.transform[4]) || 0;
        for (const token of tokens) {
          const tokenWidth = itemWidth * (token.length / totalChars);
          const normalizedX = Math.max(0, Math.min(1, cursorX / viewport.width));
          const normalizedY = Math.max(0, Math.min(1, (viewport.height - Number(item.transform[5]) - itemHeight) / viewport.height));
          words.push({
            text: token,
            confidence: 1,
            page: i,
            x: normalizedX,
            y: normalizedY,
            w: Math.max(0, Math.min(1 - normalizedX, tokenWidth / viewport.width)),
            h: Math.max(0, Math.min(1 - normalizedY, itemHeight / viewport.height)),
          });
          cursorX += tokenWidth + (tokens.length > 1 ? itemWidth * 0.01 : 0);
        }
      }
    }
    pages.push(lineChunks.join('').trim());
  }

  const text = pages.join('\n\n').trim();
  return {
    text,
    pageCount: doc.numPages,
    hasText: text.length > 30,
    words,
  };
}
