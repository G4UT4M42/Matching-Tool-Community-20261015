# Persistence migration decision record

Decision date: 2026-10-14. Source baseline: commit `5b512a8a93d5803be064bf0d39e8413e442d638c`.

The statement import journal coordinates a JSON state snapshot with a SQLite commit marker. A version 1 binary cannot recover that journal. Therefore the SQLite database advances to version 2 before journal-enabled operation. A prior binary sees `user_version=2` and exits before schema writes. Merely adding a JSON field would not protect older binaries because JSON and SQLite are opened at different times.

Version 2 adds a capability table and a second immutable migration row. It does not edit the version 1 migration, its SQL sources, or its stored checksum. A future version must add a new migration module with a new immutable digest and explicit edges from every supported starting version. Skipped upgrades traverse the registered edges in sequence; the implementation currently supports the two edges `0 -> 1 -> 2` only. Unknown versions, a corrupted prior checksum, a physical schema mismatch, and a pending journal during `1 -> 2` are refusals.

Backup format version 1 is independent of database version 2 and JSON format version 1. A future backup reader must explicitly support old manifests and reject unknown new formats. The ZIP stores only reviewed accounting files; no whole-runtime copy is allowed. Restore stages in isolation and activates through the supervisor's close/reopen callback. A durable operation journal permits startup rollback after interrupted renames.

Legacy migration uses an explicit field-by-field compatibility rule: every populated table and non-null field must map or be documented as a removed credential/approval. This avoids treating the offline importer's narrow synthetic table whitelist as proof of complete V2 parity. A historical installation with a different schema remains blocked until a specific mapping migration and fixture are added. Prior payment authorization cannot be reused after migration.
