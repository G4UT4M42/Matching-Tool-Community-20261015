# Statement date semantics and rejected-save recovery

Migration-Required: no
Rationale: Booking, value and card transaction dates use existing canonical posting_at, value_at and extensible transaction metadata. Existing source IDs and historical rows are never rewritten. UI draft recovery changes no persisted schema, SQLite migration checksum or JSON capability version.
Rollback: Stop the candidate and retain its complete isolated generation. Reopen the prior qualified binary only with its own verified matching backup; never reinterpret or rewrite original source fields to force reimport.

Booking aliases are checked within one semantic field. Sparkasse prefers booking, generic, value then card transaction date; Visa prefers booking, transaction, generic then value date. Distinct value dates remain value_at and card dates remain statement_transaction_at. Duplicate headers, competing same-field aliases and malformed secondary dates still reject.

Rejected split/transfer saves retain all staged legs and values. Stale revisions refresh source state before a retry. Synchronous in-flight exclusion prevents duplicate submissions. A confirmed write clears submitted drafts even when follow-up reads fail; uncertain outcomes require explicit reload and inspection and cannot be immediately replayed.

Independent focused qualification: six Vitest entrypoints79/79 and an actual React/Chromium failure-injection regression1/1. Evidence remains under candidate-acceptance/functional-closure-review-01. These source iterations precede final complete candidate qualification.
