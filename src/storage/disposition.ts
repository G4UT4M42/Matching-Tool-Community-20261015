import { getDb } from './db.js';
import type { Disposition } from '../core/types.js';

export interface DispositionSummary {
  matched: number;
  privat: number;
  ok_no_match: number;
  quarterly_aggregate: number;
  open: number;
}

export function getDispositionSummary(): DispositionSummary {
  const db = getDb();
  const rows = db.prepare(
    'SELECT disposition, COUNT(*) as cnt FROM transaction_dispositions GROUP BY disposition'
  ).all() as { disposition: string; cnt: number }[];

  const summary: DispositionSummary = {
    matched: 0, privat: 0, ok_no_match: 0, quarterly_aggregate: 0, open: 0,
  };
  for (const r of rows) {
    if (r.disposition in summary) {
      (summary as any)[r.disposition] = r.cnt;
    }
  }
  return summary;
}

export function setDisposition(
  transactionId: string,
  disposition: Disposition,
  note?: string,
  aggregateQuarter?: string,
  actor: string = 'user',
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO transaction_dispositions (transaction_id, disposition, set_by, note, aggregate_quarter)
    VALUES (@tid, @disp, @actor, @note, @quarter)
    ON CONFLICT(transaction_id) DO UPDATE SET
      disposition = @disp, set_by = @actor, note = @note,
      aggregate_quarter = @quarter, set_at = datetime('now')
  `).run({
    tid: transactionId,
    disp: disposition,
    actor,
    note: note ?? null,
    quarter: aggregateQuarter ?? null,
  });
}

export function setDispositionBatch(
  transactionIds: string[],
  disposition: Disposition,
  note?: string,
  aggregateQuarter?: string,
  actor: string = 'user',
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO transaction_dispositions (transaction_id, disposition, set_by, note, aggregate_quarter)
    VALUES (@tid, @disp, @actor, @note, @quarter)
    ON CONFLICT(transaction_id) DO UPDATE SET
      disposition = @disp, set_by = @actor, note = @note,
      aggregate_quarter = @quarter, set_at = datetime('now')
  `);

  const run = db.transaction(() => {
    for (const tid of transactionIds) {
      stmt.run({
        tid,
        disp: disposition,
        actor,
        note: note ?? null,
        quarter: aggregateQuarter ?? null,
      });
    }
  });
  run();
}

export function getTransactionsByDisposition(disposition: Disposition): any[] {
  const db = getDb();
  return db.prepare(`
    SELECT t.*, td.disposition, td.note, td.aggregate_quarter
    FROM transactions t
    JOIN transaction_dispositions td ON t.transaction_id = td.transaction_id
    WHERE td.disposition = ?
    ORDER BY t.posting_at
  `).all(disposition);
}

/** Mark all open transactions from private vendors as privat */
export function autoMarkPrivateVendors(): number {
  const db = getDb();
  const vendors = db.prepare('SELECT vendor_name FROM private_vendors').all() as { vendor_name: string }[];
  if (vendors.length === 0) return 0;

  let count = 0;
  const setStmt = db.prepare(`
    INSERT INTO transaction_dispositions (transaction_id, disposition, set_by, note)
    VALUES (@tid, 'privat', 'system', @note)
    ON CONFLICT(transaction_id) DO UPDATE SET
      disposition = 'privat', set_by = 'system', note = @note, set_at = datetime('now')
      WHERE disposition = 'open'
  `);

  const run = db.transaction(() => {
    for (const v of vendors) {
      // Find all transactions from this vendor that are still 'open'
      const txns = db.prepare(`
        SELECT t.transaction_id FROM transactions t
        LEFT JOIN transaction_dispositions td ON t.transaction_id = td.transaction_id
        WHERE LOWER(t.counterparty_name) = LOWER(?)
          AND (td.disposition IS NULL OR td.disposition = 'open')
      `).all(v.vendor_name) as { transaction_id: string }[];

      for (const t of txns) {
        setStmt.run({ tid: t.transaction_id, note: `Auto: Vendor "${v.vendor_name}" ist privat` });
        count++;
      }
    }
  });
  run();
  return count;
}

export function setDocumentDisposition(
  documentId: string,
  disposition: Disposition,
  note?: string,
  actor: string = 'user',
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO document_dispositions (document_id, disposition, set_by, note)
    VALUES (@did, @disp, @actor, @note)
    ON CONFLICT(document_id) DO UPDATE SET
      disposition = @disp, set_by = @actor, note = @note, set_at = datetime('now')
  `).run({
    did: documentId,
    disp: disposition,
    actor,
    note: note ?? null,
  });
}
