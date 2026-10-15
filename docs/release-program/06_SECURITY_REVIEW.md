# Security review - preliminary

**Security boundary:** the preview runs on a loopback HTTP listener and an isolated runtime root. Local processes/users, untrusted imported PDFs/ZIPs/spreadsheets, browser origins and optional external banking code remain threat surfaces. Assume all financial records are sensitive.

## Existing observed controls
- `src/server/host.ts` rejects non-loopback bind requests.
- `createCommunityGuard` requires a per-process long token, checks Host/Origin and denies several dangerous API paths.
- Banking and payment automation are deliberately disabled by preview policy.
- `settings-security.ts` limits HTTP setting disclosure.
- `src/storage/paths.ts` constrains declared runtime paths (but call-site/realpath coverage needs audit).
- Offline staging imports into a separate path, with SQLite online backup and some SHA-256 checking.

## Unresolved risks and tests
| Control | Review requirement |
|---|---|
| API route allowlist | classify all routes: read, safe local mutation, sensitive file IO, bank/external; deny unreviewed by default; bypass tests |
| HTTP session | token handling, referrer/history/log exposure, same-origin, CSRF, host headers, XSS, rate/size limits |
| File handling | canonical paths, symlink races, zip slip/bombs, parser limits, malformed CSV/XLSX/PDF, excessive attachments |
| SSRF/external URL | network disabled in preview; strict URL schemes/destinations for enabled future modes |
| SQLite/storage | parameterized queries, migrations, future-version refusal, WAL and consistent cross-store backup, offline restore |
| Legacy import | classified DB fields and nested JSON, secrets excluded even in opaque metadata, payment locks and audit retention |
| Payment | independent explicit authorization, uncertain release states never retried, demo cannot produce real side effects |
| Dependencies | high/critical findings and separately sourced tarballs assessed, not merely npm audit |
| Secret hygiene | no status/log leakage and no private literal detection patterns inside distributable scanner |

**Acceptance:** repeatable negative tests for each attack surface, plus manual code review on exact release commit. Unknown or ambiguous behavior must fail closed. No security proof here authorizes public or real-money use.