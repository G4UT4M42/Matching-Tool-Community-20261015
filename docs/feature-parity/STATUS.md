# Matching Tool Community — authoritative implementation status

Status: **IN_PROGRESS, NOT RELEASE_ACCEPTED**. Updated 2026-10-15 after recovery. The entire application and private release are not accepted.

Current isolated continuation: `<isolated-worktrees>/Matching-Tool-Community-Final-20261015`, branch `feature/community-final-20261015`; verify HEAD and worktree before each edit. The original E2E worktree and productive V2 are preserved and untouched. The remainder of this document records the 2026-10-14 baseline; the 2026-10-15 verification below supersedes older pending-status statements where they conflict.

## 2026-10-15 verified recovery milestone

- **FINAL-P01: SOFTWARE_PASS** against the actual built application. Real browser financial journey **1/1 PASS**: synthetic bank import, offline English OCR, invoice CSV, accept/reject, partial allocation, tax/report/export, attachment-inclusive backup/restore and restart. No page errors or external calls. Evidence: `<external-audit-root>/Matching-Community-Final-20261015\\financial-retest-04\\financial-workflows\\result.json`.
- Root cause of the original HTTP 500: `recordAudit` retained references to mutable nested decision evidence; later state transitions altered prior audit events, correctly rejected by immutable history validation. Record before/after are now deep snapshots, with **4/4 new fail-before/pass-after regressions**.
- Full latest TypeScript application discovery **291/291 PASS** (39 files; 0 failed/skipped): `<external-audit-root>/Matching-Community-Final-20261015\\p01-app-20261015-0708-vitest.json`.
- Full Node/test discovery **49/49 PASS** (19 entrypoint files; 0 failed/skipped). Two earlier loader-only failures were repaired by registering `tsx` for TypeScript-importing `.mjs` tests. Together **340 nonoverlapping passing tests**.
- Qualified Node 22.23.3; backend/frontend typechecks, Vite production build PASS. Existing >500 KB frontend chunk warning remains. Whole-tree generic privacy scanner PASS for 449 candidate paths, **not** an independent secret/history/license certification.
- Canonical JSON v2 + registered SQLite schema v4 and cross-store restore operated in the real browser. Previously noted unfinished v3 payment registry integration is resolved in code, but normal-app payment flows still require authorization and end-to-end qualification.
- `package.json` test command now executes full application and Node discovery. Dedicated policy and smoke scripts retained.
- No production changes, real transfers, owner financial source files, live provider credentials, public publication or GitHub push were performed. Review and qualify new integrations before release.

**Next work:** mount and qualify protected provider sync, banking, Invoice Bot and payment management in the normal owner application, complete full 21-area UI/install/negative browser matrix, run final exact-commit tests, perform independent licenses/history/privacy review and only then a sanitized PRIVATE GitHub release. No ordinary software defect is classified as external blocker.

## Resolved in the current continuation

1. **All six previously reported regressions are resolved.** Five backup/legacy failures came from confusing positive supplier invoice face values with signed bank cashflow. `document-settlement.ts` now determines direction from the document's documented source/explicit convention, never from the transaction being matched. Source amounts and IDs are retained. Manual review, automatic proposals, persistence validation and partial/FX allocations use the same interpretation. Ten new regression tests cover positive payables, historical signed documents, income/refund direction, incompatible values/currencies, source preservation, partial balances, exact FX and explicit credit-note conventions.
2. The SQLite version test now verifies the complete 0→1→2 migration history and both ledger entries. Baseline migration source and fixture were not modified to hide a failure.
3. **The normal account browser is implemented and mounted.** The real server and built UI support first-owner setup, login/logout, role-based account management, password confirmation/change, in-memory CSRF handling and stale-session invalidation. Synthetic token access remains separate and cannot open account-owned data.
4. **Bank statement preview/confirm/discard is mounted in the normal application.** Only accounts with `finance:import` receive access. The backend still independently checks sessions, workspace roles, allowed methods, origin and CSRF; hiding a navigation link is not authorization.
5. The Windows launcher now generates one-use first-run authorization, clears inherited demo/bank-execution settings, selects an independent data directory and checks actual native SQLite loading. Existing accounts ignore new bootstrap codes.
6. The existing Vitest configuration and its temporary-data isolation/aliases are retained. `npm run test:app` now discovers all TypeScript tests through that configuration instead of selecting only four historical files. New account-browser and launcher checks are included in the normal smoke script.

