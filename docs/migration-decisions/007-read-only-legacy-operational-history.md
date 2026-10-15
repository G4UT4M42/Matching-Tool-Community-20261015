# Read-only preservation of known legacy operational history

Migration-Required: no
Rationale: The locally known historical portal/run/file/event/extracted-invoice and cost schemas are mapped into explicitly versioned immutable audit evidence, using registered SQLite4/JSON2 extensible event metadata. No historical migration checksum, financial source identity or physical schema is changed. Empty active operational tables gain no login, scheduling or payment authority.
Rollback: Keep the unchanged original source and complete verified backup. Stop the candidate before restoring the matching qualified binary/data generation. Old readers do not implement the versioned archive attachment references and are not a qualified downgrade. Do not remove audit rows, rewrite source files or historical migration checksums to accommodate them.

The earlier converter rejected every populated known Invoice Bot operational
table. Those schemas are available locally; the rejection was an engineering
gap rather than an external authorization requirement.

The converter now validates a bounded, explicit field/relationship contract.
Each retained original row receives a deterministic system audit event with
its table, original ID, original timestamp, raw row digest and typed historical
fields. Existing canonical source records and original audit events remain
unchanged. Event metadata has `legacy_operational_history_version:1`.

Portal/profile/session/download configuration, raw URLs, worker messages,
payloads and free-form cost contexts cannot become reusable authority or
unchecked backup content. Omitted populated fields have explicit reasons and
digests. Unknown populated columns and inconsistent references reject.
Cost values retain their original finite REAL values and IEEE754 representation;
they are historical telemetry, not converted ledger amounts. Extracted invoice
amounts retain integer minor units, source IDs and original review status.
Nothing becomes a newly confirmed or payable invoice.

An explicitly linked financial screenshot with a supported image media type
and source hash retains its separate original bytes as well as its artifact
relationship. Unlinked screenshots and arbitrary HTML/log bundles remain inert
metadata with omitted paths. Required download/screenshot references cannot be
removed from a valid archive projection. Generated audit IDs, system actor and
outer timestamps are bound to their preserved source projection; a bounded
historical run ID need not equal a later current run ID.

Original download requirements are ephemeral. The converter uses the existing
reviewed evidence-root guard, verifies bytes/hash/optional size and document
relationship, then copies each distinct original under a content-addressed
`documents/legacy-evidence/` path. No excluded browser/session tree is opened.
At most1000 distinct originals and256MiB aggregate are accepted. Immutable
audit references contain only the new relative path, hash, byte count and
optional media type. Backup creation and inspection validate those versioned
references and require the same exact original bytes. Unrelated HTML/log
artifacts are not silently promoted to financial evidence.

The existing authorized Audit page exposes the inert projection through
read-only event details. Original portal/run/artifact/document relationships
remain visible without enabling legacy crawlers or restoring browser profiles.
The independently generated integrated fixture includes all eight tables and
a linked invoice original and a distinct linked screenshot. It exercises migration interruption/recovery, exact canonical
preservation, normal history display and restart alongside the full journey.
Actual qualification counts and failures belong to their external run manifests;
source presence alone does not establish acceptance.

The V2 converter accepts original historical layouts. An already converted
Community archive uses its complete backup/restore path; it is explicitly
rejected before generic legacy credential scrubbing can reinterpret versioned
archive fields such as a cost telemetry session relationship. Reusable browser
sessions remain excluded independently of those inert telemetry identifiers.
