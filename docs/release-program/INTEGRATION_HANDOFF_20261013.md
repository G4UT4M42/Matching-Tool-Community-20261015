# Isolated integration handoff — 2026-10-13

**Release decision: NOT_READY. Public visibility change forbidden pending independent review and owner authorization.** This file records locally demonstrated synthetic-only work; no protected finance records were read or modified.

## Branches and ownership

- Primary development branch: feature/community-app-port-20261013. Another agent is actively editing its own worktree. Never overwrite its uncommitted files.
- Verified integration branch: integration/community-security-20261013. The private, separate worktree is intentionally isolated from the primary agent.
- Isolated legacy guard branch: fix/community-offline-stage-guards-20261013, source commits ccb83a7 and 7eed336.
- Combined commits in integration: a3007c0 (legacy schema/credential screening), b9c3e8f (stage manifest verification), 4fc65e5 (migration decision path separation), c73f93c (merge versioned SQLite bootstrap), af1fefb (Windows first-run and real HTTP smoke), e14211a (merge versioned JSON baseline), be87c93 (documentation).
- Later integration changes must be explicitly committed and tested before cherry-picking/merging into the primary branch.

## Implemented in the isolated branch

- Early rejection of unclassified SQLite tables/columns and credential-bearing JSON fields or settings; duplicate match membership and unsafe JSON object keys rejected.
- Synthetic offline staging verifies artifacts, SHA-256, source document links, SQLite integrity and signed minor-unit summaries before reporting success.
- Staged data can NEVER be activated by this code; bank/payment execution is disabled.
- Windows PowerShell 5.1 launcher compatibility, Node 22 PATH discovery, synthetic named profiles, unknown database and junction refusal.
- Real loopback authenticated/unauthenticated HTTP and restart/persistence tests, including payment routes refused.
- Full overview documentation for architecture, installation, configuration, development, testing, financial safety, legacy staging, backup/restore limitations, localization and release.

## Exact local checks

- On combined e14211a: 29 Node policy/migration tests + 22 Vitest tests + 2 real HTTP smoke tests = 53/53 PASS.
- Backend/frontend typecheck PASS. Production Vite build PASS with a nonblocking 535.68 KB bundle warning.
- Generic privacy gate PASS on 243 candidate files before the final documentation commit. Independent manual and owner-specific screening NOT yet passed.
- npm production advisory audit reported zero findings; CDN SheetJS and every asset/binary still require independent provenance/licensing review.
- Windows launcher negative guard test: 2 scenarios PASS (invalid profile path and unfamiliar SQLite database unchanged).
- Earlier clean Git clone with independent npm ci root/web installation, build, 40 tests and privacy scan PASS on the prior pre-SQLite combination. Repeat on the final integrated HEAD for release evidence.

## Open blockers (do not claim success)

- P01: independent manual/source-object/generated-asset privacy audit and owner-specific blocklist review.
- P02: original-source copyrights and complete dependency/transitive/asset redistribution rights review, including CDN sheet library.
- P03/P04: complete API security and financial correctness through all real import/reporting workflows.
- P05: coordinated consistent SQLite/JSON/filesystem backup and safe staged restore.
- P06: versioned full real legacy importer, user-visible wizard, quiescence, migration ID ledger, interrupted restart, full relationships and rollback.
- P07/P08: full English/German UI and comprehensive synthetic demonstrator.
- P09/P10: clean operating system installation, browser/mobile interaction, broad financial import/reporting/corruption/fault-injection qualification.
- P11/P12: reconcile concurrent documentation changes, hosted CI checks, release archive provenance and branch protections.
- P13/P14: independent release review, private remote preparation, release candidate approval; public GitHub visibility requires separate explicit owner signoff.

## Safe continuation

1. Inspect the primary branch's HEAD, uncommitted files, active processes and worktree ownership. Another agent was making P11/P12 changes while this integration was validated; do not overwrite or force-reset any worktree.
2. Diff newly committed primary changes against this integration. Merge only after resolving overlapping package scripts and documentation, preserving both E2E HTTP tests, SQLite/JSON migrations and staged security gates.
3. Repeat Node 22 full test, typecheck, build, privacy scanner, independent license review and new clean installation on the final reconciled commit.
4. Add exact test evidence to the authoritative release status, without marking any unqualified phase done.
5. Do not run real legacy import, payment, banking, source mutation or public push. All future data changes require reviewed migration decisions.

**Important:** A passing synthetic smoke suite and a provisional MIT file are not authorization to publish or process real financial records.
