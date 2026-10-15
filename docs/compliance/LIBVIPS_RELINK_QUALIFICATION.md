# Windows libvips source build and relink qualification

A complete isolated source build produced a Windows libvips 8.18.7 C DLL that passed native loading and PNG, JPEG, WebP, SVG and AVIF checks with the unchanged sharp 0.35.5 binding and installed MSVC C++ companion. The child process asserted exact loaded paths and hashes for all three native files. A separate rebuild of the five original C++ companion units also passed the same checks with the new C DLL and unchanged binding.

These are engineering results. `legalClearance`, `releaseAccepted` and `historicalBinaryReproduced` remain false. This qualification did not replace the checkout's dependencies or runtime binaries.

## Exact proposed replacement

The immutable external bundle is `libvips-relink-01/native-replacement-01`. It selects exactly `node_modules/@img/sharp-win32-x64/lib/libvips-42.dll`, package version `0.35.5`. Supporting material uses the distinct `compliance/libvips-replacement/` prefix.

| Artifact | SHA-256 |
| --- | --- |
| Sealed manifest | `32e5abf93be6355db6af64ac5cf2d837ac47848bea05146a46f57a53bf5e37ff` |
| New source-built C DLL, 19,018,752 bytes | `2c843d083a0bc59a4114366fc79d8b5e5faf6472062f472a2ce9ad91e4dc06fc` |
| Original C DLL being replaced | `06dab07cc386748513337a31672b1d5269fbc770a14ff403080575665bf0813f` |
| Unchanged installed MSVC C++ companion | `25001dbd05305a0a29119ab49933622c70b4a20ea12ef1d5d20ca40181db53bf` |
| Unchanged installed Sharp binding | `971048779f9c8598df14641dfc03c625885c93f473a788e65ca2deb50d0b083e` |

The manifest binds 171 support files plus the C DLL, totaling 709,548,758 payload bytes. Every support file, including `SHA256SUMS`, is in `files[]`. The proposed replacement remains C-DLL-only. The optional rebuilt MSVC companion is relink evidence and is not selected for installation.

## Frozen source build

The libvips 8.18.7 archive has SHA-256 `5baaead3b0bb20ffdb9e9ff09aa9fda08620923df77b63b436654cb5e0b3bf94`. The build-win64-mxe recipe is commit `ef19ca09af2453d127453d677c849ccb37cf5694`, archive SHA-256 `f52864572e6df6e549016369fdb2705aa195a837bd7bc8c52e45f42b59ef97a7`.

The bootstrap image is `ghcr.io/libvips/build-win64-mxe@sha256:09723abfa1099965e2a1cb22a2f3149bb4ae93283d38968fc305d082a02be9e5`. Its actual MXE commit is `c9bf131cd7c6da55dc3f6f16db0f62d843a3ea88`, separately supplied as archive SHA-256 `434717d9d3dea75e214c1a7da4d9fa5fc36d1a57709919c04dd9d94edcb18e0c`. This is a new frozen build, not a reconstruction of the historical publisher toolchain.

The context-dependent graph has 53 build nodes. The bundle supplies 39 original package/compiler/tool archives, including LLVM 23.1.3, MinGW runtime sources and Rust nightly source dated 2026-10-08, together with exact recipes and patches. The measured Rust compiler is 1.101.0-nightly, commit `1d81eb4ad9cd207e3e638bd32b17ec4fce8412a6`. Compiler hashes and versions are recorded. Host tools come from the immutable bootstrap image; rebuilding those host tools from scratch is not claimed.

Libpng is explicitly pinned to the installed 1.6.58 source, SHA-256 `28eb403f51f0f7405249132cecfe82ea5c0ef97f1b32c5a65828814ae0d34775`. A newer endpoint failed certificate validation and was not retried or bypassed. The optional ccache endpoint also failed certificate validation. Caching was already disabled upstream; its disabled branch compiles no code and only removes wrappers. A documented empty local source tree supplies that no-op branch.

Librsvg 2.63.2's exact Cargo.lock supplies 357 registry packages. Thirty-one independently verified standard-library vendor packages extend them; equal-package deduplication yields 378 supplied packages and 19,514 files. The merged archive has SHA-256 `a52bf1dba80b75ca51a68ebae63136bb01030c2050894d5011fd66143fdd0b61`. GLib 2.90.0's gvdb commit `2b42fc75f09dbe1cd1057580b5782b08f2dcb400`, PCRE2 10.46 source and exact Meson patch are also supplied and byte-compared against frozen originals.

Compilation ran offline with Docker networking disabled, two configured CPUs, six GiB RAM and `JOBS=2`. The full build exited zero. Evidence records 40 installed target build stamps and 75 built library/executable artifacts. All 28 declared runtime versions exactly match the installed package. No runtime source version was silently upgraded.

## Measured behavior and component coverage

`proof/qualification.json` binds the new DLL hash and records native loading, PNG/JPEG/WebP/AVIF encode/decode with dimensions and pixel checks, and SVG geometry/pixel checks. It asserts loaded full paths and hashes and independently checks the unchanged binding and companion against installed files.

