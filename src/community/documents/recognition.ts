import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import sharp from 'sharp';
import { createWorker, OEM } from 'tesseract.js';
import { statementDate, statementMinor } from '../../import/statement-parser.js';
import { packagedOcrDirectory } from './ocr-assets.js';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_PAGES = 10;
export const MAX_PIXELS = 20_000_000;
export type DocumentKind = 'pdf' | 'png' | 'jpeg';
export interface RecognizedInvoice {
  invoice_number?: string; supplier_name?: string; document_date?: string;
  total_amount_minor?: number; net_amount_minor?: number; vat_amount_minor?: number;
  currency_code?: string; payment_reference?: string; iban?: string;
  confidence: number; raw_text: string; warnings: string[];
}
export class DocumentInputError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): never => { throw new DocumentInputError(code, message); };
export const documentHash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

/** Content is checked before any durable state mutation. PDF active actions are forbidden. */
export async function inspectDocument(buffer: Buffer, filename: string): Promise<{ kind: DocumentKind; pages: number }> {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_DOCUMENT_BYTES) fail('FILE_LIMIT', 'Document must be 1 byte to 10 MiB');
  if (!filename || filename.length > 200 || /[\\/\u0000-\u001f]/.test(filename) || filename === '.' || filename === '..') fail('INVALID_FILENAME', 'Invalid document filename');
  const ext = extname(filename).toLowerCase();
  if (buffer.subarray(0, 5).toString() === '%PDF-') {
    if (ext !== '.pdf') fail('TYPE_MISMATCH', 'PDF content needs a .pdf filename');
    const binary = buffer.toString('latin1');
    const decodedNames = binary.replace(/\/(?:[A-Za-z]|#[0-9a-fA-F]{2})+/g, token => token.replace(/#([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))));
    if (!/%%EOF\s*$/.test(binary) || /\/(?:JS|JavaScript|OpenAction|AA|Launch|URI|GoToR|SubmitForm|ImportData|EmbeddedFile|RichMedia|XFA|AcroForm|Encrypt|ObjStm)\b/i.test(decodedNames)) fail('UNSAFE_PDF', 'Malformed or active PDF is unsupported');
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, isEvalSupported: false }).promise;
      try {
        if (pdf.numPages < 1 || pdf.numPages > MAX_PAGES) fail('PAGE_LIMIT', 'PDF page count exceeds limit');
        if (await pdf.getAttachments() || await pdf.getJSActions()) fail('UNSAFE_PDF', 'PDF attachments and active actions are unsupported');
        for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
          const page = await pdf.getPage(pageNo);
          if ((await page.getAnnotations()).length) fail('UNSAFE_PDF', 'PDF annotations and external links are unsupported');
          const viewport = page.getViewport({ scale: 1 });
          if (!(viewport.width > 0 && viewport.height > 0) || viewport.width > 4000 || viewport.height > 4000 || viewport.width * viewport.height > 2_000_000) fail('PAGE_LIMIT', 'PDF page dimensions exceed limit');
          page.cleanup();
        }
        return { kind: 'pdf', pages: pdf.numPages };
      } finally { await pdf.destroy(); }
    } catch (error) {
      if (error instanceof DocumentInputError) throw error;
      fail('MALFORMED_PDF', 'PDF could not be parsed');
    }
  }
  const png = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (!png && !jpeg) fail('UNSUPPORTED_CONTENT', 'Only PDF, PNG, and JPEG files are supported');
  if (ext !== (png ? '.png' : '.jpg') && !(jpeg && ext === '.jpeg')) fail('TYPE_MISMATCH', 'Filename extension does not match image content');
  if (png && buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (!width || !height || width * height > MAX_PIXELS) fail('PIXEL_LIMIT', 'Image dimensions exceed limit');
  }
  try {
    const metadata = await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS || metadata.pages && metadata.pages !== 1) fail('PIXEL_LIMIT', 'Image dimensions exceed limit');
    await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).stats();
  } catch (error) {
    if (error instanceof DocumentInputError) throw error;
    fail(/pixel/i.test(String((error as Error).message)) ? 'PIXEL_LIMIT' : 'MALFORMED_IMAGE', 'Image could not be decoded');
  }
  return { kind: png ? 'png' : 'jpeg', pages: 1 };
}

