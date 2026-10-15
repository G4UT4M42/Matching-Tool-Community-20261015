/**
 * Image preprocessing for OCR quality using sharp.
 *
 * IMPORTANT: sharp only supports JPEG, PNG, WebP, AVIF, GIF, TIFF, SVG.
 * PDF rendering may produce buffers in unsupported formats (raw RGB, JBIG2, etc.).
 * When sharp fails, we convert via ImageMagick as fallback.
 */
import sharp from 'sharp';
import { execFileSync } from 'child_process';

export async function preprocessForOcr(input: Buffer, rotation: 0 | 90 | 180 | 270 = 0): Promise<Buffer> {
  try {
    return await sharp(input)
      .rotate(rotation)
      .grayscale()
      .normalize()
      .sharpen()
      .resize({ width: 2400, withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (err: any) {
    if (err.message?.includes('unsupported image format') || err.message?.includes('Input buffer')) {
      console.log(`[preprocess] sharp failed (${err.message.slice(0, 60)}), trying ImageMagick convert...`);

      // Fallback: use ImageMagick to convert the buffer to PNG
      try {
        const pngBuf = execFileSync('magick', [
          '-', // read from stdin
          ...(rotation ? ['-rotate', String(rotation)] : []),
          '-colorspace', 'Gray',
          '-normalize',
          '-sharpen', '0x1',
          '-resize', '2400x>',
          'png:-', // write PNG to stdout
        ], {
          input: input,
          maxBuffer: 50 * 1024 * 1024,
          timeout: 15_000,
        });
        console.log(`[preprocess] ImageMagick converted: ${(pngBuf.length / 1024).toFixed(0)} KB PNG`);
        return Buffer.from(pngBuf);
      } catch (magickErr: any) {
        console.log(`[preprocess] ImageMagick also failed: ${(magickErr.message || '').slice(0, 80)}`);
      }

      // Last fallback: try sharp with failOn:none (lenient mode)
      try {
        return await sharp(input, { failOn: 'none' }).png().toBuffer();
      } catch {
        // Give up preprocessing — return a 1x1 white PNG so tesseract doesn't crash
        console.log('[preprocess] All conversions failed, returning empty image');
        return await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
      }
    }
    throw err;
  }
}

export async function createThumbnail(input: Buffer, width = 400): Promise<Buffer> {
  return sharp(input)
    .resize({ width, withoutEnlargement: true })
    .png()
    .toBuffer();
}
