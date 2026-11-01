# Matching Tool

**Local-first bookkeeping and reconciliation for simple accounts and complex financial systems.**

Matching Tool brings transactions, receipts, invoices and related money movements into one workspace. It helps connect the economic event behind a payment across bank accounts, cards, PayPal, Stripe, fees, refunds and currencies, while keeping the original evidence and a reviewable history.

The long-term goal is **99% automated bookkeeping, through to country-specific tax return preparation and filing**. Significant parts of importing, document recognition and matching already run automatically. The full end-to-end goal remains in development: official tax return generation and filing are not currently implemented, and no measured 99% automation rate is claimed.

This repository contains the Community edition of the tool. It is a **development preview**, with an isolated synthetic demo, rather than a certified accounting or tax-filing product.

## What it does

| Area | Current capabilities |
| --- | --- |
| Multiple accounts | Supported bank/card CSV and XLSX imports, account-aware reconciliation and multiple currencies. Supported source formats include Sparkasse and Visa. |
| Payment providers | User-configured read-only PayPal, Stripe and Enable Banking AIS integrations. Provider availability and account permissions depend on the provider and your own configuration. |
| Complex money flows | Reviewable matching for partial and split payments, processor fees, refunds, chargebacks, payouts, own-account transfers and exact foreign-currency allocations. A bank payout or transfer is not automatically counted as new income. |
| Receipt recognition | Local offline English/German OCR for PDFs and images, extracted field suggestions, preserved originals and hashes, and explicit document review. |
| Invoice collection | Eleven assisted portal choices. You sign in and download the invoice in a separate browser session, then explicitly select documents for import. This is not an unattended account crawler. |
| Reconciliation | Automatic matching suggestions, manual allocations, accept/reject/reopen decisions, private/excluded classifications, bounded rules and undo. |
| Reports | Period-based reconciliation, separate currency totals, reviewed VAT evidence, and CSV/JSON exports. Reports currently remain jurisdiction-neutral. |
| Payment preparation | SEPA XML preparation and local simulated payment workflows. Actual bank payment submission is disabled. |
| Control and recovery | Local user accounts and roles, audit history, protected provider credentials, backups, staged restores and explicitly supported migration paths. |

The assisted invoice portals currently include Amazon Business, OpenAI Platform, ChatGPT, Google Cloud, Spotify, Fiverr, Google purchases/Google One, two Austrian Post services, Bambu Lab EU and AliExpress. Portal login and MFA remain user-controlled. An AliExpress screenshot is explicitly unconfirmed receipt evidence, not automatically a tax invoice. See the [portal inventory](docs/feature-parity/INVOICE_PORTAL_INVENTORY.md).

For financial semantics and limitations, see the [accounting scope](docs/ACCOUNTING_SCOPE.md), [feature matrix](docs/feature-parity/02_FEATURE_MATRIX.md) and [financial-data safety guidance](docs/FINANCIAL_DATA_SAFETY.md).

## Try the demo

The Windows demo creates an isolated workspace with **17 fictional transactions, 13 documents and six source/account combinations**. It does not open an existing personal workspace or connect to real accounts. Matching decisions can be explored; additional views show the stored synthetic accounts, documents, reports and payment drafts.

After installing the development dependencies and building the frontend:

```powershell
npm run demo:windows
```

The launcher prints the local address and access token. English is the default; German is available. The interface has help text and tooltips, but a guided onboarding tour is not yet implemented. See the [demo contract](docs/feature-parity/DEMO_CONTRACT.md).

## Build from source

Use **Node.js 22**, with the root and frontend lockfiles. The current qualified environment is Windows x64 with Node 22.23.3. Other platforms and a pristine Windows installation are not certified by this source preview.

```powershell
git clone https://github.com/G4UT4M42/Matching-Tool-Community-20261015.git
cd Matching-Tool-Community-20261015
node --version
npm ci --ignore-scripts
npm rebuild better-sqlite3 sharp esbuild
npm ci --prefix web --ignore-scripts
npm run build
npm run demo:windows
```

For a separate normal workspace:

```powershell
powershell -NoProfile -File scripts/Start-Community.ps1 -DataDirectory 'C:\MatchingToolData'
```

The launcher provides a temporary setup code for creating the first local owner. Use a new data directory outside the source checkout. Do not point a preview installation at an existing accounting dataset. Follow the [installation guide](docs/INSTALLATION.md), [configuration reference](docs/CONFIGURATION.md), [backup/restore guide](docs/BACKUP_AND_RESTORE.md) and supported migration documentation before moving existing records.

The application binds to loopback by default. OCR and bookkeeping processing run locally; configured provider integrations and invoice portals require network access. Account permissions and user consent remain necessary.

## Checks

```powershell
npm run typecheck
npm test
npm run privacy:check
npm audit --audit-level=high
npm audit --prefix web --audit-level=high
```

Tests use synthetic financial data. Complete browser/installation journeys require the documented Windows environment and browser prerequisites. See [testing](docs/TESTING.md), [development](docs/DEVELOPMENT.md) and [architecture](docs/ARCHITECTURE.md). Historical reports qualify only their recorded revisions; current verification results are available in GitHub Actions.

## Feedback and contributions

Feedback, bug reports, improvements, documentation and translations are welcome. **Country-specific reports, tax formats and accounting adaptations are especially useful contributions.** Include the jurisdiction, applicable period, an authoritative public reference and fictional test cases for any proposed tax treatment.

The roadmap includes deeper automation, guided onboarding and reviewed country-specific tax workflows. Tax filing is a future objective, not a current capability.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. Use fictional examples in issues and pull requests; never attach real invoices, account exports, credentials or browser sessions. Report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

The original application code is licensed under [MIT](LICENSE). Third-party dependencies retain their respective licenses; the root MIT license does not relicense them. See [NOTICE](NOTICE), the [third-party components](THIRD_PARTY_COMPONENTS.md), the [license decision](docs/LICENSE_DECISION.md), [source-publication review](docs/compliance/PUBLIC_SOURCE_REVIEW.md) and [dependency documentation](docs/compliance/README.md).

This publication covers the source repository. Prepared Windows installers, bundled runtimes and native/WASM replacement archives have separate distribution requirements; they are not released by making this repository public. See the [source plan](docs/compliance/NATIVE_SOURCE_PLAN.md), [packaging contract](docs/compliance/PACKAGING.md) and [release process](docs/RELEASE_PROCESS.md).
