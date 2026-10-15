# Matching Tool Community - release execution masterplan

**Status:** active; public release prohibited until all release gates pass and explicit owner approval is received.
**Canonical checkout:** `<isolated-worktrees>/Matching-Tool-Community`; branch `feature/community-app-port-20261013`.
**Protected inputs:** the productive accounting installation and separate remediation worktree. No direct mutation, real records, or private Git history are permitted.

## Scope and invariant
Deliver a self-contained, local-first accounting-evidence reconciliation application with a tested fresh installation, completely generated fixtures, safe local operation, predictable matching/reporting, a language selector, versioned upgrades, non-destructive legacy migration, and traceable third-party rights.

No compilation-only or screenshot-only release. No automatic banking, payment release, or live-data migration until independently certified. An unresolved P0/P1 financial, privacy, security, licensing, or migration failure blocks public status.

## Execution order
1. **P00 Baseline:** establish branch, change ownership, provenance, build/test evidence and work-package register.
2. **P01 Privacy:** inspect tracked tree, object history, generated assets, fixtures, log paths and bundled materials; replace leaks; independent signoff.
3. **P02 Licensing:** source ownership and copyright decision; transitive packages, binary assets, schemas, fonts and separately hosted dependencies.
4. **P03 Security:** threat model, deny-by-default API, file paths and parsing, secure local token/session, payment kill-switch, negative tests.
5. **P04 Accounting:** signed-minor-unit reconciliations, acceptance semantics, split/refund/foreign-currency and tax evidence, synthetic golden cases.
6. **P05 Storage:** version every persistent store; WAL-safe backup, cross-store consistency, integrity and tested offline restore.
7. **P06 Legacy and upgrade:** stable version graph, staging, dry run, full relationship/invoice hash reconciliation, retry/rollback, explicit activation.
8. **P07 Localization:** extract all UI strings with English default and German coverage; fallback, accessibility, formatting-only locales.
9. **P08 Demo:** reproducible fictional fixture corpus; no real payment or network connector in demo.
10. **P09 Install:** clean Windows install, first-run auth, isolated state, diagnostics, documented upgrades.
11. **P10 QA:** unit, integration, UI E2E, threat tests, interruption/failure injection, clean-run performance.
12. **P11 Documentation:** community docs, vulnerability handling, architecture, support and contributor setup.
13. **P12 CI:** checks on clean workers, privacy/secret scanning, migration enforcement, artifact manifest, SBOM and supply-chain review.
14. **P13 Release candidate:** independent audit and SHA/evidence report; no unresolved release blocker.
15. **P14 GitHub:** private remote first, branch protection, tag/release only after qualification; public visibility after explicit approval.

## Dependency rules
P00 precedes any source change; P01/P02/P03/P04/P05/P06 all precede P13. P06 depends on P05. P10 spans every phase, not just the end. P12 consumes real P03-P10 checks. P14 private setup can be prepared early, but public publication is a separate owner gate.

## Checkpoint protocol
For each package: exact objective; affected files; synthetic acceptance and negative tests; before/after hashes; result; remaining risk; commit. No fabricated percentages or green checklists. Fix regressions before continuing. Review other active agents and worktrees before edits. Never commit data artifacts.

## Canonical evidence
See `01_WORK_PACKAGES.md`, `02_FINDINGS.md`, `03_ACCEPTANCE_MATRIX.md`, `04_PRIVACY_INVENTORY.md`, `05_MIGRATION_MATRIX.md`, `06_SECURITY_REVIEW.md`, `07_RELEASE_CHECKLIST.md`, `STATUS.md` and `HANDOFF.md`. Earlier source documentation in `docs/` remains authoritative where cited and has not been overwritten.