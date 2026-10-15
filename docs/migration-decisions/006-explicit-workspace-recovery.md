# Explicit recovery into a new local authentication workspace

Migration-Required: no
Rationale: Exact document recovery grants use version1 extensible canonical audit metadata within registered SQLite4/JSON2. Historical ownership, source IDs, financial values, attachment paths and migration checksums remain unchanged. Request generations are in-memory lifecycle authority and do not change the persisted format.
Rollback: Stop the candidate, retain the complete current generation and identity audit, and restore the prior verified full backup with its matching qualified binary. Use registered journal recovery after interruption. Never rewrite historical sources, grant metadata or migration checksums to make an older reader accept this candidate.

## User-visible recovery contract

Financial restore first verifies the exact old canonical SQLite/JSON and original
attachments. The receiving identity store remains separate. The current owner
then explicitly inspects foreign originals and confirms their exact fingerprint,
receiving workspace and current owner subject with recent authentication and
CSRF. The separate adoption appends a versioned audit grant; it does not rewrite
original source/owner metadata, source bytes or prior financial history.

The exact records become available to the receiving workspace's existing
permission model. The authorizing owner remains in fingerprint/audit evidence.
Other workspaces and ungranted IDs remain inaccessible. Unconfirmed originals
remain unconfirmed. Recovery verifies source hashes, immutable review identity,
financial/payment/type consistency and source conventions, with explicit rejection
of conflicting or ambiguous evidence. Unknown populated structures require
separate mapping rather than guessed ownership.

Previously active/unknown payment items remain blockers across the original
workspace and every exact prior adoption namespace, including A→B→C
and return-to-A recovery. A retired legacy identity digest grants no document
access. Its strictly validated document ID, original workspace and blob hash
remain conservative payment-history/deduplication evidence after a new strong
adoption. Wrong IDs, hashes, source workspaces, actors or extra fields reject.
Read-only history is explicitly scoped to currently strongly adopted
record/hash identities. Old batches and approvals do not gain mutation authority
in the receiving workspace. Provider identities, secrets and portal namespaces
are not granted. Future provider connections need their own supported proof.

## Lifecycle isolation

Every request captures its data generation. Before cutover, only the exclusive
restore owner's own context advances to the next generation; older asynchronous
work is retired even if the client already disconnected. Exclusive operations
reject writes by unrelated contexts while allowing the owning verified operation.
Nonfatal rollback reopens the prior exact dataset and rebuilds every database-
bound service. The same restoring context can finish success/failure audit.

Independent actual-app regressions reproduce both original failures and pass
3/3 after repair: nonfatal cutover rollback retains exact canonical state plus
working payment/bank reads; an aborted provider cannot change restored state or
encrypted checkpoints; a held real SQLite backup excludes the stale operation
and yields a fully verified SQLite/JSON archive. Evidence remains in
`candidate-acceptance/workspace-lifecycle-01`. The five-second
post-transport observation is a measured schedule, not proof of every timing.

## Compatibility and qualification

Old readers can parse physical formats but do not implement these access grants
or lifecycle guarantees; they are not a qualified downgrade path. Original
financial data and review strings are preserved. No released production dataset
was upgraded during implementation. Full exact-candidate application, installed
browser and security verification remain mandatory. New focused source and
normal two-owner browser evidence remain under functional-closure-review-01 and
workspace-recovery-main-02; these are scoped iterations until the final freeze.

The final recovery module's focused nine-file suite passes81/81 with backend
typecheck. Independent final compatibility qualification passes45/45 plus
typecheck, including the actual old unknown-outcome SQLite payment batch.
Exact module SHA256 is97084264468fd9bc704cc09ac238fcdbd3d4ba0ad0d652b3bcc641f69c544ff0.
Reports: functional-closure-review-01/recovery-legacy-payment-handoff.json and
independent-security/workspace-recovery-compatibility-independent-final-01.report.json.
