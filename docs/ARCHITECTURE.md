# Architecture and trust boundaries

Matching Tool Community is a TypeScript/Node.js Express service with a React/Vite browser frontend. The current release is a local synthetic-data developer preview, not a production-finance application.

## Logical components

- src/server/index.ts: loopback-only HTTP startup, per-launch access token guard, synthetic startup dataset, and safe API route allowlist.
- src/server/community-guard.ts: constant-time token comparison, localhost host and origin checks, method-specific route allowlist; unreviewed payment, real import, file and remote browser actions are disabled.
- src/core: transaction normalization, exact/heuristic matching proposals, document associations and financial-report eligibility.
- src/storage: mapping of application-specific runtime paths, SQLite persistence, atomically replaced JSON state.
- src/migrations: versioned Community SQLite/JSON baseline with explicit incompatibility rejection.
- src/migration: preview-only legacy V2 offline staging, conservative schema/credential gate and staged-manifest verification.
- web/src: interactive local browser app and English/German translation registry.
- tests: synthetic regression, HTTP access/persistence, accounting evidence, migration, privacy and Windows startup qualification.

## Persistence boundary

An external runtime root holds independent database, state, attachments, imports, exports, backups, logs, cache and temporary directories. The development checkout must never serve as a finance data directory. SQLite is operated with WAL and version verification; JSON writes are temporary-file-and-rename based.

These mechanisms DO NOT make SQLite, JSON state, invoices and audit records one atomic transaction. There is no fully certified cross-store snapshot, generation journal, or validated online restore. Any future backup/export activation must either obtain a consistent write-quiescence epoch or refuse to claim data consistency.

## Financial invariants

Use signed integer minor units for money; maintain immutable source-event IDs and document SHA-256. A proposed match is never silently converted into an accepted record. Reports require approved economic evidence and sufficient VAT facts; unknown tax status remains subject to review. Bank release states UNKNOWN/CLAIMED must not trigger an automatic repeat.

## Trust boundary

The browser is not a trusted local administrator merely because it can load the static UI. Finance API requests require the local session token; token possession does not grant access to disabled routes. Loopback-only binding is intentional. No multi-user identity, encrypted remote session, or network sharing mode has been approved.

The legacy V2 program and its real financial data remain strictly separate, never imported into this Git history. The currently supported offline adapter does not activate a staged dataset. Full migration must be implemented and independently audited before real-world use.

## Extension requirements

A new API route requires positive method/path permission, authorization and negative-security tests. A new financial state field requires a migration decision, versioned forward mapping, old/new synthetic fixtures, failure recovery and a preservation check. A new integration requires reviewed permissions, source provenance and no automatic payment execution.
