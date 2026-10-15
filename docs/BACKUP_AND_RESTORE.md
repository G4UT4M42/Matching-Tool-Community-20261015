# Backup and restore safety

**No fully qualified backup/restore of real financial installations exists in the current Community preview.** Do not treat a copied database file or JSON export as a complete recoverable accounting dataset.

## Stores to preserve

The Community runtime may contain SQLite in WAL mode, JSON state, invoice evidence bytes, imported source events, audit history, payment records and user settings. Some stores are transactionally independent. A successful backup of one store does not prove that references across all stores belong to the same logical instant.

## Mandatory design for a supported backup

1. Require an explicit maintenance/quiescence state preventing writers from changing SQLite, JSON state or attachments while taking a cross-store snapshot.
2. Use a SQLite online backup/checkpoint mechanism that correctly includes committed WAL records. Never copy the active main .db file alone and claim atomicity.
3. Record a generation/epoch covering SQLite, JSON and every attached binary. If the epoch cannot be guaranteed, mark the backup UNVERIFIED and block activation/restore.
4. Write the snapshot to a new restricted temporary destination. Calculate SHA-256 for every artifact and a manifest with application/storage schema versions, counts, amount totals and relationships.
5. Ensure enough disk space, handle interruption, fsync as appropriate, and publish only an independently verified completed generation.
6. Exclude bank secrets, login sessions and approval credentials from any portable backup. Require reconnect rather than copying sensitive sessions.
7. Encrypt or otherwise securely restrict any backup containing real users' financial information. Public issue trackers and CI are never valid storage destinations.

## Mandatory restore procedure

Restore only while the target application is stopped or safely quiescent. Validate manifest hashes, supported versions, complete attachments, database integrity, foreign keys and signed financial totals before applying any change. Restore into an isolated staging candidate and atomically switch the active pointer only after a complete successful verification. Retain the previous generation and original until the owner explicitly chooses retention.

Never overwrite an open SQLite file. A failed restore must leave the current active dataset unchanged and provide a deterministic recovery explanation. UNKNOWN payment states must remain locked; software recovery may not retry payments.

## Current scope and tests

The offline V2 staging adapter and staged verifier exercise WAL-aware copying, hash verification, and integrity checks on fictional fixtures. They do not certify the consistency or restore of a live multi-store installation. Full corruption, disk-full, backup/restore and crash-recovery matrices remain mandatory release blockers.

If you currently possess real finance data, use your existing verified backup procedure for the original system rather than the Community preview.
