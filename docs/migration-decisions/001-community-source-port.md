# Community source admission and legacy V2 migration decision

Migration-Required: yes
Rationale: Community Edition introduces an independent runtime and codebase while requiring preservation of all financial records, links, evidence and approvals from legacy V2. An offline, versioned staging adapter is essential.
Rollback: The original installation is never modified. On failure discard only the isolated pending candidate after examining audit evidence, preserving the last activated community generation and all legacy records.

## Contract change
Legacy V2 stores JSON, SQLite (possibly WAL), document evidence and payment history. Community Edition stages verified snapshots with a manifest and forbids migration of API credentials and bank sessions. New state never activates without separate versioned validation.

## Forward implementation
`src/migrations/000-legacy-stage.mjs` exports the offline `stageLegacyV2` adapter. It preserves signed integer cents, stable IDs, match status, audit records and document SHA-256 while requiring owner-confirmed offline source, SQLite integrity and source immutability.

## Regression fixtures
`tests/fixtures/migrations/legacy-v2-old.json` and `community-pending-new.json` contain invented records only. `tests/offline-legacy-import.test.mjs` and `tests/legacy-migration-evolution.test.mjs` verify preview, WAL, discarded credential secrets, orphan references and non-activation.

## Remaining acceptance gate
The staging adapter is not a production importer or skip-version upgrader. A production release requires migration registry across all supported versions, interruption/rollback tests, missing-document repair path and financial review.
