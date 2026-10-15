# Remove application files only. The independently located accounting data is always retained.
param(
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [Parameter(Mandatory=$true)][string]$DataDirectory,
  [switch]$ConfirmStopped
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Assert-UninstallTree([string]$Directory) {
  foreach ($item in (Get-ChildItem -LiteralPath $Directory -Force)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Remove linked entries manually before uninstalling; accounting data will not be touched.' }
    if ($item.PSIsContainer) { Assert-UninstallTree $item.FullName }
  }
}
if (-not $ConfirmStopped) { throw 'Stop Community and pass -ConfirmStopped before uninstalling.' }
if (-not [IO.Path]::IsPathRooted($InstallDirectory) -or -not [IO.Path]::IsPathRooted($DataDirectory)) { throw 'Install and data paths must be absolute.' }
$install = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$data = [IO.Path]::GetFullPath($DataDirectory).TrimEnd('\')
if ($install -eq [IO.Path]::GetPathRoot($install).TrimEnd('\') -or $install -eq $data -or $install.StartsWith($data + '\',[StringComparison]::OrdinalIgnoreCase) -or $data.StartsWith($install + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Application and retained data must be independent, non-root directories.' }
foreach ($target in @($install,$data)) {
  $ancestor = $target
  while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and (((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Uninstall paths cannot traverse links or junctions.' }
    $parent = Split-Path -Parent $ancestor
    if ($parent -eq $ancestor) { break }; $ancestor = $parent
  }
}
$markerPath = Join-Path $install '.community-install.json'
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $install 'scripts\Start-Community.ps1') -PathType Leaf)) { throw 'Refusing to remove an unrecognized installation directory.' }
if (((Get-Item -LiteralPath $markerPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Installation marker cannot be a link.' }
$marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if ($marker.format -ne 'matching-community-install-v1') { throw 'Unrecognized installation marker.' }
Assert-UninstallTree $install
$removal = $install + '.uninstall-' + [guid]::NewGuid().ToString('N')
if ((Split-Path -Parent ([IO.Path]::GetFullPath($removal))) -ne (Split-Path -Parent $install) -or -not $removal.StartsWith($install + '.uninstall-',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe uninstall target.' }
$renamed = $false
for ($attempt = 0; $attempt -lt 12; $attempt++) {
  try { [IO.Directory]::Move($install,$removal); $renamed = $true; break }
  catch [IO.IOException] { if ($attempt -eq 11 -or (Test-Path -LiteralPath $removal)) { throw }; Start-Sleep -Milliseconds 250 }
  catch [UnauthorizedAccessException] { if ($attempt -eq 11 -or (Test-Path -LiteralPath $removal)) { throw }; Start-Sleep -Milliseconds 250 }
}
if (-not $renamed) { throw 'Application files remain in use; installation and accounting data were preserved.' }
if ((Split-Path -Parent ([IO.Path]::GetFullPath($removal))) -ne (Split-Path -Parent $install)) { throw 'Unsafe uninstall cleanup target.' }
Remove-Item -LiteralPath $removal -Recurse -Force
Write-Host 'Community application files removed. Accounting data and separately retained previous-version directories were preserved.'
