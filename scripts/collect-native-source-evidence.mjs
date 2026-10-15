#!/usr/bin/env node
/** Fetch a fixed public, version-pinned source/notices catalog; never extract or execute it. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sharp = '51a990faa26ade5586a4934ac9673c98d8893326';
const vendor = 'ebb95f8add54eee8bed840e3fb587e4cbec857d7';
const mxe = 'ef19ca09af2453d127453d677c849ccb37cf5694';
const canvas = '86211d2700057f801a193a5b5d6282c9d53cab47';
const skia = '90228207f40ec85064f8b5c41fcdc2c0cf855ff2';
const icu = '364118a1d9da24bb5b770ac3d762ac144d6da5a4';
const pdfkit = '6e3727f8cb4e4e62ae24db010422c1a17c2a76bf';
const pdfjs = '5279646985f4744386a9fe3cf61b28bf1ff88d6e';
const raw = (repo, commit, path) => `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
const record = (id, url, kind, version, expectedSha256) => ({ id, url, kind, version, ...(expectedSha256 ? { expectedSha256 } : {}) });
export const catalog = [
  record('sharp-source', `https://codeload.github.com/lovell/sharp/tar.gz/${sharp}`, 'source-archive', '0.35.5'),
  record('sharp-vendor-source', `https://codeload.github.com/lovell/sharp-libvips/tar.gz/${vendor}`, 'build-source-archive', '1.3.4'),
  record('mxe-build-source', `https://codeload.github.com/libvips/build-win64-mxe/tar.gz/${mxe}`, 'build-source-archive', '8.18.7'),
  record('mxe-toolchain-source', 'https://codeload.github.com/kleisauke/mxe/tar.gz/c36160b231e66e1cbe032ed54aef7617e8b259da', 'build-source-archive', 'llvm-mingw-20260924'),
  record('libvips-source', 'https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz', 'source-archive', '8.18.7', '5baaead3b0bb20ffdb9e9ff09aa9fda08620923df77b63b436654cb5e0b3bf94'),
  record('libvips-source-digest', 'https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz.sha256sum', 'publisher-checksum', '8.18.7'),
  record('vips-static-web', 'https://github.com/libvips/build-win64-mxe/releases/download/v8.18.7/vips-dev-x64-web-8.18.7-static.zip', 'publisher-binary-reference-not-executed', '8.18.7', 'a736af61d3b46499760efa606e469cb14e060445b1f6fd36a1fa2e75009e1197'),
  record('sharp-vendor-npm', 'https://registry.npmjs.org/@img/sharp-libvips-win32-x64/-/sharp-libvips-win32-x64-1.3.4.tgz', 'publisher-package-reference', '1.3.4'),
  record('sharp-vendor-notices', raw('lovell/sharp-libvips', vendor, 'THIRD-PARTY-NOTICES.md'), 'notice-text', '1.3.4'),
  record('sharp-vendor-versions', raw('lovell/sharp-libvips', vendor, 'versions.properties'), 'build-version-map', '1.3.4'),
  record('sharp-vendor-windows-recipe', raw('lovell/sharp-libvips', vendor, 'build/win.sh'), 'build-recipe', '1.3.4'),
  record('sharp-npm-packaging-recipe', raw('lovell/sharp', sharp, 'npm/from-local-build.js'), 'build-recipe', '0.35.5'),
  record('canvas-source', `https://codeload.github.com/Brooooooklyn/canvas/tar.gz/${canvas}`, 'source-archive', '0.1.97'),
  record('canvas-release-metadata', 'https://api.github.com/repos/Brooooooklyn/canvas/releases/tags/v0.1.97', 'publisher-metadata', '0.1.97'),
  record('canvas-npm-metadata', 'https://registry.npmjs.org/@napi-rs/canvas-win32-x64-msvc/0.1.97', 'publisher-metadata', '0.1.97'),
  record('canvas-skia-recipe', raw('Brooooooklyn/canvas', canvas, 'scripts/build-skia.js'), 'build-recipe', '0.1.97'),
  record('canvas-skia-pin', raw('Brooooooklyn/canvas', canvas, '.gitmodules'), 'submodule-repository-map', '0.1.97'),
  record('skia-source', `https://codeload.github.com/google/skia/tar.gz/${skia}`, 'source-archive', skia),
  record('skia-license', raw('google/skia', skia, 'LICENSE'), 'notice-text', skia),
  record('skia-deps', raw('google/skia', skia, 'DEPS'), 'dependency-revision-map', skia),
  record('icu-license-base64', `https://chromium.googlesource.com/chromium/deps/icu/+/${icu}/LICENSE?format=TEXT`, 'base64-notice-text', icu),
  record('icu-data-base64', `https://chromium.googlesource.com/chromium/deps/icu/+/${icu}/common/icudtl.dat?format=TEXT`, 'base64-data-reference', icu),
  record('icu-version-base64', `https://chromium.googlesource.com/chromium/deps/icu/+/${icu}/source/common/unicode/uvernum.h?format=TEXT`, 'base64-version-header', icu),
  record('icu-source', `https://chromium.googlesource.com/chromium/deps/icu/+archive/${icu}.tar.gz`, 'source-archive', icu),
  ...[
    ['expat', 'chromium.googlesource.com/external/github.com/libexpat/libexpat', '8e49998f003d693213b538ef765814c7d21abada'],
    ['freetype', 'chromium.googlesource.com/chromium/src/third_party/freetype2', 'b91f75bd02db43b06d634591eb286d3eb0ce3b65'],
    ['harfbuzz', 'chromium.googlesource.com/external/github.com/harfbuzz/harfbuzz', '31695252eb6ed25096893aec7f848889dad874bc'],
    ['highway', 'chromium.googlesource.com/external/github.com/google/highway', '424360251cdcfc314cfc528f53c872ecd63af0f0'],
    ['jpeg-turbo', 'chromium.googlesource.com/chromium/deps/libjpeg_turbo', 'e14cbfaa85529d47f9f55b0f104a579c1061f9ad'],
    ['jxl', 'chromium.googlesource.com/external/gitlab.com/wg1/jpeg-xl', 'a205468bc5d3a353fb15dae2398a101dff52f2d3'],
    ['png', 'skia.googlesource.com/third_party/libpng', '4e3f57d50f552841550a36eabbb3fbcecacb7750'],
    ['webp', 'chromium.googlesource.com/webm/libwebp', '845d5476a866141ba35ac133f856fa62f0b7445f'],
    ['wuffs', 'skia.googlesource.com/external/github.com/google/wuffs-mirror-release-c', 'e3f919ccfe3ef542cfc983a82146070258fb57f8'],
    ['zlib', 'chromium.googlesource.com/chromium/src/third_party/zlib', '646b7f569718921d7d4b5b8e22572ff6c76f2596'],
    ['brotli', 'skia.googlesource.com/external/github.com/google/brotli', '6d03dfbedda1615c4cba1211f8d81735575209c8'],
  ].map(([name, repo, commit]) => record('skia-' + name + '-source', `https://${repo}/+archive/${commit}.tar.gz`, 'pinned-native-dependency-source', commit)),
  record('glib-source', 'https://download.gnome.org/sources/glib/2.90/glib-2.90.0.tar.xz', 'source-archive', '2.90.0', '17d15cac2af80a33271127408e0abc2748eb297c595c2a26409e81e14e7d1b8f'),
  record('pango-source', 'https://download.gnome.org/sources/pango/1.58/pango-1.58.2.tar.xz', 'source-archive', '1.58.2', '342385b6ca3b7c73455d7c80a13b7dbe4489e00bc3bd4c5bd6ed4dce421e374a'),
  record('librsvg-source', 'https://download.gnome.org/sources/librsvg/2.63/librsvg-2.63.2.tar.xz', 'source-archive', '2.63.2', '852b18e1a00b8605528825a27dc7748bff2a5dd254028f59dc22a34ea57e81b6'),
  record('cairo-source', 'https://cairographics.org/releases/cairo-1.18.6.tar.xz', 'source-archive', '1.18.6', '1c767308174337a74694da0f3ec069c271452163a1ef4540964c50c301f157d4'),
  record('cairo-official-alias', 'https://cairo.freedesktop.org/releases/cairo-1.18.6.tar.xz', 'source-archive', '1.18.6', '1c767308174337a74694da0f3ec069c271452163a1ef4540964c50c301f157d4'),
  record('cairo-tagged-source', 'https://gitlab.freedesktop.org/cairo/cairo/-/archive/018b3424a10ecd37450360f21454ecf0f3007e17/cairo-018b3424a10ecd37450360f21454ecf0f3007e17.tar.gz', 'version-pinned-source-alternative-not-release-tar', '1.18.6'),
  record('cairo-mpl-text', 'https://gitlab.freedesktop.org/cairo/cairo/-/raw/018b3424a10ecd37450360f21454ecf0f3007e17/COPYING-MPL-1.1', 'license-text', '1.18.6'),
  record('cairo-copying', 'https://gitlab.freedesktop.org/cairo/cairo/-/raw/018b3424a10ecd37450360f21454ecf0f3007e17/COPYING', 'license-choice-notice', '1.18.6'),
  record('fontconfig-copying', 'https://gitlab.freedesktop.org/fontconfig/fontconfig/-/raw/2.18.3/COPYING', 'license-text', '2.18.3'),
  record('vips-highway-release-source', 'https://github.com/google/highway/releases/download/1.4.0/highway-1.4.0.tar.gz', 'source-archive', '1.4.0', '36f672ab48ddb3c8555e9e89e16fe400cd7d16c6eb455a1a3d0c146a63ababdc'),
  record('vips-lcms-release-source', 'https://github.com/mm2/Little-CMS/releases/download/lcms2.19.1/lcms2-2.19.1.tar.gz', 'source-archive', '2.19.1', 'bfc54f7bab59fbc921012014a8032e4cba4abd46db47d46b76416a8c0b2815c8'),
  record('vips-freetype-tagged-source', 'https://github.com/freetype/freetype/archive/refs/tags/VER-2-14-3.tar.gz', 'version-pinned-source-alternative-not-release-tar', '2.14.3'),
  ...[
    ['cairo', '1.18.6', 'cairo-1.18.6.tar.xz', '1c767308174337a74694da0f3ec069c271452163a1ef4540964c50c301f157d4'],
    ['fontconfig', '2.18.3', 'fontconfig-2.18.3.tar.bz2', '8d28f79d2017cbe1fbb7da84b2502c86421b4f45860234d2f4ab5b35564c8d01'],
    ['freetype', '2.14.3', 'freetype-2.14.3.tar.xz', '36bc4f1cc413335368ee656c42afca65c5a3987e8768cc28cf11ba775e785a5f'],
    ['png', '1.6.58', 'libpng-1.6.58.tar.xz', '28eb403f51f0f7405249132cecfe82ea5c0ef97f1b32c5a65828814ae0d34775'],
  ].map(([name, version, filename, expected]) => record('mxe-cache-' + name + '-source', 'https://mxe-pkg.s3.amazonaws.com/' + filename + '_' + expected, 'build-project-source-cache', version, expected)),
  record('fribidi-source', 'https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz', 'source-archive', '1.0.17', '6949dcde27d41cebad1fd741fcafc36d55a1020d2d872d4a6eb3914caabbada2'),
  record('libexif-release-source', 'https://github.com/libexif/libexif/releases/download/v0.6.26/libexif-0.6.26.tar.xz', 'source-archive', '0.6.26', '4a055ed6575e61ca46c3172be3c753cc16c9becd0f99ec71d58dd0e471476c0c'),
  record('libheif-source', 'https://github.com/strukturag/libheif/releases/download/v1.23.5/libheif-1.23.5.tar.gz', 'source-archive', '1.23.5', 'fd9036064c4432f0550d15072ddf34956a248279ee9aeaff0fba3fa0f77d8f1a'),
  record('proxy-libintl-source', 'https://github.com/frida/proxy-libintl/archive/refs/tags/0.5.tar.gz', 'source-archive', '0.5', 'f7a1cbd7579baaf575c66f9d99fb6295e9b0684a28b095967cfda17857595303'),
  ...[
    ['aom', '3.15.1', 'https://storage.googleapis.com/aom-releases/libaom-3.15.1.tar.gz', '8ca0c52746174603500f0adb6f2a215d69c9ca2aab2acb3caa06fb791d8d01bf'],
    ['archive', '3.8.9', 'https://www.libarchive.org/downloads/libarchive-3.8.9.tar.xz', '888c934f9d95648ecb9163dc8e23ab80a476ecb81a8f1154704a227b5b676dde'],
    ['cgif', '0.5.4', 'https://github.com/dloebl/cgif/archive/v0.5.4.tar.gz', '83a70a15bc2da41f081a44ebc58ee48e2e1d524a6d3fdb4a24064afa08d5ad4d'],
    ['expat', '2.8.5', 'https://github.com/libexpat/libexpat/releases/download/R_2_8_5/expat-2.8.5.tar.bz2', '952c03c33a6b337f12dae7a9b0f9dee86f867550d35c994d6bdaaddd37dc8454'],
    ['ffi', '3.8.0', 'https://github.com/libffi/libffi/releases/download/v3.8.0/libffi-3.8.0.tar.gz', '7da3e2d9a171eb0a038f592ecad3ff2bb2550f3496d87b3b29ad0cf4430c0db4'],
    ['fontconfig', '2.18.3', 'https://gitlab.freedesktop.org/fontconfig/fontconfig/-/archive/2.18.3/fontconfig-2.18.3.tar.bz2', '8d28f79d2017cbe1fbb7da84b2502c86421b4f45860234d2f4ab5b35564c8d01'],
    ['freetype', '2.14.3', 'https://download.savannah.gnu.org/releases/freetype/freetype-2.14.3.tar.xz', '36bc4f1cc413335368ee656c42afca65c5a3987e8768cc28cf11ba775e785a5f'],
    ['harfbuzz', '14.5.0', 'https://github.com/harfbuzz/harfbuzz/releases/download/14.5.0/harfbuzz-14.5.0.tar.xz', 'b7132e148358a45185c9feafd049dbaf243649d3c44414b3534d9c95d18592b9'],
    ['highway', '1.4.0', 'https://github.com/google/highway/archive/1.4.0.tar.gz', '36f672ab48ddb3c8555e9e89e16fe400cd7d16c6eb455a1a3d0c146a63ababdc'],
    ['imagequant', '2.4.1', 'https://github.com/lovell/libimagequant/archive/v2.4.1.tar.gz', '47d2a84b7b1052975c9d50a3d4e3cacbf57b43d84a4c3131210848ead9964dfb'],
    ['lcms', '2.19.1', 'https://downloads.sourceforge.net/project/lcms/lcms/2.19.1/lcms2-2.19.1.tar.gz', 'bfc54f7bab59fbc921012014a8032e4cba4abd46db47d46b76416a8c0b2815c8'],
    ['mozjpeg', '0826579', 'https://github.com/mozilla/mozjpeg/archive/08265790774cd0714832c9e675522acbe5581437.tar.gz'],
    ['pixman', '0.46.4', 'https://xorg.freedesktop.org/archive/individual/lib/pixman-0.46.4.tar.gz', 'd09c44ebc3bd5bee7021c79f922fe8fb2fb57f7320f55e97ff9914d2346a591c'],
    ['png', '1.6.58', 'https://downloads.sourceforge.net/project/libpng/libpng16/1.6.58/libpng-1.6.58.tar.xz', '28eb403f51f0f7405249132cecfe82ea5c0ef97f1b32c5a65828814ae0d34775'],
    ['tiff', '4.7.2', 'https://download.osgeo.org/libtiff/tiff-4.7.2.tar.xz', '4996f0c4f93094719b1ca5c6279b20e588773ba8a247533e486416fb662ddb88'],
    ['uhdr', '2.0.2', 'https://github.com/google/libultrahdr/archive/v2.0.2.tar.gz', 'aa8d193bb887c348c419780511dd03b374f4e07af8812b6d3f80c8537cf1ef2c'],
    ['webp', '1.6.0', 'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz', 'e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564'],
    ['xml2', '2.15.4', 'https://download.gnome.org/sources/libxml2/2.15/libxml2-2.15.4.tar.xz', '98087fd181d9070724f3fbc65c7377db03038eb92bd882374daff44940138821'],
    ['zlib-ng', '2.3.3', 'https://github.com/zlib-ng/zlib-ng/archive/2.3.3.tar.gz', 'f9c65aa9c852eb8255b636fd9f07ce1c406f061ec19a2e7d508b318ca0c907d1'],
  ].map(([name, version, url, expected]) => record('vips-' + name + '-source', url, 'pinned-native-dependency-source', version, expected)),
  record('gpl3-text', 'https://www.gnu.org/licenses/gpl-3.0.txt', 'license-text', 'GPL-3.0'),
  record('lgpl3-text', 'https://www.gnu.org/licenses/lgpl-3.0.txt', 'license-text', 'LGPL-3.0'),
  record('node-source', 'https://nodejs.org/dist/v22.23.3/node-v22.23.3.tar.xz', 'source-archive', '22.23.3'),
  record('node-publisher-checksums', 'https://nodejs.org/dist/v22.23.3/SHASUMS256.txt', 'publisher-checksum', '22.23.3'),
  record('sharp-wasm-npm', 'https://registry.npmjs.org/@img/sharp-wasm32/-/sharp-wasm32-0.35.5.tgz', 'publisher-package-reference', '0.35.5'),
  record('sharp-wasm-npm-metadata', 'https://registry.npmjs.org/@img/sharp-wasm32/0.35.5', 'publisher-metadata', '0.35.5'),
  record('sharp-wasm-provenance', 'https://registry.npmjs.org/-/npm/v1/attestations/@img%2fsharp-wasm32@0.35.5', 'publisher-provenance', '0.35.5'),
  record('sharp-wasm-dev-npm', 'https://registry.npmjs.org/@img/sharp-libvips-dev-wasm32/-/sharp-libvips-dev-wasm32-1.3.4.tgz', 'publisher-linkable-build-inputs', '1.3.4'),
  record('sharp-wasm-dev-metadata', 'https://registry.npmjs.org/@img/sharp-libvips-dev-wasm32/1.3.4', 'publisher-metadata', '1.3.4'),
  record('sharp-wasm-dev-provenance', 'https://registry.npmjs.org/-/npm/v1/attestations/@img%2fsharp-libvips-dev-wasm32@1.3.4', 'publisher-provenance', '1.3.4'),
  record('sharp-wasm-build-recipe', raw('lovell/sharp-libvips', vendor, 'build/wasm.sh'), 'build-recipe', '1.3.4'),
  record('xmllint-npm', 'https://registry.npmjs.org/xmllint-wasm/-/xmllint-wasm-5.3.0.tgz', 'publisher-package-reference', '5.3.0'),
  record('xmllint-npm-metadata', 'https://registry.npmjs.org/xmllint-wasm/5.3.0', 'publisher-metadata', '5.3.0'),
  record('xmllint-source', 'https://codeload.github.com/noppa/xmllint-wasm/tar.gz/83b814cdc39625af5c34370c627599d973d28b07', 'source-archive', '5.3.0'),
  record('xmllint-tag-metadata', 'https://api.github.com/repos/noppa/xmllint-wasm/git/ref/tags/v5.3.0', 'publisher-metadata', '5.3.0'),
  record('canvas-build-runs', `https://api.github.com/repos/Brooooooklyn/canvas/actions/runs?head_sha=${canvas}&per_page=10`, 'public-build-run-metadata', '0.1.97'),
  record('canvas-build-artifacts', 'https://api.github.com/repos/Brooooooklyn/canvas/actions/runs/23125669213/artifacts?per_page=100', 'public-build-artifact-metadata', '0.1.97'),
  record('canvas-build-jobs', 'https://api.github.com/repos/Brooooooklyn/canvas/actions/runs/23125669213/jobs?per_page=100', 'public-build-job-metadata', '0.1.97'),
  record('canvas-npm-wrapper', 'https://registry.npmjs.org/@napi-rs/canvas/-/canvas-0.1.97.tgz', 'publisher-package-reference', '0.1.97'),
  record('canvas-binary-provenance', 'https://registry.npmjs.org/-/npm/v1/attestations/@napi-rs%2fcanvas-win32-x64-msvc@0.1.97', 'publisher-provenance', '0.1.97'),
  record('canvas-windows-build-log-status', 'https://api.github.com/repos/Brooooooklyn/canvas/actions/jobs/67168119814/logs', 'public-build-log-availability-check', '0.1.97'),
  record('sharp-wasm-vendor-jobs', 'https://api.github.com/repos/lovell/sharp-libvips/actions/runs/36315646015/jobs?per_page=100', 'public-build-job-metadata', '1.3.4'),
  record('sharp-wasm-vendor-log-status', 'https://api.github.com/repos/lovell/sharp-libvips/actions/jobs/108609814244/logs', 'public-build-log-availability-check', '1.3.4'),
  record('wasm-vips-build-time-head', 'https://api.github.com/repos/kleisauke/wasm-vips/commits?until=2026-09-27T11:25:26Z&per_page=1', 'historical-head-inference-not-build-proof', '8.18.7'),
  record('wasm-vips-inferred-source', 'https://codeload.github.com/kleisauke/wasm-vips/tar.gz/dca91909178800875b575eb896d1fe4ed0a27931', 'inferred-build-source-not-attested-historical-input', '8.18.7'),
  record('resvg-release-source', 'https://github.com/linebender/resvg/releases/download/v0.48.1/resvg-0.48.1.tar.xz', 'source-archive-with-vendored-rust-dependencies', '0.48.1'),
  record('emscripten-6-source', 'https://codeload.github.com/emscripten-core/emscripten/tar.gz/d6c521a7f05449857c76bd99e396895583cf2083', 'version-pinned-toolchain-source', '6.0.10'),
  record('emscripten-4-source', 'https://codeload.github.com/emscripten-core/emscripten/tar.gz/1ddaae4d2d6dfbb678ecc193bc988820d1fc4633', 'version-pinned-toolchain-source', '4.0.6'),
  record('xmllint-libxml-submodule', 'https://api.github.com/repos/noppa/xmllint-wasm/contents/libxml2?ref=83b814cdc39625af5c34370c627599d973d28b07', 'submodule-commit-map', '2.13.8'),
  record('xmllint-libxml-source', 'https://codeload.github.com/GNOME/libxml2/tar.gz/eb0a2f2b91566384f378d870ffcd69c0a24162cc', 'version-pinned-submodule-source', '2.13.8'),
  record('wasm-rust-nightly-channel', 'https://static.rust-lang.org/dist/2026-09-26/channel-rust-nightly.toml', 'publisher-toolchain-version-map', 'nightly-2026-09-26'),
  record('wasm-rust-std-source', 'https://static.rust-lang.org/dist/2026-09-26/rust-src-nightly.tar.xz', 'pinned-standard-library-source', 'nightly-2026-09-26', '9960c4bd878cfdc6acfe4a01b428c33ff6a5527f6f5e4a8b426cbe19236bded0'),
  record('wasm-emscripten-observed-patches', 'https://github.com/kleisauke/emscripten/compare/d6c521a7f05449857c76bd99e396895583cf2083...d1aa1ceae8408311868149e0971473bd3e2eafab.patch', 'observed-pinned-patches-not-attested-historical-input', '6.0.10'),
  record('pdfkit-source', `https://codeload.github.com/foliojs/pdfkit/tar.gz/${pdfkit}`, 'source-archive', '0.18.0'),
  record('pdfkit-afm-permission', raw('foliojs/pdfkit', pdfkit, 'lib/font/data/MustRead.html'), 'permission-notice', '0.18.0'),
  record('adobe-historical-afm-archive', 'https://www.adobe.com/devnet/font/pdfs/Core14_AFMs.zip', 'historical-primary-reference', 'Core14'),
  record('pdfjs-source', `https://codeload.github.com/mozilla/pdf.js/tar.gz/${pdfjs}`, 'source-archive', '5.5.207'),
  ...['standard_fonts/LICENSE_FOXIT', 'standard_fonts/LICENSE_LIBERATION', 'standard_fonts/README.md', 'bcmaps/LICENSE', 'iccs/LICENSE', 'iccs/README.md', 'jbig2/LICENSE_JBIG2', 'jbig2/LICENSE_PDFJS_JBIG2', 'jbig2/README.md', 'openjpeg/LICENSE_OPENJPEG', 'openjpeg/LICENSE_PDFJS_OPENJPEG', 'openjpeg/README.md', 'qcms/LICENSE_QCMS', 'qcms/LICENSE_PDFJS_QCMS', 'qcms/README.md'].map((path, i) => record('pdfjs-asset-notice-' + i, raw('mozilla/pdf.js', pdfjs, 'external/' + path), 'asset-notice-or-build-reference', '5.5.207')),
];
const hosts = new Set(['raw.githubusercontent.com', 'api.github.com', 'github.com', 'codeload.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'registry.npmjs.org', 'chromium.googlesource.com', 'skia.googlesource.com', 'www.adobe.com', 'download.gnome.org', 'cairographics.org', 'cairo.freedesktop.org', 'www.gnu.org', 'nodejs.org', 'storage.googleapis.com', 'www.libarchive.org', 'gitlab.freedesktop.org', 'download.savannah.gnu.org', 'download-mirror.savannah.gnu.org', 'xorg.freedesktop.org', 'downloads.sourceforge.net', 'netix.dl.sourceforge.net', 'master.dl.sourceforge.net', 'download.osgeo.org', 'mxe-pkg.s3.amazonaws.com', 'static.rust-lang.org']);
export function safeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || url.hash) throw new Error('Unapproved public source URL');
  return url;
}
export function outputDirectory(value) {
  if (!value || !isAbsolute(value)) throw new Error('Use an absolute new external evidence directory');
  const out = resolve(value), rel = relative(root, out);
  if (!(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) || existsSync(out)) throw new Error('Evidence directory must be new and outside source');
  let current = out;
  while (true) { if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Evidence output cannot traverse links'); const parent = dirname(current); if (parent === current) break; current = parent; }
  return out;
}
async function download(url, redirects = 0) {
  safeUrl(url);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'Matching-Community-Source-Provenance/1.0', Accept: new URL(url).hostname === 'api.github.com' ? 'application/vnd.github+json' : '*/*' } });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= 5 || !response.headers.get('location')) throw new Error('Source redirect limit');
    await response.body?.cancel(); return download(new URL(response.headers.get('location'), url).href, redirects + 1);
  }
  if (!response.ok) { await response.body?.cancel(); return { status: response.status, failure: 'HTTP_' + response.status }; }
  const max = 128 * 1024 * 1024, chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > max) { await response.body.cancel().catch(() => {}); throw new Error('Artifact exceeds 128 MiB bound'); } chunks.push(chunk); }
  return { status: response.status, bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type') };
}
export async function collect(out, only = []) {
  if (only.some(id => !catalog.some(entry => entry.id === id)) || only.length !== new Set(only).size) throw new Error('Unknown or duplicate catalog selection');
  const selection = only.length ? catalog.filter(entry => only.includes(entry.id)) : catalog;
  out = outputDirectory(out); mkdirSync(out, { recursive: true }); mkdirSync(join(out, 'downloads'));
  const results = [];
  // Limit network concurrency; never use downloaded scripts or extract archives.
  let next = 0;
  async function worker() {
    while (next < selection.length) {
      const item = selection[next++]; let result;
      try {
        const response = await download(item.url);
        if (!response.bytes) result = { ...item, status: response.status, failure: response.failure };
        else {
          const hash = sha(response.bytes), path = 'downloads/' + item.id + '.bin';
          writeFileSync(join(out, path), response.bytes);
          result = { ...item, status: response.status, path, bytes: response.bytes.length, sha256: hash, expectedDigestMatched: item.expectedSha256 ? hash === item.expectedSha256 : null };
          if (item.kind.startsWith('base64-')) { const decoded = Buffer.from(response.bytes.toString().trim(), 'base64'), decodedPath = 'downloads/' + item.id + '.decoded'; writeFileSync(join(out, decodedPath), decoded); result.decoded = { path: decodedPath, bytes: decoded.length, sha256: sha(decoded) }; }
          if (result.expectedDigestMatched === false) result.failure = 'PUBLISHER_DIGEST_MISMATCH';
        }
      } catch (error) { result = { ...item, failure: error instanceof Error ? error.name + ': ' + error.message : 'Download failed', ...(error?.cause?.code ? { networkCause: String(error.cause.code) } : {}) }; }
      results.push(result);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  results.sort((a, b) => a.id < b.id ? -1 : 1);
  const report = { format: 'matching-native-source-evidence-v1', retrievalDateUtc: new Date().toISOString(), downloadedCodeExecuted: false, archivesExtracted: false,
    sourceOwnershipVerified: false, correspondingSourceComplete: false, relinkQualificationComplete: false, legalClearance: false, releaseAccepted: false, artifacts: results };
  writeFileSync(join(out, 'source-artifacts.json'), JSON.stringify(report, null, 2) + '\n');
  const hashes = results.flatMap(entry => [...(entry.path ? [{ path: entry.path, sha256: entry.sha256 }] : []), ...(entry.decoded ? [entry.decoded] : [])]);
  hashes.push({ path: 'source-artifacts.json', sha256: sha(JSON.stringify(report, null, 2) + '\n') });
  writeFileSync(join(out, 'SHA256SUMS'), hashes.sort((a, b) => a.path < b.path ? -1 : 1).map(entry => entry.sha256 + '  ' + entry.path).join('\n') + '\n');
  return { requested: results.length, fetched: results.filter(e => e.path).length, failures: results.filter(e => e.failure).map(e => ({ id: e.id, failure: e.failure })), releaseAccepted: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--self-test') {
      for (const item of catalog) { assert.match(item.id, /^[a-z0-9-]+$/); safeUrl(item.url); }
      assert.equal(new Set(catalog.map(e => e.id)).size, catalog.length);
      for (const url of ['http://github.com/source', 'https://unapproved.example/source', 'file:///source']) assert.throws(() => safeUrl(url));
      const credentials = new URL('https://github.com/source'); credentials.username = 'synthetic'; assert.throws(() => safeUrl(credentials.href));
      assert.throws(() => outputDirectory(join(root, 'work')));
      assert.throws(() => outputDirectory('relative-evidence'));
      console.log(JSON.stringify({ catalogEntries: catalog.length, unsafeUrlsRejected: 4, unsafeOutputsRejected: 2, releaseAccepted: false }));
    } else {
      const args = process.argv.slice(2), options = {};
      while (args.length) { const name = args.shift(); if (!['--out', '--only'].includes(name) || !args.length || options[name]) throw new Error('Usage: node scripts/collect-native-source-evidence.mjs --out <new-absolute-external-directory> [--only catalog-id,catalog-id] | --self-test'); options[name] = args.shift(); }
      console.log(JSON.stringify(await collect(options['--out'], options['--only'] ? options['--only'].split(',') : []), null, 2));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : 'Source evidence collection failed'); process.exitCode = 1; }
}
