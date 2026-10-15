# FINAL-P03 — Normal application, migration, providers and installation

Status: IN_PROGRESS. No product or release acceptance is implied.

## Requirement and ownership

Complete the normal account-owned workflows across F01–F21, preserve immutable
financial sources, and execute one synthetic browser journey through the built
application. Root owns application composition, normal UI and integrated browser
qualification. Delegated provider, bank, migration, security and packaging work
has explicit file ownership and separate review. Existing recovery sources and
productive V2 remain untouched.

## Implemented behavior and repaired causes

- The production application factory is shared by the ordinary server and an
  explicit synthetic composition. Production accepts no HTTP/environment switch
  for test transports, portal origins or payment outcomes.
- Account/source filtering, an exact per-currency dashboard, settings and audit
  pages replace retained normal-user navigation. Mutation controls follow role
  capabilities; backend authorization remains independently enforced.
- Bank credential versions are immutable, scoped and encrypted. Configure and
  disconnect share one canonical SQLite/JSON/audit commit and recover real
  process interruptions. Orphan encrypted versions can remain after termination;
  disconnected material is inaccessible through the service.
- Provider financial identities derive from official PayPal merchant account
  evidence and Stripe's current Account.id. Local actor IDs do not identify the
  financial account. Different classification/currency/amount under one economic
  reference rejects; unchanged replay remains idempotent. Ambiguous legacy rows
  require explicit reconciliation, preserving their original IDs.
- Provider operations append scoped, secret-free started/completed history.
  A failed durable start prevents mutation. Mutation/recovery guards and historical checkpoint coverage passed focused regression and independent review; final full-suite confirmation remains required.
- Supported complete legacy structures retain allocations, classifications,
  taxes, exclusions, scans, reviews, templates, audit and historical payment
  evidence. Attachment filenames are deterministically rebased; bytes and hashes
  remain unchanged. Unknown populated tables/fields reject explicitly.
- Independent review reproduced an attachment path that copied an excluded
  browser-profile file outside confirmed fingerprint coverage. Resolution limits
  attachments to reviewed evidence roots; the original synthetic canary fails
  during inspection. Historical source bytes remain untouched.
- Backup size/entry preflight rejects aggregate oversized attachments before
  reading them into memory. Historical payment snapshots retain reviewed economic
  fields while removing reusable authority and exported transfer artifacts.
- The integrated browser exposed missing negative credit-note support. Reviewed
  uploads and CSV/XLSX now require an explicit credit_note type and consistent
  signed face/net/VAT amounts. Original source signs are retained. Negative
  sub-unit decimal serialization is exact.
- Windows development packages include qualified runtime, native dependencies,
  offline OCR languages, NOTICE, SBOM and full external license text evidence.
  Runtime dependency reachability excludes unused development roots. Distribution
  mode refuses unresolved source/license gates. Windows installation/upgrade/uninstall regression passed; final exact-candidate repetition remains required.

## Verification and evidence

Evidence references are relative to the owner's external acceptance directory;
generated financial fixtures, raw legal texts and machine paths are excluded
from Git source. Results are intermediate, not final exact-commit acceptance.

| Evidence | Observed result |
|---|---|
| baseline-recovered-vitest.json | 298/298 recovered app tests |
| baseline Node/browser log | 52/52 recovered tests |
| bank-portal-integrated-vitest.json | 315/315 intermediate app tests |
| application-ui-refactor/ | 4/4 actual built normal-app browser entrypoints |
| integrated-current-01-vitest.json | 365/365 intermediate app tests, zero skipped |
| bank-audit-agent/tests.json | 22/22 bank crash/encryption/scope tests |
| independent-security/provider-account-identity-history-02.stdout.txt | 44/44 provider tests |
| bank-audit-agent/legacy-history-tests.json | 30/30 supported migration/history tests |
| independent-security/legacy-attachment-boundary-repair-01.stdout.txt | 34/34 persistence tests including boundary regressions |
| credit-notes-01.json | 12/12 document tests including explicit credit notes |
| source-selection-api-03.json | Account-scoped local selection and rejection tests |
| production-audit-20261015.json | Zero npm production advisories returned |

The integrated runner is `tests/community-integrated-acceptance.e2e.mjs`.
Failed iterations are retained, including actual negative-credit import, missing
labels, provider asynchronous scope races, and precise browser error correlation.
Repairs retain all mandatory assertions. The source-mode run
`integrated-interface-source-07/integrated-acceptance/result.json` passes the
complete journey including actual exit86 at cutover, rollback/retry, six original
legacy-document downloads and twelve pages × two languages × two widths.
`integrated-installed-01` passed an earlier freshly installed complete journey;
it precedes the interruption and page-matrix extensions. It cannot certify those
later changes. No unexplained browser errors are accepted.

Additional completed evidence:

| Evidence | Observed result and scope |
|---|---|
| committed-app-01-vitest.json / app-manifest.json | 440/440 app tests, 63 entrypoints, no failures/skips at 2f7d0a8 |
| document-migration-commit-01.json | 54/54 review/migration tests |
| independent data-operation review | 34/34 including real child-process interruption |
| independent historical-document review | 36/36 across six suites, plus typechecks |
| packaging-source-binding-01/packaging-test-result.json | 4/4 package/supplement tests; 224 runtime packages, 7154 files in tested snapshot |
| candidate-policy-finalization-02.log | 15/15 migration/privacy policy tests |

The historical 5/5 installation/launcher result and newer 4/4 package result are
separate invocations, never added into a fabricated suite count. Source-map
exports/routes are indexed source evidence and do not assert runtime acceptance.

## Remaining acceptance and recovery

