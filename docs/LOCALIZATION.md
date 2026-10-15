# Localization and financial display rules

## Current state

English (en) is the default language. German (de) can be selected in the React Community UI. Both are registered in web/src/i18n/locale.tsx. The language preference is stored under a dedicated browser localStorage key rather than inside the economic transaction state.

Main navigation messages have been translated. Many inner screens, validation errors, tooltips and accessibility strings have not yet been moved into the registry. Therefore full multilingual UI release qualification is NOT_READY.

## Translation registry

The registry uses stable dot-separated keys, for example navigation.transactions and settings.language. The English catalog is required; non-English catalogs may be partial and fall back to English. Runtime registration of additional locale codes is supported using the registerLocale function, provided all keys are recognized by the English catalog.

Adding new end-user messages requires corresponding English translation keys, German mappings where applicable, and tests for fallback. Do not embed user-visible prose directly in JSX when a translation key can be used.

## Invariants

Locale changes alter presentation only; never rewrite financial values, decimal minor units, currencies, source event IDs, fiscal periods, timestamps, accepted/proposed match status or tax classification. Use Intl.NumberFormat and Intl.DateTimeFormat with explicitly supplied source currency/timezone; do not parse formatted strings back into financial numbers.

## Missing qualification

Full accessibility labels, pluralization, locale-aware input validation, date/currency formatting coverage, missing-key reporting, all dialog/error text and end-to-end locale switching remain open. These must have reproducible tests before claiming an English-complete or multilingual release.

See I18N_POLICY.md for the mandatory contract.
