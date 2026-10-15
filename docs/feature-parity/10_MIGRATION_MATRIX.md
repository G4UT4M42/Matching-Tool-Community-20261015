# Storage and migration coverage

Updated 2026-10-15. Implemented local contracts are SQLite capability4 and JSON
capability2, with the unchanged historical checksum registry. Exact final
committed installed regression remains required.

|Contract|Implemented and qualified synthetic evidence|Limit|
|---|---|---|
|Schema evolution|Registered upgrades, skipped-version chains, current reopen, newer-version and checksum-drift rejection; sqlite-migration/json-state-migration/community-upgrade suites|No historical checksum is rewritten; unknown populated formats require explicit mapping|
|Legacy source selection|Account-scoped opaque selection, three reviewed layouts, read-only inspect/dry run and original tree hashes|Local path is entered explicitly by authorized owner; no automatic discovery of personal stores|
|Entities and relationships|Transactions/accounts/immutable IDs, six original attachments, all supported match states, allocations, exclusions/classifications/tax, audit, scans/reviews/templates and economic payment history in complete fixture|Unknown populated tables/fields and ambiguous historical provider bindings reject; no invented mapping|
|Wizard|Inspect → prior backup → dry run → compare → stage/verify → explicit digest-bound activation, normal authenticated UI|Earlier installed journey passed; later complete interruption/page matrix passes source mode and awaits final installed confirmation|
|Interruption and rollback|Genuine child exit86 after directory cutover before reopen; prior canonical state rolls back exactly, durable started audit survives; explicit retry succeeds|This is a measured real process interruption, not an HTTP200 or a simulated thrown error|
|Original retrieval|Legacy original byte/hash/MIME retrieval through trusted workspace binding, audit recovery and six normal UI downloads|Historical original ownership is not invented; explicit foreign scope rejected; independent cancellation preserved|
|Backup/restore|Exact SQLite/JSON/audit and referenced original attachments, aggregate entry/size bounds, missing-index review reconstruction, fingerprints and stale-plan rejection|No sessions, reusable secrets, bank authority or stored payment approvals transferred; reconnect required|

Existing source and reference migration evidence is preserved. Key executable
suites are `community-legacy-complete.test.ts`,
`community-legacy-document-binding-review.test.ts`,
`community-data-audit-review.test.ts`, `community-persistence-backup.test.ts`,
`community-upgrade-v2.test.ts`, `sqlite-migration.test.ts`,
`json-state-migration.test.ts` and the complete integrated browser.

The independently calculated complete fixture has10 transactions,3 accounts,
6 documents and5 allocations, plus all five match statuses and associated
historical metadata. Reconciliation checks exact records/relationships,
attachment bytes, source identities and per-currency totals. Original synthetic
legacy tree hashes remain unchanged. No real V2 financial dataset was opened.
Separate identity-store data-operation audit preserves historical financial
JSON equality while recording trusted actor and before/after state hashes/counts.
