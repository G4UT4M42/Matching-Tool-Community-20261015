# Development workflow

## Local setup

Follow INSTALLATION.md using Node.js 22.x and a sanitized checkout. Use npm ci at the repository root and again with --prefix web to ensure dependency versions match the lock files. Do not reuse native modules built for Node.js 24.

## Source layout

Backend service: src/server. Economic invariants and matching: src/core. Versioned SQLite/JSON stores: src/storage and src/migrations. Offline staging: src/migration. React UI: web/src. Tests: tests. Privacy gates: scripts. Release program and compatibility decisions: docs.

## Quality checks

Run the complete npm test suite, backend/frontend typecheck, production build, privacy scan and production dependency advisory audit for every significant change. On Windows, run tests/demo-launcher-guard.tests.ps1. An isolated synthetic loopback HTTP test must confirm working end-to-end behavior; compilation alone is insufficient.

No test fixture may be copied or pseudonymized from an actual bank statement, invoice or production accounting database. Generate records from scratch. Tests must check acceptance versus proposals, signed integer totals, status transitions, rollback, attachments and unauthorized finance actions.

## Contract changes

Before modifying storage schemas, state serialization, source identities, payment history, matching rules or reporting behavior, create a migration-decisions Markdown record. See MIGRATION_POLICY.md. Incompatible changes need executable ordered migrations, synthetic old/new fixtures, integrity validation and rollback guidance. Never change the historical treatment of real tax records silently.

## Git hygiene

Use an isolated worktree and feature branch for concurrent development. Check git status and active worktree ownership before modifying files. Explicitly stage named paths, inspect staged diffs and run the privacy scanner on staged content. Do not import Git history from the private owner-operated V2 repository. Do not force-push or overwrite another agent's work.

## Contribution boundaries

No external payment, bank automation or live legacy import should be enabled without new human-reviewed security controls and financial test evidence. Critical financial or security test failures cannot be skipped to obtain a green CI result. A local green test run is not authorization to publish.

See CONTRIBUTING.md, SECURITY.md, RELEASE_PROCESS.md and the release-program acceptance matrix for required reviews.
