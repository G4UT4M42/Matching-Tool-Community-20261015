# Synthetic offline staging admission — historical qualification record

Historical scope note (2026-10-16): this record describes the isolated 2026-10-13 staging preview. Its unavailable-backup/migration statements below apply to that snapshot, before the later Community canonical backup, restore and owner-reviewed migration implementation. Current contracts and candidate qualification are recorded in [persistence implementation](feature-parity/persistence-implementation.md) and [current status](feature-parity/STATUS.md). This note does not promote release or software acceptance.

Date: 2026-10-13
Scope: isolated Community release-preparation branch, synthetic fixture datasets only.
Publication state: NOT_READY.

## Changes

- Reject unmapped SQLite tables and credential-bearing columns before staging.
- Reject credential-like structured JSON metadata found in reviewed SQLite metadata columns.
- Admit only explicitly classified local preference settings and constrained values; other settings block import.
- Redact mixed-case and separator-varied auth/secret keys in JSON state and approved settings rows.
- Reject prototype-modifying JSON keys and duplicate match-group/reservation memberships.
- Preserve source-event identity, signed minor-unit totals, invoice hashes and proposal status on the supported synthetic fixture.
- Keep bank/payment actions and stage activation disabled.
- Verify the staged SQLite database, JSON state, declared files, document hashes and minor-unit reconciliation before reporting a checked candidate.
- Reject stray files, path traversal and altered activation flags; the stage CLI now verifies after copying.

## Locally reproduced checks (Windows, Node 22.16.0)

- `npm test`: 25 policy/migration tests plus 5 API guard tests PASSED (30 total) after adding stage-verification regression coverage.
- `npm run typecheck`: PASSED backend and frontend.
- `npm run build`: PASSED; a 535.68 kB JavaScript chunk generated a performance warning.
- `npm run privacy:check`: PASSED for 217 candidate Git files; scanner evidence only, not independent signoff.
- `npm run audit:production`: npm reported zero advisories. The out-of-band spreadsheet library and bundled assets require separate provenance/license review.
- 13 offline import and candidate verification unit tests passed; ten are new adversarial and regression cases.

## Operator-only synthetic verification

After a staged synthetic import, re-check it using `node scripts/verify-offline-stage.mjs --stage SYNTHETIC_STAGE_FOLDER`. Passing is verification of this preview manifest only; it never activates financial data.

## Unresolved release blockers

This is not a certified legacy-data importer. Source write-quiescence is not verified, cross-store atomic backup and recovery remain unavailable, historical version-to-version migrations and owner-reviewed activation are not implemented, and opaque SQLite content requires an independent classification pass. No real records were read or copied. Keep the public and production approval gates closed.
