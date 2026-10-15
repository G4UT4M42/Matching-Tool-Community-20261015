# FINAL-P02 — Account banking and controlled invoice collection

Status: IN_PROGRESS. Recovery source: final branch at f082819841f9c209d82fb6696b16dc6143487e0b plus its 20 preserved pending files. This isolated source-only candidate intentionally has no V2 Git ancestry. No release acceptance is implied.

## Requirement and existing implementation

Expose read-only banking in normal authenticated navigation with individual encrypted configuration, idempotent durable import and accurate capability declarations. Replace the empty Invoice Bot catalog with explicitly controlled user-owned collection. Existing banking service/router/page and bot coordinator/document service are reused.

## Defects and missing work

Banking is not mounted. Its form supplies one string where the adapter requires application, session and key fields. The AIS client requires an optional account-details UID, accepts missing expiry, and ignores the mandatory credit/debit indicator. Provider cursor/financial durability patterns already exist. The bot has no production adapters, no bounded execution or persistent provenance in confirmed canonical documents.

## Sources, dependencies and ownership

Only this candidate is owned for edits: `src/community/banking/`, `src/community/invoice-bot/`, `src/server/community-workspace.ts`, their routes, pages, translations and new focused tests. Original Community/V2 worktrees remain untouched. Dependencies: existing account/session/CSRF guard, registered SQLite v4, canonical transaction journal, credential protector and content-addressed document store. Recheck staged differences before commits.

## Implementation and data

1. Reproduce AIS contract and validation defects with synthetic API fixtures.
2. Correct parsing, expiry, account and pagination guards without changing historical migrations.
3. Add a bank-specific scope-bound encrypted vault and durable canonical bank importer.
4. Mount method-specific authenticated routes and explicit form fields, reconnect/disconnect and read-only capability information.
5. Inventory retained V2 adapters using Community source only; replace shared-browser/session automation with fresh user-controlled browser collection where supported.
6. Preserve provider source IDs and hashes through confirmation and backup/restart.
7. Run focused unit/API/browser tests, full regressions, privacy scan, review and commit.

No schema upgrade is planned: reuse the registered bank connection table and canonical metadata. A new format requires an explicit migration before use.

## Invariants and negative tests

No payment initiation from AIS. No real bank calls in automated tests. No ambient browser profile, credential lookup, SSO account selection or MFA/CAPTCHA interaction. Encrypted secrets stay under identity storage and out of reusable backups. Sources cannot change on reimport. Unknown financial signs, missing expiry, malformed dates, pending rows, cross-account rows, duplicate conflicts, pagination loops, stale principals and unauthorized/CSRF requests must fail. A checkpoint never precedes durable accounting commit. Portal downloads remain unconfirmed until reviewed.

## Acceptance and evidence

Require actual built owner UI plus authorized API and role/CSRF negatives, exact per-currency fixture totals, source IDs, attachment hashes, restart, reconnect and cancellation/timeout. Provider authentication remains a separate external qualification; synthetic success does not establish live acceptance. Evidence root: `<external-audit-root>/Matching-Community-Final-20261015/candidate-acceptance/`. Exact command/result/commit references are appended after execution. Current recovered baseline: 298/298 TypeScript tests, zero failed/skipped; typechecks and production build passed. Node/browser acceptance pending.

## Recovery

Verified 459-file recovery checkpoint: `<external-audit-root>/Matching-Community-Final-20261015/recovery-20261015-current/`. All hashes matched. Recover only in a fresh isolated directory. Keep original work and historical migration checksums intact. Runtime recovery uses the existing canonical journal and staged restore; never reset schema version or overwrite an open database.
