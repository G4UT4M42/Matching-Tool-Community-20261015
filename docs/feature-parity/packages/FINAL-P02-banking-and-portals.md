# FINAL-P02 — Account banking and controlled invoice collection

Status: IMPLEMENTED. This source-only candidate has no V2 Git ancestry. No release or live-provider acceptance is implied. Banking integration is covered by its existing acceptance evidence; this closeout additionally completes the retained portal engineering workflows described below.

## Requirement and recovered baseline

Expose account-scoped read-only banking and explicit user-owned invoice/receipt collection through normal authenticated navigation, with encrypted configuration, durable financial import and preserved document provenance. The recovered baseline had unmounted banking, incomplete AIS contract validation and an empty bot catalog. Those are historical defects, not current feature declarations. Historical migration checksums and original worktrees remain unchanged.

## Current controlled collection

Eleven distinct assisted portal entries now include consumer Post purchases separately from business ELLA, Bambu Lab EU orders and AliExpress. Each opens a new dedicated identity-scoped browser. The owner signs in, performs any provider MFA/account selection and chooses available downloads. There is no crawler, automatic login or fabricated invoice.

AliExpress's retained screenshot workflow is available as a separate explicit receipt-evidence capability, with no assertion of a tax-invoice download contract. The owner selects an eligible order tab and confirms the visible receipt contains no credential material. Protected auth hosts/paths/frames, opaque frames, unsafe query keys, expired/reused/cross-scope selection, navigation and revoked permissions fail closed. The bounded viewport/crop image is staged only after a final synchronous authorization/session guard, then imported only by a further explicit user selection.

The audited document source reference preserves provider hostname, local UTC acquisition token and SHA256, with a receipt-labelled filename. The image remains unconfirmed for review; no accounting document or tax treatment is inferred automatically. Duplicate collection/import reuses content, and imported provenance/hash survives normal application restart. Browser profiles and temporary selections remain protected identity material excluded from financial backups.

## Provider evidence and limitations

[INVOICE_PORTAL_INVENTORY.md](../INVOICE_PORTAL_INVENTORY.md) records each supported controlled workflow and primary provider references. Post's primary instructions point to consumer Meine Bestellungen, not ELLA. Bambu's official store/order guide supports owner navigation; current invoice availability remains provider/account dependent. AliExpress receipt capture does not depend on an unverified invoice API. Research-tool 402/404 results are recorded precisely, without claiming they establish a provider prohibition or bypassing them. Real owner login and document availability remain external qualification.

## Verification

External evidence root: candidate-acceptance/portal-evidence-01.

- focused-final.json:12/12 passed, zero failed/skipped/pending, across new receipt evidence plus existing assisted-download, coordinator, owner-isolation and lifecycle suites.
- normal-ui-final.stdout.txt:2/2 actual normal-server/built-UI browser journeys passed. The receipt journey uses isolated real Chromium, synthetic source pixels, actual account/session/CSRF rules, document service and canonical SQL/JSON audit. It proves explicit tab and receipt-only confirmation, unconfirmed import, exact source/hash, duplicate handling, restart, English/German guidance, viewer controls and backend permission denial. The ordinary catalog journey proves all eleven entries and unsupported-adapter rejection.
- Race negatives cover revocation after actual screenshot completion and navigation starting before a new URL commits; both publish no staged image. Auth/opaque iframe, credential URL, cross-scope, expired/reused/replaced selection and crop limits remain enforced.
- Production idle/network guard was preserved while a malformed synthetic favicon fixture was repaired. Genuine failed attempts and bounded diagnostics remain in external evidence.

Backend/frontend checks and the combined production build are recorded alongside root's final exact-candidate qualification. Independent security review passed this delta (receipt-capture-independent-final-01.report.txt); final integrated package/privacy verification remains a separate release gate. No productive dataset, account, provider credentials or runtime binary was changed.

## Ownership and recovery

Changes are confined to candidate invoice-bot implementation/router/page/translations, new focused synthetic tests and this feature record. Root owns composition/permission integration, shared browser observation helpers and release packaging. Original Community/V2 worktrees remain untouched. Runtime recovery continues to use the existing canonical journal/staged restore, never a schema reset or replacement of an open database.
