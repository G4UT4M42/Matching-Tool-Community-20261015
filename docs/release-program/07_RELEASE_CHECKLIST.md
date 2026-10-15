# Release checklist - release remains NOT_READY

## Technical gates (require evidence, not assumptions)
- [ ] Complete reviewed source-file and Git-object inclusion manifest, with independent privacy approval.
- [ ] Source/license ownership, exact MIT decision and all third-party NOTICE obligations approved.
- [ ] Production and preview financial entry points audited; banking demo interlocks tested.
- [ ] Parser, archive, path, session and unauthorized API attack scenarios pass.
- [ ] Deterministic financial import/matching/reports and tax-evidence tests pass.
- [ ] Versioned SQLite + JSON + documents migrations and safe WAL backup/restore pass.
- [ ] Full legacy import UI, non-destructive conversion and verified rollback pass.
- [ ] Skipped-version upgrade matrix and corrupted/interrupted migration tests pass.
- [ ] All pages translated English and German with fallback/accessibility tests.
- [ ] Broad synthetic fixture corpus and offline demo reset pass.
- [ ] Fresh Windows user installation and restart succeed without original system.
- [ ] Complete QA on clean supported Node and browser toolchains.
- [ ] CI passes typecheck, build, tests, privacy, migration and artifact/license gates.
- [ ] Independent release-candidate security/privacy/financial assessment signed off.
- [ ] Final packaged artifact hashes and release notes match audited commit.

## GitHub / publication
- [ ] Create empty PRIVATE remote and verify repository/account ownership.
- [ ] Verify remote URL, tracked bytes, Git objects, history, branch and CI permissions.
- [ ] Push only reviewed sanitized history, never protected legacy commits.
- [ ] Configure least-privilege Actions and required checks.
- [ ] Create RC tag only after qualification.
- [ ] Submit one consolidated owner approval request with unresolved risk register.
- [ ] **Only after explicit owner permission**, make repository public / publish release.

No background work or external repo state should be claimed without a verified tool result.