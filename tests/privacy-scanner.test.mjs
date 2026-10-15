import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceScanner = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-public-tree.mjs');
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'community-privacy-spec-'));
  const root = join(parent, 'repo');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(sourceScanner, join(root, 'scripts', 'check-public-tree.mjs'));
  writeFileSync(join(root, 'README.md'), '# Fictional source tree\n');
  const privateFile = join(parent, 'private-local-blocklist.json');
  const sentinel = 'Synthetic-Secret-Name-DO-NOT-RELEASE';
  writeFileSync(privateFile, JSON.stringify([sentinel]));
  git(root, 'init', '-q');
  git(root, 'add', 'scripts/check-public-tree.mjs', 'README.md');
  return { parent, root, privateFile, sentinel };
}
function run(f, args = [], env = {}) {
  return spawnSync(process.execPath, ['scripts/check-public-tree.mjs', ...args], {
    cwd: f.root,
    env: { ...process.env, MATCHING_PRIVATE_BLOCKLIST_FILE: f.privateFile, ...env },
    encoding: 'utf8',
  });
}
test('scanner checks its own distributable source and an out-of-tree blocklist', () => {
  const f = fixture();
  try {
    const clean = run(f, ['--staged', '--require-private-blocklist']);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /generic \+ private denylist/);
    assert.ok(!readFileSync(sourceScanner, 'utf8').includes(f.sentinel));
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});
test('staged scan reads Git index rather than a later clean working-tree rewrite', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'README.md'), f.sentinel + '\n');
    git(f.root, 'add', 'README.md');
    writeFileSync(join(f.root, 'README.md'), '# now clean in working directory\n');
    const scan = run(f, ['--staged', '--require-private-blocklist']);
    assert.equal(scan.status, 1);
    assert.match(scan.stderr, /README\.md: private-review-term/);
    assert.ok(!scan.stderr.includes(f.sentinel), 'secret value must never be printed');
    assert.equal(run(f, ['--include-untracked']).status, 0, 'working-tree scan is intentionally distinct');
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});
test('private review refuses in-repository or missing blocklist configuration', () => {
  const f = fixture();
  try {
    assert.equal(run(f, ['--require-private-blocklist'], { MATCHING_PRIVATE_BLOCKLIST_FILE: '' }).status, 2);
    assert.equal(run(f, [], { MATCHING_PRIVATE_BLOCKLIST_FILE: join(f.root, 'README.md') }).status, 2);
    assert.equal(run(f, ['--staged'], { MATCHING_PRIVATE_BLOCKLIST_FILE: '' }).status, 0);
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});
test('scanner rejects financial artifacts even when contents look harmless', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'sample.sqlite'), 'nothing sensitive');
    git(f.root, 'add', 'sample.sqlite');
    const scan = run(f, ['--staged']);
    assert.equal(scan.status, 1);
    assert.match(scan.stderr, /sample\.sqlite: forbidden-path-or-extension/);
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});
