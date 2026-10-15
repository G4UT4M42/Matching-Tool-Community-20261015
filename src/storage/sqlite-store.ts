import type Database from 'better-sqlite3';
import { getDb } from './db.js';
import type {
  MatchingState, Transaction, Document, MatchGroup,
  ExclusionRule, AuditEvent,
} from '../core/types.js';

/**
 * Save the full MatchingState to SQLite.
 * Replaces all data in a single transaction (idempotent re-run).
 */
export function saveStateToDb(state: MatchingState): void {
  const db = getDb();

  const run = db.transaction(() => {
    // Clear existing data (order matters for FK constraints)
    db.exec('DELETE FROM match_group_transactions');
    db.exec('DELETE FROM match_group_documents');
    db.exec('DELETE FROM line_items');
    db.exec('DELETE FROM match_groups');
    db.exec('DELETE FROM transaction_dispositions');
    db.exec('DELETE FROM document_dispositions');
    db.exec('DELETE FROM audit_events');
    db.exec('DELETE FROM exclusion_rules');
    db.exec('DELETE FROM documents');
    db.exec('DELETE FROM transactions');

    // --- Transactions ---
    const insertTxn = db.prepare(`
      INSERT INTO transactions (
        transaction_id, source_system, source_account_id, source_row_ref,
        posting_at, value_at, amount_minor, currency_code,
        description_raw, counterparty_name, counterparty_iban,
        booking_reference, payment_reference, tags, meta,
        fx_original_amount_minor, fx_original_currency_code, fx_rate, fx_rate_source, fx_fee_minor
      ) VALUES (
        @transaction_id, @source_system, @source_account_id, @source_row_ref,
        @posting_at, @value_at, @amount_minor, @currency_code,
        @description_raw, @counterparty_name, @counterparty_iban,
        @booking_reference, @payment_reference, @tags, @meta,
        @fx_original_amount_minor, @fx_original_currency_code, @fx_rate, @fx_rate_source, @fx_fee_minor
      )
    `);

    for (const t of state.transactions.values()) {
      insertTxn.run({
        transaction_id: t.transaction_id,
        source_system: t.source_system,
        source_account_id: t.source_account_id,
        source_row_ref: t.source_row_ref,
        posting_at: t.posting_at,
        value_at: t.value_at ?? null,
        amount_minor: t.amount_minor,
        currency_code: t.currency_code,
        description_raw: t.description_raw,
        counterparty_name: t.counterparty_name ?? null,
        counterparty_iban: t.counterparty_iban ?? null,
        booking_reference: t.booking_reference ?? null,
        payment_reference: t.payment_reference ?? null,
        tags: JSON.stringify(t.tags),
        meta: JSON.stringify(t.meta),
        fx_original_amount_minor: t.fx?.original_amount_minor ?? null,
        fx_original_currency_code: t.fx?.original_currency_code ?? null,
        fx_rate: t.fx?.rate ?? null,
        fx_rate_source: t.fx?.rate_source ?? null,
        fx_fee_minor: t.fx?.fx_fee_minor ?? null,
      });
    }

    // --- Documents ---
    const insertDoc = db.prepare(`
      INSERT INTO documents (
        document_id, source_system, source_document_ref, captured_at,
        document_date, total_amount_minor, currency_code,
        supplier_name, vat_amount_minor, vat_rate, file_hash, filename, meta
      ) VALUES (
        @document_id, @source_system, @source_document_ref, @captured_at,
        @document_date, @total_amount_minor, @currency_code,
        @supplier_name, @vat_amount_minor, @vat_rate, @file_hash, @filename, @meta
      )
    `);

    const insertLineItem = db.prepare(`
      INSERT INTO line_items (document_id, description, amount_minor, quantity)
      VALUES (@document_id, @description, @amount_minor, @quantity)
    `);

    for (const d of state.documents.values()) {
      insertDoc.run({
        document_id: d.document_id,
        source_system: d.source_system,
        source_document_ref: d.source_document_ref,
        captured_at: d.captured_at,
        document_date: d.document_date,
        total_amount_minor: d.total_amount_minor,
        currency_code: d.currency_code,
        supplier_name: d.supplier_name ?? null,
        vat_amount_minor: d.vat_amount_minor ?? null,
        vat_rate: d.vat_rate ?? null,
        file_hash: d.file_hash ?? null,
        filename: d.filename ?? null,
        meta: JSON.stringify(d.meta),
      });

      if (d.line_items) {
        for (const li of d.line_items) {
          insertLineItem.run({
            document_id: d.document_id,
            description: li.description,
            amount_minor: li.amount_minor,
            quantity: li.quantity ?? null,
          });
        }
      }
    }

    // --- Match Groups ---
    const insertMg = db.prepare(`
      INSERT INTO match_groups (
        match_group_id, status, created_at, created_by, rule_id,
        amount_total_minor, currency_code, evidence, reason_codes, correlation_id
      ) VALUES (
        @match_group_id, @status, @created_at, @created_by, @rule_id,
        @amount_total_minor, @currency_code, @evidence, @reason_codes, @correlation_id
      )
    `);

    const insertMgTxn = db.prepare(`
      INSERT INTO match_group_transactions (match_group_id, transaction_id)
      VALUES (@match_group_id, @transaction_id)
    `);

    const insertMgDoc = db.prepare(`
      INSERT INTO match_group_documents (match_group_id, document_id)
      VALUES (@match_group_id, @document_id)
    `);

    for (const mg of state.match_groups.values()) {
      insertMg.run({
        match_group_id: mg.match_group_id,
        status: mg.status,
        created_at: mg.created_at,
        created_by: mg.created_by,
        rule_id: mg.rule_id,
        amount_total_minor: mg.amount_total_minor,
        currency_code: mg.currency_code,
        evidence: mg.evidence ? JSON.stringify(mg.evidence) : null,
        reason_codes: JSON.stringify(mg.reason_codes),
        correlation_id: mg.correlation_id ?? null,
      });

      for (const txnId of mg.transaction_ids) {
        insertMgTxn.run({ match_group_id: mg.match_group_id, transaction_id: txnId });
      }
      for (const docId of mg.document_ids) {
        insertMgDoc.run({ match_group_id: mg.match_group_id, document_id: docId });
      }
    }

    // --- Exclusion Rules ---
    const insertExcl = db.prepare(`
      INSERT INTO exclusion_rules (
        exclusion_id, created_at, created_by, field, operator, value,
        source_system, enabled, description
      ) VALUES (
        @exclusion_id, @created_at, @created_by, @field, @operator, @value,
        @source_system, @enabled, @description
      )
    `);

    for (const er of state.exclusion_rules) {
      insertExcl.run({
        exclusion_id: er.exclusion_id,
        created_at: er.created_at,
        created_by: er.created_by,
        field: er.field,
        operator: er.operator,
        value: er.value,
        source_system: er.source_system ?? null,
        enabled: er.enabled ? 1 : 0,
        description: er.description ?? null,
      });
    }

    // --- Audit Events ---
    const insertAudit = db.prepare(`
      INSERT INTO audit_events (
        audit_id, timestamp, actor_type, actor_id, action,
        entity_type, entity_id, before_data, after_data, reason, run_id, correlation_id
      ) VALUES (
        @audit_id, @timestamp, @actor_type, @actor_id, @action,
        @entity_type, @entity_id, @before_data, @after_data, @reason, @run_id, @correlation_id
      )
    `);

    for (const ae of state.audit_events) {
      insertAudit.run({
        audit_id: ae.audit_id,
        timestamp: ae.timestamp,
        actor_type: ae.actor_type,
        actor_id: ae.actor_id,
        action: ae.action,
        entity_type: ae.entity_type,
        entity_id: ae.entity_id,
        before_data: ae.before ? JSON.stringify(ae.before) : null,
        after_data: ae.after ? JSON.stringify(ae.after) : null,
        reason: ae.reason ?? null,
        run_id: ae.run_id ?? null,
        correlation_id: ae.correlation_id ?? null,
      });
    }

    // --- Dispositions (auto-assign based on matching state) ---
    const insertDisp = db.prepare(`
      INSERT INTO transaction_dispositions (transaction_id, disposition, set_by, note)
      VALUES (@transaction_id, @disposition, 'system', @note)
    `);

    for (const t of state.transactions.values()) {
      const isMatched = state.matched_transaction_ids.has(t.transaction_id);
      const isExcluded = state.excluded_transaction_ids.has(t.transaction_id);

      insertDisp.run({
        transaction_id: t.transaction_id,
        disposition: isMatched ? 'matched' : isExcluded ? 'privat' : 'open',
        note: null,
      });
    }

    // --- Document Dispositions ---
    const insertDocDisp = db.prepare(`
      INSERT INTO document_dispositions (document_id, disposition, set_by, note)
      VALUES (@document_id, @disposition, 'system', @note)
    `);

    for (const d of state.documents.values()) {
      const isMatched = state.matched_document_ids.has(d.document_id);
      insertDocDisp.run({
        document_id: d.document_id,
        disposition: isMatched ? 'matched' : 'open',
        note: null,
      });
    }
  });

  run();
}