function exactAmount(text: string, currency: string): number | undefined {
  try { return statementMinor(text, currency); } catch { return undefined; }
}
/** Conservative suggestions: conflicting labels or incomplete fields remain for human review. */
export function parseRecognizedInvoice(rawText: string, confidence = 1): RecognizedInvoice {
  const text = rawText.slice(0, 100_000).replace(/\r/g, '');
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const warnings: string[] = [];
  const currencyCodes = [...new Set((text.match(/\b(?:EUR|USD|GBP|CHF)\b|€/gi) ?? []).map(x => x === '€' ? 'EUR' : x.toUpperCase()))];
  const currency = currencyCodes.length === 1 ? currencyCodes[0] : undefined;
  if (!currency) warnings.push('DOCUMENT_CURRENCY_MISSING_OR_AMBIGUOUS');
  const pick = (labels: string) => lines.map(line => new RegExp(`(?:${labels})\\s*[:#]?\\s*(.+)$`, 'i').exec(line)?.[1]?.trim()).filter((v): v is string => !!v);
  const invoiceNumbers = [...new Set(pick('invoice\\s*(?:no\\.?|number|#)|rechnungs(?:nummer|nr\\.?)'))];
  if (invoiceNumbers.length !== 1) warnings.push('DOCUMENT_INVOICE_NUMBER_MISSING_OR_AMBIGUOUS');
  const dateValues = pick('invoice\\s*date|rechnungsdatum|belegdatum');
  const parsedDates = [...new Set(dateValues.map(value => { try { return statementDate(value); } catch { return undefined; } }).filter((v): v is string => !!v))];
  if (parsedDates.length !== 1) warnings.push('DOCUMENT_DATE_MISSING_OR_AMBIGUOUS');
  const extractMoney = (labels: string) => [...new Set(pick(labels).map(value => {
    const match = /(?:EUR|USD|GBP|CHF|€)?\s*([+-]?(?:\d{1,3}(?:[.,]\d{3})+|\d+)[.,]\d{2})\b/i.exec(value);
    return match && currency ? exactAmount(match[1], currency) : undefined;
  }).filter((v): v is number => v !== undefined))];
  const gross = extractMoney('grand\\s*total|invoice\\s*total|total\\s*due|amount\\s*due|gesamtbetrag|bruttobetrag|rechnungsbetrag');
  const net = extractMoney('subtotal|net\\s*total|netto(?:betrag)?');
  const vat = extractMoney('vat|mwst|umsatzsteuer|mehrwertsteuer');
  if (gross.length !== 1 || gross[0] <= 0) warnings.push('DOCUMENT_GROSS_MISSING_OR_AMBIGUOUS');
  if (net.length > 1 || vat.length > 1) warnings.push('DOCUMENT_NET_OR_VAT_AMBIGUOUS');
  if (gross.length === 1 && net.length === 1 && vat.length === 1 && net[0] + vat[0] !== gross[0]) warnings.push('DOCUMENT_TOTAL_MISMATCH');
  const supplier = pick('supplier|vendor|lieferant|aussteller');
  const iban = [...new Set((text.match(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}\b/g) ?? []).map(x => x.replace(/\s/g, '')))];
  const reference = pick('payment\\s*reference|verwendungszweck|zahlungsreferenz');
  return {
    ...(invoiceNumbers.length === 1 ? { invoice_number: invoiceNumbers[0] } : {}),
    ...(supplier.length === 1 ? { supplier_name: supplier[0] } : {}),
    ...(parsedDates.length === 1 ? { document_date: parsedDates[0] } : {}),
    ...(gross.length === 1 && gross[0] > 0 ? { total_amount_minor: gross[0] } : {}),
    ...(net.length === 1 ? { net_amount_minor: net[0] } : {}),
    ...(vat.length === 1 ? { vat_amount_minor: vat[0] } : {}),
    ...(currency ? { currency_code: currency } : {}),
    ...(iban.length === 1 ? { iban: iban[0] } : {}),
    ...(reference.length === 1 ? { payment_reference: reference[0] } : {}),
    confidence: Math.max(0, Math.min(1, confidence)), raw_text: text, warnings,
  };
}

