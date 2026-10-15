# Supported accounting report scope

Community reports reconcile entered evidence. The report engine is jurisdiction-neutral: it does not decide tax registration, place of supply, filing obligations, deductible eligibility, tax-code selection or a legally required accounting method. It does not generate an official jurisdictional VAT or income-tax return. Historical Austrian classification metadata is preserved by supported migration mappings; it is not converted into a new tax determination.

## Exact amounts and recognition

Every source amount is an integer in that currency's minor units. Currency precision is explicit. Reports keep currencies separate; they do not sum EUR, USD or other currencies into one amount. Reviewed foreign-currency allocations require an exact rational numerator/denominator and an evidence reference. Rounding is per documented source amount, half away from zero; aggregate arithmetic uses exact integers and overflow checks.

New payable invoices use positive face amounts; explicit credit notes use negative face/net/VAT amounts. Historical signed-cashflow documents retain their source convention. The settlement adapter determines payment direction without rewriting original amount, currency, source account or source reference. Refunds, provider fees and payouts retain distinct economic identities. Payout/transfer legs cannot become income merely because cash arrived in a bank account.

## Explicit classifications and VAT evidence

Income, expense, fee, refund, transfer, private and unclassified are explicit reviewed categories. Private and excluded transactions remain visible as separate categories. Accepted allocations must be undone before contradictory exclusion. Literal rules are bounded, ownership-aware and never execute historical regular expressions.

Document tax classifications are output, input, exempt, outside_scope and unclassified. Users enter reviewed VAT minor units, an exact rate and evidence; input-tax eligibility is an explicit user decision. Missing evidence remains unclassified. Reported tax values depend on eligible reconciled evidence in the selected period; an unconfirmed OCR suggestion or rejected proposal is not sufficient. Credit-note reversals retain their signed tax amounts. The software does not infer eligibility from a supplier name or a matching amount.

## Periods and exports

Reports select explicit start/end dates and expose transaction/document balances, reconciliation state, classifications, currency totals, VAT evidence and audit references. The dashboard's selected working period is a viewing preference; the report form's dates define the exported period. CSV and JSON retain exact minor-unit columns and currency identifiers. CSV escapes formula-looking text. Report numbers are reconciled against independently calculated synthetic expected values in accounting and integrated-browser tests.

## Review and recovery

Mutations record trusted actors, before/after evidence and stale-revision checks. Original source identifiers and bytes remain immutable. Restoring a financial backup preserves its historical accounting records; the separate identity audit records the restore operation and before/after state digests. Payment preparation/SEPA and simulated submission are independent from tax classification. No report operation initiates a transfer.
