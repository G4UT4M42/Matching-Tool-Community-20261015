# Security policy

This is a **pre-release private staging repository**, not a supported production application.

Do not report issues by attaching real transactions, invoices, bank-account details, customer identities, API tokens, browser profiles or database snapshots to a public issue. Provide reproduction steps with generated synthetic data and neutral placeholders.

Security boundaries for release: local-only HTTP binding by default; authenticated and CSRF-protected state-changing routes; restrictive file roots; least-privilege secret handling; verified WAL-safe SQLite backups; staged offline restores; owner-confirmed real-money actions; denial of automatic retries for ambiguous bank status; rate, file-size and resource limits.

A security issue that may expose credentials, financial records or authorize payments is a release blocker. Do not bypass failing tests by disabling protection.

Upstream asset/license and dependency-vulnerability audits are still required before first publication. Security contacts and disclosure handling will be configured before public visibility is enabled.
