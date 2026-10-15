# Source-backed feature matrix

Updated 2026-10-14 after the integrated 254-test qualification and real account-mode browser journey. All 21 original areas remain mandatory. No area is RELEASE_ACCEPTED yet. An implemented component or mock-adapter test is not a complete normal-user workflow.

|ID|Capability|Work packages|Current implementation and evidence|Remaining integration/acceptance|
|---|---|---|---|---|
|F01|Transactions, accounts and dashboard|P02-W01,P06-W02,P08-W01|Real account creation/login/roles, persisted transaction reads and normal browser navigation tested|Remaining dashboard controls, complete source parity and all role-specific views|
|F02|Bank CSV/XLSX imports|P06-W01,P06-W02|Exact Sparkasse/Visa parsing, source identities, cross-store crash recovery and actual account-browser preview/confirm/discard tested|Additional required source formats, complete preview conflict explanation and final installation matrix|
|F03|PayPal/Stripe imports|P04-W01,P04-W02,P05-W01,P05-W02|Owner-scoped credential vault, official fixed-endpoint clients, paging, fees/refunds and mock-provider tests pass|Durable accounting callback, normal UI activation, actual configured account binding and separately authorized provider sandbox/live evidence|
|F04|Documents and invoices|P07-W01,P07-W03|Bounded upload, recognition/review, content-addressed attachment and synthetic browser component implemented|Normal UI, shared durable state/attachment transaction, full backup and archival consistency|
|F05|Automatic matching|P08-W02|Deterministic exact proposals, source-document settlement interpretation and retained rejection history tested|Mount normal accounting controls behind shared durable coordinator; full source-backed rule coverage|
|F06|Manual matching and review|P08-W01|Actual browser accept/reject/reopen/manual/undo/restart tested; original source signs preserved|Unify JSON/SQL writes and complete allocation-aware main review workflow|
|F07|Refunds, splits and FX|P08-W02|Partial/split balances, exact FX ratios, original face-value versus cashflow conventions, fees and transfers tested|Normal account UI integration and complete end-to-end cross-source reconciliation|
|F08|VAT/income reports and exports|P09-W01,P09-W02|Exact per-currency reports, explicit classifications, no inferred tax eligibility and export tests pass|Mount qualified reports in normal UI, full document/fee/payout reconciliation and declared jurisdictional scope|
|F09|Exclusions/private transactions|P08-W02|Bounded literal exclusions, explicit private classification and accepted-allocation protection tested|Normal UI and durable audit/state coordination|
|F10|OCR and recognition|P07-W02|Actual synthetic OCR and standalone document browser tests pass|Normal UI/attachment lifecycle, packaged offline language assets, performance and format matrix|
|F11|Invoice Bot|P10-W01,P10-W02|Local mock portal discovery/import/cancellation, session boundary and standalone browser tests pass|Supported commercial adapter inventory, normal UI, protected user session storage and separately authorized live-provider qualification|
|F12|Payment preparation/SEPA|P11-W01|Synthetic candidates, exact sums, validation, XML, review/approval, duplicate-prevention and standalone browser tests pass|Register payment schema and normal UI; backup/history/candidate relationships in main dataset|
|F13|Authorized bank payment execution|P11-W02|Mock one-use transaction approval, recent-auth guard, persisted claim, unknown-outcome and no-retry tests pass|Supported actual provider/consent qualification and explicit live authorization; automated tests never execute real transfers|
|F14|Settings and user integrations|P02-W01,P03-W01,P03-W02,P06-W03|Actual account/password/role UI and protected provider credential components implemented|Mount normal integration configuration, durable sync, account-bound provider identity and complete settings replacement|
|F15|Audit history|P08-W01,P09-W02,P12-W02|Import/account events and component accounting/payment audit tests pass|Full append-only shared SQL/JSON event history across every normal workflow and restore|
|F16|Backup/restore|P12-W02|Prior five sign-related regressions fixed; WAL snapshot, staging, rollback and isolated browser component pass|Exact per-record cross-store equality, JSON v2 allocations, content-addressed document/index support, integrated interruption tests|
|F17|Legacy V2 migration|P13-W01,P13-W02|Synthetic source-immutable staging, IDs/links/amounts and original positive invoice/debit associations now pass|Complete V2 table/field inventory, normal UI and all version/attachment/history cases|
|F18|Versioned persistence/upgrades|P12-W01|Immutable baseline plus explicit SQLite v2 capability upgrade and failure rollback verified|Registered payment/generic-state migrations, coordinated JSON v2 evolution, full future/downgrade barriers|
|F19|English/German UI|P14-W01,P14-W02|Actual account/login/password/role/import language switching and existing review controls tested|Remaining pages/errors/accessibility labels, responsive and keyboard matrix|
|F20|Independent installation|P18-W01|Actual normal Windows launcher with one-use setup code and Unicode external storage passed; synthetic installer/upgrader passed|Complete clean distributable installation, packaged assets/dependencies, update/uninstall qualification|
|F21|Complete synthetic demo/regression|P15-W01,P15-W02,P16-W01,P16-W02,P16-W03|All 254 current TypeScript tests pass together; actual account and synthetic review browser paths pass|One complete 21-area normal-user journey, final exact-commit regression, security/privacy/license/CI and private release|

Feature status remains **IN_PROGRESS** where an integrated or release gate above remains open. See `STATUS.md` for exact result files and avoid adding overlapping test counts.

The original source audit is `../release-program/FEATURE_PARITY_AUDIT_20261013.md`. Prior INTENTIONALLY_EXCLUDED for F13 is superseded: implement the safe authorization workflow and independently qualify legitimate provider support; real-money actions remain separately authorized.
