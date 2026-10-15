# Launch a privately installed Community package with independent account storage.
param(
  [Parameter(Mandatory=$true)][string]$DataDirectory,
  [string]$InstallDirectory = '',
  [string]$NodeExe = '',
  [ValidateRange(1024,65535)][int]$Port = 3433
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $InstallDirectory) { $InstallDirectory = Split-Path -Parent $PSScriptRoot }
$app = [IO.Path]::GetFullPath($InstallDirectory)
$runtime = [IO.Path]::GetFullPath($DataDirectory)
if (-not [IO.Path]::IsPathRooted($DataDirectory) -or $runtime -eq $app -or $runtime.StartsWith(($app.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or $app.StartsWith(($runtime.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'DataDirectory must be an absolute, independent directory outside the application.'
}
foreach ($path in @($app, $runtime, (Split-Path -Parent $runtime))) {
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Application and data paths cannot be links or junctions.' }
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $app 'node_modules\tsx\dist\cli.mjs'))) { throw 'Installed server dependencies are missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $app 'web\dist\index.html'))) { throw 'Installed web build is missing.' }
if (-not $NodeExe) {
  $bundled = Join-Path $app 'runtime\node.exe'
  $NodeExe = if (Test-Path -LiteralPath $bundled -PathType Leaf) { $bundled } else { 'node.exe' }
}
$node = (Get-Command $NodeExe -ErrorAction Stop).Source
$version = (& $node -p 'process.versions.node').Trim()
$abi = (& $node -p 'process.versions.modules').Trim()
if ($version -notmatch '^22\.' -or $abi -ne '127') { throw 'Supported Node 22 runtime with ABI 127 is required. Install it separately from an official Node release.' }
Push-Location $app
try {
  & $node -e "const DB=require('better-sqlite3');const db=new DB(':memory:');db.prepare('select 1').get();db.close();require('sharp')"
  if ($LASTEXITCODE -ne 0) { throw 'Native dependencies do not match this Node runtime.' }
} finally { Pop-Location }
foreach ($name in @('database','state','documents','imports','exports','backups','logs','cache','temp')) {
  $path = Join-Path $runtime $name
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Runtime storage cannot contain linked directories.' }
  } else { New-Item -ItemType Directory -Path $path -Force | Out-Null }
}
$database = Join-Path $runtime 'database\matching.db'
$state = Join-Path $runtime 'state\state.json'
if ((Test-Path -LiteralPath $database) -xor (Test-Path -LiteralPath $state)) { throw 'Incomplete existing accounting dataset requires recovery.' }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch { throw "Loopback port $Port is already in use." } finally { $listener.Stop() }
# A fresh one-use bootstrap code never becomes a reusable account password.
# Existing installations ignore it once their owner exists. It is displayed
# only in this explicitly launched local console, never placed in a URL/file.
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
try { $random.GetBytes($bytes) } finally { $random.Dispose() }
$setupCode = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
[Array]::Clear($bytes,0,$bytes.Length)
$env:MATCHING_SETUP_TOKEN = $setupCode
$env:PATH = (Split-Path -Parent $node) + ';' + $env:PATH
$env:NODE_ENV = 'production'
$env:MATCHING_DEMO_MODE = 'false'
$env:MATCHING_ENABLE_BANK_AUTOMATION = 'false'
Remove-Item Env:MATCHING_LOCAL_ACCESS_TOKEN -ErrorAction SilentlyContinue
$env:MATCHING_AUTH_MODE = 'accounts'
$env:MATCHING_RUNTIME_MODE = 'external-runtime-root'
$env:MATCHING_RUNTIME_ROOT = $runtime
$env:MATCHING_HTTP_HOST = '127.0.0.1'
$env:PORT = [string]$Port
Write-Host "Matching Tool Community: http://127.0.0.1:$Port/"
Write-Host 'For first-run setup only (expires after 30 minutes; ignored after owner creation):'
Write-Host "Local setup code: $setupCode"
$setupCode = $null
Push-Location $app
try { & $node (Join-Path $app 'node_modules\tsx\dist\cli.mjs') (Join-Path $app 'src\server\index.ts'); exit $LASTEXITCODE }
finally { Pop-Location; Remove-Item Env:MATCHING_SETUP_TOKEN -ErrorAction SilentlyContinue }
