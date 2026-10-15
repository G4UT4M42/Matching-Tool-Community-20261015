# Synthetic-only release verification for supported Windows Node.js 22.
# Does not touch production records or change repository branches.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodePath = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = (& $nodePath --version)
if ($nodeVersion -notmatch '^v22\.') {
  $nodeDir = Join-Path $env:LOCALAPPDATA 'nvm\v22.16.0'
  $nodePath = Join-Path $nodeDir 'node.exe'
  if (-not (Test-Path $nodePath)) { throw 'Node.js 22 must be installed.' }
  $env:Path = $nodeDir + ';' + $env:Path
  $nodeVersion = (& $nodePath --version)
}
if ($nodeVersion -notmatch '^v22\.') { throw 'Node.js 22 required.' }
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
Push-Location $root
try {
  Write-Host ('Community synthetic release checks, node ' + $nodeVersion)
  foreach ($check in @('test','typecheck','build','privacy:check','audit:production')) {
    Write-Host ('===== CHECK: ' + $check + ' =====')
    & $npm run $check
    if ($LASTEXITCODE -ne 0) {
      throw ('FAILED ' + $check + ' (exit ' + $LASTEXITCODE + ')')
    }
  }
  Write-Host 'ALL EXECUTED CHECKS PASSED; INDEPENDENT RELEASE REVIEW IS STILL REQUIRED.'
} finally {
  Pop-Location
}
