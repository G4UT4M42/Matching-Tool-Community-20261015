# Upgrade application binaries while retaining external accounting data unchanged.
param(
  [Parameter(Mandatory=$true)][string]$PackageDirectory,
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [Parameter(Mandatory=$true)][string]$DataDirectory,
  [switch]$ConfirmStopped
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $ConfirmStopped) { throw 'Stop Community and pass -ConfirmStopped before upgrading binaries.' }
$install = [IO.Path]::GetFullPath($InstallDirectory)
$data = [IO.Path]::GetFullPath($DataDirectory)
if (-not (Test-Path -LiteralPath (Join-Path $install 'scripts\Start-Community.ps1'))) { throw 'Existing Community installation is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $data 'database\matching.db'))) { throw 'Existing data directory is missing the database.' }
$stage = $install + '.upgrade-' + [guid]::NewGuid().ToString('N')
$previous = $install + '.previous-' + (Get-Date -Format 'yyyyMMddHHmmss')
& (Join-Path $PSScriptRoot 'Install-Community.ps1') -PackageDirectory $PackageDirectory -InstallDirectory $stage -DataDirectory $data
$movedOld = $false
try {
  [IO.Directory]::Move($install,$previous); $movedOld = $true
  [IO.Directory]::Move($stage,$install)
  Write-Host "Application upgraded. Previous binaries retained at $previous. Data directory was not moved."
} catch {
  if ($movedOld -and -not (Test-Path -LiteralPath $install)) { [IO.Directory]::Move($previous,$install) }
  throw
}
