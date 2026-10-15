# Windows development packaging and installation

The packaging command builds a self-contained **development candidate**. It
does not create a release-accepted distributable. Ownership, native source and
relink obligations, and asset provenance remain unresolved; requesting
`--mode distributable` fails before output creation. No switch can silently
convert the current metadata into legal clearance.

## Build and inspect

Use the qualified Windows x64 Node.js 22 runtime (ABI 127), a built web
application, installed frozen dependencies, and newly generated external
compliance evidence:

```powershell
node scripts/create-compliance-inventory.mjs --out <absolute-legal-evidence-directory>
node scripts/package-community.mjs --compliance <absolute-legal-evidence-directory> --out <new-absolute-package-directory> --supplement <external-native-supplement> --supplement <external-wasm-supplement>
node scripts/verify-community-package.mjs <absolute-package-directory>
```

Output and full legal evidence must remain outside the source checkout and
independent of one another. Output must not already exist. The build verifies
current lock hashes, evidence checksums, selected dependency manifest hashes,
runtime asset hashes and notice-text hashes before writing. An interrupted
build leaves its explicit output directory for inspection; it is not promoted
or installed automatically.

Runtime selection starts from every root production dependency plus `tsx`,
which the current TypeScript server requires at runtime. It follows the locked
dependency graph, including installed optional/peer dependencies. Absent
optional platform packages are omitted; missing required dependencies fail.
Unused development roots such as Vitest and TypeScript are excluded. Selected
package files are retained in full except separately resolved nested
`node_modules` and Git metadata. This avoids speculative removal of package
assets that runtime code might read.

The package includes the running qualified `node.exe` and its upstream
LICENSE, application source and built web assets, selected runtime packages,
English/German offline OCR data, root LICENSE and NOTICE, all collected external
license-text evidence, portable SBOM/inventory metadata, installer, launcher,
upgrader, uninstaller and package verifier. The manifest records selected and
excluded package references, file hashes, runtime identity and open obligations.
No accounting data, credentials, browser profiles or Git history are copied.

`community-package.json` provides file-set/checksum integrity and explicit
development status. It is not a publisher signature or an independent legal
attestation. The native source/relink arrangements described by the independent
review still need completion before distribution. Copied npm license files
alone do not resolve those obligations.

## Fresh installation

Choose independent package, installation and data directories. No administrator
permission, system-wide Node installation, download, service, PATH change or
scheduled task is needed.

```powershell
powershell -NoProfile -File <package-directory>\scripts\Install-Community.ps1 -PackageDirectory <absolute-package-directory> -InstallDirectory <absolute-install-directory> -DataDirectory <absolute-data-directory>
powershell -NoProfile -File <install-directory>\scripts\Start-Community.ps1 -DataDirectory <absolute-data-directory>
```

The launcher selects the bundled runtime by default, checks Node22/ABI127 and
native dependencies, binds loopback, and displays one-use first-owner setup
authorization in the local console. Follow the local application to create
the owner and configure integrations. The application continues to advertise
`release_ready:false`. No transfer is performed by installation or tests.

For compatibility, installing a raw built development directory remains
possible. It prints an explicit **UNREVIEWED DEVELOPMENT DIRECTORY** warning,
never claims distributability, and copies available NOTICE/compliance material.
Use the generated manifest package for reviewable file integrity and explicit
runtime/legal-evidence inclusion. A raw directory does not acquire those gates
merely by passing the legacy installer fixture test.

## Upgrade and uninstall

Stop the owned application first. Create/review a recoverable accounting backup
before a real upgrade. The upgrader stages and verifies new application files,
retains the previous application directory, and does not move external data:

```powershell
powershell -NoProfile -File <new-package-directory>\scripts\Upgrade-Community.ps1 -PackageDirectory <absolute-new-package-directory> -InstallDirectory <absolute-install-directory> -DataDirectory <absolute-data-directory> -ConfirmStopped
```

`-ConfirmStopped` is an explicit caller assertion; the scripts do not terminate
arbitrary processes. Directory swaps briefly retry transient Windows handle
locks; persistent in-use files cause errors without permission changes.
Previous binaries are retained
for review, and a failed rename attempts to restore their original location.
Do not run an old application against a database upgraded to an unsupported
schema; application-directory recovery is separate from database recovery.

Uninstallation requires the installation marker and independent data path.
It refuses links/junctions and removes only the verified application directory.
Accounting data and previously retained application directories survive:

```powershell
powershell -NoProfile -File <install-directory>\scripts\Uninstall-Community.ps1 -InstallDirectory <absolute-install-directory> -DataDirectory <absolute-data-directory> -ConfirmStopped
```

## Synthetic qualification

```powershell
node --test tests/community-packaging.test.mjs tests/community-persistence-installer.test.mjs tests/community-launcher.test.mjs
```

The new packaging regression builds from actual dependencies and a fresh legal
inventory, rejects tampered notices and unsupported release mode, installs to
an independent Unicode path, runs the packaged native canvas and OCR asset
loader, starts with the bundled runtime, creates a synthetic owner, upgrades,
restarts/logs in, and uninstalls while verifying exact retained data hashes.
The existing fixture installation and source-launcher tests remain separate.
Set `MATCHING_PACKAGING_EVIDENCE` to an existing external evidence directory to
save the new test's compact result without owner authorization values.

These are tests on an isolated current Windows environment. A genuinely fresh
Windows VM, publisher signing and independent redistribution review remain
separate qualification gates; a package manifest does not prove those results.

## Prepared source and notice supplements

Repeated `--supplement` arguments add reviewed external source bundles. Each manifest must retain false legal/source/relink acceptance, unchanged notices, bounded files and exact byte counts/SHA256. Inputs and destinations are checked for links, traversal and duplicate/case-conflicting names. Only native/WASM source/notice folders and the specific accompanying PDFKit AFM permission destination are accepted. Original manifest, comparison and retrieval evidence are included under a digest-bound directory. The package manifest and verifier bind every copied source/notice byte. A supplement improves source supply; it cannot promote a development candidate to a distributable.
