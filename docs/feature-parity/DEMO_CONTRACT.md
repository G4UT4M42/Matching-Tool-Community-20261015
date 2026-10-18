# Protected synthetic demonstration

The fresh `Start-Community-Demo.ps1` runtime uses `synthetic-preview`, an isolated
runtime root and a launcher-generated local access token. It cannot open an
identity-bearing or account-owned installation. Provider networking and payment
submission remain disabled. Owner workspaces retain their existing routes,
permissions, same-origin/CSRF checks and recent-authentication requirements.

## Actual records and authority

The fresh canonical fixture contains 17 transactions, 13 documents, six
source/account combinations and a real persisted two-item simulator draft.
The original four transactions, two documents and accepted/proposed matching
groups are preserved. Additional fictional evidence covers PayPal and Stripe
sales, processing fees and refunds, a USD sale, a rational FX settlement, a
partial supplier balance, private expenditure, explicit tax classifications and
a balanced provider-to-bank payout transfer. The canonical accounting report
calculates totals from those records; the UI does not invent a second ledger.

The draft is created through the existing payment service from the actual
remaining invoice balances (EUR 60.00 and EUR 36.00). Its checksum-valid IBAN
has a nonroutable all-zero account body. Boot initialization never validates,
reviews, approves, confirms or submits it, and never provisions a bank
connection or credential. Restart reuses the same draft. Existing persisted
demonstrations are not silently replaced or enriched; existing user edits remain
intact. The portable `examples/synthetic/demo-bundle-v1.json` is a separate small
migration/import contract fixture, not the boot-state generator.

`GET /api/community/demo` requires the existing preview guard and returns a
bounded, explicit financial projection. It excludes raw metadata and authority,
including credentials, sessions, confirmations, claim IDs and provider payment
references. The demo UI checks its schema, exact integer totals and inactive
capabilities before rendering it. A malformed response produces an error, not
an empty successful report.

## Interface

English is the default; German is selectable and persists in the local browser.
The existing matching review, manual matching, exclusions and audit interfaces
remain interactive within their already reviewed routes. Imports, annotations,
provider collection and unreviewed matching automation are unavailable in this
mode. Their controls are hidden or disabled with an explanation rather than
invoking a forbidden endpoint.

Document, provider, account, report, VAT and payment pages render the actual
read-only projection. Settings exposes local language preferences. These views
do not claim to run OCR, download original files, connect a provider, file taxes
or authorize a payment. The separate owner application supplies those qualified
workflows according to its existing permissions.

## Verification and evidence

`community-demo-complete.test.ts` verifies independent exact financial totals,
original-record preservation, draft economics, restart persistence, projection
authority omission and real protected endpoint denials. The existing loopback
smoke test retains assertions for the original records and independently checks
the expanded fixture counts and signed currency totals.

`community-demo-browser.test.mjs` boots the real application on a fresh synthetic
runtime and browser profile. It checks 18 routes in English/German at 1400/390
pixels, actual provider/document/draft/tax data, failed HTTP/page requests and
external egress, exact SQL/JSON preservation, real authority denials and restart.
The external result and screenshots belong to the source revision recorded by
the complete test invocation. A test's presence is not a passing result.

The prior frozen f330 candidate passed its 621 application tests, but its Node
invocation exceeded the old aggregate 30-minute deadline. That invocation is a
failed historical run. The current sequential Node budget is 45 minutes for
separate installed AIS, PIS, payout and upgrade journeys; individual case
deadlines and assertions are retained. Final local/installed/hosted acceptance
must be established separately for the next clean committed candidate.
