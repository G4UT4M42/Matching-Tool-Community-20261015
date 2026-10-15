# Matching Tool Community

Status: development candidate. PRIVATE_REPOSITORY_READY=false; SOFTWARE_ACCEPTED=false; RELEASE_ACCEPTED=false. Final exact-commit qualification, private CI and redistribution gates remain open.

Matching Tool Community is a local TypeScript/Express and React/Vite application for account-owned transactions, invoice evidence and reviewed financial reconciliation. It uses an isolated external data directory, local accounts and a loopback listener. A separate sanitized Git history excludes the original private repository ancestry.

## Supported development workflows

- First-owner setup, login/logout, workspace roles, password confirmation and session-bound CSRF.
- Sparkasse/Visa CSV/XLSX preview, explicit import, immutable source identities, duplicate/conflict detection and restart recovery.
- Document PDF/image upload, real offline English/German OCR, correction, explicit credit notes, confirmation, archive/retrieval and CSV/XLSX tables. Original hashes/bytes and append-only review evidence are retained.
- Exact matching proposals and manual review, accept/reject/reopen/undo, partial/split/refund/fee/transfer allocations and rational FX.
- Explicit private/excluded classifications and manageable bounded literal rules, exact per-currency reports, reviewed VAT evidence and CSV/JSON exports. See [accounting scope](docs/ACCOUNTING_SCOPE.md).
- User-configured encrypted PayPal/Stripe read-only API credentials, test/sync/history, stable verified account identities and recoverable historical coverage.
- Read-only Enable Banking AIS settings, separate SEPA preparation, transaction-bound approval and local simulated submission with durable claims and unknown-outcome handling. Automated tests never execute real transfers.
- Eleven assisted invoice-provider choices in fresh user-controlled browser sessions, explicit downloaded-file or unconfirmed receipt selection and durable document import. See [provider inventory](docs/feature-parity/INVOICE_PORTAL_INVENTORY.md) for exact scope and unqualified providers.
- Verified backups, staged restore, explicit owner-confirmed recovery into a new authentication workspace, supported synthetic V2 migration wizard, interruption rollback, and original-source preservation. Restored payment history remains read-only and unresolved outcomes still block duplicates.
- English default, selectable German, normal settings/dashboard/audit pages and role-specific controls.

Live provider acceptance is separate from software mock qualification. Actual bank payment initiation remains unavailable. All retained providers have controlled collection paths; actual login, regional document availability and supplier tax-invoice support remain provider-specific external qualification. AliExpress receipt images remain unconfirmed evidence. No unsafe legacy crawler is enabled. This candidate is not an accepted tax-filing or production bookkeeping release.

## Installation and development

A development package includes qualified Windows x64 Node22/ABI127, native modules, offline OCR languages and legal evidence. Follow [installation and maintenance](docs/INSTALLATION.md) for fresh install, independent data storage, first-owner setup, upgrade and safe uninstall. No global Node installation is needed for that package.

For source development, use the qualified Node22 runtime and frozen root/web dependencies:

```powershell
npm ci --ignore-scripts
npm rebuild better-sqlite3 sharp esbuild
npm ci --ignore-scripts --prefix web
npm run build
powershell -NoProfile -File scripts/Start-Community.ps1 -DataDirectory <absolute-independent-data-directory>
```

The launcher binds loopback and displays temporary first-owner setup authorization in its own console. Never copy setup codes, sessions, credentials or financial data into Git, logs or screenshots. Provider credentials are entered through their normal settings pages. A separate synthetic demonstration is available through `npm run demo:windows`; it cannot open an account-owned installation or execute transfers.

## Verification

Run `npm run typecheck`, `npm test`, `npm run privacy:check` and `npm run audit:production`. `scripts/run-community-tests.mjs app` and `node` enumerate actual test entrypoints and support unique external evidence manifests. The integrated acceptance defaults to a fresh real development-package installation; its explicitly labeled source iteration mode is not installation acceptance.

See [current status](docs/feature-parity/STATUS.md), [all 21 feature areas](docs/feature-parity/02_FEATURE_MATRIX.md), [migration policy](docs/MIGRATION_POLICY.md), [security](SECURITY.md) and [contribution policy](CONTRIBUTING.md). Every regression uses independent synthetic data. Preserve historical migration checksums, original source records and other agents' work.

## Source, licensing and release

The root MIT license is provisional pending verified first-party rights. [NOTICE](NOTICE), [SBOM/inventory](docs/compliance/README.md), [native/WASM source preparation](docs/compliance/NATIVE_SOURCE_PLAN.md) and [packaging contract](docs/compliance/PACKAGING.md) track third-party obligations. Original upstream notices remain unchanged. Source archives and public legal-text bundles stay external to the privacy-scanned source tree and may be supplied through hash-validated package supplements.

Three frozen native/WASM replacement builds and four source/SBOM supplements have independent engineering qualification in their recorded scopes. Ownership and final redistribution review remain separate gates; source-build proof does not assert historical binary reproduction or legal clearance. The builder creates development candidates only and refuses distributable mode. No public publication is authorized. A private source repository may be prepared after privacy/history checks; that milestone does not imply software or release acceptance.
