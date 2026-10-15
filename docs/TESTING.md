# Testing and evidence

## Test commands

From the Community checkout using Node.js 22:

~~~powershell
npm test
npm run typecheck
npm run build
npm run privacy:check
npm run audit:production
~~~

On Windows PowerShell 5.1, also run:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/demo-launcher-guard.tests.ps1
~~~

## Existing automated coverage

- Tests for localization defaults, fallback and display-only money formatting.
- Git pull-request migration-policy failure/success gates and privacy/secret scanner behavior.
- Synthetic offline legacy V2 staging, credential rejection, hash manifests, attachment link integrity, unknown table blocking and tampering checks.
- Baseline versioned SQLite and JSON state persistence, corruption/future-version refusal and synthetic restart.
- Accepted-match reporting evidence and route authorization.
- Real HTTP loopback synthetic demo boots, rejects unauthenticated requests and payment endpoints, serves the UI, preserves transactions over restart and validates demo-only modes.
- Windows launcher refuses invalid profile paths and preexisting unfamiliar database files.

## Reproducibility

Run on a clean checkout with independent dependency installation. On Windows native dependencies must be built for the selected Node 22 ABI. Store the exact commit, platform, Node version, test count and failure output in release evidence. Never upload full financial state or authentication headers to CI logs.

## Required but missing qualification

Realistic CSV/XLSX/PDF import workflows, all matching cardinalities, multicurrency, VAT/tax edge cases, user-visible migration wizard, cross-store backup/restore, disk-full/crash injection, mobile/browser accessibility matrix, repeatable clean-OS installation, performance/resource endurance, and owner-supervised legacy migration are NOT fully qualified.

The existing tests are foundational. Do not infer safe financial operation from a green synthetic smoke suite. Any unresolved integrity, credential or external payment defect blocks stable release.
