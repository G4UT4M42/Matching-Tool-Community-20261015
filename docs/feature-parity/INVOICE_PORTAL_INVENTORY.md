# Invoice collection: controlled workflows and provider evidence

Updated 2026-10-15. Local engineering status: IMPLEMENTED. All retained provider workflows have an explicit owner-controlled collection path; no live-provider login or invoice availability is certified. Original Community/V2 worktrees and productive accounts were not inspected or changed.

|Retained adapter|Current controlled workflow|Primary provider evidence and external qualification|
|---|---|---|
|amazon-business.ts|Fresh browser; owner selects available PDF/image downloads|[Amazon Business](https://business.amazon.de/de/solutions/payment-options/managing-vat); login, seller and document availability remain external|
|openai.ts|Fresh Platform billing session; owner downloads hosted invoices|[OpenAI billing](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform); organization owner permission required|
|chatgpt.ts|Fresh ChatGPT session; owner navigates subscription billing and downloads available files|Same official billing guidance; billing platform/account permissions vary|
|google-cloud.ts|Generic Cloud Billing page; owner chooses their own account and document|[Google Cloud](https://docs.cloud.google.com/billing/docs/how-to/get-invoice); no private project/account IDs or automatic account selection|
|google-one.ts|Owner-controlled Google payments downloads|[Google purchase records](https://support.google.com/googlepay/answer/7644144?hl=en); no inferred tax treatment|
|spotify.ts|Owner selects their available receipt in payment history|[Spotify receipts](https://support.spotify.com/au/article/check-receipts/)|
|fiverr.ts|Owner selects their available billing document|[Fiverr invoice instructions](https://help.fiverr.com/hc/en-us/articles/37554374533649-Downloading-updating-and-troubleshooting-your-Fiverr-invoices)|
|post-at.ts|Separate consumer purchases session at services.post.at/store/meine-bestellungen; completed PDF/image download, explicit import|[Post Paketmarke instructions](https://www.post.at/g/a/paketmarke-geschaeftlich) link purchases and associated invoices since 31 May 2022 to Meine Bestellungen. Unauthenticated research-tool retrieval of that link returned404; current account routing/document availability needs the owner's own session, without bypass|
|Business Post addition|ELLA remains a separate supported session and does not stand in for consumer purchases|[ELLA FAQ](https://ella.post.at/b/faq); business account activation/authority required|
|bambulab.ts|Fresh EU store/account browser; owner opens their order and selects Download Invoice if available; selected download/import complete|[Official Bambu order guide](https://wiki.bambulab.com/en/how-to-get-order-id) supports the store/order navigation. Direct research-tool retrieval of wiki/store help returned402, so no current invoice-button selector, availability or live acceptance is asserted. If unavailable, the owner uses provider support; no replacement invoice is manufactured|
|aliexpress.ts|Fresh order browser; owner downloads a provider file if offered, or explicitly selects a visible order tab for receipt-image capture; explicit import for review|No authoritative current tax-invoice download contract was established from primary sources. The retained order-screenshot behavior is implemented as local unconfirmed receipt evidence, independent of a supplier invoice claim. [Official help center](https://helpcenter.aliexpress.com/) remains the owner support entry|
|browser-use.ts / auto-login.ts|Not activated; generic ambient login/SSO automation is replaced by manual owner control in a new browser|No profile, credential, account-choice, CAPTCHA or MFA automation|

## Receipt evidence boundary

The catalog has eleven distinct entries, including AliExpress, Bambu Lab EU, consumer Post purchases and ELLA. Downloads are actual files explicitly chosen by the owner; no account/order crawler or HTML invoice extraction runs.

AliExpress receipt capture is a separate capability, accurately labelled unconfirmed receipt evidence rather than a tax invoice. The owner selects an opaque, short-lived tab reference from the new dedicated identity-scoped browser and expressly confirms that the visible receipt contains no credentials or unrelated private material. Only allowlisted order paths at the configured origin are eligible. Auth hosts, embedded login markers, credential-bearing URL keys, encoded paths and opaque/non-HTTPS frame URLs fail closed. Trusted local HTTP exists only in explicitly injected synthetic composition. The manager reads URL/frame/network metadata, never form values, cookies, page text or DOM fields.

Capture is a single visible viewport or explicit bounded crop, without scrolling/full-page capture. Bounds are4096 pixels per edge,4 million pixels and the normal document byte limit, with at most100 combined staged download/capture files. Identical captured content reuses its staged file. Current actor permission, owned session, tab URL and every-frame navigation generation are checked before the screenshot command and after its async completion; final guarded staging is synchronous. A pending navigation, expired/used token, closed/replaced session, revoked permission or protected frame rejects capture.

Only an additional explicit import enters the document service. Receipt-labelled filename, provider hostname, local UTC acquisition token and content SHA256 are preserved in the audited source reference; no raw URL/query/title or browser authorization enters it. PNG dimensions remain verifiable from preserved bytes. The result stays in review and creates no confirmed accounting document automatically. Existing audited document provenance survives duplicate import and restart. Transient browser selections/run controls are not a durable provider account history.

Protected browser profiles/staging stay in managed identity/invoice-browsers storage and outside financial backups. The existing dedicated-session proxy/CDP public-network restrictions remain in force. No provider restriction was bypassed.

## Measured synthetic qualification

External evidence: candidate-acceptance/portal-evidence-01.

- focused-final.json:12/12 passed across the five portal/coordinator/lifecycle test files; no failed/skipped/pending tests.
- normal-ui-final.stdout.txt and ui-final/receipt-evidence-normal-ui/result.json: actual normal server, built UI and dedicated Chromium capture; explicit tab/affirmation, receipt label, import, source/hash/audit, duplicate/restart, English/German guidance and viewer UI/backend denial passed. All four intended HTTP failures were registered before the action and asserted exactly; no unexplained browser/network errors.
- ui-final/invoice-bot-normal-app/result.json: actual normal catalog contains all eleven entries; unsupported automation is refused.
- Actual CDP completion/revocation and navigation-start-before-URL-commit races stage zero images. Login, mini_login iframe, auth hostname, encoded/opaque frame, cross-owner/workspace, stale/replaced/expired selection and invalid crop negatives remain enforced.
- Earlier failed tests/diagnostics are retained. A synthetic server answering favicon requests with HTML caused two pending requests; explicit favicon responses fixed the fixture without relaxing the production idle/eligibility guard. Expiry uses a trusted short fixture TTL and real elapsed time, not a global browser clock mock.

Live authentication, regional provider availability and supplier document contents remain BLOCKED_EXTERNAL for owner-controlled qualification. These are separate from the now-completed local controlled collection implementation. Legal/source/release acceptance remains false.

Independent security review passed this source delta in `independent-security/receipt-capture-independent-final-01.report.txt`:5/5 actual-Chromium tests,1/1 built-source UI journey and7/7 observation/scope guards. Final clean installed-candidate acceptance remains separate. The specialized receipt fixture is explicitly source-only and rejects installed-package inputs before any path reads.
