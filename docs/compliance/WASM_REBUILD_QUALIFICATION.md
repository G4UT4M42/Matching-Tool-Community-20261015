# Optional WASM rebuild qualification

Engineering evidence date: 2026-10-15. The installed optional WASM binaries were reproduced byte for byte in isolated Docker builds. No installed file was replaced. This evidence does not assert legal clearance, complete corresponding source, release acceptance, or reconstruction of every publisher build input.

## Qualified results

| Target | Rebuilt WASM SHA256 | Result |
| --- | --- | --- |
| xmllint-wasm 5.3.0 / libxml2 2.13.8 | `4e3cc21a67e8dd40ccb59822e4193fd1923b4cda08b40fe8ff8973de5eed9515` | Exact installed bytes, 778,732 bytes; original build and controlled build without committed `libz.a` are identical. |
| sharp WASM 0.35.5 wrapper / publisher staticdev 1.3.4 | `22f22b41516f08077500b3472fc1c4ee55f9686cbb90cef361b71f0bee94a440` | Exact installed bytes, 9,150,351 bytes; wrapper C++ source rebuilt against publisher static archives. Nested libraries were not rebuilt in this qualification. |
| sharp WASM 0.35.5 full-library source replacement | `740521302afc687d45443ce86a9182a6a4ecc8f0dd0cffab70db117764e5efc3` | Newly frozen replacement with all 28 native static inputs rebuilt from supplied library sources. Linux and Windows functionality passed; historical binary reproduction is false. |

The external `wasm-rebuild-01` evidence directory preserves original command logs, failures, input hashes, compiler versions, frozen image identifiers, generated link maps, archive extraction records, objects, build scripts, functional results and rebuilt artifacts. Source inputs remain in the separate, unchanged `supplemental-wasm-02` and `supplemental-native-02` bundles. Installed hashes before and after both runs agree.

## xmllint source build and committed archive

The wrapper source is commit `83b814cdc39625af5c34370c627599d973d28b07`; its libxml2 submodule is `eb0a2f2b91566384f378d870ffcd69c0a24162cc`. The build uses the original libxml2 configure and compile scripts, `MAKEFLAGS=-j2`, and Emscripten 4.0.6. The official base image is pinned by digest `sha256:a73e14e25eac4d15d094a9688438ba0ea84e79867ab42365e14abec3a36635bf`. Additional Autotools packages were installed only in an isolated preparation container, their versions recorded, and the resulting environment frozen as local image `sha256:f09358b4ce81b23a390604cec09307cbf2b6719c0025c50a097b947745bc4564`. The actual source compile had no network access. The compiler itself was supplied by that image; it was not rebuilt from the separately retained compiler source.

The original link names committed `libz.a` (SHA256 `e13d4bbb2212dd198dace6f4248c52b5214b6d64be0e9efd5169cbddcfb9d05f`). Both `--why-extract` and the link map show zero extracted members from this archive. A controlled second link removes only that archive argument and produces identical final WASM bytes. The rebuilt libxml2 configuration leaves `HAVE_ZLIB_H` undefined. This closes whether that particular unidentified archive contributes object code to the checked installed WASM: it does not. It is not a conclusion about zlib in other product components.

Both variants pass the upstream Node test suite and additional XSD tests that accept a valid integer document, reject an invalid value, and reject malformed XML. Independent execution using qualified Windows Node 22.23.3 also passes all six additional checks. The upstream intentional memory-exhaustion negative test prints an expected diagnostic before reporting success; the original output is retained.

Evidence: `attempt-001/result.json`, `with-libz/link.map`, `with-libz/why-extract.tsv`, `without-libz/`, `libxml2-config.h`, `libxml2-link-objects.tar.gz`, `functional-validation.json`, and `windows-node22-functional.json`.

## sharp wrapper source relink

Sharp source commit `51a990faa26ade5586a4934ac9673c98d8893326` supplies the C++ wrapper, original Emscripten preamble, build definitions, and emnapi patch. Publisher `@img/sharp-libvips-dev-wasm32` 1.3.4 supplies headers, package configuration and 28 static archives. Its original archive SHA256 is `23f797d1d182d6e768eff78f69baa6abecbb224119f3c3f93f8e43a24b01b445`.

