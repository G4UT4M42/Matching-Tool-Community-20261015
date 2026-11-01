# Security policy

Matching Tool is a development preview. No stable production release has been
issued. Report problems against the latest `main` revision and identify the
exact version, affected component and environment.

## Report a vulnerability privately

Use GitHub's [private vulnerability reporting form](https://github.com/G4UT4M42/Matching-Tool-Community-20261015/security/advisories/new).
Include reproduction steps using synthetic data and describe the expected and
observed security boundary. Do not publish an exploit or sensitive details in
a public issue while a fix is being assessed.

Never attach real transactions, invoices, bank-account details, customer
identities, API tokens, browser profiles or database snapshots to issues,
pull requests or security reports. Use generated fictional examples and
neutral placeholders. Do not test against another person's installation or
live bank/provider accounts.

## Security boundaries

The application binds to loopback by default. It uses authenticated and
CSRF-protected state-changing routes, restrictive file roots, role checks,
protected provider credentials, WAL-safe backups and staged offline restores.
Invoice portal browser sessions are isolated. Live bank payment submission is
disabled; simulated ambiguous outcomes remain locked rather than automatically
retried. Size, rate and resource limits are part of the security contract.

Changes that expose credentials or financial records, bypass permissions or
authorize unintended financial actions require a fix and regression evidence.
Do not disable protection or weaken an assertion to make a check pass.

CI checks the source privacy gate, synthetic financial and browser tests,
build/typechecks, migration obligations, dependency inventories and root and
frontend dependency advisories. Passing CI does not certify every deployment
or third-party service. See the [source review](docs/compliance/PUBLIC_SOURCE_REVIEW.md)
and [release process](docs/RELEASE_PROCESS.md) for their exact scope.
