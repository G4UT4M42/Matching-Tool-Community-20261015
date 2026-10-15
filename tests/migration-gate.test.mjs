import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const actualRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tool = join(actualRoot, 'scripts', 'check-migration-pr.mjs');
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}
function write(root, path, value) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, value, 'utf8');
}
function baseline() {
  const dir = mkdtempSync(join(tmpdir(), 'matching-community-pr-'));
  git(dir, 'init', '-b', 'main');
  write(dir, 'README.md', '# synthetic fixture only\n');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(tool, join(dir, 'scripts', 'check-migration-pr.mjs'));
  write(dir, 'package.json', '{"type":"module"}\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'fixture baseline');
  return dir;
}
function commit(root) {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'synthetic change');
}
function check(root) {
  return spawnSync(process.execPath, ['scripts/check-migration-pr.mjs', '--base', 'HEAD~1'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
}
const decision = required => `# Verified change decision
Migration-Required: ${required}
Rationale: Existing data is preserved by an explicitly documented compatibility strategy.
Rollback: Preserve the existing application and revert the new staging pointer after verification.
`;

test('README-only change does not require a persistence decision', () => {
  const root = baseline();
  try {
    write(root, 'README.md', '# document change\n');
    commit(root);
    assert.equal(check(root).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('data schema change without a migration decision fails closed', () => {
  const root = baseline();
  try {
    write(root, 'src/storage/schema.sql', 'CREATE TABLE example (id TEXT);');
    commit(root);
    const result = check(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /without a migration decision/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('required migration without executable/test evidence fails', () => {
  const root = baseline();
  try {
    write(root, 'src/storage/schema.sql', 'CREATE TABLE example (id TEXT);');
    write(root, 'docs/migration-decisions/001.md', decision('yes'));
    commit(root);
    assert.equal(check(root).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('migration with forward script, synthetic fixtures and test is accepted by policy gate', () => {
  const root = baseline();
  try {
    write(root, 'src/storage/schema.sql', 'CREATE TABLE example (id TEXT);');
    write(root, 'docs/migration-decisions/001.md', decision('yes'));
    write(root, 'src/migrations/001.mjs', 'export const upgrade = data => ({ ...data, version: 2 });');
    write(root, 'tests/fixtures/migrations/old.json', '{"classification":"TEST_SYNTHETIC","version":1}');
    write(root, 'tests/fixtures/migrations/new.json', '{"classification":"TEST_SYNTHETIC","version":2}');
    write(root, 'tests/forward-migration.test.mjs', '// synthetic test placeholder, independent review still required\n');
    commit(root);
    assert.equal(check(root).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('financial file path in changed files is rejected', () => {
  const root = baseline();
  try {
    write(root, 'Belege/synthetic.pdf', '%PDF-fake');
    commit(root);
    assert.equal(check(root).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for(const path of ['src/community/accounting/ledger.ts','src/community/persistence/restore.ts','src/server/community-workspace.ts','src/server/routes/community-documents.ts'])test('persisted Community contract requires a decision: '+path,()=>{
 const root=baseline();try{write(root,path,'// Synthetic persisted contract change\n');commit(root);const result=check(root);assert.equal(result.status,1);assert.match(result.stderr,/without a migration decision/);}finally{rmSync(root,{recursive:true,force:true});}
});
