# Windows development packaging and installation

The owner selected private internal use on 2026-10-16. The package includes
`PRIVATE_INTERNAL_USE.md` with the bounded rights/provenance findings and
owner-deferred fresh-Windows test. Development/distribution flags remain false;
they do not represent a prohibition on private execution or a completed VM test.
The selected new local qualification includes three reviewed replacements and
five evidence supplements, including the independently reviewed runtime notices.

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

## Explicit source-built canvas replacement

`--replacement <absolute-qualified-bundle>` optionally replaces only the reviewed
Windows x64 NAPI canvas binary in the new external package. It never changes the
checkout or installed development dependencies. The bundle must bind the exact
upstream component/version/hash, distinct rebuilt binary, complete supplied
source/build/notice files and a hash-bound successful full-source Skia/image/PDF/
offline-OCR qualification. Unsafe or conflicting destinations, modified bytes,
missing checks and promoted legal claims reject before package output creation.
Admission and packaged verification additionally allow only the independently
reviewed manifest SHA-256
`907cdd47091358e832c3765610ee61da12145635917655f5b7b23022395a3b58`
and binary SHA-256
`0ea4e2558a21542e4364537cfbf06f3cc950f009cd9e740d159ca9edae250209`.
Self-asserted matching proof records cannot authorize another bundle. Future
replacements require a separately reviewed source change to that allowlist.

The resulting manifest distinguishes the frozen rebuilt binary and source proof
from the original npm inventory. `sourceBuildQualified:true` records engineering
qualification only. Legal clearance, historical binary reproduction and release
acceptance remain false. The installer verifies the replacement and every source
file through the package inventory before and after copying.

The synthetic integrated test can receive an explicit external bundle through
`MATCHING_ACCEPTANCE_NATIVE_REPLACEMENT`; the ordinary production server has no
such switch. Final acceptance must run the complete installed journey with the
actual replacement and retain its package manifest hash.

For the complete source-supply artifact, the same synthetic test accepts
`MATCHING_ACCEPTANCE_SUPPLEMENTS` as a JSON array of at most four explicit
external source-supplement directories. It passes those through the ordinary
strict package builder, performs a real installation, and retains the exact
installed package manifest bytes alongside screenshots and financial evidence.
This packaging input is absent from the production server.


The verifier contains the fixed reviewed descriptors and remains self-contained;
the installer bootstrap still hashes its complete file. The builder imports
those same descriptors from the existing verifier. Repeated `--replacement`
arguments are bounded to three distinct reviewed targets, checked before output
creation. Duplicate targets and source/supplement collisions reject. Each
component requires its own exact manifest/binary allowlist and measured proof;
self-asserted source-build claims cannot admit a component.

The first full-source canvas binary failed artifact privacy because compiler
strings retained local paths. It is retained only as failed intermediate
evidence. The current replacement02 descriptor uses a fresh compiler-remapped
binary and independent UTF8/UTF16 privacy/hash review. No binary string patching
was used. Complete installation/upgrade/uninstall test commands now record
actual elapsed time, deadline, exit and error code in immutable external JSON.
Large verified installations have a bounded300-second command budget and the
complete maintenance test has a900-second budget; all data/hash checks remain.

## Reviewed full-source WASM replacement and exact runtime SBOM

The second reviewed descriptor is sharp0.35.5 WASM: manifest
`222f7ad3b205aefdcf004434fd49525054ba822e39266756d8e2633568bb204c`,
binary `740521302afc687d45443ce86a9182a6a4ecc8f0dd0cffab70db117764e5efc3`,
qualification `9507732cd8c9763ea02cc0a35d536a5f285be0d2512dfec91b4434714b768794`.
It replaces only the versioned WASM file; installed JS glue is byte-identical
to the measured build.441support files and the binary total360099264bytes.
Source builds and actual codec tests cover load,PNG,JPEG,WebP,SVG,TIFF,GIF,AVIF
and ICC. UltraHDR gain-map runtime coverage is explicitly unqualified.

Independent review directly checked28source-built library/copy pairs,25selected
source libraries and10compiler-runtime archives,10157actual runtime-source
files, all442payload hashes,415nonarchive files,28archives/51905member headers
and9072generated payloads. No private-denylist matches remained. It grants
engineering/privacy admission for these exact bytes, not legal clearance.

Use repeated `--replacement` for canvas and WASM; the integrated synthetic
harness accepts `MATCHING_ACCEPTANCE_WASM_REPLACEMENT` alongside the existing
canvas input. Approved support entries may be zero bytes (the WASM bundle
contains an empty successful stderr log); binaries remain nonempty and proof
JSON remains bounded, hash-bound and validated. A self-asserted empty evidence
bundle still cannot pass the fixed-manifest gate.

`compliance/runtime-overlay.cyclonedx.json` binds the actual bundled Node
executable, reviewed new binaries and source/inventory file hashes. It
supplements the unchanged npm provenance graph in `sbom.cyclonedx.json` and
component-specific source inventories/nested SBOMs. The original registry or
upstream binary hash is never presented as the hash of the replacement. The
verifier compares overlay runtime hashes to the actual package inventory and
retains false legal/release claims. An actual maintenance regression modifies
the runtime SBOM and consistently rehashes its outer entry; verification still
rejects the incorrect runtime hash. Original bytes are restored before real
install/upgrade/restart/uninstall checks.

## Reviewed native Windows libvips and detailed component inventories

The third fixed replacement is Windows sharp0.35.5 libvips8.18.7, exact
manifest32e5abf93be6355db6af64ac5cf2d837ac47848bea05146a46f57a53bf5e37ff
and core2c843d083a0bc59a4114366fc79d8b5e5faf6472062f472a2ce9ad91e4dc06fc.
Only the C DLL changes. Builder and verifier require the measured original
C++ companion and Sharp binding hashes and sizes. The proof requires six
load/codec checks, exact loaded-file identities and directory assertions,
full-source rebuild/version facts and false legal/release/historical claims.
See LIBVIPS_RELINK_QUALIFICATION.md for sources, recipes and scope.

`MATCHING_ACCEPTANCE_LIBVIPS_REPLACEMENT` supplies this third bundle only to the
synthetic acceptance packager. No production application switch is added.
All three replacement descriptors are fixed, frozen and separately admitted.
Actual admission of all three plus four supplements passes; focused metadata
regression9/9 passes. Final installed application qualification remains separate.

Detailed final component inventories accompany the existing source supplements:
WASM SBOM supplement03 manifesta361d7a30c5fd2100815b0b3c2d22524790d4b17b22871609adcd301b3cf0830
(18files,8646850bytes) and Node SBOM supplement01
manifest92e5887bbfc91c895d9ac4c3fe77570090c9da2748b2fabd8ec57414bd878457
(19files,1437278bytes). Both passed independent hash/source/license/schema/privacy
review. Earlier WASM SBOM01/02 are retained failed iterations, not final inputs.
Original notices and source archives are unchanged. These inventories supplement
the exact runtime overlay; they do not confer rights or imply static archive
member linkage that was not measured.
