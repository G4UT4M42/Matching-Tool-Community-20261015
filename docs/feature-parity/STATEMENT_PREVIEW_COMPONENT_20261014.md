# P06-W02 — statement preview and explicit financial commit

Status: **IMPLEMENTED (isolated component only)**. Neither SOFTWARE_PASS for the entire package nor RELEASE_ACCEPTED.

## Contract

`src/server/routes/statement-preview.ts` supplies POST /import/preview, POST /import/commit and POST /import/discard, to be mounted behind the trusted account/session and method-specific authorization middleware. The active user principal must contain an authenticated subject, workspace and session ID. HTTP callers cannot provide or override the principal.

Preview accepts exactly one bounded Sparkasse/Visa CSV/XLSX statement plus an explicitly selected local account. It uses the reviewed parser from P06-W01 and retains only normalized transaction evidence in memory. No SQLite/JSON mutation occurs during preview; the raw multipart buffer is erased after parsing.

An unguessable 256-bit confirmation token is stored only by its SHA-256 digest. The pending preview contains an exact source-file SHA-256 digest, the entire reviewed dataset, a hash of the financial state, source/account identity and the authenticated session. It expires after ten minutes. At most eight unconfirmed previews can occupy one application process. POST /import/discard invalidates a preview on the server after verifying the same authenticated session, without writing financial records.

Confirmation rejects missing/expired/mismatched-session tokens and stale financial state. It then uses the previously qualified cross-store statement journal and activates state only after the financial write. A successful confirmation consumes the token. A repeated identical source file is idempotent at the source-event identity layer. No payment operation is called.

## User interface

`web/src/pages/CommunityStatementReview.tsx` provides responsive English/German file selection, source/account selection, exact minor-unit and per-currency totals, the first 100 normalized rows, explicit commit and discard controls. It deliberately does not convert unlike currencies or use floating-point minor-unit division. The page never persists confirmation tokens in browser storage. Its discard action calls the authenticated server endpoint rather than merely hiding the local preview.

The page requires an injected, authenticated, same-origin request callback. The production host must supply the server-issued CSRF header and session cookies through its reviewed authentication layer. A local fake principal is used **only** in the standalone browser acceptance harness, never in production.

## Exact evidence

- `tests/statement-preview.test.ts`: **9 PASS / 0 FAIL / 0 skipped**. Test boundaries include preview without writes, explicit confirmation, replay rejection, foreign user/session rejection, unauthorized requests, stale state, malformed input and file size limits.
- `tests/community-statement-review.browser.mjs`: **1 PASS / 0 FAIL / 0 skipped** in isolated Chromium. The test used a generated fictional CSV, confirmed no database write at preview, switched to German, committed, reloaded, and reimported idempotently.
- Browser proof: `Matching-Community-E2E-20261014-045708/statement-review-browser-discard/statement-browser-result.json`, with six SHA-256-hashed screenshots and zero external requests.
- Backend and frontend TypeScript checks passed after the new component was added.

## Current integration blocker

The platform's security review denied an attempted edit of the shared `src/server/routes/api.ts`. The operation was **not retried through another tool or alternate route**. Consequently, the existing full application does **not** mount the preview router or link this page in normal navigation. It still has the prior one-step upload and additional legacy import UI. Standalone component/browser success must not be relabeled as full-app acceptance.

The new route must receive explicit account-mode `finance:import` permissions and mandatory CSRF validation before activation. The legacy direct-upload workflow must be reconciled with the new explicit review policy, preserving source identity, audit and cross-store recovery guarantees. Further tests must cover full-application login, browser navigation, both locales, bad origin/cookies and process restarts.

Remaining open: resource quotas for high-concurrency accounts, full supported-source format inventory, duplicate/conflict preflight, live read-only financial aggregation and final 21-area regression. None requires real financial records or credentials for the software work.

## Safe continuation

Resume from the current isolated integration checkout without discarding dirty changes; inspect the exact blocked operation and seek an authorized execution path rather than bypassing platform controls. Run all negative authorization tests after mounting, including forged principal, missing CSRF, different browser origins, session expiration and concurrent confirmation. Update `STATUS.md` and `HANDOFF.md` before any reviewed release.
