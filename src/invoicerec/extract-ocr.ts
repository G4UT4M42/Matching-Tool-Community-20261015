/**
 * OCR extraction using tesseract.js.
 * Singleton worker with force-kill recovery if it gets stuck.
 */
import { createWorker, OEM } from 'tesseract.js';
import { existsSync } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { preprocessForOcr } from './preprocess.js';

export interface OcrResult {
  text: string;
  confidence: number; // 0-1
  words: OcrWord[];
  orientation: OcrOrientation;
  processed_width: number;
  processed_height: number;
}

export type OcrOrientation = 0 | 90 | 270;

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Normalize both the legacy `data.words` output and Tesseract.js >= 6 blocks. */
export function extractOcrWords(data: any): OcrWord[] {
  const legacyWords = Array.isArray(data?.words) ? data.words : [];
  const blockWords = Array.isArray(data?.blocks)
    ? data.blocks.flatMap((block: any) =>
      (block?.paragraphs ?? []).flatMap((paragraph: any) =>
        (paragraph?.lines ?? []).flatMap((line: any) => line?.words ?? [])))
    : [];
  return (legacyWords.length > 0 ? legacyWords : blockWords)
    .filter((word: any) => word?.text && word?.bbox)
    .map((word: any) => ({
      text: String(word.text),
      confidence: Number(word.confidence ?? 0) / 100,
      bbox: word.bbox,
    }));
}

const OCR_TIMEOUT_MS = 30_000;
const WORKER_INIT_TIMEOUT_MS = 30_000;
const PREPROCESS_TIMEOUT_MS = 10_000;

// Singleton state
let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
let workerInitializing = false;
let busy = false;

let cachedLangPath: string | undefined | null = null;

function findLocalLangPath(): string | undefined {
  if (cachedLangPath !== null) return cachedLangPath;
  for (const dir of [path.resolve('tessdata'), path.resolve('.')]) {
    if (existsSync(path.join(dir, 'deu.traineddata')) && existsSync(path.join(dir, 'eng.traineddata'))) {
      console.log(`[ocr] Local traineddata: ${dir}`);
      cachedLangPath = dir;
      return dir;
    }
  }
  cachedLangPath = undefined;
  return undefined;
}

function race<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: Timeout (${ms / 1000}s)`)), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Force-kill worker synchronously — next call will create a new one */
function forceKill() {
  const old = worker;
  worker = null;
  busy = false;
  workerInitializing = false;
  if (old) {
    // Fire and forget — don't await, don't care if it fails
    try { old.terminate(); } catch {}
  }
}

async function ensureWorker(): Promise<Awaited<ReturnType<typeof createWorker>>> {
  if (worker) return worker;
  if (workerInitializing) {
    // Another call is already creating a worker — wait a bit
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (worker) return worker;
      if (!workerInitializing) break;
    }
    if (!worker) throw new Error('Worker-Erstellung dauert zu lange');
  }

  workerInitializing = true;
  try {
    const langPath = findLocalLangPath();
    const opts: any = langPath ? { langPath } : {};
    console.log(`[ocr] Creating worker (langPath=${langPath ?? 'CDN'})...`);
    worker = await race(
      createWorker('deu+eng', OEM.DEFAULT, opts),
      WORKER_INIT_TIMEOUT_MS,
      'Worker-Init',
    );
    console.log('[ocr] Worker ready');
    workerInitializing = false;
    return worker;
  } catch (err) {
    workerInitializing = false;
    worker = null;
    throw err;
  }
}

const ORIENTATION_KEYWORDS = /rechnung|invoice|datum|date|gesamt|total|summe|betrag|netto|brutto|mwst|ust|vat|steuer|tax|eur|euro/i;

/**
 * Rates OCR output independently of a particular invoice layout. This is used
 * only to choose between rotations of the same source image.
 */
export function scoreOcrResult(result: Pick<OcrResult, 'text' | 'confidence'>): number {
  const text = result.text.trim();
  const alnumCount = (text.match(/[\p{L}\d]/gu) ?? []).length;
  const digitCount = (text.match(/\d/g) ?? []).length;
  const keywordCount = (text.match(new RegExp(ORIENTATION_KEYWORDS.source, 'gi')) ?? []).length;
  return result.confidence * 60
    + Math.min(alnumCount, 900) / 30
    + Math.min(digitCount, 80) * 0.4
    + Math.min(keywordCount, 8) * 5;
}

function needsOrientationRetry(result: OcrResult): boolean {
  const digitCount = (result.text.match(/\d/g) ?? []).length;
  return result.confidence < 0.58 || digitCount < 3 || !ORIENTATION_KEYWORDS.test(result.text);
}

async function recognizeAtOrientation(
  imageBuffer: Buffer,
  orientation: OcrOrientation,
): Promise<OcrResult> {
  const processed = await race(
    preprocessForOcr(imageBuffer, orientation),
    PREPROCESS_TIMEOUT_MS,
    `Preprocess-${orientation}`,
  );
  const metadata = await sharp(processed).metadata();
  const processedWidth = metadata.width ?? 1;
  const processedHeight = metadata.height ?? 1;

  const w = await ensureWorker();
  busy = true;
  try {
    const { data } = await race(
      w.recognize(processed, {}, { text: true, blocks: true }),
      OCR_TIMEOUT_MS,
      `OCR-${orientation}`,
    );
    busy = false;
    const words = extractOcrWords(data);
    return {
      text: data.text,
      confidence: data.confidence / 100,
      words,
      orientation,
      processed_width: processedWidth,
      processed_height: processedHeight,
    };
  } catch (err) {
    console.log(`[ocr] Recognize failed at ${orientation}°: ${(err as Error).message} — killing worker`);
    forceKill();
    throw err;
  }
}

export async function ocrImage(imageBuffer: Buffer): Promise<OcrResult> {
  // If previous call left the worker busy (timed out), kill it
  if (busy) {
    console.log('[ocr] Previous call still busy — killing worker');
    forceKill();
  }

  const first = await recognizeAtOrientation(imageBuffer, 0);
  if (!needsOrientationRetry(first)) return first;

  const candidates = [first];
  for (const orientation of [90, 270] as const) {
    try {
      candidates.push(await recognizeAtOrientation(imageBuffer, orientation));
    } catch (err) {
      console.log(`[ocr] Orientation ${orientation}° skipped: ${(err as Error).message}`);
    }
  }

  const best = candidates.sort((left, right) => scoreOcrResult(right) - scoreOcrResult(left))[0];
  console.log(`[ocr] Orientation selected: ${best.orientation}° (${candidates.map(item => `${item.orientation}°=${scoreOcrResult(item).toFixed(1)}`).join(', ')})`);
  return best;
}

export async function resetOcrWorker(): Promise<void> { forceKill(); }
export async function terminateOcr(): Promise<void> { forceKill(); }
