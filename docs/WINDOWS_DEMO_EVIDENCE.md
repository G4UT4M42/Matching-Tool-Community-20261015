# Windows first-run and synthetic HTTP qualification

Date: 2026-10-13.
Reference device: <target-host>, Windows PowerShell 5.1, Node.js 22.16.0.
Publication state: NOT_READY. No real financial data used.

## Root causes and corrections

1. The original demo startup script depended on a hard-coded user-local nvm Node executable, blocking ordinary Windows Node 22 installation. The launcher now detects supported Node 22 on PATH and uses the local fallback only if available.
2. Path.IsPathFullyQualified and RandomNumberGenerator.Fill were incompatible with Windows PowerShell 5.1. Replaced with compatible runtime-path validation and cryptographic RNG.
3. Isolated, name-validated synthetic profiles are now supported; unrecognized databases without approved synthetic state refuse startup. No arbitrary source directory is accepted.

## Reproducible evidence

- The actual launcher started the synthetic demo bound to 127.0.0.1 and initialized four fictional transactions; its own identified test server was subsequently stopped.
- The Node HTTP smoke test checked unauthenticated API response 401; token-authenticated API response 200; UI HTTP 200; sample transactions; forbidden payment action response 403; persisted SQLite and JSON data; and successful restart with unchanged synthetic transactions.
- Windows PowerShell 5.1 guard tests passed: path-escape profile names are refused and a fabricated unrecognized database remains unchanged.
- A fresh clone with independently installed npm dependencies passed build and 40 policy/API tests before the latest SQLite baseline was integrated. Current-HEAD fresh-install qualification must be repeated.

## Remaining blockers

Complete financial workflows, bank connectors, version-to-version migration, safe cross-store backup/restore, full English/German UI, additional clean operating system testing, hosted CI, and independent privacy/security/licensing reviews have not passed release qualification. This is not a stable financial application.
