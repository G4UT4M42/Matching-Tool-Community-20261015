# Compliance inventory validation — 2026-10-15

Runtime: Node.js 22.23.3, Windows x64.

```powershell
node --version
node scripts/create-compliance-inventory.mjs --self-test
node scripts/create-compliance-inventory.mjs --out <absolute-external-evidence-directory>
node scripts/check-public-tree.mjs --include-untracked
```

Results for the source-controlled snapshot:

- 18 synthetic assertions passed: hash decoding, traversal rejection,
  credential/parameter URL rejection, private location omission, malformed
  integrity rejection, source-output rejection, nested dependency resolution,
  installed/absent accounting, nested/deduplicated legal texts, deterministic
  output, no author metadata/machine-path export, unaccepted release status,
  installed-version mismatch rejection, and directory-junction refusal.
- 517 package installation entries across root and web locks: 374 installed,
  143 absent. Both scopes include development and optional dependencies.
- 381 legal-text file occurrences, 235 distinct byte-preserved text copies;
  52 binary/font/OCR assets with SHA-256 hashes.
- Three installed metadata license gaps, each with actual license text copied;
  95 metadata gaps belong to absent optional/platform installations.
- No unresolved mandatory dependency edges. The 36 unresolved edges are
  optional declarations, recorded individually rather than hidden.
- No `canvas` wrapper entry remains in the lock inventory following removal
  of the unused direct dependency. NAPI canvas remains separately inventoried.
- CycloneDX 1.5 JSON-schema validation: zero errors using the official
  specification repository's 1.5 schema and associated SPDX/JSF schemas.
- All 238 generated report/legal-text checksums verified independently.
- Repeated invocation produced byte-identical checksum-manifest content.
- Source metadata was checked for email-like addresses and machine paths
  before copying. Whole-tree privacy scanner passed at 479 candidate paths.

Root lock SHA-256:
`8a62f174788392ce04bef1e839472d04550e82f74472356f3209629242473653`

Web lock SHA-256:
`8e93fe21fe9b612726062a2643d9d86e48f6e32c606bb00fbb3796c8417529f8`

The schemas were retrieved from the official
[CycloneDX specification 1.5 source](https://github.com/CycloneDX/specification/tree/1.5/schema).
Schema validation checks inventory structure, not legal rights or package
authenticity. No financial tests were needed for this standalone collection
script. All rights/release acceptance fields remain false.

The refreshed snapshot follows removal of unused pdf-parse and its nested native/PDF dependencies. The 134-entry native source/notice supplement is separately hash-validated; source/legal/relink acceptance remains false. Historical schema/checksum results above identify their original invocation; final exact-candidate inventory validation is recorded separately.

## Candidate version refresh

The development candidate is now0.2.0-community-candidate.1. Only application
version/description and root lock version metadata changed; every dependency
package/version/integrity edge remained identical. Fresh deterministic inventory
`compliance-candidate-version-01` records517installations/374installed/143absent,
381notice occurrences/235distinct texts and52assets. Current root lockSHA256:
`5fe006d62b570c228513b53ee8a756d244dd155af0c301d2b633f032ad15b7d0`.
Web lock remains unchanged. Source-controlled SBOM/summary match that invocation.
This semantic prerelease version and refreshed inventory do not mark software,
repository or redistribution acceptance. Historical hashes above retain their
original evidence scope.
