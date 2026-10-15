# Decision 002 — Conservative offline legacy-stage screening

Migration-Required: no
Rationale: The change tightens a pre-release staging adapter's admission policy without modifying any persisted Community schema, active dataset or live data path. Previously unclassified legacy SQLite structures now fail safely instead of being copied without credential review.
Rollback: Revert this specific guard commit in the isolated development branch; never downgrade a deployed dataset or overwrite a live installation. The original synthetic fixture remains unchanged.
Tests: `tests/offline-legacy-import.test.mjs` verifies supported synthetic copies, unknown SQLite tables, sensitive JSON metadata, rejected settings, duplicate match links, stage manifest/hash verification, tampering refusal, preserved totals and cleanup on refusal.

## Explicit compatibility scope

The offline adapter remains a developer preview and does not activate imported records. This guard intentionally rejects unknown legacy tables, field names and opaque settings instead of claiming compatibility. Adding support for another version requires an explicit versioned mapper, synthetic representative fixtures, schema-by-schema review, bank-operation locks and rollback qualification. The general persistence policy remains mandatory for any change affecting stored data.

## Known limitations

The offline-confirmation flag is not proof that source writers are stopped. No cross-store generation lock or verified atomic epoch exists. Staging temporarily copies SQLite bytes before credentials are scrubbed, so real installations must remain off limits pending secure staging and interruption-review design. JSON metadata screening cannot prove that arbitrary blob/text fields never contain credentials; independent privacy review remains required. No public release or real-finance import approval follows from these tests.
