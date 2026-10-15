/**
 * Synthetic-only preview prototype. Not a real legacy importer and cannot activate.
 * Real owner records must never be handed to this demo path.
 */
import { createHash } from 'node:crypto';

const statusSet = new Set(['PROPOSED', 'RECONCILED', 'ACCEPTED', 'REJECTED', 'EXCLUDED']);
const forbidden = /^(?:api[_-]?key|token|password|cookie|iban|session[_-]?id|oauth[_-]?secret)$/i;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function ensure(condition, message) {
  if (!condition) throw new Error('Synthetic import rejected: ' + message);
}
function noSensitiveFields(value) {
  if (Array.isArray(value)) { value.forEach(noSensitiveFields); return; }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      ensure(!forbidden.test(key), 'secret/banking key in fixture: ' + key);
      noSensitiveFields(v);
    }
  }
}
function uniqueRows(rows, key) {
  const ids = rows.map(x => x?.[key]);
  ensure(ids.every(x => typeof x === 'string' && x.length > 0), 'invalid identifiers');
  ensure(new Set(ids).size === ids.length, 'duplicate identifiers');
  return new Set(ids);
}

export function dryRunSyntheticBundle(bundle) {
  ensure(bundle && typeof bundle === 'object', 'missing manifest');
  ensure(bundle.classification === 'TEST_SYNTHETIC', 'only synthetic fixtures are supported');
  ensure(bundle.bundle_version === 1 && bundle.origin_app === 'fictional-fixture', 'unsupported source version');
  noSensitiveFields(bundle);
  for (const key of ['transactions', 'documents', 'matches', 'payments']) {
    ensure(Array.isArray(bundle[key]), 'missing ' + key);
  }
  const txIDs = uniqueRows(bundle.transactions, 'id');
  const docIDs = uniqueRows(bundle.documents, 'id');
  uniqueRows(bundle.matches, 'id');
  uniqueRows(bundle.payments, 'id');

  const sums = {};
  for (const tx of bundle.transactions) {
    ensure(Number.isSafeInteger(tx.amount_minor), 'non-integer signed amount');
    ensure(/^[A-Z]{3}$/.test(tx.currency), 'currency not canonical');
    ensure(/^\d{4}-\d{2}-\d{2}$/.test(tx.posting_date), 'non-ISO date');
    sums[tx.currency] = (sums[tx.currency] ?? 0) + tx.amount_minor;
    ensure(Number.isSafeInteger(sums[tx.currency]), 'unsafe ledger total');
  }
  for (const doc of bundle.documents) {
    ensure(typeof doc.sha256 === 'string' && /^[a-f0-9]{64}$/.test(doc.sha256), 'missing document digest');
    ensure(Number.isSafeInteger(doc.amount_minor), 'invalid document amount');
  }
  for (const match of bundle.matches) {
    ensure(statusSet.has(match.status), 'unsupported approval status');
    ensure(Array.isArray(match.transaction_ids) && Array.isArray(match.document_ids), 'missing match links');
    ensure(match.transaction_ids.every(id => txIDs.has(id)), 'orphan transaction link');
    ensure(match.document_ids.every(id => docIDs.has(id)), 'orphan document link');
  }
  for (const payment of bundle.payments) {
    ensure(['UNKNOWN', 'PENDING', 'CANCELLED', 'REJECTED', 'PAID'].includes(payment.status), 'unknown payment history status');
    ensure(payment.release_enabled === false, 'never authorize payment from a migrated record');
  }
  const statuses = {};
  for (const match of bundle.matches) statuses[match.status] = (statuses[match.status] ?? 0) + 1;
  return Object.freeze({
    dry_run: true,
    activation_allowed: false,
    source_mutated: false,
    bank_calls: 0,
    totals_minor_by_currency: sums,
    counts: {
      transactions: bundle.transactions.length,
      documents: bundle.documents.length,
      match_groups: bundle.matches.length,
      historical_payments: bundle.payments.length,
    },
    match_status_counts: statuses,
    fixture_sha256: digest(bundle),
    warnings: ['Synthetic dry-run only; no actual import, schema migration or activation implemented.'],
  });
}
