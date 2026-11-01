# Private internal use: scope and evidence addendum

> Scope update, 2026-11-01: the maintainer has requested public publication of
> the sanitized source repository. See the [current source review](PUBLIC_SOURCE_REVIEW.md).
> Historical private-use and binary-package results below retain their original
> scope; public source does not certify a stable product or release an installer.

The owner selected private internal use on 2026-10-16, requested an actual
snippet attribution investigation, and deferred VM testing. No blanket
first-party ownership or MIT licensing authority was confirmed. `LICENSE`
and `NOTICE` remain unchanged; third-party material retains its own terms.
This document does not grant rights or make a software, legal, distribution,
or release acceptance claim.

The evidence below describes the sealed source revision
`fbf40e85cbaa8213e6fa199bfcf5690eeedec5f8` and selected development package
manifest `3e907dd39cd7f6187f7be85f211ef2bef14495309f69034c9487c04bec24b024`.
It does not qualify later application changes. Preserve all sealed artifacts,
historical failures, their original flags, and their independent reviews.

## Bounded snippet findings

The local screen covered 403 tracked code files, 3,889,509 bytes and 51,655
normalized windows of twelve substantive lines. It compared those windows
against 4,004 selected runtime source files totaling 88,401,875 bytes and found
zero exact-copy candidates. Three engine text files over the individual 4 MiB
bound were excluded. The 373 attribution-related markers were classified as
notice-validation code, an explicitly independent test comment, official
endpoint/provenance references, or synthetic test contracts; no positive
external snippet attribution was identified.

This cannot detect every short, rewritten, or internet-derived snippet and
does not establish authorship, contributor/employer rights, or ownership of
the inherited sanitized base. No source was uploaded or searched externally.
The root MIT statement remains limited to material for which the necessary
rights actually exist; screening is not an ownership attestation.

Owner-held evidence identifiers, relative to the acceptance evidence root:

- `snippet-attribution-20261016-01/screen.result.json`, SHA256
  `4677361394c8e5679a7a1641585575e73d690f83efb218ade129a85fa187195b`.
- `snippet-attribution-20261016-01/triage.result.json`, SHA256
  `bd0878cea1423b410d875b5b393c2b789eabb05fac0af569826293e288987f6a`.

## Runtime notice companion

`runtime-notice-supplement-02` passed independent review in its stated scope.
Its manifest SHA256 is
`6fbb34c6b8d0b1734d95fc97636c7a8860ce681df19d112506cede5737f2c58e`:
17 mapped payloads, 83,112 bytes and six unchanged original upstream notices.
Eleven original npm archives matched the frozen lock integrity strings; all
1,216 regular archive members matched actual selected-package bytes.

The companion supplies original Nodable, Puppeteer, Google Brotli submodule
and OCR data-source notices. It distinguishes already supplied notices
(including esbuild's parent license and cookie-signature's README) from
packages whose exact upstream snapshot contains only an MIT declaration.
The included standard MIT template is explicitly a reference, not a new grant
or an invented copyright holder/year. OCR data-package MIT metadata does not
replace the traineddata source's Apache-2.0 terms. The actual Tesseract.js and
core engine licenses in this package are also Apache-2.0.

Independent evidence:
`independent-security/runtime-notice-supplement-02-independent-01.result.json`,
SHA256 `df1a5445615527352d710a1837328886b319f85bc9ee892f1a130c4aa93386a6`.
The review verified all mapped bytes, the full companion inventory and its
stated privacy scope. It does not verify first-party rights or grant legal
clearance. Original upstream notices remain external to the Git source;
do not redact them to satisfy a source privacy scan.

For a newly qualified development package, retain the other reviewed inputs
and append this existing generic builder argument:

```text
--supplement <absolute-external-runtime-notice-supplement-02-directory>
```

Use a fresh output directory, current matching dependency evidence and the
qualified runtime. Verify the new package and record its actual revision,
manifest and companion hashes. Do not insert files into the sealed package
or promote its `distributable`, rights, legal, or release flags. The same
companion can instead remain an independently identified adjacent evidence
directory; that does not change the old manifest.

## Current scope of the historical gates

| Gate | Private internal scope |
| --- | --- |
| First-party authority | The bounded attribution investigation is recorded; ownership/MIT authority remains unverified. Resolve any concrete origin or rights issue specifically, rather than treating a zero-match screen as proof. |
| SheetJS provenance | The installed CE 0.20.3 full Apache-2.0 license and frozen official URL/integrity evidence remain available. Fresh exact archive authenticity is unverified. A fresh download is not an Apache-2.0 condition of internal execution; trusted owner intake is optional for closing that provenance uncertainty. |
| Redistribution | External recipient distribution is outside the selected scope. Retain applicable notices and supplied sources. Future third-party delivery, even privately, requires its own concrete notice/source/relink/recipient-terms assessment. |
| Real providers | Account, consent, MFA, scopes and actual provider capabilities require their own authorized connection. Internal use does not establish real-provider acceptance or permission for transfers. |
| Pristine Windows | Owner-deferred, not passed. Existing-host selected-package acceptance and fresh hosted publisher-package acceptance remain distinct. No current VM action is requested. |

The previous SheetJS denial was not retried or bypassed. The owner-held
lock-bound intake is `owner-sheetjs-intake-20261016-01/expected-evidence.json`.
No commercial-license requirement was established by the missing fresh
archive. See the [Apache-2.0 terms](https://www.apache.org/licenses/LICENSE-2.0)
and the [MIT copy/notice condition](https://opensource.org/license/mit).

Private visibility alone does not establish that a copy to another person or
entity is internal. The [FSF internal-distribution guidance](https://www.gnu.org/licenses/gpl-faq.en.html#InternalDistribution)
explains that boundary for its licenses. No public distribution, recipient
source offer, or license-conflicting recipient restriction is authorized here.
No blanket professional sign-off is introduced in place of checking actual
license conditions and unresolved facts.

The owner-held `license-scope-completion-01/COMPLETION_PATH_EN.md` and
`completion-plan.json` record the technical completion path and conditional
future recipient-source/relink work. Their earlier pending review is
superseded only by the exact independent companion result cited above.
