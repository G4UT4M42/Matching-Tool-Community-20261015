# Localization policy

The Community Edition defaults to **English**. All end-user strings (buttons, headings, tooltips, error messages, validation instructions, accessibility labels and notifications) must be addressed by stable translation keys rather than hard-coded JSX text.

Use a typed message registry with `en` as required fallback. Store user language preference separately from financial data. Locale selection changes display formatting only: transaction IDs, signed integer cents, ISO dates, source currencies, original event timestamps, bank references and tax classifications are not rewritten.

If a key is unavailable in a selected locale, use the English message and emit a development-only missing-key warning. Never translate persisted enum values or API contracts.

Add a language selector after the bootstrap migration. When the real React UI is imported following privacy and license review, migrate one functional page group at a time and require a compilation test plus language-switch and fallback tests. No full product UI localization can be claimed from the scaffold alone.

Examples of namespaces: `common`, `navigation`, `matching`, `documents`, `reports`, `backup`, `migration`, `payments`, `settings`.

Dates/currency display should use `Intl` with explicit currency and timezone. Calculations always use signed integer minor units, never formatted strings.
