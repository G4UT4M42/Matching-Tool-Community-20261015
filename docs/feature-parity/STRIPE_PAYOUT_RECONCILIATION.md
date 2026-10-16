# Read-only Stripe payout reconciliation

The separate reconciliation operation implements P05-W02 automatic payout grouping without importing another cash or revenue record. Its primary contracts are Stripe's [payout object](https://docs.stripe.com/api/payouts/object), [payout retrieval](https://docs.stripe.com/api/payouts/retrieve) and [balance transaction listing](https://docs.stripe.com/api/balance_transactions/list), reviewed 2026-10-16. This is synthetic software qualification; no real account or transfer is used.

## Supported provider boundary

The client uses the configured restricted key and GET `/v1/account` to verify the merchant identity on every reconciliation. The payout ID must be a bounded `po_` identifier. GET `/v1/payouts/:id` must return the exact payout object, boolean automatic flag, expected live/test mode, valid amount/currency, exact enum strings and a valid nullable balance-transaction reference. Supported membership requires automatic, standard, paid, completed reconciliation. Manual/instant/unavailable cases remain explicitly unsupported; delayed reconciliation or settlement remains pending and retriable.

Completed membership is fetched with GET `/v1/balance_transactions?payout=:id&limit=100`, advancing only `starting_after`. Financial-sync date bounds are deliberately absent. Limits are 100 pages and 10,000 distinct rows, with explicit loop, duplicate-conflict, integer, currency and response-schema checks. Exact duplicate overlap is deduplicated. No provider POST, payment, payout creation or arbitrary URL is supported.

The exact payout `balance_transaction` is also retrieved independently. It must identify a payout debit sourced from this payout, with the same currency and amount equal to negative bank amount. Its actual signed fee and net are preserved. If it appears in the membership listing, the exact ID is excluded from component totals; unrelated rows are never removed by label.

## Exact financial equations

Every component and the settlement debit must satisfy `amountMinor - feeMinor = netMinor` using safe integers. Payout report fees retain Stripe's signed fee convention, including negative fee credits; existing imported cash-row conventions are unchanged.

`amountMinor` is the positive bank amount. `settlementFeeMinor` is the actual own-debit fee, `requiredFundingMinor` is negative own-debit net, and `residualMinor` is component-net total plus own-debit net. Only residual zero is reconciled. A nonzero residual is explicitly unreconciled (`PAYOUT_TOTAL_MISMATCH`); no fee, exchange rate, missing member or balancing transaction is invented. Totals remain separate per report/currency.

## Normal application HTTP contract

All routes below `/api/community/integrations/stripe/:environment` retain existing account/session, role, origin and CSRF guards. Environment is `test` or `live`. Reads require `integrations:read`; reconciliation requires `integrations:sync` and adds history operation `payout-reconcile`.

| Method / path | Response |
| --- | --- |
| GET `/payouts` | `{items,limit:100,account,requiresAccountVerification}`; bounded summary entries, including discovered payout IDs from the locally bound merchant's canonical payout rows |
| GET `/payouts/:payoutId` | Latest full persisted safe report with `replayed:false`, or 404 |
| POST `/payouts/reconcile` with `{payoutId}` | Durably stored full report and actual `replayed` boolean |

Summary fields are `payoutId`, `account`, `environment`, `status`, and, for observed reports, optional `reason`, `currency`, `amountMinor`, `componentCount`, `observedAt`. A newly discovered item has status `discovered`. Full reports use `pending`, `reconciled`, `unsupported`, or `unreconciled` and include:

- Payout metadata: `automatic`, `method`, `providerStatus`, `reconciliationStatus`, `payoutBalanceTransaction`.
- `totals:{grossMinor,feeMinor,netMinor}`, `componentCount` and `components`.
- Component fields: `reference`, exact provider `providerType` and `reportingCategory` (each bounded to 80 lowercase letters/underscores), derived controlled `classification`, `sourceReference` or null, `occurredAt`, `amountMinor`, `feeMinor`, `netMinor`. Raw type/category distinctions are retained and checked for same-ID conflicts even when the derived classification and money remain equal.
- `payoutLeg` or null, with the same fields and `includedInListing`.
- `requiredFundingMinor`, `settlementFeeMinor`, `residualMinor` (null when membership is unavailable).
- Durable `observationId` and `observedAt`.

History reads use the local encrypted merchant binding and canonical evidence, with no provider request. Without a verified local account, the list is empty and requests account verification; it does not guess from old credentials or another account. New reconciliation verifies the account again and rejects changed merchant identity. It can establish a separate protected payout-account binding while leaving sync cursor, seen references, coverage dates and success timestamps unchanged. Reconfiguration clears that binding; disconnect preserves historical local inspection without reusable credentials.

## Persistence and authorization

Reports are strict bounded safe projections stored as append-only canonical audit evidence with `stripe_payout_reconciliation_version=1`. Absent or unknown versions reject; historical reports are not inferred from unrelated audit events. Descriptions, destinations, provider metadata blobs, credentials and raw errors are excluded. Admission requires the expected user, action, Run entity, content-bound observation ID and valid audit/observation timestamps. Canonical SQL and JSON journal commit precedes successful acknowledgement. An exact evidence replay returns the original observation ID/time without adding another membership event. Observation IDs are actor-scoped; read visibility stays actor-specific. Economic conflicts apply globally to the verified merchant/environment/payout, including across different local actors, before any replay early return. Changed payout economics or already-observed completed membership conflict; previous records and cash rows remain unchanged. Later provider status observations append rather than overwrite history.

Reconciliation shares the provider scope lock with sync/configure/disconnect. Permissions and workspace generation are checked after asynchronous work and immediately before protected merchant-binding and canonical evidence publication. A revoked or retired response cannot commit. A failed completion-history write can report `INTEGRATION_HISTORY_UNAVAILABLE` after a membership observation committed; the started event and latest persisted report remain inspectable.

Focused tests in `tests/community-stripe-payout.test.ts` cover pagination, signed fees, own-leg presence/absence, delays, unsupported modes, environment/schema/identity/currency conflicts, exact replay, no cash duplication, canonical rollback/reopen, offline detail reads and revoked async responses. Normal application/browser qualification is composed with a synthetic transport separately; owner provider acceptance remains distinct.
