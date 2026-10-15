# Execution handoff

## Safe workspace
Target only the isolated Community checkout `<isolated-worktrees>/Matching-Tool-Community`. Preserve private/protected checkouts and their dirty working trees, never copy invoices or databases into Community. At initial inspection Community HEAD was `bd4700f` on `feature/community-app-port-20261013`, clean and with no configured remote. Another agent might change it; rerun status/process inventory before writing.

## Local test shell on <target-host>
The machine's default `node` was v24 (native ABI mismatch). For a single PowerShell process use:
```powershell
$env:PATH = (Join-Path $env:LOCALAPPDATA 'nvm\v22.16.0') + ';' + $env:PATH
$env:ComSpec = 'C:\Windows\System32\cmd.exe'
$env:SystemRoot = 'C:\Windows'
Set-Location '<isolated-worktrees>/Matching-Tool-Community'
node --version
npm test
npm run typecheck
npm run build
npm run privacy:check
```
Do not switch global Node installations or rebuild the existing native dependency for Node 24. Existing policy tests in `tests/migration-gate.test.mjs` create synthetic temporary Git repositories and may print harmless line-ending warnings.

## Verified start outcome
Node 22 baseline: 15 node:test policy tests and 5 Vitest API guard tests PASS; typecheck, build and privacy check PASS; privacy scanner checked 212 tracked candidate paths. Vite warns about a large JavaScript chunk; it is not a release security certification.

## Follow-up and blockers
Use `docs/release-program/01_WORK_PACKAGES.md` and `02_FINDINGS.md`; review `docs/RELEASE_STATUS.md`, `docs/MIGRATION_POLICY.md` and `docs/THIRD_PARTY_LICENSE_REVIEW.md`. Prioritize the tracked privacy scanner's embedded owner literals, complete security route policy, versioned migrations, and full financial QA. Avoid claiming that staged offline import is a live migration. No public push; independent privacy/security/licensing review and owner consent required.

## Commit procedure
Explicit `git add -- path1 path2 ...`; validate `git diff --cached --check`, `git status`, scan staging, run relevant suite and commit with precise message. Do not use `git add .` when untracked files or other agents may exist. Before any remote operation verify remote ownership and private visibility.