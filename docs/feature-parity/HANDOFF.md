# Matching Tool Community — current continuation handoff

> Current private internal development, 2026-10-16: active branch
> `community/payout-finalization-20261016` in
> `<isolated-worktrees>/Matching-Community-Payout-Completion-20261016` extends
> `9ae282fd86cb67ac00d875f580141efeb5321b2e`; sealed `fbf40e85` artifacts are preserved.
> AIS consent and PayPal event corrections are committed at 9ae; its app suite
> passed 571/571, while its complete Node run was still in progress at this update.
> New Stripe payout reconciliation is implemented with focused synthetic
> evidence; it is not yet committed or fully qualified as a final candidate.
> See [bank consent](BANK_CONSENT_CONTRACT.md), [PayPal events](PAYPAL_EVENT_CONTRACT.md),
> [Stripe payouts](STRIPE_PAYOUT_RECONCILIATION.md) and
> [private internal scope](../compliance/PRIVATE_INTERNAL_USE.md).
> A separate private Community repository and sealed-fbf hosted CI are verified.
> Later source needs its own qualification. VM testing is OWNER_DEFERRED, not PASS.
> No blanket ownership/MIT, legal, distribution or release clearance is inferred.

Status: IN_PROGRESS. Updated 2026-10-16. Read [STATUS](STATUS.md), [feature matrix](02_FEATURE_MATRIX.md), [current work package](packages/FINAL-P03-integrated-acceptance.md), actual Git HEAD and status before editing.

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
- Payment simulator and supported AIS are accurately separated. Unknown outcomes cannot be blindly resubmitted.

## Execution

Use the externally qualified Windows x64 Node22.23.3 / ABI127; system Node24 is incompatible with the installed SQLite build. Rebuild the production UI before normal-browser tests. `scripts/run-community-tests.mjs app` discovers all app tests; `node` discovers actual node:test entrypoints, excludes ordinary helpers and registers tsx. Set unique external MATCHING_TEST_EVIDENCE_ROOT, MATCHING_TEST_RUN_ID and MATCHING_MAIN_BROWSER_EVIDENCE_DIR; existing evidence is never overwritten. The bounded Node group deadline is30minutes (app20minutes), recorded in each runner manifest. The earlier16.2-minute baseline plus the2.2GB source closure and added browser/lifecycle regressions require this measured capacity; command/test assertions and timeout failures remain enforced.

`tests/community-integrated-acceptance.e2e.mjs` defaults to a newly built development package and real installation. MATCHING_ACCEPTANCE_MODE=source is an explicitly labeled iteration mode, never installed acceptance. The test composition uses only synthetic provider/portal/payment responses and the installed actual application factory. Its controlled interruption hook exists only as a code dependency; no production request can arm it.

Main browser evidence includes screenshots, responses, exact SQL/JSON snapshots, source IDs, hashes and all console/request errors. An expected interrupted activation must prove its exact process exit, journal cutover phase and one correlated failed request; all other browser errors remain failures.

## Next work

Finish current payout tests/reviews, logical commit, exact-candidate regression, package/installed qualification and private index/history scans. The separate PRIVATE Community repository and historical sealed-fbf CI already exist; newer source needs its own authorized sanitized push and CI. Never push quarantined roots or use the private V2 repository. Native source-supply evidence remains external to Git; preserve original notices. Scope is private internal use; VM testing is owner-deferred. Ownership/MIT authority remains unverified. Current software, redistribution and release acceptance are not promoted by focused tests or historical CI.
