# Source-backed feature matrix

> Current private internal development, 2026-10-18: active branch
> `community/sandbox-payments-20261016` in
> `<isolated-worktrees>/Matching-Community-Sandbox-Payments-20261016` extends
> `d5210593b5d70f4a292e2b891273857bc4ac37f4`; sealed earlier artifacts are preserved.
> d521 includes AIS consent, PayPal event corrections and standard-automatic Stripe
> payout reconciliation. Its complete local app 587/587 and Node 90/90 results are
> historical evidence for d521, which did not yet implement the supported PIS flow.
> New sandbox-only SEPA EUR PIS is implemented with exact intent, one-use claim,
> callback/status verification and GET-only recovery. Focused backend tests passed
> 62/62, independent financial/security reviews found no remaining defect in their
> bounded snapshots, and the source-mode normal PIS journey passed 1/1. These are
> separate focused invocations, not a frozen/full/installed/CI acceptance result.
> See [sandbox payment contract](SANDBOX_PAYMENT_CONTRACT.md),
> [bank consent](BANK_CONSENT_CONTRACT.md), [PayPal events](PAYPAL_EVENT_CONTRACT.md),
> [Stripe payouts](STRIPE_PAYOUT_RECONCILIATION.md) and
> [private internal scope](../compliance/PRIVATE_INTERNAL_USE.md).
> A separate private Community repository and historical hosted CI are verified.
> Current PIS source needs its own committed qualification. VM testing is
> OWNER_DEFERRED, not PASS. No ownership/MIT, legal or release clearance is inferred.

> Historical checkpoint (2026-10-15; superseded, measurements retained for their original snapshots): local contracts are implemented for34of41 work packages;2packages have explicit external account/hosted-CI requirements and5final qualification/release packages retain separate gates. All11 controlled portal choices, explicit workspace recovery, generation isolation and original-preserving operational migration are integrated. New known-history composition passes89/89; independent new-file review38/38 plus envelope/REAL/null-MIME/backup-tamper probes. Expanded source journey passes in105651.872ms with9 historical rows,2linked originals,48 interface combinations and actual exit86/rollback/retry; no unexplained browser errors. Standalone OCR harness now uses packaged languages and passes1/1. Full4867 app run507/508 failed only the old owner fixture, repaired focused1/1; all failed evidence remains. Final clean candidate complete suites and installed3replacement/4supplement journey are recorded in external exact-final run manifests after this immutable freeze. No final PASS is inferred here. Repository/software/release milestones remain false until their own actual gates pass.

Updated 2026-10-18. All 21 areas remain mandatory. IMPLEMENTED behavior below
has concrete synthetic evidence; full-area status remains IN_PROGRESS until its
remaining software and final exact-candidate criteria are satisfied. External
provider acceptance is never inferred from a mock. No area is RELEASE_ACCEPTED.

