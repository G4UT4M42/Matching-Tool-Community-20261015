# Third-party components

Matching Tool uses third-party software. The project MIT license covers its
original application material; it does not replace dependency licenses.
This index describes the source-only publication reviewed on 2026-11-01.
Pinned complete dependency edges, public distribution URLs and integrity
declarations are in [the CycloneDX SBOM](docs/compliance/sbom.cyclonedx.json).
Counts and lockfile SHA-256 bindings are in [the summary](docs/compliance/summary.json).

The reviewed locks contain **515 installation entries**: 372 installed in the
qualified Windows environment and 143 absent optional/platform entries. The
review collected 379 legal-text occurrences, deduplicated to 233 original
texts. An absent manifest license is not automatically an unlicensed package.
The installed busboy 1.6.0, png-js 1.0.0 and streamsearch 1.1.0 metadata gaps
were resolved by their unchanged original MIT license texts.

## Direct runtime dependencies

| Component | Locked version | Workspace | License scope |
| --- | --- | --- | --- |
| [@tesseract.js-data/deu](https://www.npmjs.com/package/@tesseract.js-data/deu/v/1.0.0) | 1.0.0 | root | MIT wrapper; Apache-2.0 trained data |
| [@tesseract.js-data/eng](https://www.npmjs.com/package/@tesseract.js-data/eng/v/1.0.0) | 1.0.0 | root | MIT wrapper; Apache-2.0 trained data |
| [better-sqlite3](https://www.npmjs.com/package/better-sqlite3/v/12.6.2) | 12.6.2 | root | MIT |
| [cors](https://www.npmjs.com/package/cors/v/2.8.6) | 2.8.6 | root | MIT |
| [csv-parse](https://www.npmjs.com/package/csv-parse/v/7.0.3) | 7.0.3 | root | MIT |
| [express](https://www.npmjs.com/package/express/v/4.22.1) | 4.22.1 | root | MIT |
| [fast-xml-parser](https://www.npmjs.com/package/fast-xml-parser/v/5.11.0) | 5.11.0 | root | MIT |
| [multer](https://www.npmjs.com/package/multer/v/2.5.0) | 2.5.0 | root | MIT |
| [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist/v/5.5.207) | 5.5.207 | root | Apache-2.0 |
| [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist/v/5.5.207) | 5.5.207 | web | Apache-2.0 |
| [pdfkit](https://www.npmjs.com/package/pdfkit/v/0.18.0) | 0.18.0 | root | MIT |
| [pino](https://www.npmjs.com/package/pino/v/9.14.0) | 9.14.0 | root | MIT |
| [pino-pretty](https://www.npmjs.com/package/pino-pretty/v/13.1.3) | 13.1.3 | root | MIT |
| [puppeteer-core](https://www.npmjs.com/package/puppeteer-core/v/25.13.0) | 25.13.0 | root | Apache-2.0 |
| [react](https://www.npmjs.com/package/react/v/18.3.1) | 18.3.1 | web | MIT |
| [react-dom](https://www.npmjs.com/package/react-dom/v/18.3.1) | 18.3.1 | web | MIT |
| [react-router-dom](https://www.npmjs.com/package/react-router-dom/v/7.18.4) | 7.18.4 | root | MIT |
| [react-router-dom](https://www.npmjs.com/package/react-router-dom/v/7.18.4) | 7.18.4 | web | MIT |
| [sharp](https://www.npmjs.com/package/sharp/v/0.35.5) | 0.35.5 | root | Apache-2.0 |
| [tesseract.js](https://www.npmjs.com/package/tesseract.js/v/7.0.0) | 7.0.0 | root | Apache-2.0 |
| [xlsx](https://docs.sheetjs.com/docs/miscellany/license/) | 0.20.3 | root | Apache-2.0 |
| [xmllint-wasm](https://www.npmjs.com/package/xmllint-wasm/v/5.3.0) | 5.3.0 | root | MIT |

## Direct development dependencies

| Component | Locked version | Workspace | Declared license |
| --- | --- | --- | --- |
| [@types/better-sqlite3](https://www.npmjs.com/package/@types/better-sqlite3/v/7.6.13) | 7.6.13 | root | MIT |
| [@types/cors](https://www.npmjs.com/package/@types/cors/v/2.8.19) | 2.8.19 | root | MIT |
| [@types/express](https://www.npmjs.com/package/@types/express/v/5.0.6) | 5.0.6 | root | MIT |
| [@types/multer](https://www.npmjs.com/package/@types/multer/v/2.1.0) | 2.1.0 | root | MIT |
| [@types/node](https://www.npmjs.com/package/@types/node/v/22.19.11) | 22.19.11 | root | MIT |
| [@types/pdfkit](https://www.npmjs.com/package/@types/pdfkit/v/0.17.5) | 0.17.5 | root | MIT |
| [@types/react](https://www.npmjs.com/package/@types/react/v/18.3.28) | 18.3.28 | web | MIT |
| [@types/react-dom](https://www.npmjs.com/package/@types/react-dom/v/18.3.7) | 18.3.7 | web | MIT |
| [@vitejs/plugin-react](https://www.npmjs.com/package/@vitejs/plugin-react/v/4.7.0) | 4.7.0 | web | MIT |
| [concurrently](https://www.npmjs.com/package/concurrently/v/9.2.5) | 9.2.5 | root | MIT |
| [tsx](https://www.npmjs.com/package/tsx/v/4.23.15) | 4.23.15 | root | MIT |
| [typescript](https://www.npmjs.com/package/typescript/v/5.9.3) | 5.9.3 | root | Apache-2.0 |
| [typescript](https://www.npmjs.com/package/typescript/v/5.9.3) | 5.9.3 | web | Apache-2.0 |
| [vite](https://www.npmjs.com/package/vite/v/6.4.5) | 6.4.5 | web | MIT |
| [vitest](https://www.npmjs.com/package/vitest/v/5.0.4) | 5.0.4 | root | MIT |

## Transitive payloads and additional terms

- **Sharp/libvips:** the Sharp wrapper is Apache-2.0. The installed Windows native package declares Apache-2.0 AND LGPL-3.0-or-later; its compiled sublibraries have additional retained terms. The WASM package also declares MIT for part of its payload. Wrapper metadata does not cover the complete binary.
- **PDF.js:** the Apache-2.0 distribution includes separate font, CMap, ICC and WASM codec notices, including OFL and permissive font/data terms. Keep those original disclosures when conveying those files.
- **PDFKit:** its MIT wrapper includes Adobe font-metric material with its own permission notice. The source repository contains no AFM files. Artifact-specific font notices remain a packaging duty.
- **NAPI canvas:** optional PDF dependencies can install MIT wrappers with Skia/ICU native payloads. Keep the payload-specific source and notices; do not call the whole compiled bundle MIT based on wrapper metadata.
- **Tesseract OCR:** the engine and upstream English/German trained data use Apache-2.0. The data packages' MIT wrapper metadata does not relicense the trained data. See [the upstream data license](https://github.com/naptha/tessdata/blob/gh-pages/LICENSE).
- **Lightning CSS:** the installed compiler/native component declares MPL-2.0. Conveying it requires the applicable covered-source and notice arrangements. The project does not vendor its files. See [Mozilla's MPL guidance](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).
- **caniuse-lite:** the frontend development data declares CC-BY-4.0. Preserve attribution if that data is redistributed.
- **Other transitive packages:** the inventory includes MIT, ISC, BSD, Apache-2.0, 0BSD and permissive dual-license choices. Original package-local notices remain authoritative for their material; the full SBOM lists every installation, including absent platform variants.

## What this publication contains

The Git source history contains project code, synthetic tests, documentation
and portable evidence metadata. It does **not** vendor `node_modules`, built
web bundles, Node.js, OCR model files, native/WASM libraries, font files,
banking XSDs, financial documents or installer archives. Normal source
installation obtains dependencies separately using the pinned locks and keeps
their original package-local license/NOTICE files.

The source-only assessment identified no vendored third-party implementation
or asset requiring a different project license. This is a statement about the
reviewed Git content, not blanket clearance of every future compiled artifact.
Before distributing a built frontend, installer or native/runtime bundle,
complete its actual attribution, license-text, covered-source and relink
requirements. Do not remove notices to satisfy a privacy scanner. See
[NOTICE](NOTICE), [the source review](docs/compliance/PUBLIC_SOURCE_REVIEW.md),
[dependency evidence](docs/compliance/README.md) and
[the packaging contract](docs/compliance/PACKAGING.md).

SheetJS CE remains Apache-2.0 with the attribution retained in root NOTICE.
The historical unavailable archive was not retrieved through another
endpoint; no fresh archive-authenticity claim is made. No such archive is
redistributed in this Git source publication. See the
[official SheetJS terms](https://docs.sheetjs.com/docs/miscellany/license/).

PayPal, Stripe, banking/AIS providers and invoice portals are external services,
rather than bundled libraries. Their own access, API and trademark terms
continue to apply. Publication does not create accounts or provider consent.
