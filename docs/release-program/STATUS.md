# Release execution status and historical baseline

Current private internal development update (2026-10-18): active checkout
`<isolated-worktrees>/Matching-Community-Sandbox-Payments-20261016`, branch
`community/sandbox-payments-20261016`, extends d521. AIS consent, PayPal financial
corrections and standard-automatic Stripe payout reconciliation are committed
in d521; its historical complete local app 587/587 and Node 90/90 passed.
New sandbox-only single SEPA EUR PIS is implemented and focused-tested (62/62),
independently reviewed in bounded snapshots and exercised by a separate source
normal journey (1/1). Current PIS committed/full/installed/CI qualification is
pending. See [current status](../feature-parity/STATUS.md),
[sandbox contract](../feature-parity/SANDBOX_PAYMENT_CONTRACT.md) and
[payout contract](../feature-parity/STRIPE_PAYOUT_RECONCILIATION.md).

A separate PRIVATE Community repository and sealed-fbf hosted CI already exist.
Do not infer newer-source CI from that result. Owner-selected scope is private
internal use; pristine Windows VM testing is OWNER_DEFERRED. Ownership/MIT
authority remains unverified; no legal/public/redistribution acceptance is
inferred. Provider live authority is separate from supported local code.

## Historical 2026-10-13 baseline (retained unchanged in scope)

Date: 2026-10-13 (Europe/Vienna)
Repository: Matching Tool Community isolated worktree
Branch: `feature/community-app-port-20261013`
Start commit (verified): `bd4700f`
Public release: **NOT_READY**; visibility change not approved.

## Verified baseline
- Independent isolated Git history already exists; source worktree clean at start.
- No Matching Tool Community process/agent detected by process command-line filter at start.
- Protected production and separate remediation checkouts observed without mutation by this program.
- 212 tracked candidates scanned by current privacy gate, automated PASS only.
- Node 22.16.0 / ABI 127 validated; 20 of 20 existing tests PASS.
- Backend/frontend typecheck PASS; Vite build PASS; privacy scan PASS.
- Initial Node 24 attempt failed 3 native SQLite tests due ABI mismatch, not adjudicated application defects.

## Execution at the historical baseline
- P00 release-program inventory/checkpoint documentation and security/privacy follow-up.
- No phase beyond baseline qualified; all P01-P14 release gates remain open.
- Source-license provenance, functional migration, browser E2E, tax/report validation and publication remain blocked.

## Next packages at the historical baseline
1. P01-B remove private owner-specific terms from publicly tracked scanner and test the private-blocklist mechanism.
2. P03-A positive API route policy and negative tests.
3. P05-A per-store versioning plus forward migration fixtures.
4. P06-A classify legacy SQLite/JSON data, no credential leakage.
5. P12-A CI build and synthetic regression gates.

## Owner-only gates recorded at the historical baseline
Rights verification/MIT final decision; any private dry run with real records; permission to publish public. These are never inferred from a generic execution prompt.

**Do not report Done unless `03_ACCEPTANCE_MATRIX.md` is fully evidenced.**