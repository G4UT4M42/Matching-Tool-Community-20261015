## Change summary
What changed, why, and what is the impact on financial records and user accounts?

## Privacy and security
- [ ] No real identities, invoices, account numbers, sessions or secrets in source, commits, fixtures or logs
- [ ] Tests use synthetic records and fake payment drivers only
- [ ] Original stored records, document hashes and approval semantics are protected

## Persisted compatibility
- [ ] No persistence/interface change; reason below
- [ ] OR a migration decision is included in `docs/migration-decisions/`
- [ ] If required: executable forward migration, old/new fixtures, restart + idempotency tests, rollback runbook
- [ ] Historical payment UNKNOWN/PENDING states are never automatically retried
- [ ] Original installation remains untouched until explicit activation

## Verification
Commands and exact PASS/FAIL counts, compiler/build evidence, dependencies, screenshots using synthetic data only, reviewer and limitations.

## Owner gates
Any external deployment, real data migration or live bank action requires separate explicit authorization.
