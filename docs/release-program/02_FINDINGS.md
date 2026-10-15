# Findings register

Reviewed 2026-10-13, using the private, isolated Community candidate. Treat provisional findings as hypotheses until reproduced.

| ID | Severity | Verified finding | Disposition |
|---|---|---|---|
| F001 | Release blocker | `docs/RELEASE_STATUS.md` identifies preview-only features and eight unresolved categories. | P01-P14 OPEN |
| F002 | P1 privacy | The original public-tree scanner hard-codes owner-specific markers inside its own distributed source and exempts its own rule definitions from scanning. A green scan is insufficient for independent privacy approval. | P01-B remediation |
| F003 | P0 migration | Legacy V2 importer is staging/preview only: no destination activation, rollback UI, skipped-version upgrade, or full data contract verification. | P06 OPEN |
| F004 | P1 security | Community API uses a token and denylist for known dangerous paths, but no positive allowlist or comprehensive route-by-route permission audit exists. | P03-A OPEN |
| F005 | P1 persistence | `src/storage/db.ts` uses opportunistic `CREATE IF NOT EXISTS` and `ALTER TABLE` rather than a complete versioned migration ledger; JSON schema has no verified multi-version registry. | P05-A OPEN |
| F006 | P1 completeness | English is limited to navigation and a few strings; most inner React pages are not translated. | P07 OPEN |
| F007 | P1 QA | 20 existing tests are foundational; they do not establish financial reporting, import, browser E2E or backups. | P04/P10 OPEN |
| F008 | P1 licensing | `xlsx` fetched as a separate hosted tarball; bundled schemas/assets and source ownership not fully approved. | P02 OPEN |
| F009 | Environment | A shell selected Node 24 (ABI 137), while the existing better-sqlite3 native module and project target Node 22 (ABI 127). Using Node 22.16.0 and a populated ComSpec allowed policy tests to pass. | Toolchain isolated, test environment documented |
| F010 | P2 maintainability | Vite reports a >500 kB JS output chunk. Security is not affected directly; split after correctness/security tasks. | Deferred |
| F011 | P1 importer safety | The staging importer removes key-named credentials from state and settings but does not prove that arbitrary SQLite text/JSON/blob columns or evidence are credential-free. | P06 source-content exclusion review required |
| F012 | P1 release | No remote GitHub destination configured. Public push is prohibited pending independent checks and owner approval. | P14 OPEN |

No sensitive values are reproduced in this register. Actual financial correctness, privacy clearance, or legal rights have **not** been certified.