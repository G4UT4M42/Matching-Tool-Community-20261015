# Native source and notice preparation

Evidence date: 2026-10-15. This is technical provenance preparation, not legal clearance. Source ownership, complete corresponding source, recipient relinking qualification, and distribution approval remain unverified. Keep every release gate false until its own evidence has been reviewed.

The fixed public catalog in `scripts/collect-native-source-evidence.mjs` downloads version-pinned upstream material into a new absolute directory outside the checkout. It checks HTTPS hosts and redirects, rejects linked output ancestors and existing output directories, limits transfer size and concurrency, records failures, and hashes original and decoded payloads. It does not install dependencies, extract archives, execute downloaded code, use authentication, or change release gates. GitHub archive packaging bytes can differ from release tarballs; a mismatching expected digest is recorded as a failure and excluded from the prepared supplement.

```powershell
node scripts/collect-native-source-evidence.mjs --self-test
node scripts/collect-native-source-evidence.mjs --out <new-absolute-external-evidence-directory>
node scripts/collect-native-source-evidence.mjs --only pdfkit-source,pdfkit-afm-permission --out <another-new-external-evidence-directory>
```

Use the qualified Node 22 runtime. Downloads need network access. A completed run reports both fetched artifacts and failures; successful execution does not mean every fetch succeeded or that redistribution requirements are satisfied. Preserve `source-artifacts.json` and `SHA256SUMS` together with downloaded bytes. Never put raw third-party notice text or source archives into the privacy-scanned Git checkout.

## Prepared external supplement

The external `supplemental-native-02` evidence bundle contains a portable `manifest.json`, `comparisons.json`, full retrieval history, original notices, and 50 source archives. Its 134 builder entries carry relative source and intended package paths, byte counts, SHA256 hashes, public upstream URLs, and versions where applicable. The bundle contains no source-authoring audit script or absolute owner paths in its portable manifest. Raw public upstream archives and notices retain their original wording and metadata externally.

The assembly independently rehashed 136 downloaded or base64-decoded payloads. The manifest maps all 28 entries of Windows sharp's installed `versions.json` to a fetched source snapshot. These are declared component versions, not proof that every statically linked transitive dependency has been identified. The supplement leaves `correspondingSourceComplete`, `relinkQualificationComplete`, `legalClearance`, and `releaseAccepted` false.

Packaging must validate each relative path, reject traversal and linked inputs, verify every declared byte count and hash, reject conflicting destinations, and include the supplement's manifest and comparison evidence. Include complete source archives without rewriting their contents. Include the combined-work attribution guide at `compliance/native-source/README.txt`. The original general inventory, runtime notices, and this supplement are complementary.

## Findings and exact correspondence

| Shipped material | Version-specific source and evidence | Result and action |
| --- | --- | --- |
| sharp / Windows libvips | sharp 0.35.5 source commit `51a990faa26ade5586a4934ac9673c98d8893326`; vendor 1.3.4 commit `ebb95f8add54eee8bed840e3fb587e4cbec857d7`; Windows build 8.18.7 commit `ef19ca09af2453d127453d677c849ccb37cf5694` | Installed `libvips-42.dll` is byte-identical to both the publisher's Windows ZIP and vendor npm package. Source snapshots, version map, build recipes, patches, LGPL texts, and native notices are prepared. Recipient rebuild and replacement/relink qualification remain open. |
| canvas / Skia | canvas 0.1.97 commit `86211d2700057f801a193a5b5d6282c9d53cab47`; Skia submodule `90228207f40ec85064f8b5c41fcdc2c0cf855ff2` | Installed Windows native binary matches the GitHub release asset's published SHA256. Supply Skia and enabled dependency notices in addition to the canvas wrapper's MIT notice. Exact Rust crate closure remains unresolved. |
| ICU data | Chromium ICU commit `364118a1d9da24bb5b770ac3d762ac144d6da5a4`, version header 74.2 | Installed `icudtl.dat` is byte-identical to the pinned source data. Full original ICU notice, data correspondence, and source snapshot are prepared. The OCR language-data Apache license does not cover ICU. |
| PDFKit AFMs | PDFKit 0.18.0 commit `6e3727f8cb4e4e62ae24db010422c1a17c2a76bf` | All 14 installed AFMs match tagged source bytes. The source's accompanying Adobe `MustRead.html` is omitted from npm and must be supplied unchanged beside the AFMs. This is a concrete missing-notice correction. |
| PDF.js assets | PDF.js 5.5.207 commit `5279646985f4744386a9fe3cf61b28bf1ff88d6e` | All 196 checked installed font, CMap, ICC, WASM and associated license files match the exact tagged source. Existing Foxit, Liberation OFL, Adobe CMap, ICC CC0 and codec notices must remain shipped. No missing asset notice was found in that checked set. |
| Node runtime | Node 22.23.3 source release and official `SHASUMS256.txt` | Source archive digest matches the publisher's checksum file. Retain the runtime's complete LICENSE, including its bundled-component notices. |

