import { spawnSync } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, open, rm } from 'node:fs/promises';
import { inspectVaultMember, readVaultMember, secureVaultDirectory, trustedWindowsPowerShell } from './vault-files.js';
import path from 'node:path';
import { assertEnvironment, assertPrincipal, assertProvider, type Environment, type Principal, type Provider } from './types.js';
import {trustedWindowsPowerShellEnvironment,trustedWindowsPowerShellPreamble} from '../../core/windows-powershell.js';

export interface KeyProtector { protect(plain: Buffer, context: Buffer): Buffer; unprotect(cipher: Buffer, context: Buffer): Buffer }
const dpapiScript = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$i = [Console]::In.ReadToEnd() | ConvertFrom-Json
$data = [Convert]::FromBase64String($i.data)
$entropy = [Convert]::FromBase64String($i.entropy)
if ($i.operation -eq 'protect') { $r = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
elseif ($i.operation -eq 'unprotect') { $r = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
else { exit 3 }
[Console]::Out.Write([Convert]::ToBase64String($r))`;
/** Windows current-user DPAPI. Plaintext is supplied on stdin, never in arguments or environment. */
export class WindowsDpapiProtector implements KeyProtector {
  private run(operation: 'protect' | 'unprotect', data: Buffer, context: Buffer): Buffer {
    if (process.platform !== 'win32') throw new Error('PROTECTION_UNAVAILABLE');
    const result = spawnSync(trustedWindowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', trustedWindowsPowerShellPreamble+dpapiScript], {
      env:trustedWindowsPowerShellEnvironment(),
      input: JSON.stringify({ operation, data: data.toString('base64'), entropy: context.toString('base64') }), encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    if (result.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.stdout.trim())) throw new Error('PROTECTION_UNAVAILABLE');
    return Buffer.from(result.stdout.trim(), 'base64');
  }
  protect(plain: Buffer, context: Buffer): Buffer { return this.run('protect', plain, context); }
  unprotect(cipher: Buffer, context: Buffer): Buffer { return this.run('unprotect', cipher, context); }
}
function identity(principal: Principal, provider: Provider, environment: Environment): string { return `${principal.subject}\0${provider}\0${environment}`; }
export class CredentialVault {
  private readonly protector: KeyProtector;
  constructor(readonly directory: string, protector?: KeyProtector) { this.protector = protector ?? new WindowsDpapiProtector(); }
  async ensureStorage(): Promise<void> { await secureVaultDirectory(this.directory, this.protector instanceof WindowsDpapiProtector); }
  private file(principal: Principal, provider: Provider, environment: Environment): string {
    return path.join(this.directory, `${createHash('sha256').update(identity(principal, provider, environment)).digest('hex')}.credential`);
  }
  async put(rawPrincipal: Principal, rawProvider: Provider, rawEnvironment: Environment, credentials: Record<string,string>, beforeCommit?:()=>void): Promise<void> {
    const principal = assertPrincipal(rawPrincipal), provider = assertProvider(rawProvider), environment = assertEnvironment(provider, rawEnvironment);
    if (!credentials || Object.keys(credentials).length === 0 || Object.keys(credentials).length > 4 || Object.values(credentials).some(x => typeof x !== 'string' || x.length < 1 || x.length > 4096)) throw new Error('INVALID_CREDENTIALS');
    await this.ensureStorage();
    const context = Buffer.from(identity(principal, provider, environment));
    const plain = Buffer.from(JSON.stringify(credentials));
    if (plain.length > 16384) { plain.fill(0); throw new Error('INVALID_CREDENTIALS'); }
    let cipher: Buffer;
    try { cipher = this.protector.protect(plain, context); } finally { plain.fill(0); }
    const target = this.file(principal, provider, environment), temp = path.join(this.directory,createHash('sha256').update(randomUUID()).digest('hex')+'.credential');
    await inspectVaultMember(this.directory, target, 65536);
    try {
      const handle=await open(temp,'wx',0o600);
      try{await handle.writeFile(JSON.stringify({ version: 1, identity: context.toString('base64'), ciphertext: cipher.toString('base64') }));await handle.sync();}finally{await handle.close();}
      await chmod(temp, 0o600);
      beforeCommit?.();
      renameSync(temp, target);
    } finally { await rm(temp, { force: true }); cipher.fill(0); }
  }
  async get(rawPrincipal: Principal, rawProvider: Provider, rawEnvironment: Environment): Promise<Record<string,string> | null> {
    const principal = assertPrincipal(rawPrincipal), provider = assertProvider(rawProvider), environment = assertEnvironment(provider, rawEnvironment);
    const raw = await readVaultMember(this.directory, this.file(principal, provider, environment), 65536);
    if (raw === null) return null;
    try {
      const box = JSON.parse(raw) as {version: number; identity: string; ciphertext: string};
      const context = Buffer.from(identity(principal, provider, environment));
      if (box.version !== 1 || typeof box.identity !== 'string' || box.identity.length > 512 || typeof box.ciphertext !== 'string' || box.ciphertext.length > 32768) throw new Error();
      const expected = createHash('sha256').update(context).digest();
      const actual = createHash('sha256').update(Buffer.from(box.identity, 'base64')).digest();
      if (!timingSafeEqual(expected, actual)) throw new Error();
      const plain = this.protector.unprotect(Buffer.from(box.ciphertext, 'base64'), context);
      try { return JSON.parse(plain.toString('utf8')) as Record<string,string>; } finally { plain.fill(0); }
    } catch { throw new Error('CREDENTIAL_UNAVAILABLE'); }
  }
  async has(principal: Principal, provider: Provider, environment: Environment): Promise<boolean> { return (await this.get(principal, provider, environment)) !== null; }
  async remove(principal: Principal, provider: Provider, environment: Environment, beforeCommit?:()=>void): Promise<void> { const target = this.file(assertPrincipal(principal), assertProvider(provider), assertEnvironment(provider, environment)); await inspectVaultMember(this.directory, target, 65536); beforeCommit?.(); rmSync(target, { force: true }); }
  sealMetadata(principal: Principal, provider: Provider, environment: Environment, value: Buffer): Buffer {
    return this.protector.protect(value, Buffer.from(`checkpoint\0${identity(principal, provider, environment)}`));
  }
  openMetadata(principal: Principal, provider: Provider, environment: Environment, value: Buffer): Buffer {
    return this.protector.unprotect(value, Buffer.from(`checkpoint\0${identity(principal, provider, environment)}`));
  }
}
