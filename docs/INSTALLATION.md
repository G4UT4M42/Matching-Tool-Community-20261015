# Windows installation and maintenance

The current artifact is a private development candidate. Account-owned workflows
are implemented, but redistribution, clean-machine and final release gates are
not accepted. Automated qualification uses newly generated fictional data.

## Install and start

Use the self-contained package produced by `scripts/package-community.mjs`.
It includes the qualified Windows x64 Node 22.23.3 runtime (ABI 127), native
modules, English/German offline OCR data, built UI and required legal metadata.
A source checkout, npm, developer-specific runtime paths and administrator
installation are unnecessary for this package.

Choose absolute, independent application and data directories. The data directory
must not contain an existing unrelated or productive V2 installation.

```powershell
powershell -NoProfile -File <package>\scripts\Install-Community.ps1 -PackageDirectory <package> -InstallDirectory <application> -DataDirectory <data>
powershell -NoProfile -File <application>\scripts\Start-Community.ps1 -DataDirectory <data> -Port 3433
```

The installer verifies the complete file manifest and legal bundle before
activation. The launcher selects bundled Node, checks native loading, binds
loopback and displays a temporary local setup code. Open the printed local
application address, enter that code and create the first owner with a unique
passphrase. Later starts use normal account login. English is the default;
German is selectable. Codes and passwords must not enter issue attachments.

Account settings provide password confirmation/change and owner-managed roles.
Bookkeepers can import, reconcile and prepare payments; payment approvers can
review the protected authorization flow; viewers receive read-only controls.
Role checks are also enforced by the server.

## User-owned integrations and banking

Normal settings expose PayPal app credentials, a restricted read-only Stripe key,
and read-only Enable Banking AIS application/session fields. These are encrypted
under the Windows user and scoped to the workspace/account/environment.
PayPal/Stripe financial identities use provider-confirmed merchant/account IDs.
Never use a personal account password as an API credential. Live authorization,
provider registration and actual document availability require the owner's
provider access and remain separately unaccepted.

Invoice Bot opens a new isolated browser profile for explicit user login and
PDF/image download. It never imports an existing browser session. The user
selects completed downloads for review. Eight provider workflows are declared;
see [the source inventory](feature-parity/INVOICE_PORTAL_INVENTORY.md).

SEPA drafts and XML export are separate from bank account information. Submission
in this candidate is a local simulation and cannot contact a payment bank.
An unknown simulated outcome retains its durable claim and cannot be resubmitted.

## Backup, restore and legacy migration

Use Backup and migration to create/download an attachment-inclusive verified ZIP.
Restore stages and compares it before explicit activation. Credentials, browser
sessions, reusable approvals and authentication databases are excluded. Existing
local account identity remains independent of financial restoration.

The migration wizard accepts offline source layouts `database/matching.db` plus
`state/state.json`, `data/matching.db` plus `data/state.json`, or `matching.db`
plus `state.json`; evidence belongs under the reviewed `documents` or `Belege`
root for that layout. Select a source, inspect/dry-run, review the mapped counts
and signed currency totals, stage (which creates a prior backup), then explicitly
activate. Supported records and original attachment bytes are preserved; paths
are deterministically rebased. Unknown populated registries or fields reject
with an explicit mapping error. No productive V2 data was used for qualification.
Keep the source offline and unchanged throughout migration.

## Upgrade and uninstall

Stop the owned application normally before maintenance. Preserve a verified
financial backup and retain the independent identity directory securely.

```powershell
powershell -NoProfile -File <package>\scripts\Upgrade-Community.ps1 -PackageDirectory <package> -InstallDirectory <application> -DataDirectory <data> -ConfirmStopped
powershell -NoProfile -File <application>\scripts\Uninstall-Community.ps1 -InstallDirectory <application> -DataDirectory <data> -ConfirmStopped
```

Upgrade retains previous binaries and accounting data. Uninstall validates its
marker and directory tree, refuses junctions and removes application files only;
accounting data and separately retained previous versions remain. A busy process
or failed integrity check preserves the installation for recovery. Never stop an
unrelated process to free a port.

## Qualification and package gates

The installation regression passed 5/5 checks on the target Windows host:
fresh install, bundled native/OCR loading, first-owner setup, upgrade,
restart/login, exact retained data hashes, uninstall and junction rejection.
The full synthetic browser journey also passed from a freshly installed package.
These are intermediate candidate runs; final exact-commit acceptance and a clean
Windows VM remain separate gates.

See [packaging and compliance details](compliance/PACKAGING.md),
[MIGRATION_POLICY.md](MIGRATION_POLICY.md) and the current
[implementation checkpoint](feature-parity/packages/FINAL-P03-integrated-acceptance.md).
The builder rejects distributable mode while ownership, corresponding-source,
relink and required attribution gates remain unresolved.
