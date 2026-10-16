# Internal provider finalization compatibility

Migration-Required: no
Rationale: Registered SQLite v4, canonical JSON v2 and immutable migration checksums are unchanged. Consent authority stays in protected local integration storage; provider observations append to the existing extensible audit contract. Existing financial rows remain readable and are never rewritten to a newly guessed event type or merchant identity.
Rollback: Stop the isolated candidate and retain its complete data generation. Restore a verified full backup with its matching qualified binary. Do not use an older preview to continue provider synchronization against newer observations or reuse consent authority after restore.

## Changed contracts

AIS application configuration and pending consent are protected local operational state. One-use consent binds the authenticated subject, session, environment, workspace generation and expiration. Accounting backup/migration does not export that authority. Existing live account IDs remain stable; sandbox IDs use a distinct namespace. Disconnect retires current authority before removing application credentials.

PayPal event classification follows explicit event codes and preserves actual cash events. Mutable successful/reversed status observations append outside immutable cash-row equality. Missing or pending transaction status blocks the window checkpoint. Already imported historical rows that conflict with the corrected classification are retained and synchronization reports a source conflict; no automatic accounting correction is inferred. These observations are inert audit metadata, not approval authority or replacement financial records.

Stripe payout membership is new audit metadata with explicit `stripe_payout_reconciliation_version=1`. Its reader rejects missing or unknown versions and invalid actor/action/entity/content bindings. Older qualified data contains no such report and needs no conversion. Unknown future report versions require an explicit reader/migration decision; they cannot silently become version 1. Exact provider type/category and signed integer amounts are retained. Merchant-wide conflicts reject before a second actor can append inconsistent completed membership. Historical cash, cursor, coverage and seen references are unchanged by reconciliation.

The encrypted integration-state envelope remains version 1. The optional local payout-account binding can be absent in an existing record; then reconciliation verifies the merchant before establishing it. Reconfiguration clears the binding. This is reconnectable operational metadata, excluded from portable accounting backups.

## Verification and review

Regression entrypoints cover prior provider imports, historical coverage/replay, consent expiry/restart/retirement, actor separation, payout pagination and exact fees, malformed/unknown audit versions, preserved raw event labels, canonical SQL/JSON commit failure and reopen. Normal application journeys compare the original canonical transaction objects and actual SQLite transaction rows before and after payout reconciliation, replay, restart and reconnect. Existing schema checksum, skipped-upgrade, downgrade and backup/restore tests remain in complete discovery.

Independent scoped backend security and financial reviews are recorded externally with source hashes. Exact committed full-suite and installed acceptance remain separate gates; this decision alone is not a passing acceptance result. No real provider access, historic source rewrite, general downgrade support or public redistribution is approved.
