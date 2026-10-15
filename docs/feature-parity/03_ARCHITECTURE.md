# Architecture and financial invariants

Reuse the TypeScript/Express and React application; preserve reviewed source work rather than introduce an unrelated replacement. The existing global state and SQLite/JSON dual persistence require coordinated commits and recovery, not independent writes with optimistic success.

Initial required deployment is a Windows local-first installation with an explicitly provisioned owner. An instance is not a shared multi-tenant service: adding users requires isolated storage/credentials and resource authorization, not a user-id parameter over global state. Local browser access alone is never administrator authorization. Remote hosting must fail closed unless its TLS/origin/authentication mode is qualified.

Separate route registry, request validation, authentication/session, financial services, persistence and provider clients. Restrict file handlers to opaque IDs rooted under controlled storage. Use exact minor units and explicit currencies. Preserve source event identity, document bytes/hash, decision states and audit provenance. Proposals are not accepted accounting decisions. Import duplicates require stable event evidence, not fuzzy description matching. Payouts are transfers; fees/refunds must reconcile without double counting.

Store provider metadata separately from encrypted owner-scoped secrets; exclude all secret/session/payment approval material from backup and migration. Live-provider code has explicit environment boundaries; test/demo transports cannot invoke real transfers.

Restore/migrate through verified new stages and an atomic cutover; never overwrite an open SQLite database. Every persisted schema change requires executable historical migrations and crash/recovery tests.
