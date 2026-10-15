# Windows installation — Community Developer Preview

**Scope: synthetic demo only.** This release cannot be used for real accounting, tax filing, bank connectivity, or payments. Full legacy V2 import and activation are not available.

## Requirements

- Windows 10/11 and Windows PowerShell 5.1+.
- Node.js 22.x and npm. Node.js 24 is unsupported for this build because native SQLite modules use a different ABI.
- A sanitized Community source checkout independent from private accounting installations.
- Free loopback TCP port 3433 and per-user application-data write access.

## Fresh installation

Run from the Community source directory:

~~~powershell
node --version
npm ci
npm ci --prefix web
npm run build
npm run demo:windows
~~~

The launcher recognizes Node.js 22 from PATH and falls back to the developer-specific local nvm v22.16.0 path where installed. It refuses unsupported versions. Open http://127.0.0.1:3433/ and enter the randomly generated local access token printed in the terminal. The listener accepts loopback requests only. Never post that token in screenshots or issues.

## Isolated synthetic profiles

The default runtime lives in %LOCALAPPDATA%\MatchingToolCommunity\DemoRuntime. Create another independent fictional-data profile:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Start-Community-Demo.ps1 -Port 3434 -DemoProfile SeparateTest
~~~

Only 1–32 letters, digits, underscores or hyphens are allowed in a profile name. Non-default profiles are stored under %LOCALAPPDATA%\MatchingToolCommunity\DemoRuntime-<profile>. The launcher refuses reparse-point roots and an unrecognized database with no approved synthetic state. No arbitrary runtime directory can be passed to this script.

Never copy real matching.db, state.json, invoices, banking data, or original directories into a demo profile. Unsupported existing schemas require the offline migration process; they must not be overwritten.

## Verification

~~~powershell
npm test
npm run typecheck
npm run build
npm run privacy:check
npm run audit:production
powershell -NoProfile -ExecutionPolicy Bypass -File tests/demo-launcher-guard.tests.ps1
~~~

The npm tests include real local HTTP access controls, disabled payments, demo records, restart and persistence checks in newly generated test runtimes. Windows guard tests use only generated fictional QA data. Hosted cross-platform CI and independent security, financial, licensing and privacy reviews are still required.

## Updates and recovery

Importing or upgrading real installations is not supported yet. The offline staging tool is only for synthetic development datasets; it never activates a candidate. Future persisted-format changes require versioned executable migrations, synthetic old/new fixtures, failure recovery and documented rollback. See MIGRATION_POLICY.md and LEGACY_IMPORT_SPEC.md.

If the port is busy, choose a different port; do not terminate unrelated processes. If the state or SQLite schema is rejected, preserve it and follow a reviewed offline migration procedure. Stop a demo normally with Ctrl+C and verify its server exited after abnormal termination. Uninstallation must never silently delete user data.