/**
 * Load MatchingState from SQLite back into in-memory Maps/Sets.
 */
export function loadStateFromDb(): MatchingState | null {
  const db = getDb();

  // Check if we have data
  const count = db.prepare('SELECT COUNT(*) as c FROM transactions').get() as { c: number };
  if (count.c === 0) return null;

  // Transactions
  const txnRows = db.prepare('SELECT * FROM transactions').all() as any[];
  const transactions = new Map<string, Transaction>();
  for (const r of txnRows) {
    const t: Transaction = {
      transaction_id: r.transaction_id,
      source_system: r.source_system,
      source_account_id: r.source_account_id,
      source_row_ref: r.source_row_ref,
      posting_at: r.posting_at,
      value_at: r.value_at ?? undefined,
      amount_minor: r.amount_minor,
      currency_code: r.currency_code,
      description_raw: r.description_raw,
      counterparty_name: r.counterparty_name ?? undefined,
      counterparty_iban: r.counterparty_iban ?? undefined,
      booking_reference: r.booking_reference ?? undefined,
      payment_reference: r.payment_reference ?? undefined,
      tags: JSON.parse(r.tags),
      meta: JSON.parse(r.meta),
    };
    if (r.fx_rate != null) {
      t.fx = {
        original_amount_minor: r.fx_original_amount_minor,
        original_currency_code: r.fx_original_currency_code,
        rate: r.fx_rate,
        rate_source: r.fx_rate_source,
        fx_fee_minor: r.fx_fee_minor ?? undefined,
      };
    }
    transactions.set(t.transaction_id, t);
  }

  // Documents
  const docRows = db.prepare('SELECT * FROM documents').all() as any[];
  const liRows = db.prepare('SELECT * FROM line_items ORDER BY id').all() as any[];
  const liByDoc = new Map<string, any[]>();
  for (const li of liRows) {
    if (!liByDoc.has(li.document_id)) liByDoc.set(li.document_id, []);
    liByDoc.get(li.document_id)!.push(li);
  }

  const documents = new Map<string, Document>();
  for (const r of docRows) {
    const d: Document = {
      document_id: r.document_id,
      source_system: r.source_system,
      source_document_ref: r.source_document_ref,
      captured_at: r.captured_at,
      document_date: r.document_date,
      total_amount_minor: r.total_amount_minor,
      currency_code: r.currency_code,
      supplier_name: r.supplier_name ?? undefined,
      vat_amount_minor: r.vat_amount_minor ?? undefined,
      vat_rate: r.vat_rate ?? undefined,
      file_hash: r.file_hash ?? undefined,
      filename: r.filename ?? undefined,
      meta: JSON.parse(r.meta),
    };
    const lis = liByDoc.get(r.document_id);
    if (lis) {
      d.line_items = lis.map(li => ({
        description: li.description,
        amount_minor: li.amount_minor,
        quantity: li.quantity ?? undefined,
      }));
    }
    documents.set(d.document_id, d);
  }

  // Match Groups
  const mgRows = db.prepare('SELECT * FROM match_groups').all() as any[];
  const mgtRows = db.prepare('SELECT * FROM match_group_transactions').all() as any[];
  const mgdRows = db.prepare('SELECT * FROM match_group_documents').all() as any[];

  const txnsByMg = new Map<string, string[]>();
  for (const r of mgtRows) {
    if (!txnsByMg.has(r.match_group_id)) txnsByMg.set(r.match_group_id, []);
    txnsByMg.get(r.match_group_id)!.push(r.transaction_id);
  }
  const docsByMg = new Map<string, string[]>();
  for (const r of mgdRows) {
    if (!docsByMg.has(r.match_group_id)) docsByMg.set(r.match_group_id, []);
    docsByMg.get(r.match_group_id)!.push(r.document_id);
  }

  const match_groups = new Map<string, MatchGroup>();
  const matched_transaction_ids = new Set<string>();
  const matched_document_ids = new Set<string>();

  for (const r of mgRows) {
    const mg: MatchGroup = {
      match_group_id: r.match_group_id,
      status: r.status,
      created_at: r.created_at,
      created_by: r.created_by,
      rule_id: r.rule_id,
      transaction_ids: txnsByMg.get(r.match_group_id) ?? [],
      document_ids: docsByMg.get(r.match_group_id) ?? [],
      amount_total_minor: r.amount_total_minor,
      currency_code: r.currency_code,
      evidence: r.evidence ? JSON.parse(r.evidence) : undefined,
      reason_codes: JSON.parse(r.reason_codes),
      correlation_id: r.correlation_id ?? undefined,
    };
    match_groups.set(mg.match_group_id, mg);

    for (const id of mg.transaction_ids) matched_transaction_ids.add(id);
    for (const id of mg.document_ids) matched_document_ids.add(id);
  }

  // Exclusion Rules
  const exclRows = db.prepare('SELECT * FROM exclusion_rules').all() as any[];
  const exclusion_rules: ExclusionRule[] = exclRows.map(r => ({
    exclusion_id: r.exclusion_id,
    created_at: r.created_at,
    created_by: r.created_by,
    field: r.field,
    operator: r.operator,
    value: r.value,
    source_system: r.source_system ?? undefined,
    enabled: r.enabled === 1,
    description: r.description ?? undefined,
  }));

  // Audit Events
  const auditRows = db.prepare('SELECT * FROM audit_events').all() as any[];
  const audit_events: AuditEvent[] = auditRows.map(r => ({
    audit_id: r.audit_id,
    timestamp: r.timestamp,
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    action: r.action,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    before: r.before_data ? JSON.parse(r.before_data) : undefined,
    after: r.after_data ? JSON.parse(r.after_data) : undefined,
    reason: r.reason ?? undefined,
    run_id: r.run_id ?? undefined,
    correlation_id: r.correlation_id ?? undefined,
  }));

  // Excluded transactions from dispositions
  const excludedRows = db.prepare(
    "SELECT transaction_id FROM transaction_dispositions WHERE disposition = 'privat'"
  ).all() as any[];
  const excluded_transaction_ids = new Set<string>(excludedRows.map(r => r.transaction_id));

  return {
    run_id: 'loaded-from-db',
    transactions,
    documents,
    match_groups,
    exclusion_rules,
    audit_events,
    matched_transaction_ids,
    matched_document_ids,
    excluded_transaction_ids,
  };
}
