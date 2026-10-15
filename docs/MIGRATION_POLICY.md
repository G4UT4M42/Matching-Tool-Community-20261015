# Mandatory persistence migration policy (v1)

## Non-negotiable promise

Users must be able to upgrade from a supported older release to a newer release, including skipped versions, without losing economic events, original documents, linked entities, approval statuses, audit provenance or recoverability. **A schema bump without a verified migration path is not mergeable.** No "drop and recreate" strategy is acceptable for real user data.

The owner-operated legacy V2 is a separate source product. Its migration is an explicitly supported one-time adapter, not a Git merge, database-file replacement or permission to edit the original installation.

## Supported data inventory

Each versioned contract records a canonical owner and schema for transactions (signed integer minor units and currency), imported source events and idempotency keys, documents/scans and file content SHA-256, match-group membership and allocations, PROPOSED/RECONCILED/ACCEPTED/REJECTED statuses, manual dispositions, tax rules and period attribution, vendor overrides, payment batches and release states, source-to-destination ID maps, immutable audit events, and settings.

Secrets, browser cookies, OAuth refresh tokens, bank credentials, live payment confirmations and active sessions are never exported or migrated. Represent them as `needs_reconnection` / `locked_review_required` only.

## Schema versioning and migration registry

- Each persisted store must expose machine-readable `schema_version`, `application_version` and a migration ledger (`migration_id`, from/to version, code hash, start/end time, status, input/target digests).
- A forward migration has a unique stable ID and a preflight/simulate/apply/verify interface. Every supported version-to-version edge is covered.
- On boot, if schema version is newer than the software supports, fail closed, read-only and report required upgrade. Do not downgrade silently.
- Migrators run exclusively on a **copy outside the original installation**. No implicit mutation of an owner-controlled legacy source.
- SQLite operations use transactions where possible and SQLite online backup for WAL. JSON/files require an explicit journal/epoch and transactional staging plan. If stores cannot share a consistent epoch, stop and label the snapshot UNVERIFIED rather than claim an atomic backup.
- No loss of old IDs or references. If IDs change, store a durable one-to-one map and assert every incoming and outgoing reference resolves exactly once.

## Controlled migration stages

1. **Inspect:** discover source version, store ownership, OS permissions, disk capacity, encryption availability and unsupported artifacts; do not read credentials into logs.
2. **Preflight:** stop or quiesce source writes using a supported app maintenance mechanism. If write-quiescence or consistent snapshot is impossible, block activation.
3. **Backup:** produce encrypted/restricted local snapshot of SQLite (online WAL-safe), state JSON and user document content; include manifest schema hashes, SHA-256, counts and epochs.
4. **Dry run:** create an isolated staging destination and execute the precise versioned migration path with network/bank drivers disabled.
5. **Reconcile:** compare signed cents grouped by currency/source/period; source-event cardinality, item IDs, document hashes, match/approval links, selected period rules, manual dispositions, audits and all payment states.
6. **Preview:** show successes, unknown classifications and unresolved blockers, with a readable difference report. No successful import claim when differences remain unexplained.
7. **Confirm:** owner reviews exact source/destination, backup location/hash, planned changes and offline bank policy.
8. **Activate:** switch only the destination app's pointer to the staged dataset, atomically when supported; keep the original installation untouched and usable.
9. **Verify:** restart candidate, run integrity/foreign-key/idempotency probes and compare manifest. On failure revert destination pointer to its previous generation.
10. **Retain:** keep original and previous generation until a separate retention decision; do not delete automatically.

## Financial invariants

- Total signed minor units by source, currency, tax period and category are identical unless an explicitly reviewed versioned accounting correction exists. Never compare float totals.
- Transaction/document/event identities and unique upstream source keys remain injective; duplicate replay produces zero new economic events.
- Every match group resolves to original transaction/document IDs or audited bijective aliases. Proposal never silently becomes acceptance.
- Correct ledger status does not imply a bank transaction was released. UNKNOWN/CLAIMED payment releases remain locked, never retried automatically.
- For every stored document, copied attachment SHA-256 matches its manifest entry. Missing documents are blockers or explicitly quarantined with owner review.
- Audit events preserve order, provenance, action/reason and original timestamps. No silent squashing/rewrite.
- Tax/report output changes are flagged as **rule-version differences** and require an accountant/owner review; do not automatically treat historical periods differently.
- Credentials are replaced by a secure reconnect requirement, not migrated.

## Pull request rules

A PR that modifies `src/storage/`, `src/migration/`, `src/payments/`, `src/core/matching/`, `src/core/reporting/`, persisted data contracts or `schema*.sql` must include a `docs/migration-decisions/*.md` record, with `Migration-Required: yes|no`. `no` needs evidence explaining why old stored data remains readable and semantically equivalent. `yes` additionally requires an executable migration, old/new synthetic fixtures, a restart/failure test and a rollback document. The repository CI check flags missing artifacts, and an independent human reviewer approves the semantics. No dependency update may bypass a broken migration test.

## Failure and rollback

Migration operations are resumable and idempotent. A crash may leave a rejected/pending staging directory, but **never** an active half-migrated destination or altered source. Failed backups, manifest mismatches, unknown statuses, path escapes or missing documents abort. Rollback restores the candidate's previous active pointer, preserving every original artifact and unknown payment claim. Bank releases are never "undone" or replayed by software rollback.

## Support lifecycle

Document support for version N-2 and direct N-2→N migration for each release until formally deprecated with notice and an intermediate supported bridge. Maintain multi-version fixture archives and tests. Existing real installations may be validated only with separate owner permission in a protected local environment; synthetic CI alone is not certification of any tax return.
