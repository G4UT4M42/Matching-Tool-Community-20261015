# Native rebuild qualification

This records engineering evidence for an independently rebuilt Windows x64 canvas binding. It is not legal clearance, a claim that the publisher's historical binary was reproduced, or approval to distribute the application. The application runtime is changed only through a separately reviewed integration and installed acceptance run.

## Scope and inputs

The canvas source is version 0.1.97, commit `86211d2700057f801a193a5b5d6282c9d53cab47`; its original source archive SHA-256 is `c5cb607e0b4fb99b4301849ed240bd40c3505413a9826a788b2d8f07ca6fe85d`. Skia is commit `90228207f40ec85064f8b5c41fcdc2c0cf855ff2`, archive SHA-256 `7bd743e212a91cff750601fc9e686a5431e35081a46d918aae14f8ce0bfd873f`. These are official [canvas](https://github.com/Brooooooklyn/canvas/tree/86211d2700057f801a193a5b5d6282c9d53cab47) and [Skia](https://github.com/google/skia/tree/90228207f40ec85064f8b5c41fcdc2c0cf855ff2) source snapshots.

The publisher snapshot does not include its original Cargo.lock. A new Rust 1.92-compatible closure was therefore frozen and vendored. Its Cargo.lock SHA-256 is `ede79dab57183e888908ea1aeb76ed8af4b9aa057884512296f2244646d8c1d2`. The inventory verifies 94 registry package archives against their lock checksums, 5,325 vendored files against Cargo checksums, and preserves 168 original Rust dependency notice files externally. This closure describes the new build, not the historical publisher build. The source's original platform rustflags, including Windows `+crt-static`, are retained.

Twelve pinned Skia dependency archives cover Expat, FreeType, HarfBuzz, Highway, libjpeg-turbo, libjxl, libpng, WebP, Wuffs, zlib, Brotli, and ICU. Their exact URLs, revisions and SHA-256 values are in the external `skia-build-inputs.json` and source archive catalog. ICU is revision `364118a1d9da24bb5b770ac3d762ac144d6da5a4`. Its `common/icudtl.dat` matches the installed canvas data byte-for-byte: 10,468,208 bytes, SHA-256 `9ae98c06cbb0ea43c5cd6b5725310c008c65e46072421a1118cb88e1de9a8b92`.

## Available toolchain and isolation

The actual Windows qualification uses MSVC 14.44.35207, clang-cl 19.1.5, CMake 3.30.0-rc3, Ninja 1.12.1, Python 3.13, Perl 5.38.2, isolated Rust 1.92.0 and NASM 2.16.03. Rust components are official 2025-12-11 distribution archives and match their published SHA-256 values. GN is pinned to revision `b2afae122eeb6ce09c52d63f67dc53fc517dbdc8`; its fetched archive SHA-256 is `7249f55d6f22b55affa68aaf19d2f597c39946299216e12d78eac6cc1469f8a1`.

No global Rust installation, Cargo configuration, Git configuration, system settings, or candidate binary changes are needed. Builds use owned external directories, isolated home/cache/temp locations and two jobs. Cargo compilation uses `--locked --offline`. Short external target paths avoid Windows native build path limits. The recipe rejects relative output paths, checkout destinations, linked ancestors, and existing targets without its ownership marker.

The recipe explicitly selects the VS 2022 x64 linker and Ninja. Its CMake toolchain enables CMP0091, selects `MultiThreaded` release runtime, and removes the implicit `/MD` release flags; this matches the retained Rust static CRT target feature. These settings resolved observed linker runtime mismatches. Failures and corrections remain in external logs. No third-party functional source changes were required for the Rust binding.

## Reproduction

Run these commands from the candidate checkout, using a qualified Node 22 executable and new absolute external paths. `$Rebuild`, `$Evidence` and `$Target` are task-specific PowerShell variables chosen by the recipient; `$Evidence` contains the verified `supplemental-native-02` evidence. A full source rebuild requires the external source recipe and evidence described below as well as the baseline phases.

```powershell
node scripts/qualify-native-rebuild.mjs --phase tools --out $Rebuild
node scripts/qualify-native-rebuild.mjs --phase prepare --out $Rebuild --evidence $Evidence
node scripts/qualify-native-rebuild.mjs --phase freeze --out $Rebuild
node scripts/qualify-native-rebuild.mjs --phase inventory --out $Rebuild
node scripts/qualify-native-rebuild.mjs --phase build --out $Rebuild --target-root $Target
node scripts/qualify-native-rebuild.mjs --phase qualify --out $Rebuild
```

The `build` phase above is the baseline binding rebuild against hash-recorded publisher Skia libraries. The full source run additionally executes `stage-and-build-skia.py`, which stages and verifies the twelve source archives, applies the upstream canvas Windows ICU load-directory preference, sets the existing Python executable explicitly, runs pinned GN and builds the ten requested Skia library targets with two Ninja jobs. Its exact arguments and source change hashes are retained. The generated Ninja Python command is adapted to the existing interpreter. Skia builds statically with `/MT`, raster/PDF/SVG/paragraph/shaping support and the upstream canvas Windows options.

`finish-canvas-full-source.py` then builds the frozen Rust binding against the newly compiled Skia directory in a fresh target. This separate command uses the same explicit CMake runtime and linker settings. The executed scripts retain their audit directory arguments for exact evidence; a recipient relocates those directory assignments and existing tool paths without changing source versions, patches, flags or Cargo.lock. Sources, original archives, frozen vendor tree, scripts, tool input archives, notices and exact build metadata are supplied in the external replacement evidence bundle. The baseline phase must not be described as a full Skia source rebuild.

The replacement bundle's portable `recipes/rebuild-from-bundle.py` performs the complete offline source workflow with explicit `--bundle`, `--work`, `--skia-target`, `--canvas-target`, `--msvc`, `--cmake-bin` and `--perl-bin` directory arguments. Its `--phase stage` was actually run in a fresh recipient workspace: all bundle hashes were verified and all fourteen original source archives, the frozen vendor tree, isolated tools and source adaptations staged successfully. The already executed full source build and qualification above are preserved independently of that portability check. The bundle README gives the complete command and qualification procedure.

## Actual qualification

The corrected baseline recipe completed in a fresh target in 204,979 ms. The resulting binding SHA-256 is `c4463bdfa38fc18bc1561be7da88376451eaf91ae89c0a20d0c76be9cb2e281b`. Tests assert that the external binary was actually loaded through the unchanged 0.1.97 JavaScript wrapper, render a bundled font, encode PNG/JPEG/WebP, decode PNG dimensions and recognize `COMMUNITY 12345` with local English OCR data. A separate synthetic PDFKit document is rendered by PDF.js using that rebuilt canvas and recognized by offline OCR with the same exact text. System fonts and real documents are not used.

The full Skia source build completed all 1,718 Ninja steps with exit code zero in 798.27 seconds and produced 26 static libraries. The frozen Rust binding then compiled against those new libraries in a fresh target with exit code zero in 127.15 seconds. Its replacement binary SHA-256 is `e113eda0affe2217592fcf3ce690ab6c780e52904d3546ae8be15f6cbc3ca065`. This actual binary passed every image/font/OCR check above and the separate synthetic PDFKit-to-PDF.js-to-canvas-to-OCR test, with exact recognized text `COMMUNITY 12345`. Every source-built library output hash is retained separately from the downloaded baseline libraries.

The external `native-replacement-01/manifest.json` uses format `matching-community-native-replacement-v1`. It binds the exact binary, portable qualification report and all shipped source/build/notice files. The bundle supplies fourteen unchanged official source archives, the complete new frozen Rust vendor archive, lockfile, original notice texts, tool inputs, build flags, a portable offline recipient rebuild helper and synthetic qualification scripts. Its `sourceBuildQualified` flag describes these measured engineering results only. Raw executed scripts/logs and exact working snapshots are preserved separately; generated machine-specific paths are excluded from the shipped evidence.

The repository recipe also passes Node syntax validation, relative-path and absolute-checkout output rejection checks, and a scoped privacy scan with zero literal email addresses or owner profile paths. Raw source licenses and detailed build evidence remain external.

## Remaining integration and review

Development packaging now admits only the independently reviewed manifest
`5d791594cb4ed6dba342c85522b928a53cad3151f2d47cc83acb09ecb89052b4`
and its exact rebuilt binary. The complete portable manifest is retained in
`canvas-replacement-manifest.json`. Package inventory and installed verification
bind the new binary and all282 source/build/notice files, while legal, release
and historical-reproduction claims remain false. A self-asserted qualification
record cannot authorize a different bundle.

The earlier working-snapshot `installed-native-01` complete journey passed with
7,437 verified files, including real OCR, exact financial workflows and actual
migration interruption/recovery. Its captured manifest digest is
`956918dd9f1c129cce79c0f9bc924ff7187864e1255b80692d3354b0e8350038`.
It predates the final independent allowlist/wrapper checks. Regenerate the
package and repeat full installed acceptance against the final committed
candidate; the earlier run cannot certify those later verifier changes.

A successful source build does not approve a release or retrospectively
establish the provenance of the original publisher binary.

This canvas qualification does not qualify sharp/libvips DLL replacement or either retained WebAssembly runtime. Windows libvips still requires its separate component/source and recipient replacement review. The WASM paths require their own source-build and runtime results. Docker Desktop Linux infrastructure is available locally; its presence alone is not a successful native or WASM build.

The owner must decide the distribution terms and review license compatibility, notice placement, corresponding-source/relink requirements and any written-offer arrangements for the exact final artifacts. Review also covers proprietary application rights and assets outside these dependency snapshots. No release, legal-clearance or source-complete gate is promoted by this document.
