# Security boundaries

|Boundary|Required enforcement|Negative evidence|
|---|---|---|
|First-run/auth|Owner-bound bootstrap; hashed password; bounded expiring sessions; rate limits|Replay, second owner takeover, expiry, logout, brute-force throttle|
|API|Exact method/route/schema; authenticated owner; full origin and Host checks|Wrong token/user/resource, port/scheme mismatch, encoded route, malicious body|
|Files|Opaque record IDs; external controlled paths; size/type/decompression/page limits|Traversal, symlink/junction, bomb, malformed file, missing bytes|
|Secrets|Authenticated encryption; owner/provider/environment binding; no HTTP readback|Tamper/wrong key/owner, logs, exports, backups, deletion|
|Accounting|Exact signed minor units; distinct currencies; accepted evidence and allocation constraints|NaN/unsafe integer, double allocation, unsupported VAT, payout double revenue|
|Payment|Hash-bound transaction approval; SCA; idempotency; unknown state recovery|Approval replay, changed batch, timeout, no automatic ambiguous resubmission|
|Migration/restore|Source immutable; staged verified snapshot; atomic activation; rollback|Interruption, bad hashes, stale dry run, unknown schemas, disk full|
|Release|Sanitized source-only history; rights and dependency review; private visibility|Secret/PII fixtures, forbidden history, unknown license, unintended public visibility|