`proof/pe-import-closure.json` covers immediate and delay imports of the selected C DLL, MSVC companion, Sharp binding and qualified Node. No additional unresolved runtime DLL was found. The binding delay-imports Node; the core and companion have no delay imports. Other imports resolve to Windows API contracts or System32. OS DLL internals are outside this audit.

`proof/pe-export-comparison.json` records all 3,246 original and rebuilt named exports: no names added or removed, no ordinal/forwarding changes, and no forwarded exports in the rebuilt DLL. This supports the tested ABI behavior without claiming a complete function-signature ABI proof.

The replacement-specific CycloneDX 1.6 inventory contains 467 components: 28 runtime groups, 39 source archives, hidden GLib subprojects, LLVM/MinGW/Rust runtimes, 378 Cargo packages, 14 local Rust/standard-library compile units and unchanged selected native files. The compile log observed 172 vendor packages; 206 supplied packages were not observed compiled. Compile inputs can include host build scripts and proc macros. Retained static archive-member extraction was not separately traced and is not guessed. The complete supplied source superset remains available.

The source/license inventory binds archive hashes and original notice members. Cargo license expressions come from supplied manifests and are marked as upstream metadata, not legal conclusions. The inventory passed offline validation against exact previously cached official 1.6 schemas. A separate direct schema request returned HTTP 403 and was not retried or bypassed.

The notice archive preserves 4,557 strictly validated UTF-8 text notices and one original Meson RTF license asset. Its original trailing NUL is retained; it is not classified as plain text. Every one of the 4,558 raw hashes was independently compared with its original archive or frozen vendor source. No notice was decoded and reencoded. Original source archives remain unchanged and retain additional per-file wording.

## Recipient rebuild and relink

The bundle's `recipes/rebuild-from-bundle.py` checks input hashes and stages a fresh absolute external workspace. With the exact bootstrap image already available locally, it rebuilds the C DLL in a network-disabled container. `--prepare-only` validates/stages inputs without compiling; a fresh staging run passed. The supplied underlying recipes completed the actual full source build; the complete portable wrapper was not repeated as a second full compilation.

```text
python recipes/rebuild-from-bundle.py --out <fresh-absolute-external-directory>
```

On Windows, `--docker-host npipe:////./pipe/dockerDesktopLinuxEngine` explicitly selects Docker Desktop. `--msvc-root <existing-VS2022-installation>` also builds the optional companion. It uses the five original C++ units, generated public headers, a C import library and an existing licensed MSVC/Windows SDK. Proven flags include `/MT`, `/O1`, `/EHsc`, `/std:c++17` and `/MP2`. The two static-GLib macro undefinitions match upstream packaging. Microsoft compiler/SDK binaries are not redistributed here.

Place the intended C DLL, compatible MSVC companion and unchanged binding in an isolated directory, then run:

```text
node recipes/qualify-source-core.cjs <checkout-root> <isolated-directory> <output-directory> original-cpp
```

Use `rebuilt-cpp` only for the optional rebuilt companion. The supplied PE tools repeat the static checks. These operations do not modify application files or system configuration.

The earlier `scripts/qualify-libvips-relink.mjs --phase proof` remains a separate loading-mechanism demonstration. It forwards exports to the original DLL and truthfully reports `fullSourceRebuild:false`. The new full-source DLL described here does not use that forwarding proxy.

## Independent review and final acceptance

The expanded scan inspected 48 archives and 1,245,460 payload/header items, about 7.89 GB expanded. It found no private denylist terms or local audit/worktree roots. One generic Windows-profile fixture occurs in Cairo's unchanged public `.gitlab-ci.yml`. The archive hash is `1c767308174337a74694da0f3ec069c271452163a1ef4540964c50c301f157d4`; the member hash is `1595b4dbb6840a3b68a83d90b5fe15ef8bee0c8ff9bbe8fc70ce9700fad689a9`. The exact suppressed-value classification is supplied for independent review. The archive is preserved and the finding is not silently relabelled an overall privacy PASS. A final regular-file scan of all 173 sealed files passed.

Independent engineering review passed the exact sealed manifest and approved the third fixed replacement target. Its broader generic profile detector classified164 locations:160 unchanged public archive fixtures/docs/source locations and4 checksum-bound frozen Cargo source files. These are preserved upstream content, with zero private-denylist/local-root findings and zero generic findings in binaries or authored portable metadata. Exact triage remains external. The independent scan covered48archives,657058 header/content items and7158898144 expanded bytes; its scan accounting differs from the initial expanded scan above. All4558 original notices,378 Cargo variants,186 observed compile units,467 unique BOM components,75 built library/executable hashes,40 stamps and8 tool identities were checked. The external report is `candidate-acceptance/independent-security/libvips-native-independent-01.report.txt`. Actual three-replacement/four-supplement admission and focused9/9 metadata tests passed; original checkout binaries remain unchanged. Fresh installed application acceptance with the exact selected artifacts remains required. This work did not replace a candidate runtime binary.

The owner still reviews application rights, license compatibility, notice delivery, source/relink obligations, recipient arrangements and any written offers for the final distribution. Successful compilation and recipient relinking are engineering evidence, not legal clearance or release acceptance.
