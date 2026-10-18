# Sandbox payment target and immutable intent compatibility

Migration-Required: no
Rationale: The registered SQLite v4 schema, canonical JSON v2 and historical migration checksums are unchanged. Existing payment tables already store provider/environment as TEXT and immutable event detail as JSON. The new explicit `enablebanking-pis`/`sandbox` target and version 1 economic intent use those contracts without rewriting existing batches or financial evidence.
Rollback: Stop the isolated candidate and retain its full data generation. Use a verified financial backup with the matching qualified reader. Do not use a prior release to submit, recreate or continue authorization for a sandbox claim. Restore or downgrade never grants payment authority, and unresolved remote claims must remain active until independently reviewed.

## Persisted contract

Selecting sandbox mode at batch creation binds provider `enablebanking-pis` and environment `sandbox` into the existing detail digest before validation, review and approval. Existing simulator targets are unchanged. The current generic confirmation, submit and provider-status paths reject an adapter mismatch before consuming confirmation or making a provider call. No target is inferred from an old connection or silently promoted to production.

An atomic submission claim appends `sandbox_intent` to the existing immutable Community payment event table. Its `intent.version` is exactly `1`. The economic projection binds batch digest, exact debtor/creditor/integer amount/reference/instruction IDs, selected bank/PSU type, application ID/revision, frozen execution date, SLEV and nondeferred submission. The reader reconstructs the exact supported version 1 projection and integrity digest. Missing/unknown intent versions, changed content or ambiguous duplicate intent records are rejected as `PIS_INTENT_UNAVAILABLE`; they are never treated as version 1 by default. A future version requires a new explicit compatibility decision.

Nonsecret provider payment IDs and bounded aggregate/per-instruction status observations remain durable evidence. Callback receipt, final flag or provider status never creates cash or confirms accounting reconciliation. Exact final ACCC may become provider acknowledged only after complete request comparison and any supplied instruction-status consistency check. Unknown, pending, changed, partial and cancellation statuses do not become financially paid. Production initiation is hard-disabled.

## Excluded authority and reconnect policy

Application private keys remain in protected identity storage. Raw confirmation tokens, authorization URLs, one-use callback state and provider callback descriptions never enter financial history or backup. The process-local application mutation generation is a retirement fence, not portable authority; it advances with the final successful credential mutation, and all ephemeral flows are discarded at restart/restore.

Existing backup/restore removes confirmations and bank connection authority, invalidates approvals and downgrades actionable claims/acknowledgements while retaining immutable economic history and nonsecret remote IDs. A restored/restarted unknown PIS claim can only fetch status for its known ID after the owner supplies a freshly verified matching sandbox application. Missing ID means explicit external inspection and no automatic resubmission. A local denial/cancel receipt does not prove that the remote payment was cancelled. Active document claims therefore continue preventing duplicate payment creation.

Older readers that do not understand this PIS intent are not qualified to execute it. The physical TEXT/JSON representation does not constitute an execution-compatibility promise. Historical inspection must preserve the unknown target and original economic records rather than substitute the simulator or live provider. No historical migration/checksum or original source generation is modified by this decision.

## Verification and review

`tests/community-sandbox-payments.test.ts` exercises exact target confirmation, durable claim/audit rollback before the sole POST, transport uncertainty and no recreation after restart, callback denial/replay/expiry, permission/session/generation retirement, application replacement/removal and stale asynchronous read fencing, exact decimal/date/economic comparisons, all documented status codes and instruction-status contradictions. It verifies the real protected-vault generation advances only on successful final mutation. The actual backup → inspect → stage → activate test retains sandbox intent/provider ID, removes reusable authority and resumes using GET only against the unchanged schema and canonical SQL/JSON validators.

The existing payment, API and AIS consent regressions remain required. Independent financial/security review and exact committed normal-application/full-suite qualification are separate gates; this decision is not a claim of provider registration, sandbox account acceptance or real-money execution.
