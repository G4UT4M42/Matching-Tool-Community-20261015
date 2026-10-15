# Persistence and upgrade coverage matrix

A green staging preview is not equivalent to complete migration. Source is always read-only and retained; the target activates only after validated rollback is available.

| Source -> destination | Status | Required proof |
|---|---|---|
| Synthetic legacy state+SQLite -> candidate stage | FOUNDATIONAL TESTED | state/DB/document hashes, reservation and approval statuses |
| Legacy with missing/orphan evidence -> stage | BASIC FAIL-CLOSED TESTED | no target activation, original unchanged |
| Legacy with unknown persisted store or payment state -> candidate | OPEN | exhaustive contract map, reject or audited compatible conversion |
| Legacy with credential-like columns and nested JSON -> candidate | OPEN | no secret-bearing data in portable bundle, selective preservation of accounting history |
| Legacy active writer/WAL -> consistent backup | OPEN | source epoch/quiescence and recheck across state, DB and evidence |
| Community v0 -> v1 | OPEN | executable, checksummed, idempotent migration, restart |
| Community v1 -> v2 | OPEN | new schema and fixtures, skipped-version jump |
| Future N-2 -> N | POLICY ONLY | version graph and CI fixture matrix |
| Staged candidate -> live candidate pointer | NOT IMPLEMENTED | atomic switch, lock, audit, no payment enabling |
| Failed activation -> previous candidate | NOT IMPLEMENTED | rollback and consistency proofs |
| Duplicate reimport of same source | PARTIAL | no duplicate economic events, files or audit changes |
| Offline source after completed migration | RETAIN | original untouched, no silent deletion |

**Invariants:** signed integer minor units by source/currency/period; stable source event keys and transaction identities; no orphan evidence; SHA-256 for each attachment; proposed/accepted/rejected/manual approval unchanged; versioned tax decisions; audit order/timestamp; historical payments never released or auto-retried; no OAuth/bank credentials or cookies imported.

**Gating:** no migration of real records without separate explicit owner authorization and a private dry run. Every persisted-format PR must have a decision record, migration fixtures where needed, restart tests and rollback instructions. See `docs/MIGRATION_POLICY.md` and `docs/LEGACY_IMPORT_SPEC.md`.