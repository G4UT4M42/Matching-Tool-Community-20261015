# Integration foundation implementation

Current internal development update (2026-10-16): the application wiring and
normal connection/synchronization history are implemented. The historical
foundation notes below describe their original implementation snapshot.
[PayPal event semantics](PAYPAL_EVENT_CONTRACT.md) now correct a mandatory
local financial gap; [AIS consent](BANK_CONSENT_CONTRACT.md) has a separate
complete local flow. Current exact-candidate qualification remains pending.

This isolated implementation adds a credential vault, PayPal Transaction Search client, Stripe balance transaction client, an owner-scoped synchronization service, an authenticated management router, and an English/German React page. It does not activate an external integration in the current Community preview. The supervisor must review the wiring and accounting callback before enabling any route.

## Verified provider contracts

- [PayPal REST authentication](https://developer.paypal.com/api/get-started/) uses a merchant's own REST app client ID and secret to obtain a bearer token with `grant_type=client_credentials`. The fixed endpoints are `https://api-m.sandbox.paypal.com` and `https://api-m.paypal.com` ([PayPal REST requests](https://developer.paypal.com/api/make-api-requests)). No PayPal account password or generic OAuth login is collected.
- [PayPal Transaction Search](https://developer.paypal.com/api/transaction-search/v1/search-get) is `GET /v1/reporting/transactions`; it requires the reporting search read scope. `start_date` and `end_date` are required, the maximum window is 31 days, pages start at 1, and results can lag by three hours. The default response includes balance affecting records only. The reference states that a transaction ID can occur in more than one reporting row; the service uses a composite source event key while retaining the original transaction ID.
- [PayPal transaction detail fields](https://developer.paypal.com/api/transaction-search/v1/definitions/transaction_detail_list/) include gross `transaction_amount`, signed `fee_amount`, transaction event code, timestamps, and reference ID. Decimal strings are converted through `BigInt` to safe integer minor units. Different currency fees become separate fee records; currency totals are never added together.
- [Stripe restricted API keys](https://docs.stripe.com/keys) are server-side keys with resource-specific permissions. This implementation accepts only `rk_test_...` or `rk_live_...` according to the chosen environment. It does not support Stripe Connect or platform account headers.
- [Stripe balance transaction listing](https://docs.stripe.com/api/balance_transactions/list) is `GET https://api.stripe.com/v1/balance_transactions`, with `starting_after` pagination, `created` filtering, and integer amount/fee/net fields. [Stripe payouts](https://docs.stripe.com/api/payouts) transfer existing balance to a bank account; the balance transaction for a payout is retained as a settlement event with `revenue: false`, so it is not counted again as a charge.

No actual provider sandbox or live account was accessed. Provider tests use programmatically constructed transports and fictional records only. The hardened vault requires independently maintained application-owned storage and explicitly refuses unsafe path and permission states.

## Contracts and persistence

`CredentialVault(directory, protector?)` stores one credential envelope per authenticated subject, provider and environment. The default `WindowsDpapiProtector` uses current-user Windows DPAPI and binds each envelope to that tuple as optional entropy. It passes plaintext to PowerShell on stdin, never in process arguments, a URL, log or environment variable. The vault restricts the directory ACL to the current Windows user, writes files with mode `0600`, and fails closed when DPAPI or ACL setup is unavailable. The October 14 hardening adds regular-file checks, rejects symlink/junction ancestors and credential/checkpoint links, uses the verified system PowerShell executable, and checks explicit owner/SYSTEM Windows ACL rules without silently changing an existing permissive directory. A rejected checkpoint link no longer partially disconnects otherwise valid credentials. An injected `KeyProtector` permits independent synthetic tests. Files are in a dedicated integrations directory and are excluded from existing `backup.ts`, which copies only SQLite and `state.json`; future broader backup code must continue excluding the directory.

`IntegrationService(vault, commitBatch, transport?, now?)` returns `CanonicalTransaction` records with provider, environment, account subject, stable reference, signed exact amount, fee, net, currency, classification, and revenue flag. `commitBatch({principal, provider, environment, transactions, checkpoint})` must durably and idempotently commit the accounting batch. The service persists the DPAPI-protected cursor/dedupe checkpoint only after that callback resolves. A retry can repeat a callback if the process fails between its durable commit and checkpoint rename, so the accounting coordinator must also dedupe by provider, environment, owner and source event key. The cursor overlaps one day to cover delayed reports. A 10,000 row sync window and 100,000 key checkpoint cap fail closed.

`createCommunityIntegrationsRouter(service, permit?)` denies all permissions by default. It derives the principal exclusively from `res.locals.communityPrincipal.subject`; missing principal returns 401, denied permission returns 403. Normal HTTP responses contain only configured status, environment, last success/error code, and operation results. The following exact method/path combinations need a reviewed allowlist entry **after** account/session authentication and explicit integration authorization:

| Method | Relative path under `/api/community/integrations` | Permission |
| --- | --- | --- |
| GET | `/:provider/:environment` | `integrations:read` |
| PUT | `/:provider/:environment` | `integrations:configure` |
| POST | `/:provider/:environment/test` | `integrations:configure` |
| POST | `/:provider/:environment/sync` | `integrations:sync` |
| DELETE | `/:provider/:environment` | `integrations:configure` |

The integration router now checks the shared Community capability names (`integrations:*`) and validates the server-issued full subject, session, workspace and role context before running the separately injected workspace predicate. Default authorization remains deny. A user who may synchronize cannot read or use another user's stored credentials: a bookkeeper's synchronization requires that bookkeeper's own configured provider connection. This isolation is verified with independently generated test principals and a simulated provider, not real account data.

`provider` is `paypal` or `stripe`. PayPal environments are `sandbox` and `live`; Stripe environments are `test` and `live`. The router rejects body-supplied subjects and extra configuration fields. The management page clears credential inputs immediately after submission and only displays a masked configured state. It presents generic errors rather than provider response text.

## Validation and remaining work

Run `node node_modules/vitest/vitest.mjs run tests/community-integrations.test.ts --maxWorkers=2`, `node node_modules/typescript/bin/tsc --noEmit`, and `node web/node_modules/typescript/bin/tsc --noEmit -p web/tsconfig.json`. The browser harness is `node --test --test-concurrency=1 tests/community-integrations.browser.test.mjs`; it bundles the actual page into a temporary application, uses an isolated browser profile, and serves simulated provider responses. An October 14 standalone Chromium-based browser run with simulated provider responses passed its user-interaction scenario. The browser result is not evidence of a complete normal-app workflow, a valid external provider token or a production connection.

The full account/session authentication, accounting coordinator binding, integration route allowlist, and page navigation wiring are owned by the supervising agent. The synthetic tests verified Windows DPAPI roundtrip under the logged-in testing user, including owner-scoped storage, ACL enforcement and rejection of filesystem links. Real provider permissions and authorized sandbox/live qualification remain external acceptance gates. Invoice-to-provider reconciliation requires the accounting coordinator. Stripe payout records are preserved as non-revenue, but verified automatic payout component membership through the `payout` filter is not implemented. Historical backfill beyond the initial 30-day window has no UI. Local disconnect deletes credentials and sessions; it does not revoke the remote provider key. Banking consent, OCR, and Invoice Bot configuration are unsupported here; no provider registration or bank session flow is claimed.
