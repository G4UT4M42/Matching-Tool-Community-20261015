/**
 * Types for the invoice recognition module.
 */

export type FileType = 'pdf_text' | 'pdf_image' | 'jpeg' | 'png';
export type ExtractionMethod = 'pdf_text' | 'ocr' | 'hybrid';
export type ScanStatus = 'pending' | 'extracted' | 'reviewed' | 'confirmed' | 'rejected' | 'error';

export interface InvoiceScan {
  scan_id: string;
  created_at: string;
  original_filename: string;
  stored_filename: string;
  file_hash: string;
  file_type: FileType;
  page_count: number;
  extraction_method: ExtractionMethod;
  ocr_confidence: number | null;
  status: ScanStatus;
  template_id: string | null;
  document_id: string | null;
  raw_text: string | null;
  meta: Record<string, unknown>;
}

export interface TaxLine {
  rate: number;        // decimal 0-1 (e.g. 0.20 for 20%)
  net_minor: number;
  vat_minor: number;
}

export interface ExtractedLineItem {
  description: string;
  quantity: number | null;
  unit_price_minor: number | null;
  amount_minor: number | null;
}

export interface FieldRegion {
  page: number;
  x: number;    // 0-1 fraction of page width
  y: number;    // 0-1 fraction of page height
  w: number;
  h: number;
}

/** OCR word with normalized coordinates (0-1 fractions of page dimensions) */
export interface StoredOcrWord {
  text: string;
  confidence: number;  // 0-1
  page: number;
  x: number;   // 0-1
  y: number;   // 0-1
  w: number;   // 0-1
  h: number;   // 0-1
}

export type ExtractionSource = 'pdf_text' | 'ocr' | 'template_rule' | 'ai_parser' | 'user_corrected';

export interface FieldConfidence {
  value: number;       // 0.0 - 1.0
  source: ExtractionSource;
}

export interface ExtractedFields {
  scan_id: string;
  invoice_number: string | null;
  invoice_date: string | null;       // ISO YYYY-MM-DD
  seller_name: string | null;
  seller_address: string | null;
  seller_country: string | null;     // ISO alpha-2
  seller_vat_id: string | null;
  buyer_name: string | null;
  buyer_vat_id: string | null;
  currency_code: string;
  net_amount_minor: number | null;
  vat_amount_minor: number | null;
  vat_rate: number | null;           // decimal 0-1
  gross_amount_minor: number | null;
  tax_lines: TaxLine[];
  line_items: ExtractedLineItem[];
  field_regions: Record<string, FieldRegion>;
  confidence: Record<string, FieldConfidence>;
  validation: ValidationResult;
  meta: Record<string, unknown>;
}

export interface ValidationResult {
  warnings: ValidationIssue[];
  errors: ValidationIssue[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  field?: string;
  severity: 'warning' | 'error';
}

export interface TemplateFieldPattern {
  regex: string;
  group: string;         // capture group index as string
  format?: string;       // e.g. 'DD.MM.YYYY' for date parsing
}

export interface TemplatePatterns {
  vendor_anchors: string[];
  field_patterns: Record<string, TemplateFieldPattern>;
  page_regions?: Record<string, FieldRegion>;
}

export interface InvoiceTemplate {
  template_id: string;
  vendor_name: string;
  vendor_vat_id: string | null;
  created_at: string;
  updated_at: string;
  use_count: number;
  patterns: TemplatePatterns;
  meta: Record<string, unknown>;
}

export interface ReviewEdit {
  edit_id: string;
  scan_id: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  edited_by: string;
  edited_at: string;
}

export interface PipelineResult {
  scan: InvoiceScan;
  fields: ExtractedFields;
  template_matched: boolean;
  duplicate_of: string | null;
}
