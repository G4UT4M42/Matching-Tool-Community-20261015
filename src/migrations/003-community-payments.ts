import type Database from 'better-sqlite3';

/** Called by the central migration registry inside its transaction, after migration 002. */
export function upCommunityPayments003(db: Database.Database): void {
  db.exec(`
    CREATE TABLE community_payment_batches (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, debtor_iban TEXT NOT NULL,
      debtor_name TEXT NOT NULL, provider TEXT NOT NULL, environment TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','validated','reviewed','approved','submission_claimed','acknowledged','unknown','failed','reconciled','cancelled')),
      revision INTEGER NOT NULL CHECK(revision > 0), detail_digest TEXT NOT NULL,
      reviewer TEXT, approver TEXT, approval_revision INTEGER, approval_digest TEXT,
      claim_id TEXT UNIQUE, provider_reference TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE community_payment_items (
      id TEXT NOT NULL, batch_id TEXT NOT NULL REFERENCES community_payment_batches(id),
      workspace_id TEXT NOT NULL,
      document_id TEXT NOT NULL, active_document_id TEXT, invoice_id TEXT NOT NULL, source_hash TEXT NOT NULL,
      creditor_name TEXT NOT NULL, creditor_iban TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      currency TEXT NOT NULL CHECK(currency = 'EUR'), reference TEXT NOT NULL,
      due_date TEXT NOT NULL, match_ids_json TEXT NOT NULL,
      PRIMARY KEY(batch_id,id), UNIQUE(workspace_id,active_document_id)
    );
    CREATE TABLE community_payment_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, batch_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
      revision INTEGER NOT NULL, detail_digest TEXT NOT NULL, at TEXT NOT NULL, detail_json TEXT NOT NULL
    );
    CREATE TRIGGER community_payment_events_immutable_update BEFORE UPDATE ON community_payment_events
      BEGIN SELECT RAISE(ABORT, 'payment audit immutable'); END;
    CREATE TRIGGER community_payment_events_immutable_delete BEFORE DELETE ON community_payment_events
      BEGIN SELECT RAISE(ABORT, 'payment audit immutable'); END;
    CREATE TABLE community_payment_confirmations (
      token_hash TEXT PRIMARY KEY, batch_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      subject TEXT NOT NULL, session_id TEXT NOT NULL, provider TEXT NOT NULL,
      debtor_iban TEXT NOT NULL, revision INTEGER NOT NULL, detail_digest TEXT NOT NULL,
      expires_at TEXT NOT NULL, used_at TEXT
    );
    CREATE TABLE community_bank_connections (
      workspace_id TEXT NOT NULL, subject TEXT NOT NULL, provider TEXT NOT NULL,
      environment TEXT NOT NULL, account_ref TEXT NOT NULL, vault_ref TEXT NOT NULL,
      configured_at TEXT NOT NULL, PRIMARY KEY(workspace_id,subject,provider,environment)
    );
    CREATE TABLE community_payment_callbacks (
      provider TEXT NOT NULL, callback_id TEXT NOT NULL, claim_id TEXT NOT NULL,
      received_at TEXT NOT NULL, PRIMARY KEY(provider,callback_id)
    );
  `);
}