|ID|Capability|Implemented and observed evidence|Remaining acceptance|
|---|---|---|---|
|F01|Transactions, accounts and dashboard|Account-owned normal dashboard, source/account/date/search filters, exact signed currency totals, roles, restart and normal navigation|Final full role/responsive and source-parity reconciliation|
|F02|Bank CSV/XLSX import|Exact Sparkasse/Visa parsing, preview-before-write, confirm/discard, duplicates/conflicts, immutable IDs, audit and crash recovery|Final exact-commit supported-format matrix|
|F03|PayPal and Stripe|Normal protected configuration/test/sync/history; 9ae PayPal event/status correction; new standard-automatic Stripe payout membership, exact signed fees/residuals, immutable audit and explicit retry/offline detail, with focused evidence|Payout source is not yet committed/full-qualified; exact final tests/installed/CI pending. Manual/instant membership unavailable; real provider authorization is a separate limit, never a blocker for local code|
|F04|Documents and invoices|Normal PDF/image/CSV/XLSX, real OCR, corrections, explicit signed credit notes, confirmation/archive/retrieval, source bytes/hash and durable provenance|Immutable review audit and missing-index backup recovery passed focused tests; final exact candidate pending|
|F05|Automatic matching|Source-backed exact proposals in normal UI; ambiguity remains for review|Final candidate regression and retained-rule parity evidence|
|F06|Manual matching/review|Normal accept/reject/reopen, manual partial allocations and durable source-preserving decisions|Final candidate regression and complete audit evidence|
|F07|Refunds, splits, FX and transfers|Exact minor units/rational FX, split and partial balances, fees/refunds/credits, balanced transfer tests; integrated normal-browser FX/refund/fee|Final exact-commit scenario reconciliation|
|F08|Accounting, VAT and reports|Explicit classifications and tax evidence, exact per-currency totals and CSV/JSON exports; negative credit VAT reversal verified|Scope documented in ACCOUNTING_SCOPE.md; final exact-commit totals|
|F09|Exclusions/private transactions|Literal rules and explicit private/excluded states with allocation guards and audit; normal private workflow|Ownership-aware enable/disable/future-import and German browser matrix passed; final exact candidate pending|
|F10|Offline OCR|Actual local image/scanned-PDF extraction; pinned English/German languages included in self-contained package|Final format/resource/localization matrix; asset/source obligations tracked|
|F11|Invoice Bot|Eleven assisted user-owned provider choices; fresh isolated browser, enforced egress, explicit download/receipt selection, durable review import and synthetic normal UI|Local controlled collection implemented; live logins/document availability remain unaccepted; AliExpress receipts never claim tax-invoice status|
|F12|Payment preparation/SEPA|Normal candidates/drafts, exact XML sums, review/approval, one-use transaction confirmation and duplicate prevention|Final exact-commit and schema/rights gates|
|F13|Bank account information/payment authorization|Owner-driven AIS consent/discovery/accounts/reconnect/cancel; separate sandbox-only single SEPA EUR PIS with exact target confirmation, one durable CREATE claim, callback/status verification, immutable intent and GET-only unknown recovery; focused 62/62 and separate source journey 1/1|New committed full/installed/CI qualification pending. Provider sandbox registration/authentication and live AIS/PIS acceptance remain external; production initiation disabled; no paid/reconciled result inferred from provider status|
|F14|Settings/integrations|Normal account/password/roles/language/settings, provider/bank/bot and data-management navigation|Final localization and required recovery-action explanations|
|F15|Audit history|Immutable financial/provider/payment records and bank atomic configuration; new account history with safe before/after projection|Document/account before-after audit implemented; separate data-operation history independently reviewed (34/34); final candidate pending|
|F16|Backup/restore|Exact canonical SQLite/JSON, attachments, historical economic evidence, secret/authority exclusion, preflight bounds, rollback and restart|Missing-index review-original recovery and stale-target regression passed; final exact candidate pending|
|F17|Legacy V2 migration|Normal selection of three supported layouts, inspect/dry-run, prior backup, stage/compare/activate; complete supported synthetic records and unchanged source|Known8 operational history tables now preserve9 fixture rows and linked originals as inert audit; genuinely unknown populated structures reject; denied distinct pathname review remains limited|
|F18|Database evolution|Registered SQLite v1-v4 and JSON v1/v2, immutable checksums, skipped upgrades, cross-store journals and downgrade rejection|Final exact-commit migration policy checks|
|F19|English/German and usability|English default, selectable German, normal-role controls, responsive dashboard and keyboard checks from installed app|Complete remaining field/error/dialog localization and page/accessibility matrix|
|F20|Independent Windows installation|Historical self-contained Node/native/OCR/source-notice bundle and install/upgrade/restart/uninstall evidence; three source-build/relink scopes and notice companion02 independently reviewed|New revision-bound package/installed qualification pending. Pristine Windows VM is OWNER_DEFERRED; ownership/MIT authority remains unverified; redistribution/signing are outside current private internal scope|
|F21|Synthetic environment and regression|Independent synthetic stores/transports; historical failures and repairs retained; sealed-fbf complete local/hosted evidence; 9ae app571/571 with its Node run still pending at this update; payout focused regression/review|Latest payout complete source/installed/CI qualification remains pending; existing private repository and older CI do not qualify newer source|

See [current checkpoint](packages/FINAL-P03-integrated-acceptance.md), [status](STATUS.md) and the external evidence manifests. Historical component test counts are not added together because many overlap. The separate private repository exists; current payout-head readiness is not yet qualified. Current-candidate SOFTWARE_ACCEPTED=false; RELEASE_ACCEPTED=false. Historical sealed acceptance remains bound to its own scope/revision.
