# Primary technical sources

Inspected 2026-10-13. Revalidate relevant details before implementing a provider request.

- PayPal authentication: https://developer.paypal.com/api/rest/authentication
- PayPal transaction search: https://developer.paypal.com/api/transaction-search/v1
- Stripe key permissions/modes: https://docs.stripe.com/keys
- Stripe balance transactions: https://docs.stripe.com/api/balance_transactions/list
- Node 22.16 crypto API: https://nodejs.org/download/release/v22.16.0/docs/api/crypto.html

These sources describe supported technical interfaces, not actual qualification of this implementation or legal/tax approval.

Revalidated for the 2026-10-16 internal finalization:

- PayPal event semantics: https://developer.paypal.com/reports/reference/t-codes
- PayPal response status schema: https://developer.paypal.com/api/transaction-search/v1/schema.json
- Enable Banking AIS consent/API: https://enablebanking.com/docs/api/reference/
- Enable Banking application/consent setup: https://enablebanking.com/docs/api/quick-start/
