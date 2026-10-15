import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scripts = resolve('scripts');
function packageFixture(path, marker) {
  for (const dir of ['src/server','web/dist','node_modules/tsx/dist','scripts']) mkdirSync(join(path, dir), { recursive: true });
  writeFileSync(join(path, 'src/server/index.ts'), marker);
  writeFileSync(join(path, 'web/dist/index.html'), '<h1>Synthetic package</h1>');
  writeFileSync(join(path, 'node_modules/tsx/dist/cli.mjs'), '// synthetic installer fixture');
  writeFileSync(join(path, 'LICENSE'), 'Synthetic test license');
  writeFileSync(join(path, 'package.json'), '{}');
  copyFileSync(join(scripts, 'Start-Community.ps1'), join(path, 'scripts/Start-Community.ps1'));
}
function powershell(file, args) {
  const run = spawnSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',join(scripts,file),...args], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
}
test('clean local install and binary upgrade retain independent Unicode data path', () => {
  const base = mkdtempSync(join(tmpdir(), 'community-install-'));
  try {
    const first = join(base, 'package one'), second = join(base, 'package two');
    const install = join(base, 'Community App'), data = join(base, 'Daten Übung');
    packageFixture(first, 'version one'); packageFixture(second, 'version two');
    powershell('Install-Community.ps1', ['-PackageDirectory', first, '-InstallDirectory', install, '-DataDirectory', data]);
    assert.equal(readFileSync(join(install, 'src/server/index.ts'), 'utf8'), 'version one');
    mkdirSync(join(data, 'database'), { recursive: true });
    writeFileSync(join(data, 'database/matching.db'), 'SYNTHETIC KEEP');
    powershell('Upgrade-Community.ps1', ['-PackageDirectory', second, '-InstallDirectory', install, '-DataDirectory', data, '-ConfirmStopped']);
    assert.equal(readFileSync(join(install, 'src/server/index.ts'), 'utf8'), 'version two');
    assert.equal(readFileSync(join(data, 'database/matching.db'), 'utf8'), 'SYNTHETIC KEEP');
    assert.equal(existsSync(join(install, 'scripts/Start-Community.ps1')), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
