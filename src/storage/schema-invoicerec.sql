-- Invoice Recognition Module + Trash — SQLite Schema

-- ============================================================
-- TRASH / PAPIERKORB (soft-delete for any entity)
-- ============================================================
CREATE TABLE IF NOT EXISTS trash (
  trash_id       TEXT PRIMARY KEY,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  entity_data    TEXT NOT NULL,
  deleted_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_by     TEXT NOT NULL DEFAULT 'user',
  note           TEXT
);

CREATE INDEX IF NOT EXISTS idx_trash_type ON trash(entity_type);
CREATE INDEX IF NOT EXISTS idx_trash_date ON trash(deleted_at);

-- ============================================================
-- INVOICE SCANS (one row per uploaded file)
-- ============================================================
CREATE TABLE IF NOT EXISTS invoice_scans (
  scan_id            TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  original_filename  TEXT NOT NULL,
  stored_filename    TEXT NOT NULL,
  file_hash          TEXT NOT NULL,
  file_type          TEXT NOT NULL,
  page_count         INTEGER NOT NULL DEFAULT 1,
  extraction_method  TEXT NOT NULL,
  ocr_confidence     REAL,
  status             TEXT NOT NULL DEFAULT 'pending',
  template_id        TEXT,
  document_id        TEXT,
  raw_text           TEXT,
  meta               TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_iscan_status ON invoice_scans(status);
CREATE INDEX IF NOT EXISTS idx_iscan_hash ON invoice_scans(file_hash);
CREATE INDEX IF NOT EXISTS idx_iscan_docid ON invoice_scans(document_id);

-- ============================================================
-- EXTRACTED FIELDS (one row per scan)
-- ============================================================
CREATE TABLE IF NOT EXISTS invoice_extracted_fields (
  scan_id            TEXT PRIMARY KEY REFERENCES invoice_scans(scan_id) ON DELETE CASCADE,
  invoice_number     TEXT,
  invoice_date       TEXT,
  seller_name        TEXT,
  seller_address     TEXT,
  seller_country     TEXT,
  seller_vat_id      TEXT,
  buyer_name         TEXT,
  buyer_vat_id       TEXT,
  currency_code      TEXT DEFAULT 'EUR',
  net_amount_minor   INTEGER,
  vat_amount_minor   INTEGER,
  vat_rate           REAL,
  gross_amount_minor INTEGER,
  tax_lines_json     TEXT DEFAULT '[]',
  line_items_json    TEXT DEFAULT '[]',
  field_regions_json TEXT DEFAULT '{}',
  confidence_json    TEXT DEFAULT '{}',
  validation_json    TEXT DEFAULT '{}',
  meta               TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ifields_invnum ON invoice_extracted_fields(invoice_number);
CREATE INDEX IF NOT EXISTS idx_ifields_seller ON invoice_extracted_fields(seller_name);
CREATE INDEX IF NOT EXISTS idx_ifields_date ON invoice_extracted_fields(invoice_date);
CREATE INDEX IF NOT EXISTS idx_ifields_gross ON invoice_extracted_fields(gross_amount_minor);

-- ============================================================
-- VENDOR TEMPLATES
-- ============================================================
CREATE TABLE IF NOT EXISTS invoice_templates (
  template_id        TEXT PRIMARY KEY,
  vendor_name        TEXT NOT NULL,
  vendor_vat_id      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  use_count          INTEGER NOT NULL DEFAULT 0,
  patterns_json      TEXT NOT NULL,
  meta               TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tmpl_vendor ON invoice_templates(vendor_name);
CREATE INDEX IF NOT EXISTS idx_tmpl_vat ON invoice_templates(vendor_vat_id);

-- ============================================================
-- REVIEW EDIT AUDIT TRAIL
-- ============================================================
CREATE TABLE IF NOT EXISTS invoice_review_edits (
  edit_id            TEXT PRIMARY KEY,
  scan_id            TEXT NOT NULL REFERENCES invoice_scans(scan_id) ON DELETE CASCADE,
  field_name         TEXT NOT NULL,
  old_value          TEXT,
  new_value          TEXT,
  edited_by          TEXT NOT NULL DEFAULT 'user',
  edited_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_iredit_scan ON invoice_review_edits(scan_id);
