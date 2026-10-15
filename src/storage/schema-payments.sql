CREATE TABLE IF NOT EXISTS invoice_payment_candidates (
  candidate_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE,
  scan_id TEXT NOT NULL,
  creditor_name TEXT,
  creditor_iban TEXT,
  amount_minor INTEGER CHECK (
    amount_minor IS NULL OR (
      typeof(amount_minor) = 'integer'
      AND amount_minor BETWEEN -9007199254740991 AND 9007199254740991
    )
  ),
  currency_code TEXT,
  remittance_information TEXT,
  structured_creditor_reference TEXT,
  requested_execution_date TEXT,
  invoice_number TEXT,
  due_date TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('unpaid', 'paid', 'unclear')),
  reason_code TEXT,
  source_meta_json TEXT NOT NULL,
  validation_errors_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_batches (
  batch_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('draft', 'reviewed', 'exported', 'prepared', 'released', 'cancelled', 'failed')),
  debtor_account_label TEXT NOT NULL,
  debtor_account_holder TEXT NOT NULL,
  debtor_iban TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (
    typeof(item_count) = 'integer'
    AND item_count BETWEEN 0 AND 9007199254740991
  ),
  control_sum_minor INTEGER NOT NULL CHECK (
    typeof(control_sum_minor) = 'integer'
    AND control_sum_minor BETWEEN -9007199254740991 AND 9007199254740991
  ),
  requested_execution_date TEXT,
  reviewed_at TEXT,
  exported_at TEXT,
  export_artifact_path TEXT,
  export_artifact_data BLOB,
  xml_sha256 TEXT,
  message_id TEXT,
  george_package_reference TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_batches_message_id
  ON payment_batches(message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_batch_items (
  item_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES payment_batches(batch_id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES invoice_payment_candidates(candidate_id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  creditor_name TEXT,
  creditor_iban TEXT,
  amount_minor INTEGER CHECK (
    amount_minor IS NULL OR (
      typeof(amount_minor) = 'integer'
      AND amount_minor BETWEEN -9007199254740991 AND 9007199254740991
    )
  ),
  currency_code TEXT,
  remittance_information TEXT,
  structured_creditor_reference TEXT,
  requested_execution_date TEXT,
  invoice_number TEXT,
  due_date TEXT,
  item_status TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (typeof(active) = 'integer' AND active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_item_active_document
  ON payment_batch_items(document_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_payment_items_batch ON payment_batch_items(batch_id);

CREATE TABLE IF NOT EXISTS payment_status_events (
  event_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES payment_batches(batch_id) ON DELETE RESTRICT,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT,
  george_evidence_json TEXT,
  item_id TEXT,
  before_json TEXT,
  after_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_payment_events_batch_time
  ON payment_status_events(batch_id, occurred_at, event_id);

CREATE TRIGGER IF NOT EXISTS trg_payment_status_events_no_update
BEFORE UPDATE ON payment_status_events
BEGIN
  SELECT RAISE(ABORT, 'payment_status_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_payment_status_events_no_delete
BEFORE DELETE ON payment_status_events
BEGIN
  SELECT RAISE(ABORT, 'payment_status_events is append-only');
END;

CREATE TABLE IF NOT EXISTS payment_automation_runs (
  run_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES payment_batches(batch_id),
  phase TEXT NOT NULL CHECK (phase IN (
    'queued','connecting_browser','waiting_login_2fa','uploading','upload_attempted',
    'verifying_import','prepared','requesting_release','release_click_claimed',
    'waiting_release_2fa','verifying_release','released','failed','unknown'
  )),
  import_filename TEXT NOT NULL CHECK (
    length(import_filename) BETWEEN 6 AND 200
    AND import_filename NOT GLOB '*[^A-Za-z0-9_.-]*'
    AND import_filename LIKE '%.xml'
  ),
  upload_attempted_at TEXT,
  release_confirmation_json TEXT CHECK (release_confirmation_json IS NULL OR (
    json_valid(release_confirmation_json)
    AND json_type(release_confirmation_json, '$.revision') = 'integer'
    AND json_type(release_confirmation_json, '$.debtorIban') = 'text'
    AND json_type(release_confirmation_json, '$.itemCount') = 'integer'
    AND json_type(release_confirmation_json, '$.controlSumMinor') = 'integer'
    AND json_type(release_confirmation_json, '$.xmlSha256') = 'text'
    AND json_extract(release_confirmation_json, '$.recovery') IN ('none','stable_prepared')
  )),
  release_request_token TEXT,
  release_click_claimed_at TEXT,
  release_clicked_at TEXT,
  release_retry_claimed_at TEXT,
  release_retry_clicked_at TEXT,
  release_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (release_retry_count >= 0),
  package_reference TEXT,
  expected_json TEXT NOT NULL CHECK (
    json_valid(expected_json)
    AND json_type(expected_json, '$.artifactSha256') = 'text'
    AND json_type(expected_json, '$.messageId') = 'text'
    AND json_type(expected_json, '$.importFilename') = 'text'
    AND json_type(expected_json, '$.expectedAccount') = 'object'
    AND json_type(expected_json, '$.itemCount') = 'integer'
    AND json_type(expected_json, '$.controlSumMinor') = 'integer'
  ),
  observed_json TEXT CHECK (observed_json IS NULL OR (
    json_valid(observed_json)
    AND json_type(observed_json, '$.reference') = 'text'
    AND json_type(observed_json, '$.importFilename') = 'text'
    AND json_type(observed_json, '$.account') = 'object'
    AND json_type(observed_json, '$.itemCount') = 'integer'
    AND json_type(observed_json, '$.controlSumMinor') = 'integer'
    AND json_type(observed_json, '$.messageId') = 'text'
    AND json_type(observed_json, '$.warnings') = 'array'
    AND json_type(observed_json, '$.status') = 'text'
  )),
  last_verified_url_class TEXT CHECK (last_verified_url_class IS NULL OR last_verified_url_class IN (
    'login','overview','data_import','package_list','package_detail','release_pending'
  )),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (release_clicked_at IS NULL OR release_click_claimed_at IS NOT NULL),
  CHECK (release_click_claimed_at IS NULL OR release_request_token IS NOT NULL),
  CHECK (release_retry_clicked_at IS NULL OR release_retry_claimed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_payment_automation_runs_batch
  ON payment_automation_runs(batch_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_automation_one_nonfinal_batch
  ON payment_automation_runs(batch_id)
  WHERE phase NOT IN ('released', 'failed');

-- Backstop upgraded databases whose pre-existing column could not gain a CHECK via ALTER TABLE.
CREATE TRIGGER IF NOT EXISTS trg_payment_automation_url_class_insert
BEFORE INSERT ON payment_automation_runs
WHEN NEW.last_verified_url_class IS NOT NULL AND NEW.last_verified_url_class NOT IN (
  'login','overview','data_import','package_list','package_detail','release_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid last_verified_url_class');
END;

CREATE TRIGGER IF NOT EXISTS trg_payment_automation_url_class_update
BEFORE UPDATE OF last_verified_url_class ON payment_automation_runs
WHEN NEW.last_verified_url_class IS NOT NULL AND NEW.last_verified_url_class NOT IN (
  'login','overview','data_import','package_list','package_detail','release_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid last_verified_url_class');
END;
