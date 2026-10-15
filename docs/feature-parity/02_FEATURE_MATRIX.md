# Source-backed feature matrix

> Current checkpoint (2026-10-15): app baseline `fa6c49a`441/441. Node diagnostic70/71 had one maintenance deadline failure; two subsequent real maintenance runs each pass3/3. Reviewed canvas02 and full-source WASM01 are integrated at `b979ebe`; focused replacement/supplement/runtime-overlay regression8/8. Combined8331-file/226-runtime-package artifact verifies and copied WASM passes all nine codec/load checks. Source/history independently reviewed through `f96dac5` (21commits/527files); later commits require extension. Native Windows libvips full-source build and actual ABI/codecs now pass; source bundling/independent review remain active. Complete final clean-commit regression and installed acceptance remain pending. PRIVATE_REPOSITORY_READY=false; SOFTWARE_ACCEPTED=false; RELEASE_ACCEPTED=false.

Updated 2026-10-15. All 21 areas remain mandatory. IMPLEMENTED behavior below
has concrete synthetic evidence; full-area status remains IN_PROGRESS until its
remaining software and final exact-candidate criteria are satisfied. External
provider acceptance is never inferred from a mock. No area is RELEASE_ACCEPTED.

|ID|Capability|Implemented and observed evidence|Remaining acceptance|
|---|---|---|---|
|F01|Transactions, accounts and dashboard|Account-owned normal dashboard, source/account/date/search filters, exact signed currency totals, roles, restart and normal navigation|Final full role/responsive and source-parity reconciliation|
|F02|Bank CSV/XLSX import|Exact Sparkasse/Visa parsing, preview-before-write, confirm/discard, duplicates/conflicts, immutable IDs, audit and crash recovery|Final exact-commit supported-format matrix|
|F03|PayPal and Stripe|Normal encrypted configuration, official fixed endpoints and verified merchant identities, test/sync/history, fees/refunds/payouts, idempotent cross-user import and historical restore replay|Final candidate run; real provider registration/authorization and ambiguous legacy binding remain explicit|
|F04|Documents and invoices|Normal PDF/image/CSV/XLSX, real OCR, corrections, explicit signed credit notes, confirmation/archive/retrieval, source bytes/hash and durable provenance|Immutable review audit and missing-index backup recovery passed focused tests; final exact candidate pending|
|F05|Automatic matching|Source-backed exact proposals in normal UI; ambiguity remains for review|Final candidate regression and retained-rule parity evidence|
|F06|Manual matching/review|Normal accept/reject/reopen, manual partial allocations and durable source-preserving decisions|Final candidate regression and complete audit evidence|
|F07|Refunds, splits, FX and transfers|Exact minor units/rational FX, split and partial balances, fees/refunds/credits, balanced transfer tests; integrated normal-browser FX/refund/fee|Final exact-commit scenario reconciliation|
|F08|Accounting, VAT and reports|Explicit classifications and tax evidence, exact per-currency totals and CSV/JSON exports; negative credit VAT reversal verified|Scope documented in ACCOUNTING_SCOPE.md; final exact-commit totals|
|F09|Exclusions/private transactions|Literal rules and explicit private/excluded states with allocation guards and audit; normal private workflow|Ownership-aware enable/disable/future-import and German browser matrix passed; final exact candidate pending|
|F10|Offline OCR|Actual local image/scanned-PDF extraction; pinned English/German languages included in self-contained package|Final format/resource/localization matrix; asset/source obligations tracked|
|F11|Invoice Bot|Eight assisted user-owned provider workflows; fresh isolated browser, enforced egress, explicit download selection, durable review import and synthetic normal UI|AliExpress/Bambu Lab current authoritative contracts and consumer-Post parity unresolved; all live logins unaccepted|
|F12|Payment preparation/SEPA|Normal candidates/drafts, exact XML sums, review/approval, one-use transaction confirmation and duplicate prevention|Final exact-commit and schema/rights gates|
|F13|Bank account information/payment authorization|Read-only AIS configuration, separate SEPA preparation and simulated authorization/claim/unknown-outcome recovery; no real transfer|Actual payment-initiation provider support/registration/consent remains external; no live acceptance|
|F14|Settings/integrations|Normal account/password/roles/language/settings, provider/bank/bot and data-management navigation|Final localization and required recovery-action explanations|
|F15|Audit history|Immutable financial/provider/payment records and bank atomic configuration; new account history with safe before/after projection|Document/account before-after audit implemented; separate data-operation history independently reviewed (34/34); final candidate pending|
|F16|Backup/restore|Exact canonical SQLite/JSON, attachments, historical economic evidence, secret/authority exclusion, preflight bounds, rollback and restart|Missing-index review-original recovery and stale-target regression passed; final exact candidate pending|
|F17|Legacy V2 migration|Normal selection of three supported layouts, inspect/dry-run, prior backup, stage/compare/activate; complete supported synthetic records and unchanged source|Unknown populated account registries/operational histories require explicit mappings; final distinct pathname review remains limited|
|F18|Database evolution|Registered SQLite v1-v4 and JSON v1/v2, immutable checksums, skipped upgrades, cross-store journals and downgrade rejection|Final exact-commit migration policy checks|
|F19|English/German and usability|English default, selectable German, normal-role controls, responsive dashboard and keyboard checks from installed app|Complete remaining field/error/dialog localization and page/accessibility matrix|
|F20|Independent Windows installation|Self-contained Node/native/OCR/legal bundle; fresh install/owner/upgrade/restart/uninstall 5/5 and installed full browser journey|Final exact-commit package; clean VM, ownership/source/relink/signing gates remain open|
|F21|Synthetic environment and regression|Independent data/transports; 389/389 intermediate app tests, complete source and installed normal-browser journeys, no real transfers|Final exact-commit complete suites, CI, private repository/release and remaining parity gates|

See [current checkpoint](packages/FINAL-P03-integrated-acceptance.md), [status](STATUS.md) and the external evidence manifests. Historical component test counts are not added together because many overlap. PRIVATE_REPOSITORY_READY=false; SOFTWARE_ACCEPTED=false; RELEASE_ACCEPTED=false.
