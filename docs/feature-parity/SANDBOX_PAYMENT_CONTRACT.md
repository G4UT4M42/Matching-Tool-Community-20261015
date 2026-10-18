# Sandbox payment initiation contract

The local simulator and SEPA export remain available. The additional Enable Banking PIS adapter is **sandbox only**. Both the stored application and the authoritative `GET /application` must report SANDBOX, an active matching application ID, PIS service and the exact listener callback URL. Production is rejected in the backend before payment creation, regardless of UI selection. No production initiation or real transfer is qualified by this implementation.

Primary contract: [Enable Banking API reference](https://enablebanking.com/docs/api/reference/) (`CreatePaymentRequest`, `GetPaymentResponse`, `ResponsePaymentType`, `CreditTransferTransactionDetails`, `PaymentStatus`), checked 2026-10-18. The provider enables sandbox PIS for newly registered applications; production additionally requires provider enablement and a PISP licence. [Provider FAQ](https://enablebanking.com/docs/faq/) and the reference warn that a final status alone is not proof of creditor receipt. Actual owner registration, sandbox availability and bank authentication are external acceptance steps; synthetic tests do not claim these occurred.

## Supported subset and exact approval

Create a batch with `POST /api/community-payments/batches`, adding `mode: "enablebanking-sandbox"`. Omitting mode retains the simulator. The provider/environment become part of the existing batch digest **before** validation, review and approval. The same confirmed invoice evidence, debtor, creditor, outstanding integer EUR amount, reference, source hashes, revision, eligible-document deduplication and approval rules apply.

The supported product is one standard SEPA EUR instruction with exact approved debtor and creditor IBAN/name, unstructured reference, SLEV charges and immediate submission after bank authorization (`defer_submission: false`). Bulk is rejected rather than split. The frozen requested execution date is the later of the UTC confirmation date and invoice due date; the invoice evidence itself is unchanged. Date and ASPSP limits are checked again before creation, with no silent date recomputation.

The selected ASPSP/PSU type, application ID/revision, exact payment request, execution date, charge bearer and nondeferred choice form a provider-specific intent digest. Bank metadata must explicitly support this subset: EUR, IBAN schemes, SLEV, requested date and range. Unsupported required postal/contact/agent/regulatory data, PSU headers, multi-line remittance or unreviewed remittance patterns fail before claim or POST. The application never invents missing fields, reads bank credentials, or supplies arbitrary forwarded PSU headers.

## Authenticated HTTP contract

All paths below are relative to `/api/community-payments`. Normal session, origin and CSRF protections remain in force. Mutations and bank discovery require `payments:submit` and recent authentication. Status requires `finance:read`; pending flows are limited to the exact owner/workspace/session.

| Operation | Request | Safe response |
| --- | --- | --- |
| `GET /sandbox/status` | None | `{provider:'enablebanking-pis',environment:'sandbox',productionEnabled:false,applicationConfigured,applicationEnvironment:'sandbox'|'live'|null,callbackUrl,pending:[{batchId,flowId,stage,expiresAt}]}` |
| `GET /sandbox/banks?country=AT` | Exact uppercase country | `{items:[{name,country}],environment:'sandbox'}` |
| `POST /batches/:id/sandbox-confirmation` | `{revision,bank:{name,country},psuType:'personal'|'business'}` | `{token,flowId,expiresAt,batch,bank,psuType,intent:{digest,executionDate,chargeBearer:'SLEV',deferSubmission:false,applicationId,environment:'sandbox'}}` |
| `POST /batches/:id/sandbox-authorization` | `{revision,token,flowId}` only | `{batch,flowId,authorizationUrl,expiresAt,environment:'sandbox'}` |
| `POST /batches/:id/sandbox-complete` | `{revision,flowId}` | `{batch,providerStatus,finalStatus,verifiedDetails:true,transactionStatus?}` |
| Existing `POST /batches/:id/provider-status` | `{revision}` | Current batch, using GET-only recovery for PIS |

Stages are `confirmation_ready`, `awaiting_callback`, `callback_received`. Confirmation expires after two minutes. A created authorization receipt expires after ten minutes. Replaced/removed/live applications prune their pending flows. Status never exposes state, confirmation tokens, private keys or authorization URLs. Authorization URLs are restricted to bounded HTTPS URLs on `auth.enablebanking.com`, without credentials, fragment or a nondefault port; the reference examples do not declare a mandatory path prefix.

Generic simulator confirmation, submit and status operations reject foreign provider/environment batches before consuming authority. Sandbox authorization accepts no client bank/payment overrides: it uses the immutable target prepared by sandbox confirmation.

## Creation, callback and uncertainty

After all validation and fresh permission/evidence checks, a SQLite transaction consumes the exact existing one-use confirmation, claims the batch and appends immutable nonsecret intent evidence. This transaction finishes **before** the sole `POST /payments` attempt. There is no automatic retry, including HTTP errors, transport failure, malformed response or restart. An unresolved claim keeps its invoice active and cannot be cancelled locally into a new payment.

The only public endpoint is exact `GET /api/community-payments/sandbox/callback`. It accepts a high-entropy one-use state bound to actor/workspace/session/generation, consumes a bounded receipt, performs no provider/financial operation, reflects no query, and redirects 303 to `/payments` without query. PIS has no AIS code exchange. Completion occurs through an authenticated same-origin POST, preserving Strict-cookie, origin and CSRF protections. Provider denial remains an uncertain remote claim; local denial is not proof of remote cancellation.

Auth/session/workspace-generation retirement prevents all late financial publication. A synchronous per-scope application-vault generation advances with the final credential rename/removal. PIS checks it around asynchronous vault reads and again immediately before publication, so an old read snapshot cannot conceal a completed credential mutation. If the application is retired during creation but the original authenticated generation remains valid, only the returned nonsecret payment ID is retained under `sandbox_create_retired` (or `sandbox_create_unknown` if the read fence detects retirement) and status `unknown`; no retired authorization link is returned or stored. Subsequent recovery may only GET that ID with a freshly verified matching sandbox application. If no ID was safely obtained, the response is `PIS_STATUS_UNAVAILABLE_NO_RESUBMIT`; external inspection is necessary and creation is never repeated.

## Status is not accounting reconciliation

`GET /payments/:id` must return the exact provider ID, bank, SEPA product and every frozen economic field: debtor/creditor name and IBAN, positive exact decimal EUR amount, reference, instruction/end-to-end IDs, requested date, debtor currency and SLEV. Amount parsing uses exact integer arithmetic. Missing or changed approved details fail closed; arbitrary provider descriptions are not persisted. All eighteen documented aggregate statuses are bounded and recognized. A supplied per-instruction `transaction_status` is validated and retained; contradictory aggregate success/rejection versus item status is rejected.

Only exact-details final ACCC becomes **provider acknowledged**, and exact-details final RJCT becomes failed. All other statuses, including ACTC/ACCP/ACSP/ACSC/ACWC/PART/CNCL and cancellation-process statuses, retain uncertainty. A terminal flag, callback or authentication never creates cash, marks an invoice paid or sets `reconciled`. Financial reconciliation still requires the existing independently confirmed matching evidence. Failed/unknown claims retain duplicate-payment protection.

## Storage, backup and compatibility

No historical migration or checksum changes are needed: the existing Community payment environment column is unrestricted TEXT, and immutable payment events already have bounded JSON detail storage. `sandbox_intent` stores the frozen economic request, application ID/revision and its integrity digest; status observations store only bounded codes/booleans. Application private keys stay in the existing protected identity vault. Flow state, authorization URL, callback errors/descriptions and raw confirmation tokens never enter financial history or backups.

Existing backup/restore removes confirmations and bank authority, downgrades active approvals/claims/acknowledgements, and preserves immutable economic evidence plus nonsecret provider IDs. Runtime rebuild invalidates ephemeral PIS flows; restored/restarted unknown claims can only perform verified GET status recovery, never recreate. The exact schema registry and JSON/SQL validators remain unchanged. Older releases can inspect the existing text environment/history representation, but PIS execution is supported only by this implementation; downgrading must not be used to initiate or recreate a sandbox claim. The current generic execution paths explicitly reject provider mismatch.

Focused synthetic qualification covers claim/audit rollback, single-attempt uncertainty, exact target/session/application bindings, callback replay/denial, auth/generation retirement, application replacement/removal during POST and GET, canonical amount/date/details/status checks, SQLite restart and actual backup → stage → activate with credentials/confirmation authority excluded. It does not use real provider accounts, production data or transfers. Normal application browser qualification is a separate required integration gate.