The official Emscripten 6.0.10 base image is pinned by digest `sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65`. The isolated preparation freezes an independent npm lock and the patched source/dependency tree. Selected direct build tools are fixed to emnapi and its runtime 1.11.3, node-addon-api 8.9.2, node-gyp 12.4.0, and patch-package 8.0.1. The original source does not provide a publisher npm lock. This new lock is not presented as the original publisher dependency resolution. Local frozen image `sha256:ae3a838f292db98621e158c1323cbc2271161bcfde9f935e34a5b4a5134e4608` compiled without network access, with at most two jobs and two allocated CPUs.

The test asserts that sharp loaded the rebuilt local binding. It checks every decoded PNG pixel after nearest-neighbour enlargement of a synthetic RGB image, JPEG/WebP output dimensions, and resvg SVG-to-PNG dimensions. All passed both in Linux and qualified Windows Node 22.23.3, with identical output hashes. The Windows harness injects the rebuilt binding into the process module cache and reads the installed JavaScript wrapper; it changes no candidate file. The final WASM exactly matches the installed artifact despite independent build-tool resolution. Link extraction records identify the actual linked archives, including zlib-ng's `libz.a`, resvg, libvips and its C++ API. Unlike the xmllint result, zlib archive members do contribute here.

A genuine first preparation failure is preserved in `sharp-attempt-001`: the recipe omitted the `patch-package` executable. Adding the explicit build dependency repaired that normal build defect. The complete successful run is `sharp-attempt-002`, including `result.json`, `package-lock.json`, `npm-dependency-tree.json`, `sharp-frozen-build-inputs.tar.gz`, `sharp-link-objects.tar.gz`, `sharp-link.map`, `sharp-why-extract.tsv`, and `functional-validation.json`.

This qualifies the wrapper rebuild and executable final relink with the publisher's library archives. It does not establish full library source rebuildability or historical identity of the nested wasm-vips HEAD and mutable patch URLs. The source supplement's pinned observed snapshot and resvg vendored Rust source remain preparation material for a separately qualified new full-source build.

## Qualified full-library source replacement

The `sharp-full` target uses the explicitly pinned wasm-vips snapshot `dca91909178800875b575eb896d1fe4ed0a27931` as a newly frozen replacement route. Its identity as the publisher's historical nested HEAD is not attested. All supplied library archives are checked against fixed hashes. This route retains the complete SVG, AVIF and UltraHDR configuration; it disables the separately optional JPEG XL module, matching the publisher sharp-WASM recipe.

Preparation captures the observed Emscripten patch bytes, GLib/libvips/mozjpeg patches, GLib's pinned gvdb and checksum-verified PCRE2 fallback material, Rust nightly `2026-09-26`, and the crate cache resolved from resvg's checked lockfile. Meson 1.9.1 and preparation package versions are recorded. No compile-time download is allowed. The original source build script is preserved beside the reviewed execution script; source-input repackaging and resource-limit changes are explicit. Full attempt 004 completed the source-build chain, final binding and Linux/Windows functional checks. No source-completeness, legal or release gate is changed by this engineering qualification.

The installed sharp link explicitly extracts the gvdb reader object from `libgio-2.0.a`. GLib's source wrap pins gvdb commit `2b42fc75f09dbe1cd1057580b5782b08f2dcb400`; the newly captured source archive has SHA256 `069a00aa1fc893f18423602f4e095583be5a220429f6e8a58d70511490b4b019`. The captured PCRE2 fallback is a build input; no PCRE2 extraction was observed in the checked installed link.

Full attempt 001 successfully built zlib-ng, libffi and GLib before failing on an archive-compression mismatch at Expat. The supplied Expat release uses bzip2 while the upstream recipe expects xz. The repair deterministically changes only outer compression; libpng and TIFF source archives likewise retain their original tar payload while adapting xz to the upstream gzip commands. Original archives and hashes remain unchanged. A subsequent attempt may explicitly reuse completed source-built stages with `--full-cache-from <prior-full-attempt>`: the recipe checks identical source-input records, freezes the completed container under an immutable image identifier, binds the prior result hash, uses a fresh dependency working directory, and preserves the original failure and all prior compile logs. Cache reuse is recorded, never presented as a fresh clean build.

Full attempt 002 additionally built Expat, Exif, LCMS, Highway and mozjpeg. UltraHDR's Emscripten configuration probe then attempted to download the separate libjpeg port, although the selected mozjpeg library had already been built. Offline isolation blocked that request; the actual CMake configuration log is preserved. The reviewed repair makes the probe compile and link against the selected source-built mozjpeg headers and archive, and explicitly supplies the corresponding CMake JPEG paths. It does not bypass the probe or disable UltraHDR. Original and reviewed UltraHDR CMake files are retained with the next attempt. No separate Emscripten JPEG-port archive appears in the byte-identical publisher-library final link.

