# Storage and migration coverage

Required entities: transactions, accounts, immutable source-event identifiers, invoices, attachments/hash, match groups, accepted/rejected/proposed/manual decisions, rules, tax classifications, dispositions/exclusions, audit history, payment history, provider metadata, report periods and provenance.

Never transfer passwords, client/API secrets, access/refresh tokens, cookies, browser/bank sessions or stored payment approvals. Produce a reconnect checklist.

Qualify empty install, current schema reopen, each historical edge, skipped-version chain, unsupported newer schema, checksum drift, corrupt/missing attachment, broken relationships, interrupted copy/migration/activation, disk full and rollback. Reconcile counts and exact signed totals separately per currency and event category. The original dataset must retain identical hashes.

The existing offline importer provides staging only. Complete entity coverage, guided comparison, activation and recovery remain P13 work; do not label the historical staging result full migration.
