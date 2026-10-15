# Versioned Community JSON persistence

Migration-Required: yes
Rationale: Community state files formerly had no machine-readable version and could be silently parsed after incompatible schema changes, risking loss of match links and review decisions. Release 1 adds a fail-closed contract.
Rollback: Preserve both original JSON state and SQLite database from a consistent offline backup. Never downgrade or rewrite an unsupported source file in place; restore the previous complete generation if a verified future upgrade fails.

## Change
`src/storage/json-store.ts` now serializes `schema_version: 1` and `format: matching-community-state-v1`, validates safe integer financial amounts, match statuses, source/target IDs, reference integrity, audit arrays and supported schema before accepting or writing state. Old unversioned files and future schema versions are left unchanged and require a separately reviewed offline migration. An atomically written file is not itself evidence of consistent SQLite-and-file backups.

## Fixtures and tests
`tests/fixtures/migrations/community-state-v0.json`, `community-state-v1.json` and `tests/json-state-migration.test.ts` are fully fictional. Tests enforce roundtrip, rejection of unversioned and newer states, orphan handling, unsupported states and interruption-safe replacement.

## Remaining gates
A complete legacy-to-Community staging converter, non-destructive version-graph upgrades and cross-store epoch verification are not yet implemented. Never claim production readiness on the strength of this baseline.
