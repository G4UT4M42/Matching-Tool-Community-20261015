# Privacy and source-inclusion inventory

**Policy:** release candidate must contain only reviewed original code, licensed redistributable assets, configuration examples, independently generated fictional test inputs, build scripts, and compliant third-party notices.

| Candidate class | Current disposition | Required release check |
|---|---|---|
| Git-tracked application source | 212 tracked candidates at baseline | inspect symbols, comments, constants, paths and bundled history |
| Temporary DB, WAL, SHM, JSON state | prohibited from Git | inspect .gitignore, tracked tree, Git objects and release archives |
| Invoices, photographs, statements and spreadsheets | prohibited | never copy from productive installation |
| Browser profiles, cookies, OAuth, API secrets | prohibited | scan source, generated artifacts, logs, metadata |
| Transaction and invoice fixtures | synthetic only | seeded fresh-generation provenance, uniqueness and privacy review |
| Generated browser bundles and source maps | not published until checked | inspect source maps and compiled literal content |
| Embedded schemas, artwork, binaries | owner/license review pending | file-level provenance and redistribution |
| Git history, author metadata and tags | new isolated Git history only | review commit objects before remote push |
| Documentation and errors | text review pending | avoid personal local paths, identities, domains, debugging dumps |
| Private owner denylist | must never be committed | separate local file through environment variable; only leak-free results logged |

**Auditing method:** enumerate tracked and staged files, LFS and submodules if present, inspect every object destined for distribution, run public generic scanners and external/private identifier denylist, classify false positives with evidence, visually review binary assets, review CI artifacts, repeat on the exact release tar/zip.

**Existing evidence:** automated scanner of 212 candidate files, no detections; **not an independent privacy signoff**. The previous scanner's embedded owner markers were themselves a review finding (F002).

**Release gate:** any unresolved source/metadata/secret/privacy issue remains NOT_READY. Do not put owner-specific denylist patterns in public source or issue reports.