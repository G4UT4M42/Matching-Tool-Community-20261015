import { createHash, randomBytes } from 'crypto';

/**
 * Generate a stable deterministic ID by hashing canonical fields.
 * Uses SHA-256, returns first 16 hex chars for readability.
 */
export function stableId(...parts: (string | number | undefined | null)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(part ?? ''));
    hash.update('\0'); // separator
  }
  return hash.digest('hex').slice(0, 16);
}

/** Transaction ID: hash of (source_system, source_account_id, source_row_ref, posting_at, amount_minor, currency_code) */
export function transactionId(
  source_system: string,
  source_account_id: string,
  source_row_ref: string,
  posting_at: string,
  amount_minor: number,
  currency_code: string,
): string {
  return 'TXN-' + stableId(source_system, source_account_id, source_row_ref, posting_at, amount_minor, currency_code);
}

/** Document ID: hash of (source_system, source_document_ref, file_hash) */
export function documentId(
  source_system: string,
  source_document_ref: string,
  file_hash?: string,
): string {
  return 'DOC-' + stableId(source_system, source_document_ref, file_hash);
}

/** MatchGroup ID: hash of (sorted transaction_ids, sorted document_ids, rule_id) */
export function matchGroupId(
  transaction_ids: string[],
  document_ids: string[],
  rule_id: string,
): string {
  const sortedTxn = [...transaction_ids].sort().join(',');
  const sortedDoc = [...document_ids].sort().join(',');
  return 'MG-' + stableId(sortedTxn, sortedDoc, rule_id);
}

/** Audit ID: hash of (timestamp, action, entity_type, entity_id, run_id, correlation_id) */
export function auditId(
  timestamp: string,
  action: string,
  entity_type: string,
  entity_id: string,
  run_id?: string,
  correlation_id?: string,
): string {
  return 'AUD-' + stableId(timestamp, action, entity_type, entity_id, run_id, correlation_id);
}

/** Run ID: RUN-YYYYMMDD-HHMMSS-8HEX */
export function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  const hex = randomBytes(4).toString('hex').toUpperCase();
  return `RUN-${date}-${time}-${hex}`;
}

/** Correlation ID: CORR-8HEX */
export function generateCorrelationId(): string {
  return `CORR-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Exclusion rule ID */
export function exclusionId(field: string, operator: string, value: string): string {
  return 'EXC-' + stableId(field, operator, value);
}
