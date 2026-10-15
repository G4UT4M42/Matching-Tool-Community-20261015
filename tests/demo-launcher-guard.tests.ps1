# Synthetic-only negative tests of Windows PowerShell 5 demo startup.
# Tests create and remove ONLY their own newly created fictional profile.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$launcher = (Resolve-Path (Join-Path $PSScriptRoot '..\scripts\Start-Community-Demo.ps1')).Path

$ErrorActionPreference = 'Continue'
$invalid = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -DemoProfile '..\invalid' -Port 45494 2>&1 | Out-String
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -eq 0 -or $invalid -notmatch 'Demo profile must contain') {
  throw 'Launcher failed to reject path escape in synthetic profile'
}
Write-Host 'PASS: invalid profile rejected before filesystem access.'

$profile = 'Guard'+[Guid]::NewGuid().ToString('N').Substring(0,12)
$appRoot = Join-Path $env:LOCALAPPDATA 'MatchingToolCommunity'
$guardRuntime = Join-Path $appRoot ('DemoRuntime-'+$profile)
if (Test-Path -LiteralPath $guardRuntime) { throw 'Generated test profile collision; cannot proceed' }
try {
  New-Item -Path (Join-Path $guardRuntime 'database') -ItemType Directory -Force | Out-Null
  $foreignDb = Join-Path $guardRuntime 'database\matching.db'
  [IO.File]::WriteAllText($foreignDb,'SYNTHETIC_UNRECOGNIZED_DB_NEVER_USE')
  $before = [IO.File]::ReadAllText($foreignDb)
  $ErrorActionPreference = 'Continue'
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -DemoProfile $profile -Port 45495 2>&1 | Out-String
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -eq 0 -or $out -notmatch 'Existing database without an approved demo state') {
    throw 'Launcher did not refuse unrecognized pre-existing database'
  }
  if ([IO.File]::ReadAllText($foreignDb) -cne $before) {
    throw 'Launcher modified a pre-existing synthetic unknown database'
  }
  Write-Host 'PASS: unrecognized pre-existing database blocked and not modified.'
} finally {
  if(Test-Path -LiteralPath $guardRuntime) {
    Remove-Item -LiteralPath $guardRuntime -Recurse -Force -ErrorAction Stop
  }
}
Write-Host 'WINDOWS_DEMO_GUARDS_PASS: synthetic-only negative tests.'
