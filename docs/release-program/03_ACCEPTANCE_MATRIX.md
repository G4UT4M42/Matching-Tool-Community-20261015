# Release acceptance and evidence matrix

Current update (2026-10-16): private internal development uses branch
`community/payout-finalization-20261016`. The separate private repository and
sealed-fbf hosted CI are verified. AIS consent and PayPal corrections are in
9ae (app571/571; its complete Node run pending at this update); newest Stripe
payout reconciliation has focused implementation evidence but is not yet
committed/full-qualified. Current software acceptance remains pending, and
provider live acceptance, ownership/MIT facts and owner-deferred VM qualification
are distinct. No public or third-party redistribution is authorized by this
record. See [current status](../feature-parity/STATUS.md).

> Historical 2026-10-13 baseline retained for provenance. Current qualification supersedes its package versions, counts and unfinished-function statements; see [../feature-parity/STATUS.md](../feature-parity/STATUS.md). This historical table is not current acceptance.
| Phase | Required objective | Evidence presently available | Status |
|---|---|---|---|
| P00 | repository and work packages traced | branch `feature/community-app-port-20261013`, clean baseline `bd4700f`; documentation started | IN PROGRESS |
| P01 | all public bytes cleared | automated scan on 212 candidate paths only; independent manual review missing | BLOCKED |
| P02 | license and ownership clear | `docs/THIRD_PARTY_LICENSE_REVIEW.md` is preliminary | BLOCKED |
| P03 | no unauthorized sensitive operations | five guard tests and basic local denial checks | INCOMPLETE |
| P04 | financial correctness proven | demo cent totals and migration smoke checks only | INCOMPLETE |
| P05 | versioned backup/restore across stores | offline preview WAL snapshot only | INCOMPLETE |
| P06 | migration, skipped versions, rollback | offline synthetic staging tests; no activation | BLOCKED |
| P07 | all UI English; German optional | navigation/localization helper only | INCOMPLETE |
| P08 | broad reproducible synthetic demo | four fictional transactions and two documents | INCOMPLETE |
| P09 | fresh Windows end-user setup | developer PowerShell launcher documented | INCOMPLETE |
| P10 | full integration/browser/fault suite | baseline 20 of 20 passing on Node 22 | INCOMPLETE |
| P11 | community operations docs | foundational README/security/contribution/policy present | INCOMPLETE |
| P12 | CI enforces all relevant gates | migration-policy workflow exists; broader qualification missing | INCOMPLETE |
| P13 | independent audited release candidate | no release evidence package yet | NOT_STARTED |
| P14 | private repository / owner-approved publish | no remote configured; no visibility change authorized | NOT_STARTED |

**Baseline run:** Node v22.16.0, 2026-10-13. `npm test` 20/20, `npm run typecheck` PASS, `npm run build` PASS, `npm run privacy:check` PASS (212 candidates). These are developer-preview gates only.

Every row needs specific command, date, commit, fixture identity, log/hash and reviewer signoff before PASS. A failed test must never be changed to SKIP to pass a financial or security gate.
