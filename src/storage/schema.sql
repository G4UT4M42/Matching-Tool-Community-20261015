-- Matching Tool V2 — SQLite Schema
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id      TEXT PRIMARY KEY,
  source_system       TEXT NOT NULL,
  source_account_id   TEXT NOT NULL,
  source_row_ref      TEXT NOT NULL,
  posting_at          TEXT NOT NULL,
  value_at            TEXT,
  amount_minor        INTEGER NOT NULL,
  currency_code       TEXT NOT NULL,
  description_raw     TEXT NOT NULL,
  counterparty_name   TEXT,
  counterparty_iban   TEXT,
  booking_reference   TEXT,
  payment_reference   TEXT,
  tags                TEXT NOT NULL DEFAULT '[]',
  meta                TEXT NOT NULL DEFAULT '{}',
  fx_original_amount_minor  INTEGER,
  fx_original_currency_code TEXT,
  fx_rate                   REAL,
  fx_rate_source            TEXT,
  fx_fee_minor              INTEGER
);

CREATE INDEX IF NOT EXISTS idx_txn_source ON transactions(source_system);
CREATE INDEX IF NOT EXISTS idx_txn_posting ON transactions(posting_at);
CREATE INDEX IF NOT EXISTS idx_txn_amount ON transactions(amount_minor);

-- ============================================================
-- DOCUMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  document_id          TEXT PRIMARY KEY,
  source_system        TEXT NOT NULL,
  source_document_ref  TEXT NOT NULL,
  captured_at          TEXT NOT NULL,
  document_date        TEXT NOT NULL,
  total_amount_minor   INTEGER NOT NULL,
  currency_code        TEXT NOT NULL,
  supplier_name        TEXT,
  vat_amount_minor     INTEGER,
  vat_rate             REAL,
  file_hash            TEXT,
  filename             TEXT,
  meta                 TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_doc_source ON documents(source_system);
CREATE INDEX IF NOT EXISTS idx_doc_date ON documents(document_date);
CREATE INDEX IF NOT EXISTS idx_doc_amount ON documents(total_amount_minor);

-- ============================================================
-- LINE ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS line_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  quantity     REAL
);

CREATE INDEX IF NOT EXISTS idx_li_doc ON line_items(document_id);

-- ============================================================
-- MATCH GROUPS
-- ============================================================
CREATE TABLE IF NOT EXISTS match_groups (
  match_group_id     TEXT PRIMARY KEY,
  status             TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  rule_id            TEXT NOT NULL,
  amount_total_minor INTEGER NOT NULL,
  currency_code      TEXT NOT NULL,
  evidence           TEXT,
  reason_codes       TEXT NOT NULL DEFAULT '[]',
  correlation_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_mg_rule ON match_groups(rule_id);
CREATE INDEX IF NOT EXISTS idx_mg_status ON match_groups(status);

-- ============================================================
-- MATCH GROUP MEMBERS (junction tables)
-- ============================================================
CREATE TABLE IF NOT EXISTS match_group_transactions (
  match_group_id TEXT NOT NULL REFERENCES match_groups(match_group_id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL REFERENCES transactions(transaction_id),
  PRIMARY KEY (match_group_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_mgt_txn ON match_group_transactions(transaction_id);

CREATE TABLE IF NOT EXISTS match_group_documents (
  match_group_id TEXT NOT NULL REFERENCES match_groups(match_group_id) ON DELETE CASCADE,
  document_id    TEXT NOT NULL REFERENCES documents(document_id),
  PRIMARY KEY (match_group_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_mgd_doc ON match_group_documents(document_id);

-- ============================================================
-- EXCLUSION RULES
-- ============================================================
CREATE TABLE IF NOT EXISTS exclusion_rules (
  exclusion_id  TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  field         TEXT NOT NULL,
  operator      TEXT NOT NULL,
  value         TEXT NOT NULL,
  source_system TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  description   TEXT
);

-- ============================================================
-- TRANSACTION DISPOSITIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS transaction_dispositions (
  transaction_id    TEXT PRIMARY KEY REFERENCES transactions(transaction_id),
  disposition       TEXT NOT NULL,
  set_at            TEXT NOT NULL DEFAULT (datetime('now')),
  set_by            TEXT NOT NULL DEFAULT 'system',
  note              TEXT,
  aggregate_quarter TEXT
);

CREATE INDEX IF NOT EXISTS idx_disp_disposition ON transaction_dispositions(disposition);

-- ============================================================
-- DOCUMENT DISPOSITIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS document_dispositions (
  document_id       TEXT PRIMARY KEY REFERENCES documents(document_id),
  disposition       TEXT NOT NULL,
  set_at            TEXT NOT NULL DEFAULT (datetime('now')),
  set_by            TEXT NOT NULL DEFAULT 'system',
  note              TEXT
);

CREATE INDEX IF NOT EXISTS idx_doc_disp ON document_dispositions(disposition);

-- ============================================================
-- AUDIT EVENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_events (
  audit_id       TEXT PRIMARY KEY,
  timestamp      TEXT NOT NULL,
  actor_type     TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  before_data    TEXT,
  after_data     TEXT,
  reason         TEXT,
  run_id         TEXT,
  correlation_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);

-- ============================================================
-- PRIVATE VENDORS
-- ============================================================
CREATE TABLE IF NOT EXISTS private_vendors (
  vendor_name TEXT PRIMARY KEY COLLATE NOCASE,
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  added_by    TEXT NOT NULL DEFAULT 'user'
);

-- ============================================================
-- VENDOR OVERRIDES (manual corrections to auto-detected vendor data)
-- ============================================================
CREATE TABLE IF NOT EXISTS vendor_overrides (
  vendor_key  TEXT PRIMARY KEY COLLATE NOCASE,  -- lowercase seller_name
  name        TEXT,
  country     TEXT,
  address     TEXT,
  vat_id      TEXT,
  email       TEXT,
  is_reverse_charge INTEGER NOT NULL DEFAULT 0,  -- 1 = reverse charge vendor (non-EU services)
  tax_category_kz TEXT,                          -- Income tax category (e.g. '9100', '9190')
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- SETTINGS (key-value store for app configuration)
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
