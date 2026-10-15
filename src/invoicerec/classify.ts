/**
 * Classify uploaded file by reading magic bytes.
 */
import { readFileSync } from 'fs';
import type { FileType } from './types.js';

export function classifyFile(filePath: string): FileType {
  const buf = readFileSync(filePath);
  const head = buf.subarray(0, 8);

  // PDF: starts with %PDF
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
    return classifyPdf(buf);
  }

  // JPEG: starts with FF D8 FF
  if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) {
    return 'jpeg';
  }

  // PNG: starts with 89 50 4E 47
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) {
    return 'png';
  }

  // Fallback: try as PDF anyway (some PDFs have BOM prefix)
  const headStr = buf.subarray(0, 1024).toString('ascii');
  if (headStr.includes('%PDF')) {
    return classifyPdf(buf);
  }

  throw new Error(`Unrecognized file format: ${filePath}`);
}

function classifyPdf(buf: Buffer): FileType {
  // Heuristic: if the PDF contains /Font or significant text stream markers, it's text-based.
  // If it only has /Image XObjects, it's image-based.
  const content = buf.toString('ascii', 0, Math.min(buf.length, 50000));

  const hasFont = content.includes('/Font');
  const hasText = content.includes('/Type /Page') && (content.includes('BT') && content.includes('ET'));
  const hasImage = content.includes('/Subtype /Image') || content.includes('/XObject');

  if (hasFont && hasText) return 'pdf_text';
  if (hasImage && !hasFont) return 'pdf_image';

  // Default: assume text-based, pdf-parse will tell us if there's no text
  return 'pdf_text';
}
