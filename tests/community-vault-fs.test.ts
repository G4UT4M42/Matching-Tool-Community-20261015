import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CredentialVault, type KeyProtector } from '../src/community/integrations/vault.js';
import { IntegrationService } from '../src/community/integrations/service.js';
import type { Transport } from '../src/community/integrations/types.js';

const fakeCredentials = { clientId: 'fictional-only-identifier', clientSecret: 'fictional-only-private-value' };
const principal = { subject: 'USR-fake-vault-owner' };
class SyntheticProtector implements KeyProtector {
  private readonly key = randomBytes(32);
  protect(plain: Buffer, context: Buffer): Buffer {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(context);
    return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }
  unprotect(ciphertext: Buffer, context: Buffer): Buffer {
    const cipher = createDecipheriv('aes-256-gcm', this.key, ciphertext.subarray(0, 12));
    cipher.setAAD(context); cipher.setAuthTag(ciphertext.subarray(-16));
    return Buffer.concat([cipher.update(ciphertext.subarray(12, -16)), cipher.final()]);
  }
}
let root = '', directory = '', vault: CredentialVault;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'community-vault-fs-fake-'));
  directory = path.join(root, 'vault');
  vault = new CredentialVault(directory, new SyntheticProtector());
});
afterEach(async () => { if (root) await rm(root, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 }); });
const credential = async () => path.join(directory, (await readdir(directory)).find(file => file.endsWith('.credential'))!);

describe('Provider credential and checkpoint filesystem boundaries', () => {
  it('keeps synthetic credentials encrypted in a regular private directory', async () => {
    await vault.put(principal, 'paypal', 'sandbox', fakeCredentials);
    const stored = await readFile(await credential(), 'utf8');
    expect(stored).not.toContain(fakeCredentials.clientSecret);
    expect(await vault.get(principal, 'paypal', 'sandbox')).toEqual(fakeCredentials);
    expect(await vault.get(principal, 'paypal', 'live')).toBeNull();
    expect(await vault.get({subject:'other-user'}, 'paypal', 'sandbox')).toBeNull();
    await vault.ensureStorage();
  });
  it('refuses a redirected junction directory during read, write and remove without touching external storage', async () => {
    await vault.put(principal, 'paypal', 'sandbox', fakeCredentials);
    const outside = path.join(root, 'synthetic-outside');
    await rename(directory, outside);
    const outsideName = (await readdir(outside)).find(file => file.endsWith('.credential'))!;
    const outsideBefore = await readFile(path.join(outside,outsideName));
    await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(vault.get(principal,'paypal','sandbox')).rejects.toThrow('UNSAFE_VAULT_STORAGE');
    await expect(vault.put(principal,'paypal','sandbox',fakeCredentials)).rejects.toThrow('UNSAFE_VAULT_STORAGE');
    await expect(vault.remove(principal,'paypal','sandbox')).rejects.toThrow('UNSAFE_VAULT_STORAGE');
    expect(await readFile(path.join(outside,outsideName))).toEqual(outsideBefore);
  });
  it('rejects a symlink substituted for an individual credential file', async () => {
    await vault.put(principal, 'paypal', 'sandbox', fakeCredentials);
    const file = await credential(), outside = path.join(root, 'synthetic-external-credential');
    await rename(file, outside);
    await symlink(outside, file, 'file');
    await expect(vault.get(principal,'paypal','sandbox')).rejects.toThrow('UNSAFE_VAULT_STORAGE');
    await expect(vault.put(principal,'paypal','sandbox',fakeCredentials)).rejects.toThrow('UNSAFE_VAULT_STORAGE');
    await expect(vault.remove(principal,'paypal','sandbox')).rejects.toThrow('UNSAFE_VAULT_STORAGE');
    expect((await readFile(outside,'utf8')).includes(fakeCredentials.clientSecret)).toBe(false);
  });
  it('rejects a checkpoint symlink before reading or disconnecting provider state', async () => {
    const fakeTransport: Transport = async req => req.method === 'POST'
      ? {status:200,json:{access_token:'fictional-token',expires_in:3600}}
      : {status:200,json:{account_number:'SYNTHETICMERCHANT',total_pages:1,transaction_details:[]}};
    const service = new IntegrationService(vault,async()=>{},fakeTransport,()=>new Date('2026-10-14T00:00:00Z'));
    await service.configure(principal,'paypal','sandbox',fakeCredentials);
    await service.testConnection(principal,'paypal','sandbox');
    const checkpoint = path.join(directory,(await readdir(directory)).find(name=>name.endsWith('.checkpoint'))!);
    const moved = path.join(root,'synthetic-outside-checkpoint');
    await rename(checkpoint,moved);
    await symlink(moved,checkpoint,'file');
    await expect(service.status(principal,'paypal','sandbox')).rejects.toThrow('CHECKPOINT_UNAVAILABLE');
    await expect(service.disconnect(principal,'paypal','sandbox')).rejects.toThrow('UNSAFE_VAULT_STORAGE');
    expect(await vault.get(principal,'paypal','sandbox')).toEqual(fakeCredentials);
    expect(existsSync(moved)).toBe(true);
  });
  it('refuses relative vault roots before creating files', async () => {
    const relative=new CredentialVault('relative-synthetic-vault', new SyntheticProtector());
    await expect(relative.put(principal,'paypal','sandbox',fakeCredentials)).rejects.toThrow('UNSAFE_VAULT_STORAGE');
  });
  it('rejects a preexisting permissive storage directory rather than silently rewriting its ACL', async () => {
    const existing = path.join(root,'preexisting-vault');
    await mkdir(existing,{mode:0o755});
    const actual = new CredentialVault(existing);
    await expect(actual.put(principal,'paypal','sandbox',fakeCredentials)).rejects.toThrow('UNSAFE_VAULT_STORAGE');
    expect((await readdir(existing))).toHaveLength(0);
  },30000);
  it('roundtrips credentials under real user-scoped Windows DPAPI and verifies directory ACLs', async () => {
    if (process.platform !== 'win32') return;
    const actual=new CredentialVault(path.join(root,'private-dpapi-vault'));
    await actual.put(principal,'paypal','sandbox',fakeCredentials);
    expect(await actual.get(principal,'paypal','sandbox')).toEqual(fakeCredentials);
    await actual.ensureStorage();
    await actual.remove(principal,'paypal','sandbox');
    expect(await actual.get(principal,'paypal','sandbox')).toBeNull();
  },60000);
});
