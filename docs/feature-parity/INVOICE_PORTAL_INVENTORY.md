# Invoice collection: retained source and current supported contracts

Updated 2026-10-15. Status: IN_PROGRESS, no live-provider acceptance. The source inventory was obtained from the retained Community `src/invoicebot/portal-adapters/` modules; no productive V2 browser profile, credentials or financial dataset was inspected.

|Retained V2 adapter|Current Community behavior|Primary contract / remaining gate|
|---|---|---|
|amazon-business.ts|Fresh user-controlled browser; collect explicitly downloaded PDFs/images|[Amazon Business invoice instructions](https://business.amazon.de/de/solutions/payment-options/managing-vat); owner login and seller-issued invoice availability|
|openai.ts|Fresh user-controlled Platform billing browser; hosted Stripe invoice download captured locally|[OpenAI billing](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform); API organization owner permission|
|chatgpt.ts|Fresh user-controlled ChatGPT billing browser; user navigates Billing|Same official billing instructions; subscription billing platform and owner permission determine invoice availability|
|google-cloud.ts|Generic Cloud Billing landing page; user selects their own account|[Google Cloud invoice instructions](https://docs.cloud.google.com/billing/docs/how-to/get-invoice); IAM permission required. Hardcoded private account/project identifiers removed|
|google-one.ts|Google payments transaction download, without inferring tax treatment|[Google purchase VAT invoice instructions](https://support.google.com/googlepay/answer/7644144?hl=en); geography, billing platform and document availability apply|
|spotify.ts|User signs into payment history and explicitly downloads a receipt|[Spotify receipts](https://support.spotify.com/au/article/check-receipts/); provider retention/window and user access apply|
|fiverr.ts|User opens Billing History and downloads an invoice|[Fiverr invoice instructions](https://help.fiverr.com/hc/en-us/articles/37554374533649-Downloading-updating-and-troubleshooting-your-Fiverr-invoices); user login required|
|post-at.ts|Business invoices through supported ELLA portal, distinct from old consumer-order URL|[Post ELLA invoice FAQ](https://ella.post.at/b/faq); account activation/business authorization required; old consumer-shop parity is not accepted|
|aliexpress.ts|Not enabled in the supported catalog|An authoritative current invoice-download contract has not been established. Retained scraping code is not activated. This remains investigation/implementation work, not an asserted legal prohibition|
|bambulab.ts|Not enabled in the supported catalog|Exact store/region/order invoice availability requires authoritative provider evidence. Retained scraping code is not activated. This remains investigation/implementation work|
|browser-use.ts / auto-login.ts|Not activated|Generic agent/automatic SSO mechanisms are not a provider contract; they must not read ambient sessions or choose an account on the owner's behalf|

## Scope and security

The eight declared adapters share a controlled **assisted download** implementation. They do not crawl account data, enter credentials, choose an SSO account, bypass MFA/CAPTCHA, or infer invoice fields from HTML. The owner signs in and selects downloads in an entirely new account-scoped browser. Discovery lists completed PDF/image downloads. Import is explicit, hash-checked, duplicate-aware, source-observed, and creates an unconfirmed document for review. Closed/expired sessions require reconnection.

Application-owned profiles and download staging remain in protected identity storage, excluded from financial backups. The session's loopback proxy enforces allowed provider domains, public DNS pinned to the actual TCP destination, HTTPS port 443, and blocks unapproved HTTP/WS/CONNECT destinations. CDP guards paused pages and worker targets as additional protection. No existing browser profile/session is read.

Independent synthetic Chromium evidence: `candidate-acceptance/independent-security/proxy-only-rerun-20261015.json`. The test proves allowed dedicated/nested/shared workers execute, while forbidden HTTP, WebSocket and popup requests receive zero server hits **without** depending on the CDP interceptor. Local document source observations survive confirmation and canonical-index recovery. This evidence does not prove live-provider authentication, TLS compatibility, billing selectors or permission to bypass a provider restriction.

Each live provider remains BLOCKED_EXTERNAL for owner-controlled authentication and provider document availability. The two missing supported-provider contracts and consumer-Post parity remain IN_PROGRESS engineering investigation. All release gates remain open until the final integrated journey, rights review and exact-candidate verification pass.
