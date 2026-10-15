# Local account authentication — implementation and qualification boundary

Status: IN_PROGRESS. This document describes a tested backend component, not an accepted complete product or completed first-run browser workflow.

## Implemented source

- `src/server/community-auth-store.ts`: an installation-owned identity database, first-owner bootstrap, password verification, persisted sessions, rate limits, account roles, password changes and security events.
- `src/server/community-auth-http.ts`: strict HTTP input boundaries, session cookies, origin and CSRF checks, account-management endpoints and an explicit method/capability registry.
- `src/server/community-permissions.ts`: trusted workspace principals and separate read, import, matching, document, integration, backup, migration, payment and account-administration capabilities.
- `src/server/community-identity-files.ts`: private application-owned identity storage and native Windows permission verification.
- `src/server/community-guard.ts`: the existing preview guard remains intact; a directly observed same-origin predicate is exported for the account HTTP boundary.

The existing application's main server and token-based preview gate have NOT been converted to the new account UI. Standalone authenticated API qualification must not be reported as a completed installation or browser acceptance.

## Identity and installation ownership

Each explicitly configured runtime has an independent `identity/auth.sqlite` database, random workspace identifier and random cookie namespace. First-owner creation requires a random, installation-bound local setup code. Only its SHA-256 digest is persisted; it expires after 30 minutes and is consumed atomically when the first owner is created. Concurrent setup requests cannot create two initial owners.

The intended normal launcher must present the temporary code locally rather than expose it in a URL, repository file, browser localStorage or ordinary log. That launcher/UI integration remains pending. A missing setup code is not an invitation to enable unrestricted registration.

On Windows, a newly created empty identity directory receives protected discretionary access rules for the current Windows user and Local System. Reopening an existing directory verifies its actual rules and the rules of known SQLite members. Unexpected access principals, inherited unrelated permissions, directory links and unrecognized members fail closed. Existing permissive directories are not silently rewritten. This boundary protects the application-owned store; it does not claim protection against a compromised operating-system administrator.

Unix permission checks are implemented, but the current acceptance evidence was collected on Windows. Do not claim a separate Unix installation qualification.

## Password and session controls

Passwords use NFC normalization, a 15–128-character policy, support spaces and password managers, and reject a limited built-in set of obvious common passwords. The implementation does not claim a comprehensive breached-password database check.

Password hashes use scrypt with N=131072, r=8, p=1, a 32-byte random salt and a 64-byte derived value. Parameters are encoded and strictly checked. At most two expensive derivations may run concurrently per process. Unknown valid-format usernames perform equivalent dummy password derivation. Login rate limits are persisted and survive restart.

Raw session tokens contain 32 random bytes and are not stored in the identity database. The database stores their digest, a session-specific CSRF nonce and expiration metadata. Sessions have a 30-minute idle limit and a 12-hour absolute limit. Sensitive account administration requires password confirmation within five minutes. Password and account-role changes revoke older sessions. The last enabled owner cannot be disabled or demoted.

Cookies are HttpOnly and SameSite=Strict, with Secure enabled for HTTPS. The current deployment contract is loopback-only; a remotely exposed deployment requires independently qualified TLS, reverse-proxy and host/origin configuration. Browser cookies are not port-scoped; the local operating-system trust boundary must be documented accordingly.

The CSRF value is derived from the session token, workspace identity, session identity and nonce. It is returned to the same-origin application for mutation requests, but the raw session cookie is never returned in JSON. Private account and financial responses are marked no-store.

## Trusted permissions and HTTP routes

A principal is created from server-side session state, not from a request body, query, hidden form field, forwarded host header or caller-supplied role. Every financial route must have an explicit anchored method/path rule and capability. Unreviewed legacy payment and secret-reading routes remain denied even for an owner.

