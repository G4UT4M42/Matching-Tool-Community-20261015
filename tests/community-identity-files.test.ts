import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePrivateIdentityDirectory } from '../src/server/community-identity-files.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'community-acl-synthetic-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('P02 private app-owned identity filesystem boundary', () => {
  it('creates a private identity directory and verifies inherited permissions on its synthetic files', () => {
    const directory = preparePrivateIdentityDirectory(root);
    expect(directory).toBe(join(root, 'identity'));
    const file = join(directory, 'auth.sqlite');
    writeFileSync(file, 'SYNTHETIC-NOT-A-DATABASE', { mode: 0o600 });
    expect(preparePrivateIdentityDirectory(root)).toBe(directory);
    expect(readFileSync(file, 'utf8')).toBe('SYNTHETIC-NOT-A-DATABASE');
  }, 30000);
  it('rejects an existing unprotected directory instead of silently changing its permissions', () => {
    const directory = join(root, 'identity'); mkdirSync(directory);
    if (process.platform !== 'win32') chmodSync(directory, 0o755);
    expect(() => preparePrivateIdentityDirectory(root)).toThrow(/private|permissions/);
    expect(existsSync(directory)).toBe(true);
  }, 20000);
  it('rejects unknown files without deleting or rewriting them', () => {
    const directory = preparePrivateIdentityDirectory(root);
    const unrelated = join(directory, 'unrelated-synthetic.txt'); writeFileSync(unrelated, 'SYNTHETIC-PRESERVE');
    expect(() => preparePrivateIdentityDirectory(root)).toThrow(/Unexpected/);
    expect(readFileSync(unrelated, 'utf8')).toBe('SYNTHETIC-PRESERVE');
  }, 20000);
  it('rejects directory links in the runtime ancestry', () => {
    const target = join(root, 'target'); mkdirSync(target);
    const linked = join(root, 'linked'); symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => preparePrivateIdentityDirectory(linked)).toThrow(/regular local/);
    expect(existsSync(join(target, 'identity'))).toBe(false);
  });
  it('rejects relative roots and a file substituted for the identity directory', () => {
    expect(() => preparePrivateIdentityDirectory('relative-synthetic')).toThrow(/absolute/);
    const file = join(root, 'identity'); writeFileSync(file, 'SYNTHETIC-PRESERVE');
    expect(() => preparePrivateIdentityDirectory(root)).toThrow(/regular local/);
    expect(readFileSync(file, 'utf8')).toBe('SYNTHETIC-PRESERVE');
  });
});
