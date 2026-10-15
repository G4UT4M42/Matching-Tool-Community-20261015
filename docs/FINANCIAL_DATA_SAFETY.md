# Financial data safety

**This Community build must not be used for real bookkeeping, payment release, tax filing or financial advice.** The available data is synthetic and the application remains a preview.

## Economic evidence

A matching proposal is a suggestion, not accounting approval. Only explicitly accepted matches meeting evidence constraints may qualify for validated report calculations. Preserving a transaction relationship is not sufficient evidence for input-VAT deduction; VAT rates, jurisdiction and invoice support must be reviewed.

Monetary comparisons must use signed integer minor units per source currency. Do not silently net refunds against charges without respecting signs and underlying source identities. Currency conversion and tax period rules require recorded version, original currencies and explicit provenance.

## Sensitive data boundaries

No real IBANs, bank logins, customer/supplier identities, browser profiles, OAuth secrets, payment authorizations or invoice PDF files may be committed to this repository or used as public fixtures. Synthetic fixture names, amounts and source events must be generated independently.

A sanitized stage manifest is not proof that arbitrary source fields contain no credentials. Unknown legacy schemas and unclassified JSON/SQLite metadata must fail closed. Secrets and tokens are excluded from any future migration; users must reconnect services separately.

## Payment safety

Demo Mode cannot trigger real banking action. Claims such as UNKNOWN, UPLOAD_ATTEMPTED or RELEASE_CLAIMED must never be retried automatically without reconciled independent bank evidence and explicit owner authorization. A software restore must not replay a financial instruction.

## Backups and upgrades

SQLite, JSON state and filesystem evidence are independent stores. Copying an active SQLite main file or only backing up JSON is not a guaranteed consistent backup. A safe backup requires validated WAL handling and a coordinated quiescent epoch. Restore must not overwrite open files or modify the protected original V2 installation.

## If something goes wrong

Stop use and preserve the original records. Do not delete unknown databases or payment logs to recover a green test. Use the restricted private incident process in SECURITY.md, with synthetic reproduction where possible. Financial totals that cannot be reconciled exactly must block activation and release.
