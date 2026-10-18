# Matching Tool Community — current continuation handoff

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

Status: IN_PROGRESS. Updated 2026-10-18. Read [STATUS](STATUS.md), [feature matrix](02_FEATURE_MATRIX.md), [current work package](packages/FINAL-P03-integrated-acceptance.md), actual Git HEAD and status before editing.

> Historical checkpoint (2026-10-15; superseded, measurements retained for their original snapshots): local contracts are implemented for34of41 work packages;2packages have explicit external account/hosted-CI requirements and5final qualification/release packages retain separate gates. All11 controlled portal choices, explicit workspace recovery, generation isolation and original-preserving operational migration are integrated. New known-history composition passes89/89; independent new-file review38/38 plus envelope/REAL/null-MIME/backup-tamper probes. Expanded source journey passes in105651.872ms with9 historical rows,2linked originals,48 interface combinations and actual exit86/rollback/retry; no unexplained browser errors. Standalone OCR harness now uses packaged languages and passes1/1. Full4867 app run507/508 failed only the old owner fixture, repaired focused1/1; all failed evidence remains. Final clean candidate complete suites and installed3replacement/4supplement journey are recorded in external exact-final run manifests after this immutable freeze. No final PASS is inferred here. Repository/software/release milestones remain false until their own actual gates pass.

## Boundaries and ownership

Use only the active worktree named above. Productive V2, the preserved sealed candidate, recovered original worktrees, user financial stores and existing browser sessions remain untouched. All tests create independent synthetic roots. Never use real provider credentials or execute real transfers. Owner communication is German; code/docs/tests are English by default.

Root owns application composition, normal pages, integration tests, data-operation audit and packaging. Agent source handoffs are explicit. Root owns handed-back source; current payout work has explicit concurrent ownership until handoff. Native build evidence remains external and frozen. Independent data-audit and historical-document source reviews are completed and handed back. Do not overwrite active files or retry any denied operation.

## Current contracts

- `src/server/application.ts`: actual production composition shared with explicit test dependencies; no HTTP/environment transport backdoor. `index.ts` is the ordinary listener entrypoint.
- `community-workspace.ts`: current session/actor capability checks, quiescence for persistence, canonical commits, account-bound provider coverage and separate operation audit.
- `canonical-transaction.ts`: recoverable SQLite/JSON/audit transaction and immutable sources. Do not weaken comparisons to pass tests.
- `documents/review-audit.ts`: bounded strict review replay; derived index is recoverable and not sole authority. Unconfirmed uploads do not create financial documents.
- `persistence/backup.ts` and `restore.ts`: referenced evidence, aggregate limits, exact cross-store verification and interrupted activation rollback; never restore reusable secrets or payment authority.
- `accounting/ledger.ts`: exact allocation math, before/after audit and ownership-aware literal rules. Future imports apply reviewed enabled literals within statement/workspace canonical commits. Regex is never evaluated.
- Provider adapters use verified official account identity. AIS consent and PayPal financial corrections are committed at 9ae; new standard-automatic Stripe payout membership is audit-only, focused-tested and awaits complete qualification. Missing historical coverage and ambiguous legacy bindings fail explicitly; do not rewrite original source IDs.
- Local simulation, supported AIS and sandbox-only PIS are distinct targets. PIS binds the exact approved request before one CREATE, retains unknown claims and permits GET-only recovery; it never marks accounting paid from provider status.

## Execution

Use the externally qualified Windows x64 Node22.23.3 / ABI127; system Node24 is incompatible with the installed SQLite build. Rebuild the production UI before normal-browser tests. `scripts/run-community-tests.mjs app` discovers all app tests; `node` discovers actual node:test entrypoints, excludes ordinary helpers and registers tsx. Set unique external MATCHING_TEST_EVIDENCE_ROOT, MATCHING_TEST_RUN_ID and MATCHING_MAIN_BROWSER_EVIDENCE_DIR; existing evidence is never overwritten. The bounded Node group deadline is30minutes (app20minutes), recorded in each runner manifest. The earlier16.2-minute baseline plus the2.2GB source closure and added browser/lifecycle regressions require this measured capacity; command/test assertions and timeout failures remain enforced.

`tests/community-integrated-acceptance.e2e.mjs` defaults to a newly built development package and real installation. MATCHING_ACCEPTANCE_MODE=source is an explicitly labeled iteration mode, never installed acceptance. The test composition uses only synthetic provider/portal/payment responses and the installed actual application factory. Its controlled interruption hook exists only as a code dependency; no production request can arm it.

Main browser evidence includes screenshots, responses, exact SQL/JSON snapshots, source IDs, hashes and all console/request errors. An expected interrupted activation must prove its exact process exit, journal cutover phase and one correlated failed request; all other browser errors remain failures.

## Next work

Finish the current sandbox PIS logical commit, exact-candidate regression, package/installed qualification and private index/history scans. d521 payout and historical full-suite evidence do not qualify the newer PIS source. The separate PRIVATE Community repository and historical sealed-fbf CI already exist; newer source needs its own authorized sanitized push and CI. Never push quarantined roots or use the private V2 repository. Native source-supply evidence remains external to Git; preserve original notices. Scope is private internal use; VM testing is owner-deferred. Ownership/MIT authority remains unverified. Current software, redistribution and release acceptance are not promoted by focused tests or historical CI.
