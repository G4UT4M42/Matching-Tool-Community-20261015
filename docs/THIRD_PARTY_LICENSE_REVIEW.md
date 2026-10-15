# Third-party dependency license review (preliminary)

> Historical 2026-10-13 baseline retained for provenance. Current qualification supersedes its package versions, counts and unfinished-function statements; see [compliance/README.md](compliance/README.md). This historical table is not current acceptance.
**Status:** PARTIAL — not legal approval or permission to publish.

The review below is generated from installed package manifests in the private candidate on 2026-10-13, using Node.js 22. Verify all distribution artifacts and NOTICE obligations independently before public release. Manifests can be inaccurate; this is not a source-provenance or copyright audit.

| Runtime package | Observed version | Declared license |
|---|---:|---|
| better-sqlite3 | 12.6.2 | MIT |
| canvas | 3.2.1 | MIT |
| cors | 2.8.6 | MIT |
| csv-parse | 7.0.3 | MIT |
| express | 4.22.1 | MIT |
| fast-xml-parser | 5.11.0 | MIT |
| multer | 2.4.0 | MIT |
| pdf-parse | 2.4.5 | Apache-2.0 |
| pdfjs-dist | 5.5.207 | Apache-2.0 |
| pdfkit | 0.18.0 | MIT |
| pino | 9.14.0 | MIT |
| pino-pretty | 13.1.3 | MIT |
| puppeteer-core | 25.13.0 | Apache-2.0 |
| sharp | 0.35.5 | Apache-2.0 |
| tesseract.js | 7.0.0 | Apache-2.0 |
| xlsx (SheetJS CDN tarball) | 0.20.3 | Apache-2.0 (package manifest) |
| xmllint-wasm | 5.3.0 | MIT |

## Outstanding publication gates

1. Inspect **all transitive packages**, browser distributables, fonts, SVG/icons, XSD validation schemas, embedded binary modules and their attribution/NOTICE terms.
2. Independently verify the provenance, cryptographic hash, exact published license and redistribution terms of the SheetJS tarball at `cdn.sheetjs.com`. `npm audit` returning zero issues does not independently cover its third-party distribution.
3. Validate that source copied from the preexisting private application is original, owned by the maintainer or licensed for redistribution; code contains no other contributor's or vendor's proprietary material.
4. Ensure the MIT license's copyright/ownership statement is accurate and the owner explicitly chooses that license.
5. Ship obligatory copyright notices and a complete third-party attribution index in release archives.
6. Have a qualified independent reviewer sign off with evidence. Until then: **NOT_READY** for publication.

## Current technical evidence

- `npm ci --ignore-scripts` and native-module rebuild succeeded on Windows Node.js 22.
- `npm test`: 19/19 PASS across policy/migration and app guard tests.
- `npm run build`: PASS, Vite bundle warning for a 535.68 KB chunk.
- `npm run privacy:check`: 211 Git candidate files scanned without detected issues; manually review false negatives.
- `npm run audit:production`: 0 reported vulnerabilities after explicitly pinning `qs@6.16.0` with dependency override.

No bank driver, production finance database, payment operation or public push was used to produce this inventory.
