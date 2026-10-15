# Release process and publication gates

Every release requires an independently verified commit, an immutable evidence package and explicit signoff for data integrity, security, privacy and licensing. The current state is a synthetic developer preview and NOT_READY for public visibility or real accounting.

## Candidate workflow

1. Identify the authoritative Community branch and stop concurrent edits to overlapping files. Preserve original private V2 Git/data as a separate protected installation.
2. Verify the Git tree, ignored/generated outputs, commit metadata, object history, dependency sources and assets. No original private history may be transferred to the public candidate.
3. Complete the release-program acceptance matrix with exact passing/failing test inventories and reproduction instructions, never percentages from estimates.
4. Run full synthetic financial unit, integration, browser, negative, localization, migration, version upgrade, durability and fault-injection tests under clean supported environments.
5. Independently review privacy, source copyrights, third-party licenses, bundled binaries, generated assets and release archives. Scanners are necessary but insufficient.
6. Verify safe legacy migration, WAL/cross-store backup, staged activation, rollback and financial reconciliation on versioned fictional datasets. No real owner data without separate explicit authorization.
7. Prepare a reproducible private release artifact with hashes, SBOM, notices, supported platform list, CHANGELOG and release notes.
8. When an authenticated destination exists, verify the remote is private, ownership is correct, history is newly sanitized, branch protections and CI are configured, and hosted workflow checks succeed.
9. Record an independent final GO/NO-GO decision. Only after owner explicitly approves the final report may repository visibility be changed to public.

## CI/PR contract

Changes to stored schemas, identities, financial treatment, payment records and migration code require a migration-decision document and executable old/new synthetic fixtures. CI must fail closed for unresolved security, privacy, tax or migration defects. Do not mark required tests as skipped to pass a gate. Third-party archive downloads and built distributions must be scanned in addition to repository source.

## Rollback

An unsafe release candidate remains private and unpublished. A versioned release must preserve users' previous good dataset generation and perform a verified destination rollback on migration failure. Restoring an app dataset never authorizes new banking execution.

## Current blockers

Full financial workflows, complete legacy migration and backup/restore, full UI translations, independent asset/license ownership checks, clean-OS/cross-platform testing, hosted CI, private GitHub remote preparation, privacy signoff and final owner permission are not all complete.

For structured work packages and exact release evidence see docs/release-program/ and docs/RELEASE_STATUS.md.
