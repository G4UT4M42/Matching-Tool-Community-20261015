# Matching Tool Community — current continuation handoff

Status: IN_PROGRESS. Updated 2026-10-15. Read [STATUS](STATUS.md), [feature matrix](02_FEATURE_MATRIX.md), [current work package](packages/FINAL-P03-integrated-acceptance.md), actual Git HEAD and status before editing.

> Current checkpoint (2026-10-15): reviewed canvas02+fullsourceWASM01 fresh-install journey passes at `55959e8` in362203ms with48 interface combinations and actual migration interruption/recovery.8331-file packageSHA c7f3e1b8f1f5ed148b2ea993b5a4fad4ad21cf88308273f0fcb0f8db04b7ba40; dirty=true due then-untracked compliance work. Raw console records contain intentional negative responses/cutover; review found the generic4xx console filter too broad. Explicit per-method/path/status one-use negative registration is being implemented and final journey must repeat. App baseline441/441; maintenance defect repaired with two3/3 runs; focused replacement/SBOM8/8. Native fullsource core/companion/codecs pass; detailed source/SBOM review remains active. All three repository/software/release milestones remain false.

## Boundaries and ownership

Use only `<isolated-worktrees>/Matching-Tool-Community-Private-Candidate-20261015`. Productive V2, recovered original worktrees, user financial stores and existing browser sessions remain untouched. All tests create independent synthetic roots. Never use real provider credentials or execute real transfers. Owner communication is German; code/docs/tests are English by default.

Root owns application composition, normal pages, integration tests, data-operation audit and packaging. Agent source handoffs are explicit. The native rebuild agent owns its external builds and new rebuild-qualification document. Independent data-audit and historical-document source reviews are completed and handed back. Do not overwrite active files or retry any denied operation.

## Current contracts

- `src/server/application.ts`: actual production composition shared with explicit test dependencies; no HTTP/environment transport backdoor. `index.ts` is the ordinary listener entrypoint.
- `community-workspace.ts`: current session/actor capability checks, quiescence for persistence, canonical commits, account-bound provider coverage and separate operation audit.
- `canonical-transaction.ts`: recoverable SQLite/JSON/audit transaction and immutable sources. Do not weaken comparisons to pass tests.
- `documents/review-audit.ts`: bounded strict review replay; derived index is recoverable and not sole authority. Unconfirmed uploads do not create financial documents.
- `persistence/backup.ts` and `restore.ts`: referenced evidence, aggregate limits, exact cross-store verification and interrupted activation rollback; never restore reusable secrets or payment authority.
- `accounting/ledger.ts`: exact allocation math, before/after audit and ownership-aware literal rules. Future imports apply reviewed enabled literals within statement/workspace canonical commits. Regex is never evaluated.
- Provider adapters use verified official account identity. Missing historical coverage and ambiguous legacy bindings fail explicitly; do not rewrite original source IDs.
- Payment simulator and supported AIS are accurately separated. Unknown outcomes cannot be blindly resubmitted.

## Execution

Use the externally qualified Windows x64 Node22.23.3 / ABI127; system Node24 is incompatible with the installed SQLite build. Rebuild the production UI before normal-browser tests. `scripts/run-community-tests.mjs app` discovers all app tests; `node` discovers actual node:test entrypoints, excludes ordinary helpers and registers tsx. Set unique external MATCHING_TEST_EVIDENCE_ROOT and MATCHING_TEST_RUN_ID; existing evidence is never overwritten.

`tests/community-integrated-acceptance.e2e.mjs` defaults to a newly built development package and real installation. MATCHING_ACCEPTANCE_MODE=source is an explicitly labeled iteration mode, never installed acceptance. The test composition uses only synthetic provider/portal/payment responses and the installed actual application factory. Its controlled interruption hook exists only as a code dependency; no production request can arm it.

Main browser evidence includes screenshots, responses, exact SQL/JSON snapshots, source IDs, hashes and all console/request errors. An expected interrupted activation must prove its exact process exit, journal cutover phase and one correlated failed request; all other browser errors remain failures.

## Next work

Finish pending tests/reviews, logical commits, exact-candidate regression and private history scans. CLI login remains owner-dependent; check status metadata after notification without requesting or printing a token. Create a new PRIVATE Community repository only after applicable checks; never push quarantined roots or use the existing V2 repository. Native source-supply evidence must remain external to Git; do not edit original notices to satisfy privacy scanning. Redistribution, SOFTWARE_ACCEPTED and RELEASE_ACCEPTED remain false until their own gates pass.
