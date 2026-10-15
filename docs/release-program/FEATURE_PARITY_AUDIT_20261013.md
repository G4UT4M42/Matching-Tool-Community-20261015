# Feature parity audit — Local V2 vs Community

Audit date: 2026-10-13. Status: SOURCE INVENTORY COMPLETE, RUNTIME PARITY NOT QUALIFIED.
Source reference: protected local V2 Git tracked code ONLY. No production accounting records, credentials, attachments or live databases were accessed.
Community reference: feature/community-app-port-20261013 at 779753a and isolated integration at a2efaef. Revalidate HEAD before implementation.

## Summary

Most major source modules and all named React page modules are present in the Community source. This is **source presence**, not functional parity: the Community guard currently exposes only a narrow route allowlist, the demo contains four fictional transactions and two documents, many UI texts are not translated, and integrations/real import/payment execution are disabled. Complete V2-style usable workflows have not passed synthetic end-to-end qualification.

## Parity matrix

| ID | Functional capability | V2 evidence | Community evidence | Classification | Gap / acceptance | Priority |
|---|---|---|---|---|---|---|
| F01 | Transactions and dashboard | src/core/ingestion, web/src/pages/Transactions, Dashboard | source present; synthetic preview GET access | PARTIAL | import/review/edit/persist across restart on synthetic corpus | P0 |
| F02 | Bank CSV/XLSX import | src/import/bank-import, core/ingestion/sparkasse/visa, BankImport page | source present but /import routes denied | BLOCKED | input validation, dedupe, normalization, safe file limits, tests | P0 |
| F03 | PayPal and Stripe imports | src/import/paypal*, stripe*, core/ingestion/paypal, stripe | source present; provider imports denied | BLOCKED | offline file import first, mock API then authorized connectors | P0 |
| F04 | Document/invoice management | src/import/document-import, Rechnungen, Import | source present; upload/open routes denied | BLOCKED | local sandbox file import, hash, links, view, persistence | P0 |
| F05 | Automatic matching | src/core/matching/engine + rule modules | source present, limited preview routes | PARTIAL | full synthetic cardinality and confidence matrix | P0 |
| F06 | Manual matching and review queue | ManualMatch, Matches, Matching, ReviewQueue | source present and selected route access | PARTIAL | accept/reject/undo/restart/audit semantics | P0 |
| F07 | Refund/split/FX handling | paypal-refund, paypal-split, fx-usd-invoice, eust rules | source present | UNVERIFIED | signed cents, no double-count, deterministic proposals | P0 |
| F08 | Income/VAT reports and export | vat-report, income-tax-report, generate-report | accepted-evidence safety added; limited report routes | PARTIAL | owner-independent synthetic tax evidence, report reconciles | P0 |
| F09 | Exclusions and private transactions | Exclusions page, src/storage/disposition | source present; limited exclusion routes | PARTIAL | exclude, restore and report suppression tests | P1 |
| F10 | OCR and recognition | src/invoicerec modules, InvoiceRecognition | source present; OCR/import routes denied | BLOCKED | sandboxed PDF/OCR, limits, text extraction, adversarial fixtures | P1 |
| F11 | Invoice Bot/browser collection | src/invoicebot + portal adapters | source present; external browser actions disabled | BLOCKED | mock browser workflows and explicit credential/rights review | P2 |
| F12 | Payment candidates/SEPA | src/payments/candidates, sepa, validation, PaymentReview | source present; all payment routes disabled | BLOCKED | offline draft/preview validation; execution separately gated | P2 |
| F13 | Real George/bank payment execution | src/payments/browser/george-* | source present but disabled | INTENTIONALLY_EXCLUDED | explicit separate security approval; no release retry | P3 |
| F14 | Settings/integrations | Settings, src/storage/settings | source present; secret endpoints blocked | PARTIAL | safe nonsecret preferences; reconnection UI, authorization | P1 |
| F15 | Audit trail | src/observability/audit and AuditTrail | source present, selected read routes | PARTIAL | immutable event provenance and status decision coverage | P0 |
| F16 | Backup/restore | src/storage/backup, sqlite-online-backup | WAL-aware partial backup; online restore disabled | BLOCKED | multi-store quiescence, manifests, offline restore/recovery | P0 |
| F17 | Existing V2 data migration | src/migration/offline-v2 | preview staging and verification only | BLOCKED | all entity mapping, guided cutover, rollback, skipped versions | P0 |
| F18 | Persistence/version upgrades | SQLite/JSON storage | versioned Community baseline; incomplete upgrade graph | PARTIAL | future compatible migrations, attachments, interrupted upgrade | P0 |
| F19 | English/German UI | legacy page strings + new locale registry | main navigation localized; inner UI largely hardcoded | PARTIAL | complete page/dialog/error/a11y key coverage | P1 |
| F20 | Independent first-run installation | original local setup scripts | local Windows synthetic demo tested | PARTIAL | clean OS, end-user installer and functional private-data mode | P0 |
| F21 | Realistic demo and regression | legacy tests and assorted golden fixtures | small four-transaction demo | PARTIAL | seeded corpus for all workflows, reset and Browser E2E | P0 |

## Execution order to reach V2-style practical usability

**Wave A, P0: functional ledger without live bank execution.**
A1: source-to-route manifest and public API guard design; enumerate each endpoint method, data mutation and required scope.
A2: safe sandboxed offline bank, card, PayPal and Stripe file imports (not remote logins).
A3: invoice/document import and local review sandbox; repair file permissions, hashes, staging, persistence.
A4: matching lifecycle, manual reconciliation, refunds, splits and ledger invariants; preserve proposal vs acceptance.
A5: tax/income reporting and exports with reviewed evidence rules, no unsupported deductions.
A6: full synthetic user journey through browser and restart; disallow payment execution.

**Wave B, P0: durable migration and upgrade.**
B1: classify complete legacy persisted source format using synthetic replica; no owner data.
B2: cross-store WAL-safe coordinated quiescent backup with attachments and recovery.
B3: portable versioned adapter, exact identities, audit and payment-history mapping, reconciliation.
B4: guided UI staging/preview/owner confirmation/atomic destination activation and rollback.
B5: skipped-version and crash-injection upgrade matrix; prove source remains immutable.

**Wave C, P1-P3: remaining V2 capabilities.**
C1: OCR/PDF/file limits, vendor rules, receipts and document extraction.
C2: all English UI text, German mapping, locale E2E/accessibility.
C3: expanded seeded offline fixtures, Windows clean install, docs and release CI.
C4: optional browser invoice providers and actual payment execution only with independent security review and owner authorization.

## Definition of functional parity

A function is NOT complete because files exist or TypeScript builds. For each Fxx:
1. Identify the corresponding V2 UX action and API/storage effect through code inspection.
2. Generate independent fictional input files and expected integer-minor-unit results.
3. Exercise Community browser/API and compare output to independently specified accounting invariants.
4. Test invalid input, idempotent replay, interrupted operation, restart and state recovery.
5. Verify authorization, privacy, payment lock and resource limits.
6. Attach exact command, hash, branch/commit, reproducible fixture and test evidence.
7. Mark PASS only when every mandatory case succeeds.

## Release limitations

No live banking, owner data migration or payment action is authorized. Public GitHub exposure remains blocked by separate privacy, ownership/license and owner final approval gates. Existing remediation and production worktrees must not be reset or overwritten. Review concurrent agent work before implementing overlapping files.
