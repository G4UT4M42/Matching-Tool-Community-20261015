# Implementable work packages

Each ID remains **OPEN** until its acceptance checks have reproducible evidence. Technical tasks may be split into commits without declaring their parent complete.

| ID | Work package | Required proof / gate |
|---|---|---|
| P00-A | Git/worktree/process inventory | clean candidate, protected input confirmation, baseline commit |
| P00-B | Full source/runtime/dependency map | exact routes, stores, binaries and generated artifacts |
| P01-A | Audit all tracked, historical and packaged bytes | inclusion manifest, no identity or secret exposure |
| P01-B | Private-owner blocklist out of distributable code | regression shows scanner itself is clean |
| P02-A | Source and asset ownership review | written ownership approval, NOTICE and license matrix |
| P02-B | Transitive dependency and binary audit | pinned inventory/SBOM, compatibility findings resolved |
| P03-A | Route-by-route access and risk audit | unreviewed routes default denied, negative API tests |
| P03-B | File, SSRF, archive, parser and OAuth safety | adversarial fixtures and explicit limits |
| P03-C | Local session, payment and backup/restore controls | no unauthenticated data path or hidden money movement |
| P04-A | Matching invariants and synthetic ledger corpus | one-to-many, splits, proposals and refunds tested |
| P04-B | Tax/report decision provenance | no unaccepted matches or undocumented VAT assertions |
| P05-A | Persisted-store version registry | every supported storage version identified |
| P05-B | Reliable backup/restore with attachments | WAL and cross-store consistency, failure recovery tests |
| P06-A | Real legacy format inventory using **synthetic replica** | schema/status/relationship coverage including unknowns |
| P06-B | Portable staging and full migration verification | count/hash/financial parity, status and audit preservation |
| P06-C | Activation, revert, repeated imports and skipped upgrades | interrupted retries and all version edges pass |
| P07-A | English/German full application pages and dialogs | key coverage and locale-switch E2E |
| P08-A | Seeded synthetic cases and demo reset | no real identity or live connector, repeatable hashes |
| P09-A | Clean Windows installer/onboarding | non-developer setup and restart tested |
| P10-A | Full regression and UI/browser matrix | every mandatory user journey and negative scenario |
| P11-A | Contributor and operations docs | independent developer able to install and validate |
| P12-A | Continuous integration/quality gates | clean run on defined Node 22 runners |
| P12-B | Pre-push source/artifact privacy and migration gates | unsafe changes produce non-zero exit |
| P13-A | Independent release qualification | signed-off test and privacy/license/security package |
| P14-A | Secure private GitHub remote setup | no private history or artifacts pushed |
| P14-B | Public visibility and initial release | explicit owner authorization after P13 |

**Workflow:** inspect -> acceptance criteria -> synthetic tests -> change -> run all checks -> review -> explicit staging -> commit -> update STATUS/HANDOFF -> next. Legacy financial data cannot be used as test input.