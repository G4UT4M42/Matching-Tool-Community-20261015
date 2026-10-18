# Community payments and controlled banking implementation

> Current sandbox addendum (2026-10-18): the text below is the historical initial
> simulator/read-only banking implementation record. Its statements that PIS is
> unregistered and AIS consent must be supplied separately describe that earlier
> snapshot, not the current sandbox branch. d521 includes owner-driven AIS consent.
> The new [sandbox PIS contract](SANDBOX_PAYMENT_CONTRACT.md) and
> [intent compatibility decision](../migration-decisions/009-sandbox-payment-intent.md)
> define the implemented sandbox-only single SEPA EUR request, exact approval,
> one durable CREATE claim, callback/status checks and GET-only unknown recovery.
> Focused backend 62/62 and a separate source normal journey 1/1 passed; new
> committed/full/installed/CI qualification remains pending. Production PIS is
> hard-disabled. Private internal scope and OWNER_DEFERRED VM testing remain.
> Historical counts, failed retrievals and earlier limitations below are retained
> as evidence; no denied request is retried and no live/provider acceptance follows.


## Source inventory and chosen behavior

The preexisting Community source includes `src/payments/candidates.ts` (OCR/raw-text creditor extraction and classification), `validation.ts`, `sepa.ts`, `service.ts` (candidate refresh, batch edits, review, XML export and cancel), `automation-service.ts` (George import/release state), `browser/george-*`, `src/server/routes/payments.ts`, `src/import/enablebanking-api.ts`, and `web/src/components/payments/PaymentReview.tsx`. The Community preview guard denies the payment routes and `src/server/index.ts` rejects bank automation. Source presence did not demonstrate an authorized payment.

This implementation uses explicit confirmed invoice evidence from an injected accounting adapter. It does not infer payable details from OCR or copy the old fixed debtor account. The old George browser automation remains unregistered. Enable Banking account information is implemented through a fixed official read-only endpoint adapter; payment initiation is not advertised. A local fake bank adapter supports software tests only. No live payment adapter is registered.

## Accounting and identities

The accounting adapter supplies one `InvoiceEvidence` per document: stable `documentId`, `invoiceId`, `sourceHash`, confirmation, archival/rejection flags, exact `totalMinor` and `allocatedMinor`, currency, payee, IBAN, reference, due date and accepted match IDs. A candidate is payable only if explicitly confirmed, not excluded, EUR, with a positive exact outstanding balance and valid details. Partial balances remain exact integer minor units. The service rechecks all fields and match IDs before validation, approval and confirmation. The SQLite unique active document key prevents duplicate drafts; cancellation retains audit and allows a corrected draft. Workspace IDs scope every batch and active document key.

The supervisor's financial allocation adapter must compute `allocatedMinor` from accepted reconciliation evidence, with no proposed/rejected match credit. It must verify `confirmedReconciliation` before marking a batch reconciled. This worker does not write accounting state, and does not invent allocation types. All payment state is in the existing injected SQLite database, introduced by migration 003; no separate financial database or ad hoc JSON store is created. `AccountingCallbacks` includes `persistAndActivate(expectedState,nextState,actor)` for the supervisor's accounting writes.

## Workflow and security

`draft -> validated -> reviewed -> approved -> submission_claimed -> acknowledged|unknown|failed -> reconciled`. Draft, validated, reviewed and approved may be cancelled. Editing debtor details resets to draft, increments the revision, invalidates review/approval and removes confirmation tokens. Every transition compares the expected revision and appends an immutable audit row. The database forbids audit updates/deletes.

Routes require a trusted `res.locals.communityPrincipal` from the supervisor account guard. `authorize` is injected and defaults deny in the required wiring. Read, prepare, approve, submit and integration rights are separate. A bookkeeper cannot approve, even if a malformed permission list contains `payments:approve`; only an owner may be both reviewer and approver. HTTP body actor/role/amount fields have no authority. Every mutating route calls a session-bound CSRF verifier. The supervisor must supply recent trusted reauthentication for confirmation and submission.