Key independently checked SHA256 values:

| Artifact | SHA256 |
| --- | --- |
| Installed / publisher `libvips-42.dll` | `06dab07cc386748513337a31672b1d5269fbc770a14ff403080575665bf0813f` |
| Installed sharp `libvips-cpp-8.18.7.dll` | `25001dbd05305a0a29119ab49933622c70b4a20ea12ef1d5d20ca40181db53bf` |
| Publisher Windows static web ZIP | `a736af61d3b46499760efa606e469cb14e060445b1f6fd36a1fa2e75009e1197` |
| libvips 8.18.7 release source | `5baaead3b0bb20ffdb9e9ff09aa9fda08620923df77b63b436654cb5e0b3bf94` |
| Installed canvas Windows native binary | `2f73f296e1aacec88e4600d97182d8cf13cfbfe8a0e5c27c6e60b7b33918158d` |
| Installed / pinned ICU data | `9ae98c06cbb0ea43c5cd6b5725310c008c65e46072421a1118cb88e1de9a8b92` |
| PDFKit Adobe accompanying permission file, 937 bytes | `b226bfc00e1b8b8a80c7b3cfbbc322d13b4b0401f94cdeafdd93b2210ad802eb` |

The C++ DLL is built and packaged by sharp; do not claim it equals the differently named C++ DLL in the upstream Windows ZIP. The Adobe historical archive URL returned 404, but the exact PDFKit tag contains the accompanying permission. That missing-notice correction does not depend on obtaining a new permission from Adobe.

The direct Cairo hosts failed with connection resets/timeouts; the official GitLab archive returned HTTP 406. Fontconfig's direct archive also returned HTTP 406. Some source redirects were rejected by the fixed host allowlist; no TLS checks were bypassed. Cairo, Fontconfig, FreeType and libpng canonical release archives were subsequently fetched from the source cache configured in the exact MXE Makefile. All four SHA256 values matched the pinned recipes. Earlier failed or mismatching alternative payloads remain in retrieval history and are not silently substituted as verified release source.

## Remaining engineering work

1. Include and verify the prepared notice supplement. Put the original Adobe file at `node_modules/pdfkit/js/data/MustRead.html`; preserve its unchanged permission paragraph and every AFM copyright. Retain the full Skia, ICU, FreeType, JPEG, native-library and PDF.js notices in recipient documentation. The supplement includes a FreeType Team acknowledgement and JPEG attribution guide; notice collection alone does not establish a complete binary component map.
2. Resolve actual static-link dependencies. The canvas source archive omits `Cargo.lock` and declares Rust dependencies with ranges. The pinned Skia DEPS and eleven enabled native dependency source snapshots are supplied, but Rust crate versions and all second-level static dependencies still need a build/link SBOM or an independently frozen rebuild. The source snapshot is not a substitute for that evidence. For libvips, inspect the recorded Rust lockfiles and GLib fallback source requirements and supply any additional build inputs required by the selected terms.
3. Resolve the historical build environment. The vendor recipe identifies the exact Windows release ZIP and build repository; its toolchain branch was observed at `c36160b231e66e1cbe032ed54aef7617e8b259da`. That observation does not prove the historical publisher build used this branch state. Record immutable container/toolchain inputs and actual build configuration, including modified source and patches.
4. Qualify the recipient rebuild and modification route. Rebuild the covered native libraries from the frozen supplied sources, replace the relevant DLLs or relink as required, and run the synthetic image/PDF/OCR regression on the supported Windows runtime. Record the practical replacement procedure, object/link inputs if required, and license-compatible terms for recipient modification/debugging. No rebuild, ABI replacement, or relink qualification was performed by this source-harvesting task.
5. Treat the optional `@img/sharp-wasm32` payload separately if packaging retains it. It has a different component map, including resvg 0.48.1 and Emscripten 6.0.10; the additional WASM supplement below supplies its own preparation evidence. `xmllint-wasm` has separate libxml2/Emscripten inputs. Neither artifact is covered by the Windows libvips component map. Qualify their remaining historical-input and final-link correspondence, or exclude them only after dependency and execution reachability prove safe. No optional payload was removed by this task.
6. Regenerate the existing lockfile/installed inventory after dependency changes and bind the supplement to the exact final runtime manifest. The removed unused `pdf-parse` nested versions are historical evidence and are excluded from this supplement's claimed runtime scope. Installed web build dependencies must keep their own SBOM classification.

