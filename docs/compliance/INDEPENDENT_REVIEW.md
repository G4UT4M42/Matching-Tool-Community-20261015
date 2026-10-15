# Independent dependency and asset review — 2026-10-15

This review inspected Community dependencies and public upstream evidence. It
did not access productive financial data, credentials, owner browser sessions,
or productive V2 source/history. It grants no legal clearance. The current
generated inventory is authoritative for the selected lockfiles and installed
files; the observations below explain obligations rather than freezing package
counts across dependency changes.

| Material | Observed evidence and obligation |
| --- | --- |
| SheetJS CE 0.20.3 | Official documentation identifies the exact CDN tarball and Apache-2.0 license. Retain attribution, copyright and license text; identify modified files. A fresh direct archive request returned HTTP 403 during review, so independent tarball digest verification remains open. |
| English/German Tesseract data | Installed `4.0.0_best_int` gzip files matched bytes retrieved from the official naptha repository. Its Apache-2.0 license applies to upstream data despite MIT npm wrapper metadata. Preserve data and engine notices separately. |
| Sharp/libvips | Installed Windows package declares Apache-2.0 AND LGPL-3.0-or-later. Its README identifies additional library terms, and `versions.json` identifies compiled versions. The top-level Apache text alone is insufficient. Complete native source/build mapping, license texts and source/relink compliance before binary redistribution. |
| node-canvas, if included | The reviewed 3.2.1 Windows installation contained 44 DLLs plus the wrapper binary. Wrapper MIT terms do not cover every compiled dependency. Omission from a later lockfile must be accompanied by clean-install evidence that the binary bundle is absent. |
| NAPI canvas | Wrapper metadata says MIT, while the Windows package contains Skia and ICU data. Match exact compiled components to Skia, ICU and their third-party notices. |
| PDFKit 0.18.0 | Fourteen AFM files retain Adobe copyright notices; an accompanying Adobe AFM permission notice was not found in the installed package. Establish precise data provenance and include applicable permission text, or replace/exclude the material and test the replacement. |
| PDF.js 5.5.207 | Preserve separate Liberation OFL-1.1, Foxit/PDFium permissive font, Adobe CMap, ICC CC0 and WASM codec notices; Apache metadata is not the complete asset inventory. |
| Lightning CSS | MPL-2.0 declarations require applicable notices and covered-source availability review when executable material is conveyed. |
| caniuse-lite | CC-BY-4.0 data requires attribution if actually redistributed. Development-only use and package redistribution are different scopes. |
| XML validator | xmllint-wasm includes MIT terms for the port/libxml material. Preserve COPYING and verify exact compiled dependencies when packaging. |
| Schemas/icons/fonts | No standalone XSD, SVG, font, image or PDF assets were observed in application source directories outside dependency installations. Austrian banking schemas were excluded; code references do not establish redistribution rights for absent files. |

The initial metadata-only review reported 107 unknown installation entries.
Of those, 104 were absent optional/platform entries. The three installed
packages with missing metadata (`busboy`, `png-js`, `streamsearch`) each had
actual MIT license text. Preserve that distinction and record text evidence;
do not silently modify upstream manifests or call absent packages unlicensed.

## Verified OCR bytes

| Official best-int gzip resource | SHA-256 |
| --- | --- |
| English | `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91` |
| German | `306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b` |

Both hashes matched direct in-memory upstream retrieval and installed bytes.
The application also records compressed/raw hashes. This establishes observed
byte equivalence, not a signed upstream build or ownership attestation.

## Remaining gates

1. Technical: collect final exact-lock inventories and native source/build
   mappings, complete all applicable notices and source/relink arrangements,
   include them in the installer, and verify the final package and installation.
2. Technical provenance: authenticate the exact SheetJS archive, reconcile all
   compiled/native assets, and establish the PDFKit AFM origin and permission.
   A failed download does not prove commercial permission is required.
3. Owner-dependent rights: confirm authority to redistribute original imported
   application code and choose its license. Existing project documentation
   labels root MIT provisional; Git authorship does not establish ownership.
4. Legal/release review: independently review the actual obligations against
   the concrete artifact. Missing engineering evidence remains technical work,
   rather than an external authorization blocker.

LGPL compliance includes appropriate notices and license texts, library source
arrangements, and a reviewed modification/relink mechanism. Dynamic linking
does not itself complete the obligations of distributing the library.

## Primary references

- [SheetJS exact distribution URL](https://docs.sheetjs.com/docs/getting-started/installation/frameworks/)
- [SheetJS license and attribution](https://docs.sheetjs.com/docs/miscellany/license/)
- [Tesseract data source](https://github.com/naptha/tessdata/blob/gh-pages/README.md)
- [Tesseract data Apache license](https://github.com/naptha/tessdata/blob/gh-pages/LICENSE)
- [Sharp/libvips build project](https://github.com/lovell/sharp-libvips)
- [node-canvas 3.2.1 upstream documentation](https://github.com/Automattic/node-canvas/blob/v3.2.1/Readme.md)
- [Skia license](https://skia.googlesource.com/skia/+/refs/heads/main/LICENSE)
- [ICU license](https://github.com/unicode-org/icu/blob/main/LICENSE)
- [GNU LGPLv3](https://www.gnu.org/licenses/lgpl-3.0.html)
- [Mozilla MPL guidance](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
- [PDFBox upstream reproduction of Adobe AFM permission](https://github.com/apache/pdfbox/blob/trunk/app/src/main/appended-resources/META-INF/LICENSE)

Adobe's historical Core 14 archive endpoint returned HTTP 404. PDFBox's notice
is corroborating upstream redistribution evidence; it does not by itself prove
the exact PDFKit files' chain of provenance. No claim of completed rights
clearance is made.