Rerun every suite against the final committed candidate, including the freshly installed interruption/page-matrix journey. Role/localization, provider replay, data-audit and historical-document focused/independent reviews have completed; their final integrated regression remains required.
Finish native corresponding-source/relink and asset provenance obligations, then
build/hash the exact candidate package. Private GitHub CLI authentication is
pending owner action; no repository push, CI run or release is yet verified.

Recovery uses the preserved source checkpoint, immutable source history and
canonical journal/restore rollback. Never reset another worktree or rewrite
historical migration checksums. The preliminary local import is quarantined;
only the new reviewed parentless source history may be pushed, without tags or
other branches. Generated bank evidence retained inside the local checkout after
a denied move is explicitly excluded, preserved and not delivered as source.

Milestones: PRIVATE_REPOSITORY_READY=false; SOFTWARE_ACCEPTED=false;
RELEASE_ACCEPTED=false. No real provider or real-money acceptance is claimed.

## Current fa6c49a checkpoint

`full-fa6c49a-01-vitest.json` records441/441 app tests, zero failed/skipped,
63 actual entrypoints. Its manifest reports the committed revision and dirty
state caused by active external-compliance helper/doc development. Full Node
regression is running with the actual reviewed native replacement and both
complete source/notice supplements. This is a current qualification checkpoint;
it is not a clean final-release declaration.

The earlier diagnostic `final-bbf73b8-01` Node run had64 tests:60 passed,
3 failed and1 timeout-cancelled, zero skipped. Causes were exact204 browser
observation classification, an obsolete provider-history fixture, installation
budget and a364.97s complete package test against a360s deadline. Actual package
functional assertions completed, but the timeout remains a failed run. Repairs
retain all financial/security assertions. Provider malformed-response handling
now has20 EN/DE cases plus the delayed prior-scope regression; focused real
browser and both typechecks pass. No failed run is relabeled PASS.

`installed-native-01` subsequently passed the complete fresh-install journey,
including48 interface combinations, real cutover exit86/rollback/retry, OCR,
exact finances,6 legacy original downloads and roles. Its7437-file manifest
SHA256 is `956918dd9f1c129cce79c0f9bc924ff7187864e1255b80692d3354b0e8350038`.
It precedes the final review allowlist/wrapper check and is not final acceptance.

`candidate-native-replacement-observations-03.log` passes8 focused tests.
Actual independent bundle validation confirms the exact reviewed manifest,
rebuilt binary and282 source/build/notice files. Admission now rejects any
other manifest before parsing or reading payloads; final package/install rerun
is mandatory. `capacity-02` passed fixed2000 transactions/200 documents/200
allocations, exact currency totals, bounded p95/peak memory and cleanup.

Independent privacy review covers `2318718`,18 parent-closed sanitized commits,
526 files and676 unique blobs. No concrete privacy finding remains in that
scope; later commits and final artifacts require their own verification.

Artifact privacy finding: the actual first rebuilt native binary contains one private-denylist match and a local build prefix. The bounded UTF8/UTF16 scan records suppressed values in native-replacement-binary-privacy-01.json. This is an unresolved artifact gate, separate from passed source-only privacy review and runtime tests. Native replacement02 is being genuinely rebuilt with compiler path remapping; no binary string patching or overwrite of old evidence is permitted. Final acceptance must use the new independently checked artifact.

## Completed fa6c49a diagnostic and remapped artifact

`candidate-full-fa6c49a-01-node.log` completed71 tests:70 passed,1 failed,
zero skipped/cancelled,973794.873ms. The failure was a120-second maintenance
subcommand timeout (null status), not a financial/browser assertion. Its
separate complete test elapsed370484.3587ms before failure. The new maintenance
helper records executable/action, actual elapsed/deadline, exit/signal/error
in new external JSON; command budget300s, complete test900s. Retesting remains
required; this diagnostic is not relabeled PASS.

The actual installed integrated browser journey in that same run passed.
Its7861-file installed package manifest SHA256 is
`7e294b5b8d5c0393fdc129ebd56c4c87ef77a3ba5fded901a5221639bab265d4`,
source `fa6c49a`,dirty=true (active compliance/doc work). Installation took
103652ms with a300000ms deadline and exit0. It includes48 interface
combinations, exact finances, six legacy original downloads and actual
cutover exit86/rollback/retry. Its canvas01 binary subsequently failed the
separate artifact privacy gate, so this is intermediate functional evidence.

A fresh compiler-remapped canvas02 passes real image/font/PDF/OCR qualification
and independent hash/privacy review: manifest907cdd47091358e832c3765610ee61da12145635917655f5b7b23022395a3b58,
binary0ea4e2558a21542e4364537cfbf06f3cc950f009cd9e740d159ca9edae250209,
286 payloads404970748bytes,285 evidence files. Independent report:
`independent-security/native-artifact-privacy-02.report.txt`. The original01
finding is preserved. No legal, historical reproduction or release claim is
promoted. Focused replacement/supplement admission regression5/5 and actual02
bundle admission pass. Source review additionally hardened packaged descriptor
preflight to a single bounded hash/parse buffer before general payload reads,
with two distinct reviewed-target bounds and global evidence collisions.

The separate `candidate-packaging-budget-02.log` retest completed3/3, no
failed/skipped/cancelled,336374.3535ms. The complete real maintenance test took
334611.0697ms. Actual install84323ms,upgrade93844ms,uninstall6386ms,each exit0;
immutable command JSON and exact tested manifest are under
`packaging-budget-02/`. All owner setup, native/OCR assets, restart/login,
retained state/database checks and cleanup assertions passed. This focused
working-snapshot retest resolves the maintenance defect; final combined-source
installed acceptance is still required.
