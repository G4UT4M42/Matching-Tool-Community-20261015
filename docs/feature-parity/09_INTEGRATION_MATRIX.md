# Provider contracts and qualification

|Integration|Supported design|Local test requirement|External evidence|
|---|---|---|---|
|PayPal|User-owned REST application client ID/secret; official OAuth client-credentials access token; offline statements; approved onboarding only when registered|Auth errors, expiry, pagination, rate limits, refunds/fees/FX/idempotency|Sandbox credentials not supplied; NOT_RUN|
|Stripe|User-owned restricted read-only API key, test/live distinction; offline exports; Connect OAuth only with registration|Permissions, paging, fees/refunds/disputes/payout consistency and retries|Test-mode credentials not supplied; NOT_RUN|
|Banking|Local account configuration; supported provider consent/authentication|State/nonce, consent expiry, independent account, dedupe|Provider registration and owner authorization needed for external tests|
|OCR|Local controlled text/OCR; optional user-owned API only with explicit configuration|Generated PDF/images, extraction, limits and manual review|No private API permitted|
|Invoice Bot|Individually inventoried V2 adapters; interactive supported login or API|Realistic isolated mock portals, expiry, downloads and duplicate handling|Provider-specific authorized accounts/rights needed|
|Payments|Draft/validate/SEPA/review/approve and safeguarded provider submission|Mock payment state machine, unknown outcomes, real execution forbidden in demo|Real-money approval/security qualification not granted|

Official primary references inspected 2026-10-13: PayPal API authentication and Transaction Search v1; Stripe API keys and balance transactions; Node 22.16 crypto. The credential flow must be described accurately in the UI. Source URLs are retained in SOURCES.md.
