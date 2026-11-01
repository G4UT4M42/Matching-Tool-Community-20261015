# Dependency evidence and redistribution review

> Scope update, 2026-11-01: the maintainer has requested public publication of
> the sanitized source repository. See the [current source review](PUBLIC_SOURCE_REVIEW.md).
> Historical private-use and binary-package results below retain their original
> scope; public source does not certify a stable product or release an installer.

Status: IMPLEMENTED for reproducible evidence collection. Ownership, complete
native-library compliance, legal review, and release acceptance remain open.

The owner-selected private internal scope and bounded attribution/notice
findings are recorded in the [private internal use addendum](PRIVATE_INTERNAL_USE.md).
It distinguishes current internal-use conditions, future recipient obligations
and owner-deferred VM testing without changing license or acceptance flags.

Run from the checkout using the qualified Node.js 22 runtime:

```powershell
node scripts/create-compliance-inventory.mjs --self-test
node scripts/create-compliance-inventory.mjs --out <absolute-external-evidence-directory>
```

The generator uses no network, executes no dependency code, and reads only the
root/web npm v3 locks and matching installed dependency files. It emits stable
content for identical inputs, without timestamps or machine-specific paths.
It does not copy package author, contributor, funding, or credential metadata.
Parameterized/credential-bearing dependency URLs, traversal paths, links, and
installed package name/version mismatches are rejected. Unapproved distribution
locations are omitted and flagged. All package license declarations remain
claims awaiting review.

| Output | Purpose |
| --- | --- |
| `sbom.cyclonedx.json` | CycloneDX 1.5 inventory of every root/web lock installation, including absent platform packages, dependency edges, declared licenses, public distribution URLs and correctly decoded hexadecimal package hashes |
| `compliance-inventory.json` | Installed/absent status, metadata evidence, package manifest hashes, nested legal-text and binary/font/OCR/schema hashes, review gates and unresolved dependency edges |
| `license-texts/<sha256>.txt` | Byte-preserved legal-text evidence, deduplicated by SHA-256; source package and relative path remain in the inventory |
| `summary.json` | Portable counts, lock hashes, limitations and unresolved edges |
| `SHA256SUMS` | Hashes of every generated report and copied text in this invocation |

The source-controlled `sbom.cyclonedx.json` and `summary.json` are portable
review snapshots. Their lock hashes identify the reviewed inputs; regenerate
external evidence and replace these snapshots after a lockfile change. Review
metadata for machine paths/contact information before copying it into source.
The external full inventory maps copied legal texts to packages and records
asset hashes; it is intentionally separate from the portable source snapshot.
See [validation evidence](VALIDATION.md) for the qualified runtime and checks.

Use a fresh external evidence directory for each reviewed candidate. Existing
files from previous invocations are not deleted. The checksum manifest lists
only this invocation's outputs. Collect again after dependencies, installation
platform, package contents or lockfiles change. A lock integrity string is a
declared download digest; this offline tool does not claim it downloaded or
independently authenticated that archive.

Both development and production installations are scanned because a blanket
`node_modules` installer can redistribute either. Absent platform dependencies
remain visible in the SBOM but are not represented as installed binaries. Scan
the actual packaged installation as an additional acceptance step. Package
legal-text copies are collected recursively, excluding nested `node_modules`
which belong to their own installation entries. node-canvas, if installed, has
its wrapper license extracted from the Readme license section as additional
evidence. A license-looking filename is evidence collection, not an assignment
of that license to every file.

## Source and binary inclusion

Commit only reviewed portable metadata, this documentation, the generator and
root NOTICE. Full legal-text evidence stays external during source privacy
review because upstream legal notices can contain third-party contact details.
Do not remove required upstream copyright or permission text to make a scanner
pass. Distinguish upstream public legal notices from private owner information.

A binary distribution must include the applicable original license/NOTICE
texts, accurate attribution, required source or a compliant source offer and
modification/relink information. Preserve package-local legal files. The full
bundle may need additional upstream native-source notices not present in npm
packages; the generated copied-text directory alone is not sufficient proof.
The installer must carry the root NOTICE and reviewed complete disclosures.
Check the final archive and installed result, not only the source checkout.

See [the independent review](INDEPENDENT_REVIEW.md) for known obligations and
remaining gates. Automated counts, absence of vulnerability advisories and
successful CI do not provide copyright ownership or redistribution clearance.


The development package additionally carries an exact runtime CycloneDX
overlay. It identifies bundled Node and each separately reviewed source-built
replacement by actual binary hash, with hash-bound source/notice/build
inventories. This complements the npm source inventory above; it does not
replace original attribution or claim that registry-tarball hashes describe
modified binaries. See PACKAGING.md for exact descriptors and measured scope.
