import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { runtimeOverlay, sha256, verifyPackage } from '../scripts/verify-community-package.mjs';

// Metadata acceptance only: every apparent runtime/source file is inert synthetic text.
// Neither this fixture nor verifyPackage executes a runtime or loads a native module.
const revision = 'a'.repeat(40);
const nodeVersion = '22.23.3';
const applicationVersion = '0.1.0';
const runtimeBytes = Buffer.from('SYNTHETIC METADATA FIXTURE; NEVER EXECUTED');

// Independently specified public overlay contract, not output copied from the generator.
function expectedOverlay() {
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: {
      component: {
        type: 'application', 'bom-ref': 'application:packaged-community',
        name: 'matching-tool-community', version: applicationVersion,
      },
      properties: [
        { name: 'matching:source_revision', value: revision },
        { name: 'matching:legal_clearance', value: 'false' },
        { name: 'matching:release_accepted', value: 'false' },
        {
          name: 'matching:scope',
          value: 'Exact bundled Node and reviewed replacement binaries. Base npm dependency graph remains in sbom.cyclonedx.json; complete source inventories and nested SBOMs remain hash-bound to replacement manifests.',
        },
      ],
    },
    components: [{
      type: 'application', 'bom-ref': 'runtime:node', name: 'Node.js', version: nodeVersion,
      hashes: [{ alg: 'SHA-256', content: sha256(runtimeBytes) }],
      properties: [
        { name: 'matching:package_path', value: 'runtime/node.exe' },
        { name: 'matching:license_evidence', value: 'runtime/LICENSE.node' },
      ],
    }],
    dependencies: [{ ref: 'application:packaged-community', dependsOn: ['runtime:node'] }],
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'community-overlay-metadata-'));
  const required = [
    'LICENSE', 'NOTICE', 'PACKAGING.md', 'package.json', 'package-lock.json',
    'runtime/node.exe', 'runtime/LICENSE.node', 'src/server/index.ts',
    'node_modules/tsx/dist/cli.mjs', 'web/dist/index.html',
    ...['Start', 'Install', 'Upgrade', 'Uninstall'].map(name => `scripts/${name}-Community.ps1`),
    'scripts/verify-community-package.mjs',
    ...['sbom.cyclonedx.json', 'compliance-inventory.json', 'summary.json', 'SHA256SUMS', 'runtime-overlay.cyclonedx.json'].map(name => `compliance/${name}`),
    ...['eng', 'deu'].map(language => `node_modules/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`),
  ];
  const files = new Map(required.map(path => [path, runtimeBytes]));
  files.set('package.json', Buffer.from(JSON.stringify({ version: applicationVersion })));
  files.set('package-lock.json', Buffer.from('{}'));
  files.set('compliance/compliance-inventory.json', Buffer.from(JSON.stringify({
    releaseAccepted: false, redistributionRightsVerified: false,
    sourceLockSha256: { 'package-lock.json': sha256(files.get('package-lock.json')) },
    installations: [],
  })));
  return {
    write(overlay) {
      files.set('compliance/runtime-overlay.cyclonedx.json', Buffer.from(JSON.stringify(overlay)));
      for (const [path, bytes] of files) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), bytes);
      }
      // Rehash the outer inventory too: contradictions must fail semantic verification,
      // rather than only the ordinary package-file checksum check.
      writeFileSync(join(root, 'community-package.json'), JSON.stringify({
        format: 'matching-community-package-v1', kind: 'development-candidate',
        distributable: false, releaseAccepted: false,
        sourceRevision: revision, sourceDirty: false,
        runtime: { node: nodeVersion, abi: '127', platform: 'win32', arch: 'x64' },
        runtimePackages: [], nativeReplacements: [],
        files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
      }));
    },
    verify() { return verifyPackage(root); },
    close() {
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith('community-overlay-metadata-'));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('synthetic metadata-only overlay matches the independent contract and passes development verification', () => {
  const overlay = expectedOverlay();
  assert.deepEqual(runtimeOverlay({
    sourceRevision: revision, applicationVersion, nodeVersion,
    nodeSha256: sha256(runtimeBytes), replacements: [],
  }), overlay);
  const f = fixture();
  try {
    f.write(overlay);
    const result = f.verify();
    assert.equal(result.ok, true);
    assert.equal(result.distributable, false);
    assert.equal(result.releaseAccepted, false);
  } finally { f.close(); }
});

test('synthetic overlay contradictions reject even after the outer inventory is rehashed', () => {
  const mutations = [
    ['Node version', value => { value.components[0].version = '999.0.0'; }],
    ['conflicting clearance', value => { value.metadata.properties.push({ name: 'matching:legal_clearance', value: 'true' }); }],
    ['contradictory hash', value => { value.components[0].hashes.push({ alg: 'SHA-256', content: '0'.repeat(64) }); }],
    ['duplicate component', value => { value.components.push(structuredClone(value.components[0])); }],
    ['unreviewed source reference', value => { value.components[0].properties.push({ name: 'matching:reviewed_manifest', value: 'unreviewed' }); }],
    ['unknown dependency', value => { value.dependencies[0].dependsOn.push('unreviewed'); }],
    ['application version', value => { value.metadata.component.version = '999.0.0'; }],
  ];
  const f = fixture();
  try {
    for (const [name, mutate] of mutations) {
      const overlay = expectedOverlay();
      mutate(overlay);
      f.write(overlay);
      assert.throws(() => f.verify(), /Runtime SBOM overlay differs/, name);
    }
  } finally { f.close(); }
});
