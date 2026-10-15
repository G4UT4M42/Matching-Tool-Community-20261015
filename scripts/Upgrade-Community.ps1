# Upgrade application binaries while retaining external accounting data unchanged.
param(
  [Parameter(Mandatory=$true)][string]$PackageDirectory,
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [Parameter(Mandatory=$true)][string]$DataDirectory,
  [switch]$ConfirmStopped
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Move-UpgradeDirectory([string]$From,[string]$To) {
  for ($attempt = 0; $attempt -lt 12; $attempt++) {
    try { [IO.Directory]::Move($From,$To); return }
    catch [IO.IOException] { if ($attempt -eq 11 -or (Test-Path -LiteralPath $To)) { throw }; Start-Sleep -Milliseconds 250 }
    catch [UnauthorizedAccessException] { if ($attempt -eq 11 -or (Test-Path -LiteralPath $To)) { throw }; Start-Sleep -Milliseconds 250 }
  }
}
if (-not $ConfirmStopped) { throw 'Stop Community and pass -ConfirmStopped before upgrading binaries.' }
$install = [IO.Path]::GetFullPath($InstallDirectory)
$data = [IO.Path]::GetFullPath($DataDirectory)
if (-not [IO.Path]::IsPathRooted($InstallDirectory) -or -not [IO.Path]::IsPathRooted($DataDirectory)) { throw 'Install and data paths must be absolute.' }
if (-not (Test-Path -LiteralPath (Join-Path $install 'scripts\Start-Community.ps1'))) { throw 'Existing Community installation is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $data 'database\matching.db'))) { throw 'Existing data directory is missing the database.' }
$stage = $install + '.upgrade-' + [guid]::NewGuid().ToString('N')
$previous = $install + '.previous-' + [guid]::NewGuid().ToString('N')
& (Join-Path $PSScriptRoot 'Install-Community.ps1') -PackageDirectory $PackageDirectory -InstallDirectory $stage -DataDirectory $data
$movedOld = $false
try {
  if ([IO.Path]::GetFullPath((Split-Path -Parent $install)) -ne [IO.Path]::GetFullPath((Split-Path -Parent $previous)) -or -not $previous.StartsWith($install + '.previous-',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe upgrade recovery target.' }
  Move-UpgradeDirectory $install $previous; $movedOld = $true
  Move-UpgradeDirectory $stage $install
  Write-Host "Application upgraded. Previous binaries retained at $previous. Data directory was not moved."
} catch {
  if ($movedOld -and -not (Test-Path -LiteralPath $install)) { Move-UpgradeDirectory $previous $install }
  throw
}
