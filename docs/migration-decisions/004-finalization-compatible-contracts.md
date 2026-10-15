# Community finalization compatibility decision

Migration-Required: no
Rationale: This change retains the already registered SQLite v4 and canonical JSON v2 physical contracts and immutable migration checksums. It adds versioned extensible audit metadata, stricter import/source validation, derived review recovery and explicit legacy staging mappings without rewriting active financial sources or silently upgrading unknown datasets.
Rollback: Stop the candidate, retain the complete isolated data generation and identity audit, and restore the prior verified full backup with its matching qualified binary. Do not point an older unqualified prototype at newer review, provider or payment state.

## Persisted compatibility boundaries

- Existing transactions, amounts, currencies, source references, documents and financial audit remain immutable. Supported migration inspects original bytes read-only, builds a separate target, retains every reviewed relationship, then verifies equality before activation. Operational attachment names are rebased while bytes/hashes remain unchanged.
- Registered SQLite migrations 0→1→2→3→4 and JSON v1/v2 remain unchanged. Existing checksum and downgrade rejections stay enforced. No historical migration source or stored digest was rewritten for this finalization.
- New review events use explicit document_review_version=1 in the already extensible before/after audit JSON. Strict replay rejects unknown review versions and inconsistent identities/actors/transitions. Historical canonical documents gain a recovery baseline only when a user mutates their review state. Derived indexes/blobs can be rebuilt; original owner/source metadata is not invented.
- Exclusion ownership has an explicit audit ownership_version=1. Historical exclusions with unknown ownership remain retained until individual review. Unsupported legacy regular expressions are never executed. New imported IDs are excluded in the same canonical commit, with immutable ownership/application evidence.
- Provider account identities use official merchant IDs, distinct environment namespaces and append-only source events. Ambiguous historical actor-bound rows and unknown backfill coverage fail explicitly; this release does not rewrite them to guessed identities. Encrypted checkpoint and credential generations remain separate from accounting backups.
- Financial backup format v2 preserves exact canonical JSON/SQLite and referenced attachments. Existing v1/v2 readers are explicit; unknown manifest versions reject. Reusable secrets, bank connections and payment confirmation authority are excluded. Restore operation audit is retained separately in the identity store so historical financial audit equality is preserved.
- Archive/restore removes only cancellation it owns and preserves independent prior cancellation. Metadata changes carry before/after evidence and unique correlation IDs.

## Independent evidence

Tests cover full legacy entities, schema checksum/downgrade and skipped upgrades, immutable document review, missing-index backup/recovery, historical document access, cancellation retention, rule overlaps/future imports, provider replay, actual process interruption, exact SQLite/JSON state and role/API negatives. The installed browser journey performs the full migration wizard, interruption rollback, retry and historical-original download. Final exact-commit evidence is recorded in the feature-parity checkpoint rather than inferred from this policy declaration.

## Release compatibility

All builds remain development candidates until full acceptance. An older developer preview is not a qualified downgrade path for the new operational semantics merely because it can parse the same physical schema. Before a future incompatible format or released version changes capability requirements, add a registered forward migration and old/new synthetic fixtures in that same change. This decision does not approve unknown populated legacy tables, real provider access or redistribution rights.