## Verified evidence

Evidence run: `Matching-Community-E2E-20261014-045708/continuation-20261014-135300` in the private external audit directory.

| Evidence | Observed result |
|---|---|
| `polarity-before.json` | Ten newly added source-convention regressions failed before implementation |
| `settlement-after.json` | 45/45 related accounting, backup, legacy and matching tests passed |
| `six-regressions-after.json` | 14/14 migration/backup/legacy tests passed; the original six errors no longer reproduce |
| `post-ui-integrated-suite.json` | **254/254 tests passed, 0 failed, 0 skipped**, across all 34 currently present TypeScript application test files |
| `browser-boundary-tests.json` | 29/29 request, origin, guard and statement-review tests passed |
| `account-authorization-and-accounting.json` | 30/30 account HTTP, native identity permissions and accounting/restart tests passed |
| `actual-account-browser-02/account-browser-result.json` | Real main server + built application: owner setup, preview before write, import, EN/DE, viewer creation, authorization/CSRF negatives, login/logout and process restart passed; seven screenshot hashes, no page errors or external requests |
| `matching-after-account-ui/` | Existing real-browser manual/review lifecycle and restart passed after account UI integration |
| `normal-launcher.log` | Actual Windows launcher with synthetic Unicode data path, one-use setup and existing-account restart passed |
| TypeScript / Vite | Backend and frontend typechecks passed; production UI built; the existing bundle-size warning remains |

An initial account-browser test exposed unreliable triple-click field replacement in its test driver. The driver now uses real Select All/Backspace/typing and asserts the resulting field value. Account logout also clears credential form fields. Assertions were not removed or weakened.

## Still incomplete — do not call these external blockers

The full 21-area normal-user journey is not complete. Independently tested provider, document/OCR, Invoice Bot, payment, accounting and data-management components exist, but their normal-app activation must use a reviewed durable cross-store coordinator and the actual role/CSRF boundary. Component HTTP 200 or mock-browser success does not establish whole-product readiness.

The next engineering dependencies are:

- Coordinate every financial/document/matching write between SQLite and versioned JSON; retain immutable audit and source identities, serialize competing writers, and recover pre-/post-commit interruptions.
- Reconcile the SQLite v2 registry, unregistered payment migration and future generic-persistence capability before activating payment history in the main server. Do not mutate historical migration checksums.
- Back up and restore allocation-enabled JSON v2, document content-addressed attachments and all relevant SQL relationships. Existing persistence prototypes primarily exercise the earlier JSON v1/SQLite v2 format; broader data equality and restore failure cases need qualification.
- Mount provider management with per-user protected credentials and atomic/idempotent import callbacks. Never advance a synchronization checkpoint before durable accounting commit.
- Mount documents/OCR, accounting/reports, Invoice Bot, bank and payment management in normal navigation after those storage/authorization contracts are proven.
- Complete source-backed V2 parity, all supported statement formats, remaining localization/responsive controls, clean independent installation and the complete integrated browser journey.
- Finish dependency/license/SBOM/NOTICE and original-history privacy review, then a separate sanitized PRIVATE GitHub candidate and CI. The draft SBOM is not a license certification.

## Execution and release boundaries

The native patch API returned an unsupported MCP elicitation response. Subsequent explicit source updates through the normal Remote Agent owner-policy command path were authorized and completed; no approval policy was changed. A first combined test-start request was platform-blocked; the later explicit current-source test invocation was accepted through the same tool and its result was observed to exit 0. These historical transport/tool events are **not current unresolved financial defects**.

No real bank transfer, original financial dataset, stored original provider credential or productive V2 modification was used. No public/private GitHub release has been pushed by this continuation. `release_ready` remains false intentionally until the above product and release gates pass.