The one-use confirmation token is stored only as a SHA-256 hash, expires in two minutes, and binds subject, workspace, session, provider, debtor IBAN, batch revision and a digest of all creditor IBANs, amounts, currencies, references and other details. A successful SQLite transaction consumes the token and persists a unique claim before contacting the injected adapter. If the adapter throws, times out, or process execution stops after the claim, the batch remains claimed or unknown; status reconciliation is read-only and never invokes `submit` again. Duplicated callbacks are deduplicated. Restore clears confirmations and approval authority; claimed/acknowledged batches become unknown, with append-only restore audit events. This does not prove an actual bank accepted a transfer.

## SEPA format and official sources

As checked on 14 October 2026, the EPC 2025 SCT rulebook version 1.2 is in force; the [EPC 2025 SCT Customer-to-PSP Implementation Guidelines version 1.0](https://www.europeanpaymentscouncil.eu/document-library/implementation-guidelines/sepa-credit-transfer-customer-psp-implementation-1) use ISO 20022 `pain.001.001.09` and link the related XSD ZIP. The EPC states these XSDs are technical validation subsets, not production schemas. The [ISO 20022 message catalogue](https://www.iso20022.org/catalogue-messages/iso-20022-messages-archive?search=pain.001) lists `pain.001.001.09`. [ISO intellectual property rights](https://www.iso20022.org/intellectual-property-rights) grant a nonexclusive royalty-free license to published repository information. No third-party schema bytes are copied into this worktree.

The generator emits a pain.001.001.09 document with UTF-8 XML escaping, fixed SEPA/EUR payment type, deterministic message and transaction IDs, valid date, exact integer control sums/counts, and SHA-256 of the download. Browser export produces an actual XML attachment. The existing source's ISO 20022 payment schema assertion checks pass on the generated XML. The official EPC XSD ZIP could not be fetched because this environment denied outbound sockets; formal XSD qualification and bank-specific acceptance remain open.

## Banking provider contract

The [Enable Banking API reference](https://enablebanking.com/docs/api/reference/) specifies `GET /sessions/{session_id}`, account details and transaction reads at `https://api.enablebanking.com`, with RSA-signed application JWT. It says payment initiation requires explicit enablement, and available payment products vary by bank. `EnableBankingAisAdapter` uses only fixed HTTPS GET paths, checks the authorized session and account UID, supports bounded pagination, converts supported EUR decimals to exact minor units, uses no automatic retry, and reports sanitized errors. It neither creates authorization sessions nor triggers a payment. The user must authorize the bank session through a separately reviewed provider flow; the protected vault supplies scoped credentials. The user-facing configuration stores only the returned vault reference in SQLite. HTTP callers cannot choose a provider URL, mock transport or callback URL.

`localFakeAdapters` is an injected software fixture. Its payment adapter increments a submit count and never connects to a network or real account. A George browser adapter would require a fresh user-authorized profile and an independently reviewed supported contract; none is registered here.

## API and UI integration

Mount `createCommunityPaymentsRouter(service)` at `/api/community-payments` and `createCommunityBankingRouter(service,csrf)` at `/api/community-banking` after authenticated principal middleware. Register React pages at `/community/payments` and `/community/banking` and add navigation in `web/src/main.tsx`; that file is outside this worker's ownership. Supply a trusted CSRF meta token to the pages. Register migration 003 after 002 in the central registry and call the restore hook before making restored state available. Complete DTO and callback signatures are in `src/community/payments/types.ts` and the evidence `HANDOFF.md`.

## Qualification boundary

Focused unit/API tests cover partial balances, duplicates, foreign currency refusal, malformed evidence, check digits, XML, revision/role/CSRF boundaries, forged hidden values, stale approvals, confirmation expiry and single use, concurrent claims, uncertain responses, read-only reconciliation, callback dedupe, audit immutability and restore invalidation. The isolated browser journey uses the new React page, downloaded XML, local fake submission and a restarted SQLite-backed service. These are **mocked software qualification** only. Provider sandbox was unavailable; no live account authorization, commercial-bank compatibility, schema XSD validation or real funds transfer is claimed.
