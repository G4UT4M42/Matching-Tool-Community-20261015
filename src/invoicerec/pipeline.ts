/**
 * Invoice recognition pipeline orchestrator.
 * Upload → Classify → Extract Text/OCR → Template Match → Parse Fields → Validate
 */
import { createHash } from 'crypto';
import { readFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'fs';
import path from 'path';
import type { InvoiceScan, ExtractedFields, PipelineResult, ExtractionMethod, StoredOcrWord } from './types.js';
import { scanId } from './ids.js';
import { classifyFile } from './classify.js';
import { extractPdfText } from './extract-pdf-text.js';
import { ocrImage, type OcrOrientation, type OcrWord } from './extract-ocr.js';
import { pdfToImages } from './pdf-to-image.js';
import { parseFields } from './parse-fields.js';
import { validateFields } from './validate.js';
import { findMatchingTemplate, applyTemplate } from './template-match.js';
import { insertScan, upsertFields, getScanByHash, updateScanStatus, updateScanTemplateId } from './store.js';
import { extractWithAi } from './extract-ai.js';
import { applyVendorOverride } from './vendor-override.js';
import { getSetting } from '../storage/settings.js';

const BELEGE_DIR = path.resolve('Belege');
const automaticAiAllowed = (): boolean => false;

/**
 * Image-backed PDFs frequently contain an invisible OCR text layer. That layer
 * can look plausible while its reading order and individual glyphs are unusable
 * for deterministic field extraction. Prefer our local OCR for those files.
 */
export function shouldUsePdfTextLayer(fileType: 'pdf_text' | 'pdf_image', text: string): boolean {
  if (fileType === 'pdf_image') return false;
  if (text.length < 40) return false;
  const digitCount = (text.match(/\d/g) ?? []).length;
  if (digitCount < 3) return false;
  const invoiceKeywords = /rechnung|invoice|total|betrag|amount|netto|brutto|datum|date|mwst|ust|vat|tax|subtotal|summe|preis|price|qty|stück|nettobetrag|zahlbar|fällig|due/i;
  return invoiceKeywords.test(text);
}

/** Debug log — always prints to stdout so we can see what's happening */
function log(step: string, msg: string, data?: any) {
  const ts = new Date().toISOString().slice(11, 23);
  const dataStr = data !== undefined ? ' ' + JSON.stringify(data, null, 0) : '';
  console.log(`[invoicerec ${ts}] [${step}] ${msg}${dataStr}`);
}

function hashFile(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

function storeFile(filePath: string, originalFilename: string): string {
  const year = new Date().getFullYear().toString();
  const destDir = path.join(BELEGE_DIR, year, 'Rechnungen');
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

  const ext = path.extname(originalFilename);
  const base = path.basename(originalFilename, ext).replace(/[^a-zA-Z0-9_\-. äöüÄÖÜß]/g, '_');
  const hash = hashFile(filePath).slice(0, 8);
  const storedName = `${base}_${hash}${ext}`;
  const destPath = path.join(destDir, storedName);

  if (!existsSync(destPath)) {
    copyFileSync(filePath, destPath);
  }

  log('store', `Stored as ${storedName}`, { destDir });
  return storedName;
}

export async function processFile(filePath: string, originalFilename: string): Promise<PipelineResult> {
  log('start', `Processing: ${originalFilename}`, { filePath });

  // Check file exists and size
  try {
    const stat = statSync(filePath);
    log('start', `File size: ${stat.size} bytes`);
    if (stat.size === 0) {
      throw new Error('Datei ist leer (0 bytes)');
    }
  } catch (err: any) {
    log('start', `ERROR: Cannot stat file: ${err.message}`);
    throw err;
  }

  // 1. Hash + duplicate check
  const fileHash = hashFile(filePath);
  log('hash', `SHA256: ${fileHash.slice(0, 16)}...`);

  const existingScan = getScanByHash(fileHash);
  if (existingScan && existingScan.status !== 'rejected') {
    log('hash', `Duplicate found: ${existingScan.scan_id} (status: ${existingScan.status})`);
    const { getFields } = await import('./store.js');
    const fields = getFields(existingScan.scan_id);
    return {
      scan: existingScan,
      fields: fields!,
      template_matched: !!existingScan.template_id,
      duplicate_of: existingScan.scan_id,
    };
  }

  // 2. Store file
  const storedFilename = storeFile(filePath, originalFilename);

  // 3. Classify
  let fileType;
  try {
    fileType = classifyFile(filePath);
    log('classify', `File type: ${fileType}`);
  } catch (err: any) {
    log('classify', `ERROR: ${err.message}`);
    throw err;
  }

  // 4. Extract text
  let rawText = '';
  let pageCount = 1;
  let extractionMethod: ExtractionMethod = 'pdf_text';
  let ocrConfidence: number | null = null;
  let storedOcrWords: StoredOcrWord[] = [];

  /** Race a promise against a timeout */
  function race<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: Timeout (${ms / 1000}s)`)), ms);
      promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
  }

  if (fileType === 'pdf_text' || fileType === 'pdf_image') {
    // Try native text extraction first (15s timeout)
    log('extract', 'Trying PDF text extraction...');
    try {
      const pdfResult = await race(extractPdfText(filePath), 15_000, 'PDF-Text');
      pageCount = pdfResult.pageCount;
      log('extract', `PDF parsed: ${pdfResult.pageCount} pages, hasText=${pdfResult.hasText}, textLen=${pdfResult.text.length}`);

      const textUsable = pdfResult.hasText && shouldUsePdfTextLayer(fileType, pdfResult.text);
      if (!textUsable && pdfResult.hasText) {
        log('extract', fileType === 'pdf_image'
          ? 'Ignoring embedded text layer of image-backed PDF; using local OCR...'
          : 'Text layer found but not usable as invoice (no amounts/keywords), trying OCR...');
      }

      if (textUsable) {
        rawText = pdfResult.text;
        storedOcrWords = pdfResult.words;
        extractionMethod = 'pdf_text';
        log('extract', `Using PDF text layer (${rawText.length} chars, ${storedOcrWords.length} positioned words)`);
      } else {
        log('extract', 'No usable text in PDF, falling back to OCR...');
        try {
          const ocrResult = await race(ocrPdfPages(filePath), 120_000, 'PDF-OCR');
          rawText = ocrResult.text;
          pageCount = ocrResult.pageCount;
          ocrConfidence = ocrResult.confidence;
          storedOcrWords = ocrResult.words;
          extractionMethod = 'ocr';
          // If OCR also didn't get good text but we had some PDF text, use the PDF text as fallback
          if (rawText.length < 30 && pdfResult.hasText) {
            rawText = pdfResult.text;
            extractionMethod = 'hybrid';
            log('extract', `OCR produced little text, using PDF text layer as fallback`);
          }
        } catch (ocrErr: any) {
          log('extract', `PDF OCR failed: ${ocrErr.message}`);
          // Fall back to whatever PDF text we got
          if (pdfResult.hasText) {
            rawText = pdfResult.text;
            extractionMethod = 'hybrid';
          }
        }
      }
    } catch (err: any) {
      log('extract', `PDF extraction FAILED: ${err.message}`);
      rawText = '';
      extractionMethod = 'ocr';
    }
  } else {
    // JPEG/PNG — OCR directly (45s timeout for entire OCR pipeline)
    log('extract', `OCR on image (${fileType})...`);
    try {
      const imgBuf = readFileSync(filePath);
      log('extract', `Image buffer size: ${imgBuf.length} bytes`);
      const ocrResult = await race(ocrImage(imgBuf), 100_000, 'Image-OCR');
      rawText = ocrResult.text;
      ocrConfidence = ocrResult.confidence;
      extractionMethod = 'ocr';
      storedOcrWords = normalizeOcrWords(
        ocrResult.words,
        ocrResult.processed_width,
        ocrResult.processed_height,
        1,
        ocrResult.orientation,
      );
      log('extract', `OCR done: confidence=${(ocrConfidence * 100).toFixed(1)}%, orientation=${ocrResult.orientation}°, textLen=${rawText.length}, words=${ocrResult.words.length}`);
    } catch (err: any) {
      log('extract', `OCR FAILED: ${err.message}`);
      rawText = '';
      extractionMethod = 'ocr';
    }
  }

  if (rawText.length === 0) {
    log('extract', 'WARNING: No text extracted at all!');
  }

  // 5. Create scan record
  const sid = scanId(fileHash, originalFilename);
  log('scan', `Scan ID: ${sid}`);

  const scan: InvoiceScan = {
    scan_id: sid,
    created_at: new Date().toISOString(),
    original_filename: originalFilename,
    stored_filename: storedFilename,
    file_hash: fileHash,
    file_type: fileType,
    page_count: pageCount,
    extraction_method: extractionMethod,
    ocr_confidence: ocrConfidence,
    status: 'pending',
    template_id: null,
    document_id: null,
    raw_text: rawText,
    meta: storedOcrWords.length > 0 ? { document_words: storedOcrWords } : {},
  };
  if (storedOcrWords.length > 0) {
    log('extract', `Stored ${storedOcrWords.length} OCR words with normalized bboxes`);
  }

  insertScan(scan);

  // 6. Template matching
  let fields: ExtractedFields;
  let templateMatched = false;

  const tmplMatch = findMatchingTemplate(rawText, storedOcrWords);
  if (tmplMatch) {
    log('template', `Template matched: ${tmplMatch.template.vendor_name} (${tmplMatch.template.template_id}), score=${tmplMatch.matchScore}`);
    const tmplFields = applyTemplate(sid, rawText, tmplMatch.template, storedOcrWords);
    const genericFields = parseFields(sid, rawText, extractionMethod === 'pdf_text' ? 'pdf_text' : 'ocr');

    // Merge: template fields override generic, but preserve EUSt/meta from generic parseFields
    const genericMeta = genericFields.meta ?? {};
    fields = { ...genericFields, ...tmplFields, scan_id: sid } as ExtractedFields;
    fields.confidence = { ...genericFields.confidence, ...(tmplFields.confidence ?? {}) };
    // Preserve EUSt split data from parseFields (template doesn't detect EUSt)
    if ((genericMeta as any)?.carrier_eust_split) {
      fields.meta = { ...fields.meta, ...genericMeta };
      // Override main amounts with service-only amounts from parseFields
      fields.gross_amount_minor = genericFields.gross_amount_minor;
      fields.net_amount_minor = genericFields.net_amount_minor;
      fields.vat_amount_minor = genericFields.vat_amount_minor;
      fields.vat_rate = genericFields.vat_rate;
      fields.tax_lines = genericFields.tax_lines;
    }

    scan.template_id = tmplMatch.template.template_id;
    updateScanTemplateId(sid, tmplMatch.template.template_id);
    templateMatched = true;
  } else {
    log('template', 'No template matched');
    const source = extractionMethod === 'pdf_text' ? 'pdf_text' : 'ocr';
    fields = parseFields(sid, rawText, source);
  }

  // Log parsed fields
  log('parse', 'Extracted fields:', {
    invoice_number: fields.invoice_number,
    invoice_date: fields.invoice_date,
    seller_name: fields.seller_name,
    seller_country: fields.seller_country,
    seller_vat_id: fields.seller_vat_id,
    net_amount_minor: fields.net_amount_minor,
    vat_amount_minor: fields.vat_amount_minor,
    vat_rate: fields.vat_rate,
    gross_amount_minor: fields.gross_amount_minor,
    currency_code: fields.currency_code,
  });
  log('parse', `Confidence:`, fields.confidence);

  // 7. AI is intentionally not invoked during normal extraction. The explicit
  // /rescan action is the only path that may send invoice text to an AI model.
  const aiEnabled = !!(getSetting('openrouter_api_key') || getSetting('invoicebot_api_key'));
  const isUsdInvoice = fields.meta?.original_currency === 'USD' || fields.currency_code === 'USD';
  // For USD invoices: gross is intentionally null (EUR unknown), don't count as "missing"
  const hasMissingFields = !fields.invoice_number || !fields.invoice_date || !fields.seller_name || (!isUsdInvoice && fields.gross_amount_minor == null);

  log('ai', `AI enabled=${aiEnabled}, missingFields=${hasMissingFields}, templateMatched=${templateMatched}, isUsd=${isUsdInvoice}, textLen=${rawText.length}`);

  // Fields that should NOT be overwritten by AI for USD invoices
  const usdProtectedFields = new Set(['gross_amount_minor', 'net_amount_minor', 'vat_amount_minor']);

  // AI runs when: (a) no template and missing fields, OR (b) template matched but critical fields still missing
  // This handles cases where a template recognizes the vendor but can't extract amounts (e.g. AliExpress screenshots)
  if (automaticAiAllowed() && aiEnabled && hasMissingFields && rawText.length > 30) {
    log('ai', 'Running AI extraction...');
    try {
      const aiResult = await extractWithAi(rawText, sid);
      if (aiResult && aiResult.fields) {
        log('ai', `AI result from ${aiResult.model_used}, fallback=${aiResult.fallback_used}:`, aiResult.fields);

        let aiFieldsFilled = 0;
        for (const [key, val] of Object.entries(aiResult.fields)) {
          // Don't let AI fill EUR amount fields on USD invoices
          if (isUsdInvoice && usdProtectedFields.has(key)) continue;
          if (val != null && (fields as any)[key] == null) {
            (fields as any)[key] = val;
            aiFieldsFilled++;
          }
        }
        for (const [key, conf] of Object.entries(aiResult.confidence)) {
          if (!fields.confidence[key]) {
            fields.confidence[key] = conf;
          }
        }
        fields.meta = {
          ...fields.meta,
          ai_model: aiResult.model_used, ai_used: true, ai_fallback: aiResult.fallback_used,
          ai_tokens: aiResult.usage.total_tokens,
          ai_cost_usd: aiResult.usage.cost_usd ?? 0,
        };
        log('ai', `AI filled ${aiFieldsFilled} missing fields, tokens=${aiResult.usage.total_tokens}, cost=$${(aiResult.usage.cost_usd ?? 0).toFixed(4)}`);

        // Post-AI USD check: if AI set currency to USD (or regex already detected USD),
        // move any EUR amount fields to USD meta and clear EUR fields.
        // EUR amounts must only come from bank transaction matching, not from the invoice itself.
        const nowUsd = fields.currency_code === 'USD' || (fields.meta as any)?.original_currency === 'USD';
        if (nowUsd && fields.gross_amount_minor != null) {
          const meta = fields.meta as any;
          if (!meta.original_currency) {
            meta.original_currency = 'USD';
            meta.original_amount_minor = fields.gross_amount_minor;
            meta.original_net_minor = fields.net_amount_minor;
            meta.original_vat_minor = fields.vat_amount_minor;
            log('ai', `USD invoice: moved gross ${fields.gross_amount_minor} to meta.original_amount_minor, cleared EUR fields`);
          }
          fields.gross_amount_minor = null;
          fields.net_amount_minor = null;
          fields.vat_amount_minor = null;
        }
      } else {
        log('ai', 'AI returned null/empty');
      }
    } catch (err: any) {
      log('ai', `AI ERROR: ${err.message}`);
      fields.meta = { ...fields.meta, ai_error: err.message };
    }
  } else if (aiEnabled) {
    log('ai', 'Skipping AI — automatic AI extraction is disabled; use the explicit rescan action');
  }

  // 7b. Alibaba seller override — FINAL precedence, after ALL other merges
  // parseFields detects Alibaba.com receipts, but template/AI may override seller.
  if ((fields.meta as any)?.is_alibaba) {
    fields.seller_name = 'Alibaba.com';
    fields.seller_country = 'SG';
    fields.seller_vat_id = null;
    fields.confidence.seller_name = { value: 0.99, source: 'alibaba_rule' as any };
    const orderNumber = (fields.meta as any)?.alibaba_order_number as string | undefined;
    if (orderNumber) {
      fields.invoice_number = orderNumber;
      fields.confidence.invoice_number = { value: 0.99, source: 'alibaba_rule' as any };
    }
    // If EUR paid amount exists, use it as gross (not the USD amount)
    const eurPaid = (fields.meta as any)?.alibaba_eur_paid;
    if (eurPaid != null && eurPaid > 0) {
      fields.gross_amount_minor = eurPaid;
      fields.currency_code = 'EUR';
      log('alibaba', `Alibaba.com seller override + EUR amount ${eurPaid}`);
    } else {
      log('alibaba', 'Alibaba.com seller override applied (no EUR amount)');
    }
    // Use alibaba order date as invoice date
    const orderDate = (fields.meta as any)?.alibaba_order_date;
    if (orderDate) {
      fields.invoice_date = orderDate;
    }
  }

  // Manual supplier data wins over a delivery address selected by OCR or AI.
  if (!(fields.meta as any)?.is_alibaba && applyVendorOverride(rawText, fields)) {
    log('vendor', `Applied supplier override: ${fields.seller_name}`);
  }

  // 7d. Self-name detection — if seller matches buyer's own name, find the actual counterparty
  const OWNER_NAMES = ['Fictional Business Demo', 'firma Fictional Business Demo'];
  if (fields.seller_name && OWNER_NAMES.some(n => fields.seller_name!.toLowerCase().includes(n))) {
    log('seller', `Seller "${fields.seller_name}" matches owner name — searching for counterparty`);
    // Try to find a different company name in the text (skip lines matching owner name)
    const textLines = rawText.split(/\n/).map((l: string) => l.trim()).filter((l: string) => l.length > 3 && l.length < 120);
    const companyRe = /\b(GmbH|AG|KG|OG|Ltd|Inc|LLC|e\.U\.|SE|S\.A\.|S\.à\.?r\.l|B\.V\.|S\.r\.l)\b/i;
    const skipRe = /^(rechnung|invoice|datum|date|seite|page|nr\.|zwischensumme|ust|mwst)/i;
    let counterparty: string | null = null;
    for (const line of textLines) {
      if (skipRe.test(line)) continue;
      if (OWNER_NAMES.some(n => line.toLowerCase().includes(n))) continue;
      if (companyRe.test(line)) {
        const match = line.match(/^(.{3,60}?\b(?:GmbH|AG|KG|OG|Ltd|Inc|LLC|e\.U\.|SE|S\.A\.|S\.à\.?r\.l|B\.V\.|S\.r\.l))\b/i);
        counterparty = match ? match[1].replace(/^[-–\s]+/, '').trim() : line.slice(0, 80).trim();
        break;
      }
    }
    if (counterparty) {
      log('seller', `Found counterparty: "${counterparty}"`);
      fields.seller_name = counterparty;
    } else {
      log('seller', 'No counterparty found — clearing seller name');
      fields.seller_name = null;
    }
  }

  // 8. Validate
  fields.validation = validateFields(fields);
  log('validate', `Errors: ${fields.validation.errors.length}, Warnings: ${fields.validation.warnings.length}`);
  if (fields.validation.errors.length > 0) {
    log('validate', 'Errors:', fields.validation.errors.map(e => e.message));
  }
  if (fields.validation.warnings.length > 0) {
    log('validate', 'Warnings:', fields.validation.warnings.map(w => w.message));
  }

  // 8b. Auto-recheck with AI for high-value (>1.000€) or Austrian invoices.
  // Verifies AND corrects amounts — not just gap-filling.
  // Uses the same model as the primary AI (no global settings mutation).
  const HIGH_VALUE_THRESHOLD = 100_000; // 1.000,00 EUR in minor units
  const grossForCheck = fields.gross_amount_minor
    ?? (fields.meta as any)?.original_amount_minor
    ?? (fields.meta as any)?.eust_amount_minor
    ?? 0;
  const isHighValue = Math.abs(grossForCheck) >= HIGH_VALUE_THRESHOLD;
  const isAustrian = fields.seller_country === 'AT';

  if (automaticAiAllowed() && (isHighValue || isAustrian) && aiEnabled && rawText.length > 30) {
    const reason = isHighValue ? `Hoher Betrag (${(Math.abs(grossForCheck) / 100).toFixed(2)})` : 'AT-Rechnung';
    log('recheck', `${reason} — Gegenprüfung mit AI`);
    try {
      const recheckResult = await extractWithAi(rawText, sid);
      if (recheckResult?.fields) {
        let corrections = 0;

        // Fill missing fields
        for (const [key, val] of Object.entries(recheckResult.fields)) {
          if (val != null && (fields as any)[key] == null) {
            // Don't fill EUR amounts on USD invoices
            if ((fields.currency_code === 'USD' || (fields.meta as any)?.original_currency === 'USD') &&
                ['gross_amount_minor', 'net_amount_minor', 'vat_amount_minor'].includes(key)) continue;
            (fields as any)[key] = val;
            fields.confidence[key] = { value: 0.85, source: 'ai_parser' };
            corrections++;
          }
        }

        // Verify amounts: if recheck disagrees significantly (>10%), trust the recheck
        const amountFields = ['gross_amount_minor', 'net_amount_minor', 'vat_amount_minor'] as const;
        for (const key of amountFields) {
          const current = (fields as any)[key] as number | null;
          const recheck = (recheckResult.fields as any)[key] as number | undefined;
          if (current != null && recheck != null && current !== 0) {
            const diff = Math.abs(recheck - current) / Math.abs(current);
            if (diff > 0.10) {
              log('recheck', `Betrag-Korrektur: ${key} ${(current/100).toFixed(2)} → ${(recheck/100).toFixed(2)} (${(diff * 100).toFixed(0)}% Abweichung)`);
              (fields as any)[key] = recheck;
              fields.confidence[key] = { value: 0.9, source: 'ai_parser' };
              corrections++;
            }
          }
        }

        // Update meta
        const prevTokens = (fields.meta as any)?.ai_tokens ?? 0;
        const prevCost = (fields.meta as any)?.ai_cost_usd ?? 0;
        fields.meta = {
          ...fields.meta,
          ai_used: true,
          ai_tokens: prevTokens + recheckResult.usage.total_tokens,
          ai_cost_usd: prevCost + (recheckResult.usage.cost_usd ?? 0),
          recheck_reason: isHighValue ? 'high_value' : 'austrian',
          recheck_corrections: corrections,
        };

        if (corrections > 0) {
          fields.validation = validateFields(fields);
          log('recheck', `${corrections} Korrektur(en) durch Gegenprüfung`);
        } else {
          log('recheck', 'Gegenprüfung bestätigt bestehende Werte');
        }
      }
    } catch (err: any) {
      log('recheck', `Gegenprüfung fehlgeschlagen: ${err.message}`);
    }
  }

  // Keep the manual supplier decision after the optional AI recheck as well.
  applyVendorOverride(rawText, fields);
  fields.validation = validateFields(fields);

  // 9. Store extracted fields
  upsertFields(fields);

  // 10. Update scan status
  updateScanStatus(sid, 'extracted');

  log('done', `Finished: ${originalFilename} → ${sid}`, {
    status: 'extracted',
    invoice_number: fields.invoice_number,
    seller_name: fields.seller_name,
    gross_amount_minor: fields.gross_amount_minor,
    template_matched: templateMatched,
    ai_used: !!fields.meta.ai_used,
  });

  return {
    scan: { ...scan, status: 'extracted' },
    fields,
    template_matched: templateMatched,
    duplicate_of: null,
  };
}

async function ocrPdfPages(filePath: string): Promise<{ text: string; pageCount: number; confidence: number; words: StoredOcrWord[] }> {
  log('ocr-pdf', 'Rendering PDF pages to images...');
  const images = await pdfToImages(filePath);
  log('ocr-pdf', `Rendered ${images.length} pages`);

  const ocrTexts: string[] = [];
  const allWords: StoredOcrWord[] = [];
  let totalConf = 0;

  for (const img of images) {
    log('ocr-pdf', `OCR page ${img.page} (${img.width}x${img.height})...`);
    const ocrResult = await ocrImage(img.buffer);
    ocrTexts.push(ocrResult.text);
    totalConf += ocrResult.confidence;
    allWords.push(...normalizeOcrWords(
      ocrResult.words,
      ocrResult.processed_width,
      ocrResult.processed_height,
      img.page,
      ocrResult.orientation,
    ));
    log('ocr-pdf', `Page ${img.page}: confidence=${(ocrResult.confidence * 100).toFixed(1)}%, orientation=${ocrResult.orientation}°, chars=${ocrResult.text.length}, words=${ocrResult.words.length}`);
  }

  const text = ocrTexts.join('\n\n--- Page Break ---\n\n');
  const confidence = images.length > 0 ? totalConf / images.length : 0;
  log('ocr-pdf', `OCR total: ${text.length} chars, avg confidence=${(confidence * 100).toFixed(1)}%, words=${allWords.length}`);
  return { text, pageCount: images.length, confidence, words: allWords };
}

/** Convert OCR boxes from the selected upright rotation back to source-page coordinates. */
export function normalizeOcrWords(
  words: OcrWord[],
  processedWidth: number,
  processedHeight: number,
  page: number,
  orientation: OcrOrientation,
): StoredOcrWord[] {
  return words.map(word => {
    const x = word.bbox.x0 / processedWidth;
    const y = word.bbox.y0 / processedHeight;
    const width = (word.bbox.x1 - word.bbox.x0) / processedWidth;
    const height = (word.bbox.y1 - word.bbox.y0) / processedHeight;
    if (orientation === 90) {
      return { text: word.text, confidence: word.confidence, page, x: y, y: 1 - x - width, w: height, h: width };
    }
    if (orientation === 270) {
      return { text: word.text, confidence: word.confidence, page, x: 1 - y - height, y: x, w: height, h: width };
    }
    return { text: word.text, confidence: word.confidence, page, x, y, w: width, h: height };
  });
}

export async function processBatch(files: Array<{ path: string; originalname: string }>): Promise<PipelineResult[]> {
  log('batch', `Processing ${files.length} file(s)`, files.map(f => f.originalname));
  const results: PipelineResult[] = [];

  for (const file of files) {
    try {
      const result = await processFile(file.path, file.originalname);
      results.push(result);
    } catch (err: any) {
      log('batch', `FAILED: ${file.originalname}: ${err.message}\n${err.stack}`);
      const fileHash = hashFile(file.path);
      const sid = scanId(fileHash, file.originalname);
      const errorScan: InvoiceScan = {
        scan_id: sid,
        created_at: new Date().toISOString(),
        original_filename: file.originalname,
        stored_filename: '',
        file_hash: fileHash,
        file_type: 'jpeg',
        page_count: 0,
        extraction_method: 'ocr',
        ocr_confidence: null,
        status: 'error',
        template_id: null,
        document_id: null,
        raw_text: null,
        meta: { error: err.message, stack: err.stack },
      };
      try { insertScan(errorScan); } catch { /* duplicate */ }
      results.push({
        scan: errorScan,
        fields: emptyFields(sid),
        template_matched: false,
        duplicate_of: null,
      });
    }
  }

  log('batch', `Batch complete: ${results.length} results`);
  return results;
}

function emptyFields(sid: string): ExtractedFields {
  return {
    scan_id: sid,
    invoice_number: null, invoice_date: null,
    seller_name: null, seller_address: null, seller_country: null, seller_vat_id: null,
    buyer_name: null, buyer_vat_id: null,
    currency_code: 'EUR',
    net_amount_minor: null, vat_amount_minor: null, vat_rate: null, gross_amount_minor: null,
    tax_lines: [], line_items: [],
    field_regions: {}, confidence: {},
    validation: { warnings: [], errors: [{ code: 'PROCESSING_ERROR', message: 'Verarbeitung fehlgeschlagen', severity: 'error' }] },
    meta: {},
  };
}
