# Install an already built, locally supplied Community package. No downloads or global changes.
param(
  [Parameter(Mandatory=$true)][string]$PackageDirectory,
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [Parameter(Mandatory=$true)][string]$DataDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-PackageSha256([string]$LiteralPath) {
  $stream = [IO.File]::OpenRead($LiteralPath)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Assert-PackageTree([string]$Directory) {
  foreach ($item in (Get-ChildItem -LiteralPath $Directory -Force)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Package must not contain links or junctions.' }
    if ($item.PSIsContainer) { Assert-PackageTree $item.FullName }
  }
}
$package = [IO.Path]::GetFullPath($PackageDirectory)
$install = [IO.Path]::GetFullPath($InstallDirectory)
$data = [IO.Path]::GetFullPath($DataDirectory)
if (-not [IO.Path]::IsPathRooted($PackageDirectory) -or -not [IO.Path]::IsPathRooted($InstallDirectory) -or -not [IO.Path]::IsPathRooted($DataDirectory)) { throw 'Package, install and data paths must be absolute.' }
foreach ($target in @($package,$install,$data)) {
  if ($target.TrimEnd('\') -eq [IO.Path]::GetPathRoot($target).TrimEnd('\')) { throw 'Filesystem roots cannot be package, install or data directories.' }
  $ancestor = $target
  while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
      if (((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Installation paths cannot traverse links or junctions.' }
    }
    $parent = Split-Path -Parent $ancestor
    if ($parent -eq $ancestor) { break }; $ancestor = $parent
  }
}
foreach ($pair in @(@($package,$install),@($package,$data),@($install,$data))) {
  if ($pair[0] -eq $pair[1] -or $pair[0].StartsWith(($pair[1].TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase) -or $pair[1].StartsWith(($pair[0].TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Package, install and data roots must be independent.' }
}
if (Test-Path -LiteralPath $install) { throw 'InstallDirectory already exists. Use the explicit upgrade workflow.' }
foreach ($required in @('src\server\index.ts','web\dist\index.html','node_modules\tsx\dist\cli.mjs','scripts\Start-Community.ps1','LICENSE','package.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $package $required) -PathType Leaf)) { throw "Package is missing $required" }
}
Assert-PackageTree $package
$qualifiedPackage = Test-Path -LiteralPath (Join-Path $package 'community-package.json') -PathType Leaf
if ($qualifiedPackage) {
  $manifest = Get-Content -LiteralPath (Join-Path $package 'community-package.json') -Raw | ConvertFrom-Json
  if ($manifest.format -ne 'matching-community-package-v1' -or $manifest.distributable -ne $false -or $manifest.releaseAccepted -ne $false) { throw 'Unsupported package acceptance claim.' }
  foreach ($bootstrap in @('runtime/node.exe','scripts/verify-community-package.mjs')) {
    $entry = @($manifest.files | Where-Object { $_.path -ceq $bootstrap })
    if ($entry.Count -ne 1) { throw 'Missing package verification bootstrap.' }
    $file = Join-Path $package $bootstrap
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-PackageSha256 $file) -cne $entry[0].sha256) { throw 'Package verification bootstrap integrity mismatch.' }
  }
  & (Join-Path $package 'runtime/node.exe') (Join-Path $package 'scripts/verify-community-package.mjs') $package
  if ($LASTEXITCODE -ne 0) { throw 'Package inventory or compliance verification failed.' }
  Write-Warning 'Installing a verified development candidate. Redistribution and release acceptance remain unresolved.'
} else {
  Write-Warning 'UNREVIEWED DEVELOPMENT DIRECTORY: not a qualified distributable package. Rights, notices, runtime bundling and file integrity require separate review.'
}
$pending = $install + '.pending-' + [guid]::NewGuid().ToString('N')
try {
  New-Item -ItemType Directory -Path $pending | Out-Null
  if ($qualifiedPackage) {
    foreach ($item in (Get-ChildItem -LiteralPath $package -Force)) { Copy-Item -LiteralPath $item.FullName -Destination $pending -Recurse -Force }
  } else {
    foreach ($name in @('src','node_modules','package.json','LICENSE')) { Copy-Item -LiteralPath (Join-Path $package $name) -Destination $pending -Recurse -Force }
    foreach ($name in @('NOTICE','runtime','compliance','community-package.json','package-lock.json')) {
      if (Test-Path -LiteralPath (Join-Path $package $name)) { Copy-Item -LiteralPath (Join-Path $package $name) -Destination $pending -Recurse -Force }
    }
    if (Test-Path -LiteralPath (Join-Path $package 'docs\compliance')) {
      New-Item -ItemType Directory -Path (Join-Path $pending 'docs') | Out-Null
      Copy-Item -LiteralPath (Join-Path $package 'docs\compliance') -Destination (Join-Path $pending 'docs') -Recurse
    }
    New-Item -ItemType Directory -Path (Join-Path $pending 'web'),(Join-Path $pending 'scripts') | Out-Null
    Copy-Item -LiteralPath (Join-Path $package 'web\dist') -Destination (Join-Path $pending 'web') -Recurse
    foreach ($name in @('Start-Community.ps1','Install-Community.ps1','Upgrade-Community.ps1','Uninstall-Community.ps1','verify-community-package.mjs')) {
      if (Test-Path -LiteralPath (Join-Path $package ('scripts\' + $name))) { Copy-Item -LiteralPath (Join-Path $package ('scripts\' + $name)) -Destination (Join-Path $pending 'scripts') }
    }
  }
  if ($qualifiedPackage) {
    & (Join-Path $pending 'runtime/node.exe') (Join-Path $pending 'scripts/verify-community-package.mjs') $pending
    if ($LASTEXITCODE -ne 0) { throw 'Copied installation failed package verification.' }
  }
  $packageDigest = if ($qualifiedPackage) { Get-PackageSha256 (Join-Path $pending 'community-package.json') } else { $null }
  @{format='matching-community-install-v1';kind='development';packageManifestSha256=$packageDigest;distributable=$false;releaseAccepted=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pending '.community-install.json') -Encoding UTF8
  for ($attempt = 0; $attempt -lt 12; $attempt++) {
    try { [IO.Directory]::Move($pending,$install); break }
    catch [IO.IOException] { if ($attempt -eq 11 -or (Test-Path -LiteralPath $install)) { throw }; Start-Sleep -Milliseconds 250 }
    catch [UnauthorizedAccessException] { if ($attempt -eq 11 -or (Test-Path -LiteralPath $install)) { throw }; Start-Sleep -Milliseconds 250 }
  }
  New-Item -ItemType Directory -Path $data -Force | Out-Null
  Write-Host 'Installed Community development candidate. Start with Start-Community.ps1 and an explicit DataDirectory. Release acceptance remains false.'
} finally {
  if (Test-Path -LiteralPath $pending) {
    $resolvedPending = [IO.Path]::GetFullPath($pending)
    if ((Split-Path -Parent $resolvedPending) -ne (Split-Path -Parent $install) -or -not $resolvedPending.StartsWith($install + '.pending-',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe staging cleanup target.' }
    Remove-Item -LiteralPath $resolvedPending -Recurse -Force
  }
}