## Retained WASM and canvas Rust evidence

The separate external `supplemental-wasm-02` bundle uses the same portable manifest format and leaves all source-completeness, relinking, legal and release flags false. It preserves the completed Windows-native supplement. Its 282 builder entries use only `compliance/wasm-source/` and `compliance/wasm-notices/`; its scope guide is included through `files[]`. The final assembly matched all 19 installed files across both packages and independently checked 6,428 vendored source-file hashes for the 88 resvg registry crates.

For sharp WASM 0.35.5, the exact npm archive matches every installed file and its registry integrity value. The publisher's `@img/sharp-libvips-dev-wasm32` 1.3.4 archive supplies 28 static `.a` link inputs, headers and package configuration. Its 19-component `versions.json` equals the installed WASM version map. The original archive is retained as an actual rebuild input, without claiming that link inputs alone fulfill source or recipient relinking requirements.

The exact resvg 0.48.1 release source contains `Cargo.lock`, four workspace packages and all 88 registry packages in a vendor directory. The supplement records the lock checksums, original crate notices, and checks every vendored file against its cargo-vendor checksum map. This provides concrete Rust source-supply evidence for resvg; it does not prove the entire final WASM link composition. The source recipe builds `resvg-capi` with `--locked`, no default features, and `svgz,raster-images`, while rebuilding Rust standard libraries. The matching `nightly-2026-09-26` Rust source component and its publisher digest are retained, together with Emscripten 6.0.10 source and the observed Emscripten patch set.

The sharp and vendor npm provenance statements identify repository commits and build runs. Their subject SHA512 values match the fetched archives. Signature and certificate trust were not cryptographically verified by this task; decoded statements are retained as evidence rather than treated as trusted clearance. The vendor recipe downloads nested `wasm-vips` HEAD. Public history immediately before its recorded WASM build identifies `dca91909178800875b575eb896d1fe4ed0a27931`, whose declared versions agree with the installed component map. That dated snapshot and pinned observed patch bytes are retained, but the historical nested HEAD and patch inputs are an inference rather than an attested build material. Immutable container inputs and a qualified rebuild can resolve that engineering gap.

For xmllint-wasm 5.3.0, every installed file matches the npm archive and registry integrity. Tag commit `83b814cdc39625af5c34370c627599d973d28b07` pins libxml2 commit `eb0a2f2b91566384f378d870ffcd69c0a24162cc`, whose configure source declares 2.13.8. The source Dockerfile selects Emscripten 4.0.6. Both exact source snapshots, the wrapper source/build scripts, libxml2's full original `Copyright`, and Emscripten runtime notices are supplied. The npm wrapper's generic MIT notice does not replace those upstream notices.

The xmllint link command also names a committed `libz.a`. Its original source/build identity has not been established. The recorded configure command uses `--with-minimum`, and that libxml2 configure source disables zlib by default; an archive on a link command is not proof its object members entered the final binary. Preserve this as a precise final-link or rebuild check, without asserting zlib is included or excluded. A fresh reproducible build and link map can close it using the recorded scripts and a reviewed source input.

Canvas Rust reconstruction was investigated beyond checking the source archive:

