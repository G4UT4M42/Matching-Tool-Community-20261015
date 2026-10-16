# PayPal financial event contract

This closes a local F03/F07 implementation gap found during the 2026-10-16
requirements reconciliation. The previous adapter inferred refunds from a
negative amount and treated funding, withdrawals and many adjustments as
payments. Actual provider authorization was never the cause of this gap.

The contract follows the official [PayPal event reference](https://developer.paypal.com/reports/reference/t-codes)
and [Transaction Search schema](https://developer.paypal.com/api/transaction-search/v1/schema.json).
These sources define provider events; the conservative accounting decisions
below are application policy, not tax advice or automatic tax classification.

## Financial normalization

Event kind and signed direction are independent. An outgoing checkout remains
a payment/purchase; a refund can be positive for a buyer. Known standalone
fees and fee reversals retain their signed amounts. Funding and currency or
intra-account movements use `transfer`; bank withdrawals use `payout`.
Both become report transfers and cannot be reclassified as new income or
expense. Known chargeback lifecycle events use `dispute`. Explicit refund
codes use `refund`. Ambiguous, unsupported and unknown valid codes remain
`other` without revenue evidence. In particular, generic credit-card purchase
and reversal descriptions do not prove an owner-internal transfer.

`paypal-event.ts` contains the exact reviewed mapping. This mapping is not a
claim to infer every future provider code, counterparty or tax treatment.
Display-only rows and authorizations produce no booked cash row. Requests
explicitly select balance-affecting records. All supported amounts remain
exact signed minor units; different-currency fees remain separate legs.

## Settlement, replay and audit

The provider schema permits an omitted status. This application requires an
explicit successful or previously successful/reversed status before importing
cash. Missing status blocks the current window with
`PROVIDER_TRANSACTION_INCOMPLETE`; pending status blocks it with
`PROVIDER_TRANSACTION_PENDING`. Neither can advance the checkpoint past an
unresolved event. Denied events create no cash row. Unknown or non-string
statuses reject. The user receives local English/German recovery guidance.
Earlier fully committed windows can remain committed; retry resumes from their
durable boundary or the recorded initial boundary.

A reversed original retains its original signed cash leg. No opposite refund
is invented from status alone. An actual refund/reversal event needs its own
provider source evidence. Status and provider update time are appended as
deduplicated canonical audit observations outside immutable transaction-row
equality. Thus observing an original first as successful and later reversed
does not replace it, duplicate it or change its original ID. Repeated status
observations do not create new audit rows. Provider checkpoints follow the
same durable SQLite/JSON commit, including observation-only commits.

Previously imported misclassified evidence is preserved. If the corrected
provider event contradicts it, import fails with a source conflict rather than
rewriting financial history or introducing a second economic identity. The
owner must reconcile such an actual conflict locally if one occurs; no personal
dataset was inspected and no silent conversion is supplied.

## Validation and scope

`community-paypal-events.test.ts` exercises directions, event groups, signed
fees, uncertain codes, malformed statuses, pending/missing-status restart
recovery after several days, original-plus-refund exact totals, immutable
source IDs, status audit deduplication and transfer revenue protection.
Existing provider identity, durable import, accounting and integration suites
remain mandatory. Synthetic results do not establish provider sandbox or live
account acceptance. Exact candidate regression and installed qualification are
recorded separately.

The normal integration page exposes durable connection/synchronization
operation history. Initial synchronization begins thirty days back, then uses
its recorded historical coverage and incremental cursor. Arbitrary date-range
selection from the retained legacy importer is not exposed in this page; this
is a disclosed local parity limitation, not an external authorization blocker.
