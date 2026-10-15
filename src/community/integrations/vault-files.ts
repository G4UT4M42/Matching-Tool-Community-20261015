import { constants } from 'node:fs';
import { lstat, mkdir, open, chmod, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {trustedWindowsPowerShellEnvironment,trustedWindowsPowerShellPreamble} from '../../core/windows-powershell.js';

/** Sensitive files stay inside a regular, independently owned vault directory. */
const aclCheck = String.raw`
$ErrorActionPreference = 'Stop'
$directory = $env:MATCHING_VAULT_DIRECTORY
$created = $env:MATCHING_VAULT_NEW -eq 'true'
$browserSessions = $env:MATCHING_VAULT_LAYOUT -eq 'browser-sessions'
$item = Get-Item -LiteralPath $directory -Force
if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid vault directory' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowed = @($user.Value, $system.Value)
if ($created) {
  if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) { throw 'Vault initialization must be empty' }
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($user)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($identity in @($user, $system)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $identity,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $directory -AclObject $acl
}
foreach ($member in @($item) + @(Get-ChildItem -LiteralPath $directory -Force)) {
  if ($member.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid vault member' }
  if ($member -ne $item) {
    if ($browserSessions) {
      if (!$member.PSIsContainer -or $member.Name -notmatch '^session-[A-Za-z0-9]{6}$') { throw 'Invalid browser session directory' }
    } elseif ($member.PSIsContainer -or $member.Name -notmatch '^[a-f0-9]{64}\.(credential|checkpoint)$') { throw 'Invalid vault member' }
  }
  $acl = Get-Acl -LiteralPath $member.FullName
  if ($member -eq $item -and !$acl.AreAccessRulesProtected) { throw 'Unexpected inherited vault permissions' }
  $ownerAllowed = $false
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'Unexpected vault access rule' }
    if ($rule.IdentityReference.Value -eq $user.Value -and
       (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)) { $ownerAllowed = $true }
  }
  if (!$ownerAllowed) { throw 'Owner has no vault access' }
}
Write-Output 'COMMUNITY_VAULT_ACL_VERIFIED'
`;
export function trustedWindowsPowerShell(): string {
  if (process.platform !== 'win32') throw new Error('PROTECTION_UNAVAILABLE');
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('PROTECTION_UNAVAILABLE');
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
async function directoryChain(directory: string): Promise<void> {
  let current = path.resolve(directory);
  for (;;) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('UNSAFE_VAULT_STORAGE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function verifyWindowsAcl(directory: string, created: boolean, layout:'vault'|'browser-sessions'): void {
  const env=trustedWindowsPowerShellEnvironment();
  env.MATCHING_VAULT_DIRECTORY = directory;
  env.MATCHING_VAULT_NEW = created ? 'true' : 'false';
  env.MATCHING_VAULT_LAYOUT = layout;
  const check = spawnSync(trustedWindowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', trustedWindowsPowerShellPreamble+aclCheck],
    { env, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  if (check.error || check.status !== 0 || check.stdout.trim() !== 'COMMUNITY_VAULT_ACL_VERIFIED') {
    throw new Error('UNSAFE_VAULT_STORAGE');
  }
}
export async function secureVaultDirectory(directory: string, windowsAcl = true, layout:'vault'|'browser-sessions'='vault'): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error('UNSAFE_VAULT_STORAGE');
  await directoryChain(directory);
  let created = false;
  try { await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 }); created = true;
  }
  await directoryChain(directory);
  const info = await lstat(directory);
  if (process.platform === 'win32') {
    if (windowsAcl) verifyWindowsAcl(directory, created,layout);
  } else {
    if (created) await chmod(directory, 0o700);
    if (windowsAcl && ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()))) {
      throw new Error('UNSAFE_VAULT_STORAGE');
    }
  }
}
export async function inspectVaultMember(directory: string, filename: string, maximumBytes: number): Promise<boolean> {
  if (!path.isAbsolute(directory) || path.dirname(filename) !== path.resolve(directory) ||
      !/^[a-f0-9]{64}\.(credential|checkpoint)$/.test(path.basename(filename))) throw new Error('UNSAFE_VAULT_STORAGE');
  await directoryChain(directory);
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes) throw new Error('UNSAFE_VAULT_STORAGE');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function readVaultMember(directory: string, filename: string, maximumBytes: number): Promise<string | null> {
  if (!await inspectVaultMember(directory, filename, maximumBytes)) return null;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filename, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maximumBytes) throw new Error('UNSAFE_VAULT_STORAGE');
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) throw new Error('UNSAFE_VAULT_STORAGE');
    return bytes.toString('utf8');
  } finally { await handle.close(); }
}
