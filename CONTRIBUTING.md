# Contributing

Feedback, bug reports, improvements and translations are welcome. Security and accounting integrity take priority over convenience.

## Mandatory pull-request obligations
1. Describe the user-visible behavior, data structures affected, and privacy/security impact.
2. Run the full isolated test suite with **synthetic data only**, including negative cases and interruption/restart cases for financial operations.
3. Do not introduce identities, IBANs, credentials, screenshots from real accounts, production databases or original ledger documents into code, fixtures, issue attachments or test logs.
4. For any changed persisted contract (SQLite, JSON, files, entity references, accepted/proposed match meaning, payments, audit history), add `docs/migration-decisions/<id>.md` in the **same PR**. Declare `Migration-Required: yes` or `Migration-Required: no` with explicit reasons.
5. If migration is required, include executable **forward migration** code, fixture snapshots for old and new versions, duplicate/restart tests, per-currency and per-period reconciliations, document hash checks, match-link validation and a rollback procedure.
6. A migration must be idempotent, resumable after interruption, fail closed on unsupported/newer data, and must not rewrite the original installation in place.
7. Payment execution state must never be migrated into a runnable release operation. Preserve UNKNOWN and PENDING as locked history; reconnection of bank credentials requires a separate owner action.
8. Changes to critical accounting/security/payment logic require independent review and evidence. CI must enforce the migration-policy check as a required protected-branch status.

## Compatibility contract
Keep stable identity references whenever possible. Where an ID must change, retain a bijective audited mapping and verify **all** incoming/outgoing links. The importer must preserve both technical PROPOSED and final ACCEPTED states without silently upgrading status. Retain original evidence and audit provenance; never declare reconciliation complete solely from matched counts.

## Languages
All user-facing strings must be represented by translation keys. The default locale is `en`; new locales must provide a fallback-safe catalog and at least one locale-switch test.

## Before asking for review
Run `node scripts/check-migration-pr.mjs --base <base-git-ref>` once application source is integrated. Attach test evidence, dependency/license review and a summary of any risks. A green script does not replace code review.

Never run integration tests against live banking, user data, or externally exposed HTTP without explicit owner-controlled authorization.

## License and provenance

Submit original contributions under the project's [MIT license](LICENSE).
Only contribute material you have the necessary rights to publish. Identify
third-party code or assets, their original source and license; retain required
copyright and permission notices. Do not assume that a public code snippet is
unrestricted. Unclear rights must be resolved before merge.

## Country-specific reports and adaptations

Country-specific accounting reports, tax formats, translations and workflow
adaptations are welcome. Describe the country/jurisdiction, reporting period,
supported taxpayer or business scope and authoritative public requirements.
Provide independently calculated synthetic expected results, including
rounding, currency, credit-note and missing-evidence cases. Make unsupported
cases explicit rather than silently guessing a tax treatment.

Existing reports are jurisdiction-neutral. Official tax-return generation and
filing remain roadmap work; a contribution should identify precisely which
part it implements and tests. Never attach actual tax returns or financial
records as examples.