Full attempt 003 completed all library builds, including rebuilding Rust core/std/compiler builtins and resvg offline, but sharp's final configure step found that replacing the vendor library directories also displaced their two JavaScript path resolvers. The repair preserves only those original `__dirname` resolver modules alongside the newly built headers and archives. It copies no publisher native archive into the full-source link. Each copied archive is compared to its source-built counterpart and hashed before the final link.

The independent extended Windows harness also checks TIFF/GIF/AVIF round trips, every SVG output pixel, and an ICC transform using the built-in P3 profile. These checks pass for both the byte-identical wrapper-relinked binary and the full-source replacement, with identical output hashes. TIFF/GIF/AVIF maximum pixel differences are 1/0/0; the embedded P3 profile has 480 bytes. A runtime UltraHDR gain-map fixture is not part of this qualification; retaining, building and linking that library is a narrower claim than testing such a fixture.

An independent archive/link review confirms all 28 packaged native archives equal their newly source-built counterparts before linking, 25 are selected by the actual link, and no publisher static archive is selected. Twenty of the 28 rebuilt archives are byte-identical to publisher archives, including resvg; the differing eight are a precise remaining original-binary correspondence limit. All 19 declared component versions match the installed package. The generated JavaScript glue is byte-identical to the installed glue, SHA256 `1904293fc3f6b0d2abfec1fce156e43f2c309ee13f79498d4efdf0a931b52e5f`, so the measured new WASM is compatible with a binary-only replacement.

The actual prepared compiler image was compared against supplied runtime sources: 6,182 Emscripten system-library files, 237 headers, 80 runtime JavaScript library files, and 3,658 Rust standard-library files match exactly after the captured patches. Seven SDK-omitted editor/git-ignore files are explicitly excluded from that runtime-code comparison and remain in the original source archive. The original unfiltered comparison and its reviewed correction are both preserved externally. Compiler bootstrap binaries themselves were not rebuilt from source.

The separately assembled `wasm-replacement-01` material uses `matching-community-native-replacement-v1`. It includes the replacement WASM, portable pinned sources, all original notice text, frozen npm/Cargo/build inputs, actual source/link proofs, code and recipes. Its measured proof declares load/PNG/JPEG/WebP/SVG/TIFF/GIF/AVIF/ICC checks and `fullLibrarySourceRebuild`, while keeping legal clearance, release acceptance and historical binary reproduction false. The owner-only multi-GB toolchain image export stays outside that bounded public material. The captured source-stage cache chain is preserved; byte determinism of a separate cold rebuild is not asserted.

## Reproduction

Use a qualified Node 22 runtime and Docker Desktop's Linux engine. Source and output directories must be absolute, external to the checkout, with existing evidence preserved. Installed dependencies are read only.

```powershell
node scripts/qualify-wasm-rebuild.mjs --self-test
node scripts/qualify-wasm-rebuild.mjs --out <new-external-output> --supplement <wasm-supplement> --installed-root <candidate-node-modules>
node scripts/qualify-wasm-rebuild.mjs --target sharp --resume --out <same-output> --supplement <wasm-supplement> --native-supplement <native-supplement> --installed-root <candidate-node-modules>
node scripts/qualify-wasm-rebuild.mjs --target sharp-full --resume --out <same-output> --supplement <wasm-supplement> --native-supplement <native-supplement> --installed-root <candidate-node-modules>
node scripts/package-wasm-replacement.mjs --self-test
node scripts/package-wasm-replacement.mjs --out <new-external-replacement-bundle> --evidence <qualified-build-output> --wasm-supplement <wasm-supplement> --native-supplement <native-supplement> --installed-root <candidate-node-modules>
```

The pinned official images must first exist locally, for example through `docker pull` using their immutable references above. Preparation needs public package-network access; compilation is offline. Every resumed execution creates a new numbered attempt. Frozen local images are retained; use their recorded identifiers to repeat the compile without resolving dependencies again. Public inputs are hash-checked before use. The recipe never changes global Docker/WSL settings or candidate dependencies.

Recipient distribution of complete build materials, source and notices, applicable modification/relink terms, and legal review remain separate gates. No gate in the source supplements is promoted by this engineering result.
