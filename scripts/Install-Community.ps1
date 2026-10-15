# Install an already built, locally supplied Community package. No downloads or global changes.
param(
  [Parameter(Mandatory=$true)][string]$PackageDirectory,
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [Parameter(Mandatory=$true)][string]$DataDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$package = [IO.Path]::GetFullPath($PackageDirectory)
$install = [IO.Path]::GetFullPath($InstallDirectory)
$data = [IO.Path]::GetFullPath($DataDirectory)
if (-not [IO.Path]::IsPathRooted($InstallDirectory) -or -not [IO.Path]::IsPathRooted($DataDirectory)) { throw 'Install and data paths must be absolute.' }
foreach ($pair in @(@($package,$install),@($package,$data),@($install,$data))) {
  if ($pair[0] -eq $pair[1] -or $pair[0].StartsWith(($pair[1].TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase) -or $pair[1].StartsWith(($pair[0].TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Package, install and data roots must be independent.' }
}
if (Test-Path -LiteralPath $install) { throw 'InstallDirectory already exists. Use the explicit upgrade workflow.' }
foreach ($required in @('src\server\index.ts','web\dist\index.html','node_modules\tsx\dist\cli.mjs','scripts\Start-Community.ps1','LICENSE','package.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $package $required) -PathType Leaf)) { throw "Package is missing $required" }
}
foreach ($item in (Get-ChildItem -LiteralPath $package -Recurse -Force)) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Package must not contain links or junctions.' }
}
$pending = $install + '.pending-' + [guid]::NewGuid().ToString('N')
try {
  New-Item -ItemType Directory -Path $pending | Out-Null
  foreach ($name in @('src','node_modules','package.json','LICENSE')) { Copy-Item -LiteralPath (Join-Path $package $name) -Destination $pending -Recurse -Force }
  New-Item -ItemType Directory -Path (Join-Path $pending 'web'),(Join-Path $pending 'scripts') | Out-Null
  Copy-Item -LiteralPath (Join-Path $package 'web\dist') -Destination (Join-Path $pending 'web') -Recurse
  Copy-Item -LiteralPath (Join-Path $package 'scripts\Start-Community.ps1') -Destination (Join-Path $pending 'scripts')
  [IO.Directory]::Move($pending,$install)
  New-Item -ItemType Directory -Path $data -Force | Out-Null
  Write-Host 'Installed Community package. Start with Start-Community.ps1 and an explicit DataDirectory.'
} finally { if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Recurse -Force } }