export async function recognizeDocument(buffer: Buffer, kind: DocumentKind, localLanguageDir?: string): Promise<RecognizedInvoice> {
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let renderedPixels = 0;
  const recognizeImage = async (image: Buffer): Promise<{text:string;confidence:number}> => {
    if (!worker) {
      const { join } = await import('node:path');
      const { existsSync, lstatSync } = await import('node:fs');
      const directory = localLanguageDir ?? packagedOcrDirectory();
      const file = join(directory, 'eng.traineddata');
      if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new DocumentInputError('OCR_ENGINE_UNAVAILABLE', 'The local OCR language resource is unavailable');
      const languages = existsSync(join(directory, 'deu.traineddata')) ? 'eng+deu' : 'eng';
      worker = await createWorker(languages, OEM.LSTM_ONLY, {langPath:directory,gzip:false,cacheMethod:'none'});
    }
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const result = await Promise.race([worker.recognize(image),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new DocumentInputError('OCR_TIMEOUT','Recognition exceeded the per-page processing limit')),30000);})]);
      return {text:result.data.text.slice(0,100000),confidence:result.data.confidence/100};
    } finally { if(timer)clearTimeout(timer); }
  };
  try {
    if(kind!=='pdf') { const result=await recognizeImage(buffer);return parseRecognizedInvoice(result.text,result.confidence); }
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({data:new Uint8Array(buffer),useSystemFonts:true,disableFontFace:true,isEvalSupported:false}).promise;
    const pages:string[]=[];const confidences:number[]=[];
    try {
      if(pdf.numPages<1||pdf.numPages>MAX_PAGES)throw new DocumentInputError('PAGE_LIMIT','PDF page count exceeds the recognition limit');
      for(let number=1;number<=pdf.numPages;number++){
        const page=await pdf.getPage(number);
        try {
          const content=await page.getTextContent();let text='',priorY:number|undefined;
          for(const item of content.items){
            if(!('str' in item))continue;
            const y=item.transform?.[5];if(priorY!==undefined&&y!==undefined&&Math.abs(y-priorY)>2)text+='\n';text+=String(item.str)+' ';priorY=y;
            if(text.length>100000)throw new DocumentInputError('TEXT_LIMIT','PDF text exceeds its review limit');
          }
          if(text.trim().length>=20){pages.push(text);confidences.push(1);}
          else {
            const {createCanvas}=await import('@napi-rs/canvas');
            const viewport=page.getViewport({scale:2});renderedPixels+=viewport.width*viewport.height;
            if(viewport.width*viewport.height>MAX_PIXELS||renderedPixels>50_000_000)throw new DocumentInputError('PIXEL_LIMIT','Rendered PDF exceeds the OCR pixel budget');
            const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
            await page.render({canvasContext:canvas.getContext('2d') as any,canvas:canvas as any,viewport}).promise;
            const recognized=await recognizeImage(canvas.toBuffer('image/png'));pages.push(recognized.text);confidences.push(recognized.confidence);
          }
        } finally { page.cleanup(); }
        if(pages.reduce((total,text)=>total+text.length,0)>100000)throw new DocumentInputError('TEXT_LIMIT','Combined PDF text exceeds its review limit');
      }
    } finally { await pdf.destroy(); }
    return parseRecognizedInvoice(pages.join('\n'),confidences.reduce((total,value)=>total+value,0)/Math.max(1,confidences.length));
  } finally { if(worker)await worker.terminate(); }
}
