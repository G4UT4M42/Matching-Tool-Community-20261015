# P17-W02 — draft dependency/license inventory

Status: **IMPLEMENTED (inventory script and synthetic tests)**. Redistribution rights, legal review and release acceptance are **open**.

## What was actually executed

The source-only script `scripts/generate-dependency-inventory.mjs` reads the root and web npm v3 lockfiles without fetching arbitrary dependency content. It records exact versions, declared cryptographic package integrity, observed HTTPS distribution hosts, development-vs-production classification and package license declarations.

Where a license is absent from lockfile metadata, the script examines the corresponding installed `node_modules/**/package.json` **only** when that file is regular, small, matches the lockfile name/version and is not accessed through a symbolic directory. This is metadata collection, not source licensing certification.

The script writes an explicitly labeled **draft** CycloneDX 1.5-format inventory and a rights-review JSON manifest to an owner-selected directory outside the repository. No original bank statements, credentials, browser profiles or private release history are included. Both output files deliberately indicate that redistribution rights and release acceptance remain unverified.

## Results from the October 14 integrated checkout

- 530 package-installation entries across the root and frontend lockfile dependency trees.
- 529 entries identify `registry.npmjs.org` as distribution host and one entry identifies `cdn.sheetjs.com`.
- 107 package-installation entries have no license declaration in either the lockfile or the installed package manifest. This is **not** evidence that each is unlicensed, but it does require further evidence or exclusion before public distribution.
- No non-HTTPS declared archive URLs in the inspected lockfiles.
- The script's seven synthetic tests passed after correction of an invalid single-dot package path case.

Evidence directory: `<external-audit-root>/Matching-Community-E2E-20261014-045708\dependency-license-review-extended`.

## Mandatory next gates

1. Independently review the installed/transitive packages, actual license texts and obligations, not only declared short identifiers.
2. Check the external SheetJS tarball's exact license, source/provenance and redistribution rights; separately classify font, UI asset, schema, OCR language data, browser binary and native module licensing.
3. Distinguish dependencies used during development from binaries and assets actually shipped.
4. Generate a reviewed NOTICE/attribution list and signed artifact bill of materials from a clean installed release candidate.
5. Assess vulnerability advisories against the exact distributed bundle, including any unbundled scripts/providers.
6. Audit the source-only Git history for owner identity and original V2 secrets before private publication. Do not push the original V2 history.
7. Do not grant open-source or public release acceptance until all mandatory sources/assets are legally cleared.

The initial npm production security audits reported no high/critical findings after the React Router update, but a dependency vulnerability audit is not a legal redistribution review. No GitHub release was created.