|Role|Representative permitted operations|Explicit separation|
|---|---|---|
|Owner|All configured workspace capabilities|Payment submission still needs payment-specific authorization; a role alone is insufficient|
|Bookkeeper|Read, import, matching, document edits, integration synchronization, backup and payment preparation|No account administration or payment approval/submission|
|Viewer|Financial/document/report/audit reads|No mutations|
|Payment approver|Reads plus approval/submission capability|No implicit preparation or account administration|

Authentication routes are `/api/auth/session`, `/api/auth/setup`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/reauthenticate`, `/api/auth/password` and `/api/auth/users`. Each route has an exact supported method and validated body. Unknown fields, malformed or oversized JSON, duplicate session cookies, hostile origins, encoded aliases and unsupported methods are rejected. Errors do not reflect submitted passwords or setup codes.

## Persistence and audit

Identity schema version 1 is independent of the financial schema. An existing unsupported or damaged identity database is rejected before application writes. Passwords, setup material, session tokens and provider credentials must never be included in ordinary financial backups or legacy migration.

Security events use append-only database triggers and a verified hash chain. This detects the tested integrity violations and prevents updates through ordinary application database operations. It is not a claim of cryptographic nonrepudiation against an operating-system owner who can replace the database and all its contents.

Provider credential encryption is a separate integration-vault package. A password hash is not a provider credential vault, and this implementation must not be used to justify returning saved API secrets.

## Tests and observed evidence

- `tests/community-auth-store.test.ts`: bootstrap authorization/expiry/replay/concurrency, password policy and normalization, salted storage, generic login failure, durable throttling, workspace/session separation, idle/absolute expiry, restart/logout, recent authentication, roles, account disabling, last-owner protection, password rotation, future schema refusal and audit integrity.
- `tests/community-auth-http.test.ts`: actual Express HTTP requests covering unauthenticated/preview-token denial, viewer/bookkeeper/owner separation, trusted actors, CSRF, hostile/missing/null origins, forwarded-header rejection, Host validation, cookie ambiguity, unreviewed methods/routes, body limits, private cookie handling, masked account management and response headers.
- `tests/community-identity-files.test.ts`: actual native Windows private-directory creation and verification, inherited-permission refusal, unknown-file preservation, directory-link rejection and invalid roots.
- Existing origin/guard tests were rerun alongside the initial auth tests.

Evidence run: `Matching-Community-E2E-20261014-045708`.

`iteration-09-auth.json` records 44 passing focused tests, with no failed or pending tests. `iteration-10-private-identity.json` and its command log cover the added native filesystem boundary; backend typecheck and all selected tests returned exit code zero. The later integrated result must be read from its exact command/result artifacts rather than inferred from these component passes.

One initial test containing several deliberate memory-hard password checks exceeded Vitest's default five-second test deadline. Its complete assertions and password parameters were preserved; a 20-second test envelope was supplied, and the entire focused set was rerun. This is not a measured authentication-performance acceptance. A separate stated-latency/load qualification remains required.

## Remaining qualification and tool-denied work

The authentication translation-file write was denied by the execution platform before being applied. It was not recreated through another filename, tool or embedded replacement. The complete first-run/login/account UI, the normal-server wiring and the account-mode browser journey therefore remain unqualified.

An unrelated amount-formatting write and a combined parallel-worker status query were also denied. A subsequently denied revision of a new test-discovery script was not retried through another mechanism. The initial unqualified discovery draft must not be used as release evidence or included in a release artifact. None of these denials establishes that the remaining financial, provider, OCR, migration or payment software has passed.

Full acceptance still requires normal application wiring, owner/user browser journeys, all role-specific UI controls, English/German coverage, clean installation, operating-system user boundary review, source/dependency/privacy/license gates, and the final integrated regression. Preserve these as open gates rather than calling the component a release.

## Primary technical references

- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- NIST SP 800-63B: https://pages.nist.gov/800-63-4/sp800-63b.html
- Microsoft DirectorySecurity API: https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.directorysecurity
- Microsoft FileSystemSecurity API: https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.filesystemsecurity

These references informed selected controls. This component is not represented as a complete certification against any of those publications.
