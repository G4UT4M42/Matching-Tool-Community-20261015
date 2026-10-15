# Legacy Matching Tool V2 import guide — development preview

**There is no supported live-data import in this version.** This guide describes the isolated synthetic offline staging tool and the prerequisites for a future user-facing wizard. Do not point the command at the owner's real installation, finance files or running database.

## Preview of a fictional fixture

Use only a fixture generated specifically for development, outside both the protected V2 repository and public Git. The legacy fixture layout must contain a supported SQLite database, JSON state and matching fictional evidence documents. The adapter intentionally rejects unknown tables and sensitive fields.

1. Shut down every writer attached to the synthetic source and confirm it is not being modified.
2. Choose a new, nonexistent local staging destination.
3. Use the dry run first:

~~~powershell
node scripts/import-legacy-v2.mjs --source SYNTHETIC_SOURCE_FOLDER --destination NEW_EMPTY_FOLDER --source-offline-confirmed
~~~

4. Inspect the reported counts, signed cent totals, missing attachment references and unsupported fields. Any refusal is a safety result, not permission to weaken validation.
5. For an approved fictional fixture only, repeat with --stage. It writes a separate candidate and verifies the manifest:

~~~powershell
node scripts/import-legacy-v2.mjs --source SYNTHETIC_SOURCE_FOLDER --destination NEW_EMPTY_FOLDER --source-offline-confirmed --stage
node scripts/verify-offline-stage.mjs --stage NEW_EMPTY_FOLDER
~~~

The importer NEVER activates the staging folder or starts bank/payment drivers. It NEVER modifies or repairs the original source. Do not move the staged database into a running application.

## Validation performed today

The adapter confirms supported source shape, WAL-aware SQLite copy for the fictional fixture, allowed tables/settings, absence of reviewed credential-like fields, JSON relationship consistency, document hashes and proposal/acceptance identities. The separate verifier checks staged hashes, file inventory, SQLite integrity, document artifacts and signed minor-unit summary.

## Critical limitations

The --source-offline-confirmed option represents an operator assertion; it does NOT independently prove every source writer is stopped. There is no certified cross-store epoch, atomic cutover, arbitrary version mapping, guided UI wizard, cleanup-after-crash protocol or rollback of an activated user dataset. Credentials cannot safely be migrated and must be reconnected. The adapter may temporarily contain unsanitized SQLite bytes during staging; never use real data.

## Future supported journey

Inspect → supported version detection → write quiescence → verified safety backup → dry-run migration → owner review of differences → staged transform → hash and financial reconciliation → owner confirmation → atomic candidate activation → restart qualification → rollback pointer support.

Until every gate is implemented and independently reviewed, the release must refuse real legacy import. For version-by-version requirements see MIGRATION_POLICY.md and LEGACY_IMPORT_SPEC.md.
