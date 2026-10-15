import { test } from 'node:test';
import assert from 'node:assert/strict';
import { example } from '../scripts/generate-synthetic-demo.mjs';
import { dryRunSyntheticBundle } from '../src/migration/synthetic-dry-run.mjs';

const copy = x => JSON.parse(JSON.stringify(x));

test('synthetic dry run preserves counts, cent totals and approval statuses', () => {
  const before = copy(example);
  const outcome = dryRunSyntheticBundle(before);
  assert.equal(outcome.activation_allowed, false);
  assert.equal(outcome.source_mutated, false);
  assert.equal(outcome.bank_calls, 0);
  assert.deepEqual(outcome.totals_minor_by_currency, { EUR: -12900 });
  assert.deepEqual(outcome.match_status_counts, { ACCEPTED: 1, PROPOSED: 1 });
  assert.deepEqual(before, example);
  assert.equal(outcome.fixture_sha256, dryRunSyntheticBundle(before).fixture_sha256);
});
test('orphan match link is rejected', () => {
  const bad = copy(example);
  bad.matches[0].transaction_ids.push('missing-transaction');
  assert.throws(() => dryRunSyntheticBundle(bad), /orphan transaction link/);
});
test('approval escalation, duplicate IDs, decimals, credential-like fields are rejected', () => {
  const cases = [
    v => { v.matches[0].status = 'AUTO_ACCEPT'; },
    v => { v.transactions[1].id = v.transactions[0].id; },
    v => { v.transactions[0].amount_minor = 12.34; },
    v => { v.payments[0].release_enabled = true; },
    v => { v.api_key = 'not-a-real-key'; },
    v => { v.classification = 'REAL_FINANCIAL'; },
  ];
  for (const change of cases) {
    const bad = copy(example);
    change(bad);
    assert.throws(() => dryRunSyntheticBundle(bad));
  }
});
