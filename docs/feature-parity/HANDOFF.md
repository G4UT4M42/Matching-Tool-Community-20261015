> Current continuation (2026-10-15): isolated source-only candidate `<isolated-worktrees>/Matching-Tool-Community-Private-Candidate-20261015`, branch `main` pending final sanitized-root reconstruction. Original final worktree/HEAD and all 20 pending files were preserved in a 459-file SHA-256-verified external checkpoint. Recovered source baseline: 298/298 app tests and 52/52 Node/browser tests; typechecks/build passed. New banking/assisted portal/provenance/security changes are being qualified; see `packages/FINAL-P02-banking-and-portals.md`. Eight assisted portal workflows are implemented; ZERO live providers are accepted. Banking is read-only AIS plus separate SEPA/local simulation. Source/cloud identifier and native-license findings prevent any release-ready claim. PRIVATE_REPOSITORY_READY=false; SOFTWARE_ACCEPTED=false; RELEASE_ACCEPTED=false. Historical detailed statements below do not supersede this current status.

# Matching Tool Community — continuation handoff

Status: **IN_PROGRESS, NOT RELEASE_ACCEPTED**, updated 2026-10-15. Current isolated worktree is `<isolated-worktrees>/Matching-Tool-Community-Final-20261015`, branch `feature/community-final-20261015`. Read `STATUS.md` and actual HEAD/status before proceeding. Do not modify productive V2 or other agents' worktrees.

**LATEST HANDOFF (supersedes outdated next-step details below):** FINAl-P01 financial full-browser journey PASS 1/1, and comprehensive TypeScript tests 291/291 plus Node tests 49/49 PASS. Main defect repaired by cloning audit before/after evidence; added 4 regression tests. Test driver now follows the documented report `fully_matched` status and clicks explicit document Preview. Source still includes pending uncommitted integration work and is NOT release-accepted. Source checks and evidence are in `<external-audit-root>/Matching-Community-Final-20261015`. Node 22.23.3 and built UI used; typechecks/build and whole-tree generic privacy scan passed. Work through normal-app provider/bank/Invoice-Bot/payment wiring next, full install/E2E/security/license gates later. The remainder of this handoff describes earlier implementation context and may predate canonical SQLite v4 integration.

## Current verified milestone

All 254 current TypeScript application tests passed in one integrated run. The previous six sign/schema regressions are fixed, not waived. The real built application now has first-run account setup, session-aware login/logout, role management and an authorized bank-statement preview/confirm/discard page. A real browser journey exercised these against the actual main server, including negative role/CSRF requests and restart. The standalone mocked-provider journeys from earlier work remain separate evidence.

The current Windows launcher `scripts/Start-Community.ps1` accepts explicit independent data storage, application directory, Node executable and port. It prints a temporary local setup code for a not-yet-owned installation. Never write this code into a URL or ordinary application log. The launcher disables inherited demonstration/bank-execution options in normal account mode.

## Exact source contracts

- `src/community/accounting/document-settlement.ts`: document settlement direction is defined from source/explicit metadata, never selected to fit a transaction. Legacy normalized signed amounts remain unchanged; new supplier invoice face values are interpreted separately. Preserve the new ten-case regression test.
- `src/server/community-auth-*`, `community-identity-files.ts`, `community-permissions.ts`: trusted server-side user/workspace/session roles, per-session CSRF, private identity storage, explicit method permissions and account administration. Never trust a body-supplied role or actor.
- `web/src/components/CommunityAccountAccess.tsx`: real first-owner/login flow, volatile CSRF setup, stale async response protection and logout cleanup. `CommunityAccounts.tsx` manages accounts/passwords. No session cookie or password is saved to browser storage.
- `web/src/api.ts`: only local API writes receive the in-memory CSRF header. External/other-port links must not receive local credentials. Authentication failure invalidates the active gate; rejected login credentials do not masquerade as an expired accounting session.
- `src/server/routes/statement-preview.ts`: reviewed rows are bound to user/workspace/session and the current data-state hash. Preview does not write, confirmed commit uses the existing recoverable statement transaction, and discard invalidates the token server-side.
- `src/server/routes/api.ts` and `community-auth-http.ts`: normal reviewed statement routes are now mounted with exact method/capability authorization. The synthetic demonstration guard has not been widened to account-owned data.

## Next dependency-ready engineering

1. Build the shared financial unit of work for the currently separate accounting/document/provider routers. It must durably mirror the canonical JSON state and SQL source/relationship/audit records, reject stale concurrent writes and recover interrupted commits. Reuse proved mechanisms rather than silently replace source identities or payment authority.
2. Explicitly register generic-persistence and payment schema evolution. Current normal SQLite is v2; the separate `003-community-payments.ts` prototype is not a registered main-application upgrade. Old application versions must fail closed on newer capability/state versions.
3. Extend backup/restore to exact per-record cross-store equality, allocation-enabled JSON v2, immutable source/audit history and the content-addressed document index/blobs. Keep identity/vault/session/approval material out of reusable backup authority. Test actual interrupted activation and rollback.
4. Bind provider orchestration to idempotent durable accounting imports and real trusted principals. Do not enable an unreviewed legacy handler merely because an account is authenticated. Mock providers are sufficient for independent software tests; genuine sandbox/live credentials remain a separate user-authorized qualification.
5. Mount all remaining normal-app pages and complete the full 21-area browser journey. Preserve payment preparation/review/one-use approval/unknown-outcome boundaries. No real financial transfers in tests.
6. Reconcile all work packages, privacy/history/dependencies/licenses, clean installation and the final exact-commit regression before constructing a source-only PRIVATE GitHub release.

## Tests and evidence

The existing Vitest configuration already discovers `tests/**/*.test.ts` and isolates temporary data. Its aliases and environment safeguards are preserved. `npm run test:app` no longer hardcodes only four old tests. `npm run test:smoke` includes the real account browser and launcher tests alongside the older synthetic demo/main-server/matching checks.

Evidence directory on the device: `<external-audit-root>/Matching-Community-E2E-20261014-045708\continuation-20261014-135300`.

Key files: `post-ui-integrated-suite.json` (254/254), `six-regressions-after.json` (14/14), `settlement-after.json` (45/45), `browser-boundary-tests.json` (29/29), `account-authorization-and-accounting.json` (30/30), `actual-account-browser-02/account-browser-result.json` (real built application), `normal-launcher.log`, and source before/after manifests. These counts overlap; do not add them into a fictitious global test count.

The qualified local runtime is Node 22.23.3, ABI 127, downloaded and signature/hash verified in the external audit directory. Other devices and clean installations must verify their own supported runtime/dependencies. No global runtime was changed.

No unattended background continuation is implied. Check Remote Agent's current task mode and actual active process ownership before reporting work as running. Preserve all tool approvals; a prior blocked invocation is not evidence of a permanent unsolvable software defect.
