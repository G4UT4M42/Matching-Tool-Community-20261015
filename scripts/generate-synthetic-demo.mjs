#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const sha = value => createHash('sha256').update(value).digest('hex');
export const example = {
  classification: 'TEST_SYNTHETIC',
  bundle_version: 1,
  origin_app: 'fictional-fixture',
  source_epoch: 'fictional-revision-0001',
  companies: [
    { id: 'company-demo-1', name: 'Cedar Example Labs', contact: 'billing@example.com' },
    { id: 'company-demo-2', name: 'Harbor Demonstration Supplies', contact: 'accounts@example.com' },
  ],
  transactions: [
    { id: 'txn-demo-01', amount_minor: -12900, currency: 'EUR', posting_date: '2026-01-14', vendor: 'Cedar Example Labs' },
    { id: 'txn-demo-02', amount_minor: -5050, currency: 'EUR', posting_date: '2026-01-15', vendor: 'Harbor Demonstration Supplies' },
    { id: 'txn-demo-03', amount_minor: 5050, currency: 'EUR', posting_date: '2026-01-17', vendor: 'Harbor Demonstration Supplies', kind: 'refund' },
  ],
  documents: [
    { id: 'doc-demo-01', amount_minor: 12900, currency: 'EUR', sha256: sha('synthetic invoice page one'), document_date: '2026-01-12' },
    { id: 'doc-demo-02', amount_minor: 5050, currency: 'EUR', sha256: sha('synthetic invoice page two'), document_date: '2026-01-15' },
  ],
  matches: [
    { id: 'match-demo-01', status: 'ACCEPTED', transaction_ids: ['txn-demo-01'], document_ids: ['doc-demo-01'], audit_reason: 'Approved by fictional review' },
    { id: 'match-demo-02', status: 'PROPOSED', transaction_ids: ['txn-demo-02'], document_ids: ['doc-demo-02'], audit_reason: 'Review required' },
  ],
  payments: [{ id: 'payment-demo-01', status: 'UNKNOWN', release_enabled: false, driver: 'FAKE_BANK_ONLY' }],
};
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const destination = resolve(root, 'examples', 'synthetic', 'demo-bundle-v1.json');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(destination, JSON.stringify(example, null, 2) + '\n', { flag: 'w' });
  console.log('Wrote TEST_SYNTHETIC fixture (no owner data): ' + destination);
}
