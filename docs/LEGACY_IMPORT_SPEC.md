# Legacy Matching Tool V2 → Community Edition guided import

**Implementation requirement, not yet implemented.**

The legacy application contains real accounting data and may use SQLite WAL, JSON state, in-memory matching and filesystem invoice documents with diverging write paths. The importer must understand the actual runtime, not just copy `matching.db`.

## User journey
`Import Existing Installation` → choose a local installation path → read-only environment inspection → list recognized formats/periods/counts (not secret contents) → check source app is quiescent → create verified local backup → run isolated dry run → display missing/ambiguous cases → request explicit user approval → stage/verify → activate the new dataset → offer rollback / keep old installation.

Never require uploading financial archives to GitHub, this chat, a public service or a remote issue tracker. No unattended bank portal access or 2FA occurs during import.

## Source inventory
Enumerate versioned storage and persisted references: SQLite tables/schema/user_version/WAL; JSON state revisions; accepted/proposed match-group graphs, signed transactions, documents, refunds and tax dispositions; scanned/PDF invoice content and physical SHA; invoice-bot state; payment batch content and state, browser profile references, vendor/tax overrides, audit logs and source-event IDs. Distinguish source truth versus caches and derived reports.

## Portable bundle v1 (local and restricted)
Use an explicitly versioned manifest with `bundle_version`, `origin_app`, `origin_schema`, `export_id`, `created_at`, `source_epoch`, `dataset_sha256`, `entity_counts`, `source_to_destination_id_map`, `artifacts`, `unresolved_issues`, and `requires_reconnection`. Include logical JSON data and hashed evidence objects in a restricted folder/container; encryption is required before any nonlocal movement. Do not include credentials or payment approval tokens.

The bundle is **not** a replacement of the SQLite file inside another running application. Always use a fresh staging database and replay/versioned logical transformation.

## Acceptance
- Compare counts and signed cent totals by source/currency/year/quarter, including split payments and refunds
- Preserve every source event and attach exact physical document bytes via SHA-256; unknown/missing artifacts block activation
- Preserve bidirectional match memberships, reject duplicate IDs, maintain accepted/proposed/unknown status without promotion
- Preserve vendor overrides, manual dispositions and historical reports' rule version
- Preserve payment metadata/history, but import all pending/ambiguous release states locked and suppress all bank drivers
- Retain audit event chain, actor, reason and timestamps without dropping history
- Repeat the same import: no duplicate economic rows, stable IDs, stable hashes, same result
- Interrupt after any stage, restart: no partially active data; original remains untouched
- Wrong source format/CRC/hash/permissions: precise error and no overwrite
- Moving from a later version to older code must fail closed and preserve source

## Safety
Do not fetch or use live financial data until owner authorizes a read-only private snapshot, and never automate moving/altering the live original. Use fictional test identity values and fake banking drivers during development. A 100% matched count is not proof that invoices have accepted evidence or valid tax treatment.

Owner activation and public release are distinct approvals.
