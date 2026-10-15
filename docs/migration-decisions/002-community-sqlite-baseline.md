# Community SQLite bootstrap and version ledger

Migration-Required: yes
Rationale: The first independent Community SQLite schema must be explicitly versioned, and all future schema changes must have a verified upgrade path instead of silently altering an unrecognized database.
Rollback: Preserve the original unversioned source or previous Community generation. Do not overwrite either. If the baseline transaction fails, no schema version is activated; discard only an isolated failed test staging instance. Recovery from a later Community release requires a verified offline backup and migration plan.

## Reviewed change
Add `src/migrations/001-community-sqlite-baseline.ts`, with SQLite `user_version=1`, a checksummed migration ledger and a physical schema fingerprint. Keep the existing SQL and legacy column amendments within a single transaction for a new **synthetic** instance. Existing unknown or newer databases fail closed. In-place conversion of protected private V2 databases is strictly forbidden.

## Fixtures
`tests/fixtures/migrations/community-sqlite-v0.json` and `community-sqlite-v1.json` use independently fictional identities and source-to-target version expectations.

## Verification
`tests/sqlite-migration.test.ts` proves initial schema version, no repeated DDL on reopen, integrity checks, future-version refusal, unknown unversioned database refusal, schema tampering detection and transactional failure rollback.

## Limitations
This is the first Community SQLite baseline, **not** a certified legacy import, a cross-store snapshot, a skipped-version upgrade system or a production migration. A future v2 requires a distinct executable migration plus synthetic prior-version fixtures, stable source-event ID checks, robust rollback and a new migration-decision review.
