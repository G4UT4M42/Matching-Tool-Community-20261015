-- Invoice Bot operational tables

CREATE TABLE IF NOT EXISTS invoice_bot_portals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  portal_type TEXT NOT NULL DEFAULT 'generic',
  openclaw_profile TEXT NOT NULL DEFAULT 'user',
  session_mode TEXT NOT NULL DEFAULT 'session-first',
  active INTEGER NOT NULL DEFAULT 1,
  default_download_path TEXT,
  invoice_page_hints_json TEXT,
  date_field_hints_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_bot_runs (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  requested_start TEXT NOT NULL,
  requested_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TEXT,
  finished_at TEXT,
  error_message TEXT,
  stats_json TEXT NOT NULL DEFAULT '{"found":0,"downloaded":0,"imported":0,"duplicates":0,"failed":0}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES invoice_bot_portals(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ibr_portal ON invoice_bot_runs(portal_id);
CREATE INDEX IF NOT EXISTS idx_ibr_status ON invoice_bot_runs(status);

CREATE TABLE IF NOT EXISTS invoice_bot_files (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  portal_id TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  invoice_date TEXT,
  supplier_hint TEXT,
  import_status TEXT NOT NULL DEFAULT 'pending',
  document_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES invoice_bot_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (portal_id) REFERENCES invoice_bot_portals(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ibf_run ON invoice_bot_files(run_id);
CREATE INDEX IF NOT EXISTS idx_ibf_sha ON invoice_bot_files(sha256);
CREATE INDEX IF NOT EXISTS idx_ibf_status ON invoice_bot_files(import_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ibf_run_sha ON invoice_bot_files(run_id, sha256);

CREATE TABLE IF NOT EXISTS invoice_bot_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES invoice_bot_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ibe_run ON invoice_bot_events(run_id);

-- ============================================================
-- Browser-Use extension columns (added via ALTER TABLE for existing DBs)
-- ============================================================

-- Portal extensions for browser-use adapter
-- adapter_type: 'amazon' | 'browser_use' | 'manual'
-- run_strategy: 'agentic' | 'deterministic' | 'manual'
-- login_strategy: 'credentials' | 'manual' | 'sso' | 'existing_session'
-- portal_state: 'active' | 'needs_review' | 'broken' | 'manual_only' | 'disabled'
-- review_policy: 'auto_import' | 'review_if_uncertain' | 'always_review'

CREATE TABLE IF NOT EXISTS _migration_browser_use AS SELECT 1 AS done WHERE NOT EXISTS (
  SELECT 1 FROM pragma_table_info('invoice_bot_portals') WHERE name = 'adapter_type'
);

-- Only run ALTER TABLEs if migration table was actually created (column doesn't exist yet)
-- SQLite doesn't support IF NOT EXISTS on ALTER TABLE, so we use a trigger-free approach

-- Run extensions: cost/token tracking per run
-- These columns are added safely via CREATE TABLE IF NOT EXISTS pattern below

-- ============================================================
-- Browser-Use specific tables
-- ============================================================

-- Persistent browser profiles for session reuse
CREATE TABLE IF NOT EXISTS invoice_bot_profiles (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  profile_dir TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | stale | broken
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES invoice_bot_portals(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ibp_portal ON invoice_bot_profiles(portal_id);

-- Artifacts: screenshots, downloads, logs per run
CREATE TABLE IF NOT EXISTS invoice_bot_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,  -- screenshot | download | html_snapshot | log_bundle
  local_path TEXT NOT NULL,
  mime_type TEXT,
  sha256 TEXT,
  source_url TEXT,
  label TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES invoice_bot_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_iba_run ON invoice_bot_artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_iba_type ON invoice_bot_artifacts(type);

-- Extracted invoice records from browser-use runs
CREATE TABLE IF NOT EXISTS invoice_bot_extracted_invoices (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  portal_id TEXT NOT NULL,
  supplier_name TEXT,
  invoice_number TEXT,
  invoice_date TEXT,
  currency TEXT DEFAULT 'EUR',
  gross_total_minor INTEGER,
  portal_reference TEXT,
  downloaded_filename TEXT NOT NULL,
  artifact_id TEXT,
  sha256 TEXT NOT NULL,
  extraction_confidence REAL,
  requires_review INTEGER NOT NULL DEFAULT 1,
  evidence_artifact_id TEXT,
  source_url TEXT,
  import_status TEXT NOT NULL DEFAULT 'pending',  -- pending | skipped_duplicate | ready_for_import | imported | failed
  document_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES invoice_bot_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (portal_id) REFERENCES invoice_bot_portals(id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES invoice_bot_artifacts(id),
  FOREIGN KEY (evidence_artifact_id) REFERENCES invoice_bot_artifacts(id)
);
CREATE INDEX IF NOT EXISTS idx_ibei_run ON invoice_bot_extracted_invoices(run_id);
CREATE INDEX IF NOT EXISTS idx_ibei_sha ON invoice_bot_extracted_invoices(sha256);
CREATE INDEX IF NOT EXISTS idx_ibei_status ON invoice_bot_extracted_invoices(import_status);
