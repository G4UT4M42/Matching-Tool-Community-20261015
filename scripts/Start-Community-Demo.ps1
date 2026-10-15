# Matching Tool Community — local synthetic developer preview
# No bank connection, no owner accounting import, loopback only.
param([int]$Port = 3433, [string]$DemoProfile = 'Default')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ($DemoProfile -notmatch '^[A-Za-z0-9_-]{1,32}$') { throw 'Demo profile must contain only letters, digits, underscore or hyphen.' }
$appRoot = Join-Path $env:LOCALAPPDATA 'MatchingToolCommunity'
$profileDirectory = if ($DemoProfile -eq 'Default') { 'DemoRuntime' } else { 'DemoRuntime-' + $DemoProfile }
$runtime = [IO.Path]::GetFullPath((Join-Path $appRoot $profileDirectory))
if (-not [IO.Path]::IsPathRooted($runtime)) { throw 'Demo runtime path must be absolute.' }
if ($runtime.StartsWith(($root.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Demo runtime must remain outside source repository.'
}
foreach ($path in @($appRoot, $runtime)) {
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Demo runtime must not use junctions or symbolic links.'
    }
  }
}
$node = $null
$installed = Get-Command node.exe -ErrorAction SilentlyContinue
if ($installed) {
  try {
    if ((& $installed.Source --version) -match '^v22\.') { $node = $installed.Source }
  } catch {}
}
if (-not $node) {
  $fallback = Join-Path $env:LOCALAPPDATA 'nvm\v22.16.0\node.exe'
  if (Test-Path $fallback) { $node = $fallback }
}
if (-not $node -or (& $node --version) -notmatch '^v22\.') {
  throw 'Matching Tool Community requires supported Node.js 22 on PATH (or the local v22.16.0 installation).'
}
$nodeDir = Split-Path -Path $node -Parent
if (-not (Test-Path (Join-Path $root 'node_modules\tsx\dist\cli.mjs'))) {
  throw 'Dependencies missing. Run npm ci in the repository first.'
}
if (-not (Test-Path (Join-Path $root 'web\dist\index.html'))) {
  throw 'Frontend missing. Run npm run build before launching.'
}
# An unrecognized pre-existing database cannot be silently claimed as a demo dataset.
$statePath = Join-Path $runtime 'state\state.json'
$databasePath = Join-Path $runtime 'database\matching.db'
if ((Test-Path -LiteralPath $databasePath) -and -not (Test-Path -LiteralPath $statePath)) {
  throw 'Existing database without an approved demo state requires offline review; refusing to start.'
}
foreach($name in @('state','database','documents','imports','exports','backups','logs','cache','temp')) {
  $directory = Join-Path $runtime $name
  if (Test-Path -LiteralPath $directory) {
    $item = Get-Item -LiteralPath $directory -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Demo runtime must not contain symlinked or junction storage directories.'
    }
  }
  New-Item -Path $directory -ItemType Directory -Force | Out-Null
}
foreach ($path in @($statePath, $databasePath)) {
  if (Test-Path -LiteralPath $path) {
    $file = Get-Item -LiteralPath $path -Force
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Demo state and database must be regular files, not symbolic links.'
    }
  }
}
if(Test-Path $statePath) {
  $saved = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if ($saved.run_id -ne 'COMMUNITY_SYNTHETIC_DEMO_V1') {
    throw 'Existing runtime does not contain the approved synthetic demo. Refusing to start.'
  }
}
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try {
  $listener.Start()
} catch {
  throw "Port $Port is already in use. No running process will be terminated."
} finally {
  $listener.Stop()
}
$tokenBytes = [byte[]]::new(32)
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
$token = [Convert]::ToBase64String($tokenBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
$env:Path = $nodeDir + ';' + $env:Path
$env:PORT = [string]$Port
$env:MATCHING_HTTP_HOST = '127.0.0.1'
$env:NODE_ENV = 'production'
$env:MATCHING_RUNTIME_MODE = 'external-runtime-root'
$env:MATCHING_RUNTIME_ROOT = $runtime
$env:MATCHING_ENABLE_BANK_AUTOMATION = 'false'
$env:MATCHING_DEMO_MODE = 'true'
$env:MATCHING_AUTH_MODE = 'synthetic-preview'
$env:MATCHING_LOCAL_ACCESS_TOKEN = $token
$env:TEMP = Join-Path $runtime 'temp'
$env:TMP = $env:TEMP
Set-Location $root
Write-Host ''
Write-Host 'Matching Tool Community — SYNTHETIC DEMO ONLY' -ForegroundColor Cyan
Write-Host "Local URL: http://127.0.0.1:$Port/"
Write-Host 'Banking/production imports: DISABLED'
Write-Host 'Data directory: Local demo runtime, outside the repository.'
Write-Host ('Local access token (copy into the browser unlock form): ' + $token) -ForegroundColor Yellow
Write-Host 'Close this terminal or press Ctrl+C to stop the demo.'
Write-Host ''
try {
  & $node (Join-Path $root 'node_modules\tsx\dist\cli.mjs') (Join-Path $root 'src\server\index.ts')
} finally {
  Remove-Item Env:\MATCHING_LOCAL_ACCESS_TOKEN -ErrorAction SilentlyContinue
}
