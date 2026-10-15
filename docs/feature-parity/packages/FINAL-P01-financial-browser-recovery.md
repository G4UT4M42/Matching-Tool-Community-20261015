# FINAL-P01 — Actual financial browser recovery

Status: SOFTWARE_PASS (financial journey and applicable local regressions on 2026-10-15); NOT RELEASE_ACCEPTED. This package does not supersede the original 21-area acceptance matrix.

## Scope and recovery

Continue from the complete source-only checkpoint of the E2E worktree at HEAD 9a94524d85abd5d81e94f139ed8131ca44eef351, including its valid uncommitted implementation. This continuation owns only the new branch `feature/community-final-20261015` and its isolated worktree. The previous worktree and other agents' files are unchanged. The external audit directory `Matching-Community-Final-20261015` contains the pre-change 447-file SHA-256 manifest, original dirty diff and recovery metadata. Other-session coding-process command lines were not fully visible to the Remote Agent service account; isolation avoids assuming ownership.

## Requirement

The real built normal application must complete bank import, genuine offline OCR, invoice correction/confirmation, invoice-table import, exact matching proposal acceptance/rejection, partial allocation, explicit financial/tax classification, report/export, attachment-inclusive backup, confirmed restore and restart with identical financial relationships in SQLite and JSON.

## Current implementation and defect

The previous complete financial browser test timed out waiting for a proposal to become accepted. The actual cause is not yet verified. The imported work includes a canonical cross-store coordinator, schema v4 registry, packaged OCR and mounted document/accounting/data-management pages. Historical individual passing tests are not acceptance of this snapshot.

## Affected sources and investigation

- tests/community-financial-browser.e2e.mjs
- tests/helpers/main-browser.mjs
- web/src/pages/CommunityAccounting.tsx
- src/server/routes/community-accounting.ts
- src/server/community-workspace.ts
- src/storage/canonical-transaction.ts and canonical-sql.ts
- src/core/matching/decisions.ts

First rerun the unchanged functional assertions with bounded diagnostics: non-authentication HTTP method/path/status/error-code evidence, UI alerts, browser errors, synthetic financial state and SQLite snapshot. Do not capture authentication payloads, cookies, setup codes or credentials. Diagnose before modifying product behavior. Add a targeted regression that fails before the product repair. Repair the contract, then rerun the original complete browser journey and integrated regression suite.

## Invariants

Preserve authentication, workspace permissions, CSRF, stale-state rejection, exact signed minor units, immutable transaction/document source IDs and append-only audit events. No response may claim a financial commit before durable persistence. Failed writes must preserve active state. No original V2 data, live provider accounts or real payments may be used.

## Mandatory tests and acceptance

- Real main server plus freshly built frontend, synthetic fresh owner and dataset.
- Original financial browser assertions remain enabled and are not weakened.
- Targeted regression proves the observed root cause is repaired.
- Full TypeScript application test discovery runs, without skipped failures.
- SQLite and JSON source relationships and exact amounts agree before and after restart/restore.
- Rejected proposal history is retained; incorrect roles/CSRF and stale revisions remain rejected.
- No unexplained page errors, external offline requests or live transfers.

Set SOFTWARE_PASS only after the complete applicable tests pass; RELEASE_ACCEPTED additionally requires all product and release gates.

## Evidence and continuation

Actual commands and process exit codes are recorded in the external audit directory. Initial baseline results are `initial-run-results.json`, `financial-before/`, and `integrated-baseline.json`. Record the root cause and subsequent evidence here once observed. After P01, continue with the existing persistence/migration, provider, Invoice Bot, payment, UI, installation, privacy/license and private-release packages in dependency order. Do not mark independent unfinished work externally blocked.

## Rollback

Revert only this continuation's reviewed edits or recreate this worktree from the preserved HEAD plus original dirty source checkpoint. Never reset, clean, overwrite or remove the previous E2E worktree. Preserve failed-test evidence. No deployment or public publication is authorized.

## Verified completion — 2026-10-15

**Root cause.** In the actual main-server browser run, `PATCH /api/accounting/matches/:id/status` returned HTTP 500 `ACCOUNTING_PERSISTENCE_FAILED` because `recordAudit` retained an alias to mutable matching evidence. Transitioning a proposal altered a historical `after` object, and the canonical append-only auditor correctly rejected the commit. The error was not a timeout, CSRF bypass, or underlying SQLite corruption.

**Fix.** `src/observability/audit.ts` now snapshots nested `before` and `after` evidence with `structuredClone` at event recording. Four regression tests in `tests/community-audit-snapshot.test.ts` failed before the fix and passed after it. Existing canonical/history integrity guards remain active.

**Browser-driver correction.** The live report contract returns `fully_matched` (not `complete`); the test now also asserts both document balances, both transaction balances, exact EUR -3250 minor units, and required audit actions. The document UI opens its image only after the user explicitly clicks `Preview`; the test now performs that step. No timeouts or server validations were weakened. The proof manifest truthfully identifies the English OCR input without claiming that this one scenario exercised a German OCR image.

**Evidence.**
- `<external-audit-root>/Matching-Community-Final-20261015\audit-regression-before.json`: 4/4 regression failures reproduced.
- `audit-regression-after.json`: 4/4 passed.
- `financial-retest-04\financial-workflows\result.json`: **1/1 real built-application financial journey passed**, 0 page errors and 0 external requests. Screenshots and SHA-256 evidence reside next to this result.
- `p01-app-20261015-0708-vitest.json`: **291/291 tests passed**, 39 test files, 0 skipped.
- Full Node discovery initially revealed two wrongly launched TypeScript-importing browser test entrypoints. The Node runner now registers `tsx` before `node:test`. Both separately retested **2/2 passed**; the subsequent complete Node discovery **49/49 passed**, 0 skipped.
- `package.json` now includes the complete Node test group in `npm test`; dedicated smoke and policy commands remain available.

**Boundary.** This evidence accepts P01 software functionality only, not all 21 product areas. Do not push source or claim release readiness until normal-app provider management, Invoice Bot, payment management, installation, privacy/licenses and final exact-commit CI qualification meet their independent gates.
