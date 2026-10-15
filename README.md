# Matching Tool Community

**Status: Developer-preview candidate — NOT approved for public publication or real bookkeeping.**

Matching Tool Community is an English-first, local-first application for reconciling transactions, invoice evidence and reviewable matching decisions. It combines a TypeScript/Express backend and a React/Vite web UI. A completely separate new Git history protects the owner's earlier private accounting repository.

## What currently works

- Local synthetic demo with 4 invented transactions, 2 document records and 2 matching groups.
- Loopback-only web server; random session access token; no anonymous finance API.
- Basic transaction/matching views and English main navigation.
- English and German language selector with fallback support; **many inner pages are not yet fully translated**.
- Synthetic preview of a versioned offline import of a legacy V2 accounting dataset.
- WAL-aware SQLite staging, JSON/link reconciliation, attachment SHA-256 checks and credential removal **without activating the result**.
- Automated Node/Vitest unit, privacy, migration and security smoke tests.

## Disabled until separately verified

Real banking connections, payment initiation/release, browser invoice collection, external API import, live backup restore/delete, automatic production migration and activation. The program must not be used for bookkeeping or tax filing at this stage.

## Quick start (Windows)

Requires Node.js 22, npm, and PowerShell.

```powershell
npm ci
npm ci --prefix web
npm run build
npm run demo:windows
```

The launcher creates an **external local demo runtime** under the current Windows user's local application data, starts an HTTP server only on `127.0.0.1`, and prints a new random access token in its own local terminal. Open the displayed URL and enter that token in the browser unlock form.

Stop the demo normally with Ctrl+C and verify its own server has exited after an abnormal termination. Do not store the generated token in Git, issues or screenshots. The launcher supports Node.js 22 on PATH and an optional separate synthetic profile (for example `-DemoProfile SeparateTest -Port 3434`); it refuses unknown existing databases and storage junctions.

For source development, `npm run typecheck`, `npm test`, `npm run privacy:check` and `npm run audit:production` run the respective quality gates. Bank drivers are always disabled in the preview. The test suite also performs a real synthetic loopback HTTP start/restart test. For Windows-specific negative startup checks, run `powershell -NoProfile -ExecutionPolicy Bypass -File tests/demo-launcher-guard.tests.ps1`.

See [Windows installation and troubleshooting](docs/INSTALLATION.md) and [first-run synthetic test evidence](docs/WINDOWS_DEMO_EVIDENCE.md).

## Migration contract

Future users must be able to upgrade across supported versions without losing transactions, source event IDs, invoice bytes/hashes, match-group references, approval states, audit events or payment history. Schema changes require a versioned migration with synthetic old/new fixtures and rollback evidence in the **same pull request**.

Offline staging is implemented as a tested foundation, **not as a complete production importer**:

```powershell
node scripts/import-legacy-v2.mjs --source SYNTHETIC_SOURCE_FOLDER --destination EMPTY_NEW_FOLDER --source-offline-confirmed
```

The command above performs a dry run. Adding `--stage` writes a separate candidate but never activates it. The original dataset is never modified. **Do not run this against a real installation until the importer, all version edges and the independent financial review have been qualified and approved.** Banking sessions and raw API credentials are deliberately excluded.

See [Migration policy](docs/MIGRATION_POLICY.md), [Offline V2 import contract](docs/LEGACY_IMPORT_SPEC.md), and [Migration decisions](docs/migration-decisions/).

## Contribution policy

Follow [CONTRIBUTING.md](CONTRIBUTING.md). All demo and regression data must be fictional and generated from scratch. Never upload customer invoices, bank numbers, access credentials, browser sessions, real account screenshots or old Git history. Pull requests changing financial persistence must provide complete migration evidence.

The public source tree is subject to automated privacy and npm advisory scans, but those do **not** substitute for independent security, licensing and financial correctness reviews.

## License and release

A provisional [MIT license](LICENSE) is present for owner-authored original code. Third-party redistribution rights and source provenance must be verified before the repository is made public. Austrian SEPA XSD bundles are intentionally excluded pending licensing review.

See [Release status](docs/RELEASE_STATUS.md), [Privacy gate](docs/PRIVACY_RELEASE_GATE.md), [Security](SECURITY.md), and [Localization policy](docs/I18N_POLICY.md).

**No public GitHub release or stable migration is currently authorized.**
