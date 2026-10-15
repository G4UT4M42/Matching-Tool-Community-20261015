# Community persistence implementation (isolated worker)

This implementation is scoped to synthetic Community runtimes. The integration owner must mount the router and React page, provide account authorization and coordinate server state before a release build.

## Storage capability

SQLite `user_version=2` is the current schema. Migration `community-sqlite-v2-statement-journal` adds `community_storage_capabilities(capability, capability_version)` with one row: `statement-journal-v1`, version `1`. Its source digest is computed from the fixed DDL and capability name. The v1 migration row, v1 SQL sources, and its checksum are untouched. The v2 row records the full physical schema hash. A v1 application rejects `user_version=2` before DDL. This is the downgrade barrier for coordinated SQLite/JSON statement imports. JSON remains `matching-community-state-v1`, schema version `1`.

The exact upgrade graph is `0 -> 1 -> 2`. An unversioned existing database is refused; only a genuinely new file may enter edge `0 -> 1`. Edge `1 -> 2` verifies the v1 checksum and physical schema before a single SQLite transaction creates the capability and ledger row. A pending statement journal blocks this edge. A v2 database with a pending journal may open so the existing journal recovery routine can run before `loadState`. Future versions and unexpected ledger rows fail closed. Attachment contents are independently hashed in backup manifests; they have no database schema number.

## Backup and restore

`createCommunityBackup(root, withExclusiveAccess)` requires the injected lock to quiesce every JSON, SQLite and document mutation until the function resolves. It rejects a pending statement journal and linked source paths. SQLite's online backup API captures committed WAL frames; the snapshot is scrubbed of settings credentials, browser profiles, portal credential references and payment automation approvals, vacuumed, integrity checked and compared with the JSON financial transaction IDs and signed currency totals. The ZIP uses STORE entries only, with path, type, count, per-file and archive size limits. The manifest contains schema versions, sizes, SHA-256 hashes, counts, match statuses and signed minor-unit totals. Only `database/matching.db`, `state/state.json` and referenced document bytes enter the archive.

`stageCommunityRestore` validates the ZIP, every hash, JSON relationships, document hashes, SQLite ledger, integrity, foreign keys and financial identity before writing a private stage. Activation requires the exact stage fingerprint and unchanged target fingerprint. `safeActivate(change, rollback)` must stop requests and background writers, close every SQLite connection and state cache, invoke `change`, then reopen and reload the new dataset. It must call `rollback` if reopen fails, reopen the previous dataset, and reject. The restore operation journal remains until successful reopen. Call `recoverInterruptedRestore(runtimeRoot)` before any normal database open on process startup. A successful activation retains `.restore-previous-<id>` for owner-controlled rollback; it contains the earlier accounting dataset and requires the same local file protections.

The ZIP reader rejects compression, ZIP64, duplicate entries, symlink attributes, traversal, extra records and checksum failures. Archive size is bounded to 512 MiB, each member to 256 MiB. Larger installations require a reviewed streaming successor format.

## Legacy conversion

The local server selects legacy source roots through `legacySources()`. HTTP bodies contain only a server-issued source ID and a fingerprint; no path parameter can address an arbitrary file. `inspectLegacy` runs the reviewed offline importer read-only and fingerprints source bytes. `stageLegacyConversion` requires that fingerprint again, verifies the offline stage, maps populated source tables and every non-null field to a fresh Community v2 schema, retains financial IDs, match links, audit events and attachment hashes, and refuses unknown populated tables or fields. Settings credentials and payment automation approvals are removed. The candidate becomes a normal Community backup and passes the ordinary staged restore verifier. Source bytes are compared before and after. Unsupported historical layouts are a precise refusal, never an inferred parity claim.

## Windows package

`Install-Community.ps1` consumes a previously built local package and copies only application assets to a separate installation directory. `Start-Community.ps1` requires an explicitly supplied external `DataDirectory`, checks Node 22 ABI 127 and native `better-sqlite3`/`sharp` loading, binds loopback, and sets `MATCHING_AUTH_MODE=accounts`. `Upgrade-Community.ps1` swaps application binaries after an explicit stop indication and retains previous binaries; the external data directory is never moved. No script downloads a runtime, installs global software, changes PATH, or logs secrets. Node 22.16.0 is the current test checkpoint, not an indefinite security pin; releases need a supported current Node 22 patch and rebuilt native modules. Node's official distribution and license must be used if a future portable runtime is packaged.

## Known integration gate

The current shared `server/index.ts` still requires the developer preview token and initializes demo state. The account-auth supervisor must replace that gate and mount the persistence router. The current shared `web/src/main.tsx` must mount the new page in navigation. Until then, this worker's adapter and page are independently testable but do not claim product release readiness.
