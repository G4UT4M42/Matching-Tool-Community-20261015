#!/usr/bin/env node
// Contract gate for PRs. Human review is still mandatory.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const baseIndex = argv.indexOf('--base');
const base = baseIndex >= 0 ? argv[baseIndex + 1] : null;
if (!base || !/^[\w./~^-]+$/.test(base)) {
  console.error('Usage: node scripts/check-migration-pr.mjs --base <trusted-git-ref>');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
let files;
try {
  files = git('diff', '--name-only', '--diff-filter=ACMR', base, 'HEAD').split(/\r?\n/).filter(Boolean);
} catch {
  console.error('Cannot compare with base revision; migration gate fails closed.');
  process.exit(2);
}
const changed = (pattern) => files.some(f => pattern.test(f));
const relevant = changed(/^(src\/(storage|migration|migrations|payments|import|core\/matching|core\/reporting|community\/(?:accounting|documents|integrations|banking|payments|persistence))\/|src\/server\/(?:community-(?:workspace|auth-store)\.ts|routes\/community-[^/]+\.ts)|src\/core\/types\.|.*schema[^/]*\.sql$|docs\/contracts\/|web\/src\/api\.)/i);
const decisions = files.filter(f => /^docs\/migration-decisions\/[a-z0-9._-]+\.md$/i.test(f)
  && !f.endsWith('/TEMPLATE.md'));
let failures = [];
if (relevant && !decisions.length) {
  failures.push('Persisted contract/code changed without a migration decision in the same PR.');
}
let foundYes = false;
for (const file of decisions) {
  let contents = '';
  try { contents = readFileSync(resolve(root, file), 'utf8'); }
  catch { failures.push('Migration decision not readable: ' + file); continue; }
  const answer = contents.match(/^Migration-Required:\s*(yes|no)\s*$/im)?.[1]?.toLowerCase();
  const rationale = contents.match(/^Rationale:\s*(.+)$/im)?.[1]?.trim() ?? '';
  if (!answer) failures.push(file + ': missing Migration-Required: yes|no');
  if (rationale.length < 25) failures.push(file + ': substantive rationale required (at least 25 characters)');
  if (!/^Rollback:\s*\S.{12,}$/im.test(contents)) failures.push(file + ': rollback instructions required');
  if (answer === 'yes') foundYes = true;
}
if (foundYes) {
  if (!changed(/^src\/migrations\/.*\.(ts|js|mjs)$/)) failures.push('Required migration has no executable forward migration in src/migrations/.');
  if (!changed(/^tests\/fixtures\/migrations\//)) failures.push('Required migration has no old/new synthetic migration fixtures.');
  if (!changed(/^tests\/.*migration.*\.(test\.)?(ts|js|mjs)$/)) failures.push('Required migration has no executable migration regression test.');
}
const banned = files.filter(f => /(^|\/)(Belege|runtime|logs|backups|data|browser-profiles)\/|\.(sqlite|db|csv|xlsx|xls|zip|pdf|pem|key)$/i.test(f));
if (banned.length) failures.push('Private or generated paths cannot be committed: ' + banned.join(', '));
if (failures.length) {
  console.error('MIGRATION_GATE_FAIL\n' + failures.map(x => ' - ' + x).join('\n'));
  process.exit(1);
}
console.log('MIGRATION_GATE_PASS: reviewed persisted changes=' + relevant + ', migration decisions=' + decisions.length);
