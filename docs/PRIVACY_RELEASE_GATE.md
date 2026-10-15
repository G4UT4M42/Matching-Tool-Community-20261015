# Public-source privacy and redistribution release gate

**Policy:** No legacy Git history. No copied original `.git`, source financial document, bank/account credentials, personal identifiers, browser profiles, archives, session logs or private runtime state. An empty `.gitignore` check is never enough: tracked text files can contain confidential information.

## Review every category before copying
- SQLite, WAL, JSON state, original transactions/CSV/XLSX, source statements, fee reports, exported tax/PDF reports: **exclude**.
- `Belege/`, invoice scans/PDFs, photographs, OCR temp images, downloaded invoice collections: **exclude**.
- Real customer/company/person names, addresses, emails, phone numbers, IBANs, tax IDs, seller aliases, issuer IDs, filenames, payment references: replace only with **fully generated fictional data**; no line-by-line substitution of original records.
- Tokens/API keys, OAuth credentials, passwords, .env files, browser cookies, screenshots, profiles, command history: **exclude** and rotate known exposed secrets through an owner-approved process.
- Proprietary code/assets/fonts/xsd licenses/third-party binaries: inventory licensing and permission to redistribute; unclear terms block release.
- Operational scripts with personal domains, endpoints, user paths, personal business rules: generalize or omit, review diffs.
- Logs, test snapshots, debug output, source maps: inspect for paths and secrets; no real user information.
- Git commits/branches/tags/LFS/blob objects: **fresh git init only**; scan all commits and staged content before push.

## Synthetic-only demonstration data
Generate from scratch with an explicit seeded program. Use invented fictional business names and `example.com` domains, fake bank-driver identifiers, non-routable account placeholders and scenario-specific cents/dates. Cover duplicate imports, split expense, PayPal funding versus refund, two same-amount invoices, unsupported VAT rate, cash expense, FX, chargeback and unknown payment state. Never shuffle or anonymize real records: reidentification from amounts/dates/descriptions remains possible.

## Public release steps
1. Create a separate, non-synced directory and initialize a new Git repository without original history.
2. Prepare a strict source inclusion manifest, review each imported path, run content-aware privacy/secret scanners and remove or rewrite private assumptions.
3. Build/test with generated synthetic data and non-networked bank drivers.
4. Audit dependency vulnerabilities and all third-party licenses; select project license explicitly.
5. Check every tracked file, new Git object and generated release artifact (including sourcemaps and docs) for private tokens and identities.
6. Add install/recovery/security docs, automated CI, migration gate, license and independent review.
7. Create private remote only; public visibility requires final owner authorization **after** a published-tree privacy report and security signoff.

Any unresolved privacy finding, unsafe public API, missing migration adapter or failing financial-integrity case is **NOT_READY**.
