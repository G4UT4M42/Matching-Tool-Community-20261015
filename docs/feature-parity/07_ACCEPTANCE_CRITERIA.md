# Acceptance and evidence rules

Allowed package states: NOT_STARTED, IN_PROGRESS, IMPLEMENTED, TEST_FAILED, BLOCKED_EXTERNAL, SOFTWARE_PASS, RELEASE_ACCEPTED. SOFTWARE_PASS requires reproducible unit/API/browser/negative/financial evidence as applicable, exact commit and no unresolved application defect. Mark a category NOT_APPLICABLE only with an explicit reviewed rationale. RELEASE_ACCEPTED requires all linked release gates.

Each F01-F21 must have source-backed behavior, real reachable authorized UI/API, safe validation, durable state, financial reconciliation, restart and negative security evidence. A mock provider is not a sandbox account. A staged migration is not activation. A simulated payment is not executed money movement. A scan pass is not independent privacy/licensing approval.

No personal financial records are used. No owner credentials or private Git history are included. No production installation changes. Public visibility is separately owner-approved. Release remains NOT_READY while any mandatory capability or gate lacks evidence.
