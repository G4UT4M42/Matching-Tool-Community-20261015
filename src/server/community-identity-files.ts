import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {trustedWindowsPowerShellEnvironment,trustedWindowsPowerShellPreamble} from '../core/windows-powershell.js';

const identityMembers = new Set(['auth.sqlite', 'auth.sqlite-wal', 'auth.sqlite-shm']);
const identityDirectories = new Set(['provider-vault','bank-vault','invoice-browsers']);
const windowsAclScript = String.raw`
$ErrorActionPreference = 'Stop'
$directory = $env:MATCHING_AUTH_ACL_DIRECTORY
$item = Get-Item -LiteralPath $directory -Force
if (!$item.PSIsContainer -or $item.Name -ne 'identity' -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid identity directory' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowed = @($user.Value, $system.Value)
if ($env:MATCHING_AUTH_ACL_CREATE -eq 'true') {
  if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) { throw 'Only a newly created empty identity directory may be protected' }
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($user)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($identity in @($user, $system)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $directory -AclObject $acl
}
$paths = @($directory)
foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force)) {
  if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected identity store member' }
  if ($child.PSIsContainer) {
    if ($child.Name -notin @('provider-vault','bank-vault','invoice-browsers')) { throw 'Unexpected identity directory' }
  } elseif ($child.Name -notin @('auth.sqlite','auth.sqlite-wal','auth.sqlite-shm')) { throw 'Unexpected identity store member' }
  $paths += $child.FullName
}
foreach ($path in $paths) {
  $acl = Get-Acl -LiteralPath $path
  if ($path -eq $directory -and !$acl.AreAccessRulesProtected) { throw 'Identity directory inherits unrelated permissions' }
  $granted = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'Identity storage is accessible by an unexpected principal' }
    if ($rule.IdentityReference.Value -eq $user.Value -and (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)) { $granted = $true }
  }
  if (!$granted) { throw 'The local application owner lacks identity storage access' }
}
Write-Output 'AUTH_IDENTITY_ACL_VERIFIED'
`;

function assertNoReparseAncestors(path: string): void {
  let cursor = resolve(path);
  while (true) {
    if (existsSync(cursor)) {
      const information = lstatSync(cursor);
      if (information.isSymbolicLink() || !information.isDirectory()) throw new Error('Identity storage requires regular local directory ancestors');
    }
    const parent = dirname(cursor);
    if (parent === cursor || cursor === parse(cursor).root) return;
    cursor = parent;
  }
}
function verifyLocalPermissions(directory: string, created: boolean): void {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('The trusted Windows system directory is unavailable');
    const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const environment=trustedWindowsPowerShellEnvironment();
    environment.MATCHING_AUTH_ACL_DIRECTORY = directory;
    environment.MATCHING_AUTH_ACL_CREATE = created ? 'true' : 'false';
    const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', trustedWindowsPowerShellPreamble+windowsAclScript], { env: environment, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    if (result.error || result.status !== 0 || result.stdout.trim() !== 'AUTH_IDENTITY_ACL_VERIFIED') throw new Error('Private Windows identity storage permissions could not be verified');
    return;
  }
  if (created) chmodSync(directory, 0o700);
  const paths = [directory, ...readdirSync(directory).map(name => join(directory, name))];
  for (const path of paths) {
    const info = lstatSync(path);
    if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('Identity storage is not private to the local application user');
  }
}

/** Create only the app-owned identity child; never rewrite an existing permissive ACL. */
export function preparePrivateIdentityDirectory(runtimeRoot: string): string {
  if (!isAbsolute(runtimeRoot)) throw new Error('Identity storage requires an explicit absolute runtime');
  const directory = join(resolve(runtimeRoot), 'identity');
  assertNoReparseAncestors(directory);
  const created = !existsSync(directory);
  if (created) mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(directory)) {
    const info = lstatSync(join(directory, name));
    if (info.isSymbolicLink() || !(info.isFile()&&identityMembers.has(name) || info.isDirectory()&&identityDirectories.has(name))) throw new Error('Unexpected identity storage member');
  }
  verifyLocalPermissions(directory, created);
  return directory;
}
