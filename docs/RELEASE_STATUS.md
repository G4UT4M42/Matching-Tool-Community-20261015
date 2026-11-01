# Release gate — Matching Tool Community

> Scope update, 2026-11-01: the maintainer has requested public publication of
> the sanitized source repository. See the [current source review](compliance/PUBLIC_SOURCE_REVIEW.md).
> Historical private-use and binary-package results below retain their original
> scope; public source does not certify a stable product or release an installer.

Updated 2026-10-18. Version: `0.2.0-community-candidate.1`.

PRIVATE_REPOSITORY_READY=false; SOFTWARE_ACCEPTED=false; RELEASE_ACCEPTED=false.
Current development is for owner-selected private internal use; automated qualification uses synthetic data. The active branch is `community/sandbox-payments-20261016`, extending d521 with new sandbox-only PIS. The separate PRIVATE Community repository and sealed-fbf hosted CI are verified, while current-head readiness remains pending. See the current [feature matrix](feature-parity/02_FEATURE_MATRIX.md), [checkpoint](feature-parity/STATUS.md) and [acceptance record](feature-parity/packages/FINAL-P03-integrated-acceptance.md).

## Verified implementation and intermediate evidence

The sanitized history is rooted at `0f3ba3487349324885987d46c2a6b48f478b9a59`; the earlier `community-sanitized` and sealed-fbf snapshots are historical evidence. AIS consent and corrected PayPal event/status semantics are committed at 9ae. Read-only standard-automatic Stripe payout membership, signed-fee residuals, immutable audit and normal owner retry/offline inspection are committed in d521. New sandbox-only PIS is implemented with exact approved bank/PSU/request binding, one durable CREATE claim, callback/status verification and GET-only unknown recovery. Focused backend 62/62, independent bounded reviews and a separate source normal journey 1/1 passed; no current frozen/full/installed/CI result is inferred. Account-owned normal application workflows, official read-only PayPal/Stripe contracts, read-only AIS configuration, eleven isolated assisted portal choices, including explicitly unconfirmed AliExpress receipt evidence, real offline OCR, exact matching/accounting, SEPA preparation, simulated payment safeguards, immutable audit, complete supported synthetic legacy migration and recovery, and independent Windows packaging are implemented. Tests use synthetic stores and never execute real transfers.

Historical application regression at `2f7d0a8`: 440/440, zero failures/skips. Source integrated acceptance passes the full financial journey, actual migration cutover interruption/rollback/retry and 48 normal-page language/width combinations. An earlier freshly installed integrated journey and installation/upgrade/uninstall regression passed. These runs cover their recorded snapshots. Sealed-fbf complete local/hosted acceptance is likewise historical. At this update, 9ae app regression passed571/571; its complete Node run had88/89 passing and one payment-harness timeout, so it remains FAILED. The test-owned Vite/HTTP shutdown ordering was repaired and the same focused journey passed1/1 without removing assertions. Later d521 full local app 587/587 and Node 90/90 passed for that historical snapshot. d521 did not yet include the supported PIS flow. The newest sandbox source requires its own committed complete suites, installed acceptance and exact-head CI.

## Remaining mandatory gates

- Exact-candidate complete Node/browser/installation suite, typechecks/build and production dependency audit.
- Final current index and reachable sanitized-history privacy verification and independent review limitations recorded without bypassing denied operations.
- Three frozen full-source native/WASM replacements and four source/SBOM supplements have independent engineering qualification. Final installed-package verification remains separate. Runtime-notice companion02 has an independent bounded review and is a new-package input. First-party/MIT authority remains unverified after the bounded snippet screen. Missing fresh SheetJS archive authenticity evidence is an uncertainty, not an established internal-execution license condition. Third-party redistribution is outside scope; automated inventory is not legal clearance. See [private internal scope](compliance/PRIVATE_INTERNAL_USE.md).
- Reuse the verified separate PRIVATE Community repository for the explicitly authorized sanitized push and current exact-head Actions after local checks. Existing sealed-fbf CI does not qualify new source. Retain the recorded protection limitation; never use the private V2 repository or quarantined ancestry.
- Final source/package artifact checksums, evidence manifest and German owner report.
- Actual provider registration, bank consent and sandbox/live acceptance remain specific external limits. Supported local sandbox PIS is now implemented; production PIS is hard-disabled and live PISP authority/provider enablement remain external facts. They do not excuse missing supported local code. Pristine Windows VM qualification is OWNER_DEFERRED, not passed or currently requested. Supported synthetic workflows do not certify live provider operation.

At the October 18 checkpoint, no public publication was authorized. Productive V2, private financial records and existing browser sessions remain untouched. No mandatory gate is promoted by a focused test or successful build.


## Final source freeze protocol

Known operational history is now preserved as inert audit with verified invoice
and linked-screenshot originals (89/89 focused; independent38/38). Source built-UI
journey passes with actual interruption/recovery. Both stale fixture failures
and their separate passing repairs remain historical evidence. The older34-package
implementation count is not a current acceptance total; final source/index/history, complete suites, actual installed bundle
and output privacy verification are engineering gates recorded outside Git after
the source is frozen. This avoids claiming a future exact-commit result inside
its own source. Consult the hash-bound owner report and exact run manifests;
no deployment, legal, hosted-CI or pristine-OS acceptance is implied.