- The exact source explicitly ignores root `Cargo.lock` and pins Rust 1.92.0. The published npm wrapper has no Cargo lockfile. The release metadata lists native `.node` assets and no dependency lock or build-source bundle.
- Npm provenance identifies CI run `23125669213` at the exact canvas commit. The public Actions artifact list for that run currently has zero entries. Its source workflow uploads only `${{ env.APP_NAME }}.*.node`; it does not upload Cargo locks. Public Windows job log access returned HTTP 403 without authentication. No credentialed retrieval was attempted.
- Diagnostic paths embedded in the actual shipped Windows binary reveal 19 crate versions, including napi 3.8.3, napi-sys 3.2.1, tokio 1.50.0 and regex 1.12.3. The external comparison report preserves the complete observed list and the binary SHA256. Diagnostic paths do not identify every linked crate, build dependency, feature or checksum and cannot be promoted to a complete original lockfile.
- The checked public artifacts therefore do not provide the original lock. An independently executable alternative is to generate and review a new lock for the exact source, vendor the selected crates and native inputs, then rebuild and qualify a replacement binary. Record that as a newly frozen build. Claim exact publisher reconstruction only if its original build inputs or equivalent reproducibility evidence are obtained.

Additional primary references: [resvg 0.48.1 release source](https://github.com/linebender/resvg/releases/tag/v0.48.1), [xmllint-wasm exact source](https://github.com/noppa/xmllint-wasm/tree/83b814cdc39625af5c34370c627599d973d28b07), [pinned libxml2 source mirror](https://github.com/GNOME/libxml2/tree/eb0a2f2b91566384f378d870ffcd69c0a24162cc), [inferred wasm-vips build snapshot](https://github.com/kleisauke/wasm-vips/tree/dca91909178800875b575eb896d1fe4ed0a27931), and [Rust nightly source manifest](https://static.rust-lang.org/dist/2026-09-26/channel-rust-nightly.toml).

## Owner and legal decisions after engineering evidence

- Review the chosen LGPL versions and any alternatives, including Cairo's MPL 1.1 alternative and FreeType's FTL alternative, against the actual combined binaries and recipient terms. The BSD-licensed libimagequant 2.4.1 fork must be identified accurately; generic licenses for newer upstream versions are not a substitute.
- Select an appropriate accompanying-source or source-availability mechanism, duration and recipient access route, then implement and maintain it. Downloading archives internally does not supply source to recipients by itself.
- Verify first-party ownership, contributor rights, product name/assets and any external contracts independently. Public package metadata and this audit cannot establish those rights.
- Approve a release only after the technical evidence and applicable terms have been assessed. No legal PASS is asserted here.

## Primary upstream references

- [sharp packaging recipe at the exact commit](https://github.com/lovell/sharp/blob/51a990faa26ade5586a4934ac9673c98d8893326/npm/from-local-build.js) and [vendor Windows recipe](https://github.com/lovell/sharp-libvips/blob/ebb95f8add54eee8bed840e3fb587e4cbec857d7/build/win.sh).
- [Windows build overrides and patches](https://github.com/libvips/build-win64-mxe/tree/ef19ca09af2453d127453d677c849ccb37cf5694/build), [MXE mirror configuration](https://github.com/kleisauke/mxe/blob/c36160b231e66e1cbe032ed54aef7617e8b259da/Makefile), and [libvips 8.18.7 release](https://github.com/libvips/libvips/releases/tag/v8.18.7).
- [canvas 0.1.97 release](https://github.com/Brooooooklyn/canvas/releases/tag/v0.1.97), [its exact Skia build recipe](https://github.com/Brooooooklyn/canvas/blob/86211d2700057f801a193a5b5d6282c9d53cab47/scripts/build-skia.js), and [pinned Skia dependency revisions](https://github.com/google/skia/blob/90228207f40ec85064f8b5c41fcdc2c0cf855ff2/DEPS).
- [Pinned ICU license and source](https://chromium.googlesource.com/chromium/deps/icu/+/364118a1d9da24bb5b770ac3d762ac144d6da5a4/).
- [PDFKit's accompanying Adobe permission](https://github.com/foliojs/pdfkit/blob/6e3727f8cb4e4e62ae24db010422c1a17c2a76bf/lib/font/data/MustRead.html).
- [PDF.js exact external assets and notices](https://github.com/mozilla/pdf.js/tree/5279646985f4744386a9fe3cf61b28bf1ff88d6e/external).
- [Node 22.23.3 release sources and checksums](https://nodejs.org/dist/v22.23.3/) and [GNU LGPL 3 text](https://www.gnu.org/licenses/lgpl-3.0.html).
