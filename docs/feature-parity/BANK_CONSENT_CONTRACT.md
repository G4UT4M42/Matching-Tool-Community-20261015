# Community AIS consent contract

This implementation follows Enable Banking's [official AIS flow and API reference](https://enablebanking.com/docs/api/reference/), reviewed 2026-10-16: application verification, bank discovery, authorization, callback receipt, session exchange and account selection. Only account information endpoints are used. Software qualification uses synthetic transport responses and generated keys; it does not establish that an owner's provider registration or real bank consent has been accepted.

## Local HTTP contract

The normal application exposes these paths below `/api/community-banking`. Existing authenticated session, role, same-origin, CSRF and recent-authentication checks apply to mutations. The exception is the exact public GET callback receipt described below.

| Method / path | Input | Safe response |
| --- | --- | --- |
| POST `/application` | `{applicationId, privateKeyPem, environment: 'sandbox' \| 'live'}` | `{applicationConfigured: true, applicationEnvironment}` |
| GET `/status` | none | Existing connection fields plus `applicationConfigured`, `applicationEnvironment` or null, exact `callbackUrl`, and `pendingConsent` or null |
| GET `/banks?country=AT` | Two-letter uppercase country | `{items: [{name,country,maximumConsentSeconds}], environment}` |
| POST `/consents` | `{bank: {name,country}, psuType?: 'personal' \| 'business', validUntil?: UTC ISO timestamp}` | `{flowId,authorizationUrl,expiresAt,environment}` |
| POST `/consents/:id/complete` | `{}` | `{flowId,accounts: [{accountRef,name,currency}],environment,expiresAt}` |
| POST `/consents/:id/select` | `{accountRef}` | `{configured: true,environment}` |
| POST `/consents/:id/cancel` | `{}` | `{cancelled: true}` |
| POST `/disconnect` | Existing empty request | Removes both local live and sandbox connections, then application authority; 204 |

`pendingConsent` is scoped to the exact subject, workspace and authenticated session. Its fields are `{flowId,stage,expiresAt}`; `accounts_ready` additionally includes the same safe account choices as completion. Stages are `awaiting_callback`, `callback_received`, and `accounts_ready`. A UI reload can recover this state without receiving the nonce, authorization code, provider session identifier or key. The advanced preauthorized-session form remains available, but normal composition verifies application metadata and session membership before storing its authority.

## Environment and identity

The provider reports `SANDBOX` or `PRODUCTION`; local names are `sandbox` and `live`. `GET /application` must confirm the exact application ID, active status, AIS service, registered callback URL and expected environment. A mismatch is rejected. Official registration documentation states that applications cannot be transferred between those environments. These are actual provider environments, distinct from the dependency-injected synthetic transport used by tests.

Live transaction and source-account identities retain their existing scheme. Sandbox identities include an additional environment namespace and `provider_environment: sandbox` metadata, preventing collisions with the same live account identification hash and transaction reference. No payment adapter or payment-initiation capability is added.

Application settings select the explicit environment. Disconnect removes authority for both environments before deleting those settings, so the absence of settings cannot reactivate an earlier live connection through the compatibility default. Existing old live connections remain readable without an application-settings record, but their credential is verified against actual provider metadata on each normal application read.

## Callback and concurrency boundary

Each flow uses a new 256-bit random state, stored only as a hash, plus a distinct opaque flow ID. It expires after ten minutes. Its persistent capability binds the initiating subject, workspace, authenticated session, permission and workspace generation. Authenticated mutations additionally require recent authentication both at the HTTP boundary and at coordinator capability capture. The public callback can retain a valid flow after the five-minute recent-authentication window ends; completion then requires reauthentication and can resume within the advertised flow expiry. State is consumed once. Denial, cancellation, malformed matching receipts, expiry, replacement, revocation and restore invalidate the capability. Restart intentionally discards incomplete flows; the user starts a new authorization.

External redirects do not depend on the Strict session cookie. The exact GET `/api/community-banking/callback` accepts only a bounded receipt and returns a constant empty 303 redirect to `/banking`, with no query, `no-store`, no-referrer and restrictive content policy. It makes no provider request or financial mutation. Completion occurs separately as an authenticated same-origin POST. Provider error descriptions are discarded. Normal application logging redacts callback queries.

The authorization URL policy permits only HTTPS on `auth.enablebanking.com`, without user information, a port or fragment. This is the reviewed implementation allowlist based on the official response example; the provider response schema itself specifies a URI and does not promise an `/ais/` path prefix. Other hosts require an explicit reviewed contract update.

Application changes, flow creation, advanced setup and disconnect serialize within each subject/workspace scope. Flow selection rechecks its capability after provider waits and immediately before credential/SQL publication. Revoked or replaced flows cannot publish a connection. Bank reads and sync recheck current permissions and the captured account/vault pointer after awaits; canonical import invokes the same guard immediately before synchronous commit. A response from a disconnected or replaced connection is rejected as `BANK_CONNECTION_CHANGED`.

## Storage and audit

Application private keys and provider sessions remain in the identity-only protected bank vault. Application records and staged writes use the existing strict opaque `64hex.credential` layout; encryption binds workspace, subject and environment. Each connection credential has an immutable opaque version. Financial backup/restore does not include reusable provider authority. No state, code, JWT, raw provider errors or private keys enter operation audit records.

Configuration and disconnect SQL changes retain their atomic canonical audit transaction. New operations also have durable safe started/completed events with operation IDs and bounded public error codes. If completion-event persistence fails after a committed authority change, the request reports `BANK_HISTORY_UNAVAILABLE`; status remains authoritative and the durable started event records the attempt. Failed multi-step advanced setup may leave verified application settings without a configured connection; status exposes that distinction. Protected-file cleanup can retain inaccessible unreferenced encrypted versions if filesystem cleanup fails.

Disconnect removes local authority. It does not invoke provider session deletion or promise remote consent revocation; the owner may additionally revoke consent through the provider/bank. No real registration, bank account, token, transfer or ambient browser session is used by the synthetic qualifications.

## Focused qualification

`tests/community-bank-consent.test.ts` covers application/environment checks; one-use, denied, cancelled, replaced, expired and foreign-session callbacks; safe external receipt; account recovery and selection; permission/dataset retirement during provider waits; advanced/disconnect serialization; selection cancellation during publication; strict Windows DPAPI storage; ciphertext tampering; environment identity isolation; bounded provider bytes; and retired connection responses. Existing banking and canonical bank-audit suites remain applicable. Normal application browser qualification is composed separately through an explicit code-injected `bankTransport`; no runtime HTTP switch, environment bypass or productive credential is added.
