import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stageLegacyV2, migrationId } from '../src/migrations/000-legacy-stage.mjs';

test('versioned V2 adapter preserves approved synthetic identities and blocks real activation', async () => {
  const old = JSON.parse(readFileSync(new URL('./fixtures/migrations/legacy-v2-old.json', import.meta.url)));
  const next = JSON.parse(readFileSync(new URL('./fixtures/migrations/community-pending-new.json', import.meta.url)));
  assert.equal(migrationId, 'legacy-v2-offline-stage-000');
  assert.equal(old.transactions[0].amount_minor, next.transactions[0].amount_minor);
  assert.equal(old.documents[0].transaction_id, next.documents[0].transaction_id);
  assert.equal(old.status, next.status);
  assert.equal(next.bank_credentials, null);
  assert.equal(next.activation_allowed, false);
  await assert.rejects(stageLegacyV2({ sourceRoot: '.', destinationRoot: '.' }), /offline/);
});
