# Provider contracts and qualification

Updated 2026-10-15. Local software evidence and external acceptance are separate.

|Integration|Implemented supported contract|Observed local qualification|Remaining external evidence|
|---|---|---|---|
|PayPal|User-owned REST client ID/secret; official OAuth client credentials, merchant account evidence, read-only Transaction Search; sandbox/live scopes|Normal configuration/test/sync/history/disconnect, encrypted scope-bound vault, paging, immutable payment/refund/fee/payout legs, historical replay and idempotency|No independently supplied sandbox/live authorization; no account-password login or unregistered OAuth onboarding claim|
|Stripe|User-owned restricted API key; Account.id binding; read-only account/balance transactions; test/live scopes|Same normal controls, exact gross/fee/net legs, pagination, durable checkpoint/history and disconnect/revocation guards|No independently supplied real test/live key; Stripe Connect OAuth not implemented or claimed|
|Bank account information|Enable Banking supported read-only application/session/account contract; fixed official endpoints, expiry and booking-direction validation|Normal encrypted configuration, permission checks, atomic bank/audit persistence, synthetic paging/import and actual crash recovery|Provider registration and owner consent/session required; no live AIS acceptance|
|Offline OCR|Local PDF/image render, Tesseract English/German and explicit manual review|Real OCR in source and earlier installed financial browser; input/resource bounds, corrections and explicit confirmation|No private cloud API used; exact final package regression and native source qualification pending|
|Invoice Bot|Eight assisted fresh user-owned browser/download workflows listed in INVOICE_PORTAL_INVENTORY.md|Controlled egress, explicit selection, original bytes/provenance, dedupe, cancellation/reconnect and normal synthetic portal import|All actual provider logins remain unaccepted; AliExpress/Bambu Lab current authoritative contracts and consumer-Post parity unresolved|
|Payments|Exact SEPA preparation and local simulated authorization/submission with durable one-use claims|Normal draft/review/approval, exact digest and sum, stale/replay denial, unknown outcome without automatic resubmission|No actual payment-initiation provider enabled; provider capability/registration/consent and independent live qualification required; automated real transfers forbidden|

Primary contract references and detailed limitations are retained in
[SOURCES](SOURCES.md), [provider implementation](integrations-implementation.md),
[banking/portal package](packages/FINAL-P02-banking-and-portals.md) and the portal
inventory. Official read-only contract support does not prove live account acceptance.
