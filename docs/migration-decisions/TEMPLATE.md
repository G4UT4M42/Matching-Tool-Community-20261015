# Persisted contract change decision

Migration-Required: yes
Rationale: Explain which stored data, files, IDs and financial semantics changed, including older installations.
Rollback: Keep original immutable and revert the destination pointer to the previous validated generation.

## Changed data contract
Describe old and new schema plus precise supported version edges and dependency order.

## Verification
State migration IDs, synthetic old/new fixtures, integer-cent equality, matched/accepted status preservation, attachment hashes, all foreign keys, failure injection and restart/idempotency test IDs.

## Reviewer
Independent security/financial reviewer, date, remaining risks and owner gate.
