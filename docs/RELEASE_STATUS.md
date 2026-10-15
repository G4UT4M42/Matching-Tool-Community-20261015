# Release gate — Matching Tool Community

Status: **NOT_READY** for public publishing or use with real accounting records.

## Verified local development evidence — 2026-10-13

- Sanitized independent repository on branch `feature/community-app-port-20261013`, fresh history. Latest source hardening commits: `1d76b86` (source-port), `f3b9235` (patched qs), `ee69f3d` (license inventory), `78053dd` (preview filesystem/import endpoint protection). No remote configured.
- `npm ci --ignore-scripts` and rebuild of approved native dependencies: PASS under Windows / Node.js 22.
- `npm test`: **20/20 PASS** (15 migration, locale, policy tests and 5 API security-guard tests), using synthetic data.
- `npm run typecheck`: PASS for backend and frontend.
- `npm run build`: PASS. Vite warns about a 535.68 kB Javascript bundle. Performance optimization is not a security release certification.
- `npm run privacy:check`: PASS across 212 scanned Git candidate paths after guard additions. Automated screening is not independent privacy signoff.
- `npm run audit:production`: **0 advisories detected** by npm; SheetJS is fetched separately from the CDN and requires independent provenance/license/security review.
- English first navigation and locale switching are present. Most inner pages remain to be converted.
- Community preview HTTP is loopback-only with random per-launch token. External banking and payment routes are blocked; additional unreviewed folder/file access and OCR reexecution API paths are blocked.
- An offline synthetic V2 migration preview/staging adapter is tested; it does **not** implement full verified owner-data migration, skipped-release upgrades or activation.

## Public-source blockers

1. Independent full-tree privacy review (source, generated bundles, git objects, personal/company names, sensitive paths and license ownership), not merely regex scans.
2. Independent source ownership and third-party redistribution review; approve MIT copyright rights, NOTICE and SheetJS provenance. See `THIRD_PARTY_LICENSE_REVIEW.md`.
3. Financial security review beyond prototype guard: API authorization, path controls, file parsing limits, PDF/OCR, report semantics, cross-store atomicity, WAL backups and offline restore.
4. Versioned durable migration plus guided cutover/rollback covering real legacy V2 and newer version gaps, with full synthetic test matrix and supervised owner dry run.
5. Translate every public UI page through i18n and run locale/fallback/accessibility tests.
6. Full regression with generated fixture corpus covering import, matching, statuses, refunds, tax, payment locks and failure injection; current 20 checks are foundational smoke tests, not a full test suite.
7. Document and verify clean Linux/Windows installation, CI runner builds and branch rules; connect a private GitHub remote and run hosted checks.
8. Independent signoff and **explicit owner approval** for visibility/public release.

## Safety invariants

- Do not migrate private production bookkeeping data or legacy Git history into this repository.
- Do not run browser banking, production payment execution or migrations against real financial records during preview qualification.
- Do not push this project publicly while the gate is NOT_READY.
- Original V2 checkout stays untouched at `7d1dc9e` until owner-controlled production change approval.
