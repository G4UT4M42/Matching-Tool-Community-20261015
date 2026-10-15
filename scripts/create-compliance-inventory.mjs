#!/usr/bin/env node
/** Offline evidence collection. Declared licenses and copied notices are not legal clearance. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { resolve, relative, dirname, join, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const ordered = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const publicHosts = new Set(['registry.npmjs.org', 'cdn.sheetjs.com']);
const noticeName = /^(?:licen[sc]e|notice|copying|copyright|authors|patents|ofl|unlicense)(?:$|[._-])/i;
const assetName = /\.(?:dll|node|wasm|afm|ttf|otf|woff2?|xsd)$|(?:traineddata(?:\.gz)?|icudtl\.dat)$/i;
const scopes = [['root', ''], ['web', 'web']];

function within(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
function portable(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\x00-\x1f\\]/.test(value)) throw new Error('Unsafe dependency metadata');
  return value;
}
function parts(value) {
  portable(value);
  const result = value.split('/');
  if (result.some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error('Unsafe dependency path');
  return result;
}
function packageName(key) {
  parts(key);
  if (!/^(?:node_modules\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)(?:\/node_modules\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)*$/.test(key)) throw new Error('Invalid npm installation path');
  return key.slice(key.lastIndexOf('node_modules/') + 13);
}
function plainPath(root, rel, kind = 'file') {
  let file = root;
  const segments = parts(rel);
  for (let i = 0; i < segments.length; i++) {
    file = join(file, segments[i]);
    if (!existsSync(file)) return null;
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (i < segments.length - 1 && !stat.isDirectory())) throw new Error('Dependency links or invalid ancestors are not followed');
    if (i === segments.length - 1 && (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) throw new Error('Unexpected dependency file type');
  }
  return file;
}
function bounded(file, max = 4 * 1024 * 1024) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('Unexpected or oversized evidence file');
  return readFileSync(file);
}
function location(value) {
  if (value == null) return { status: 'missing' };
  portable(value);
  let url;
  try { url = new URL(value); } catch { return { status: 'nonpublic_location_omitted' }; }
  if (url.username || url.password || url.search || url.hash) throw new Error('Credential-bearing or parameterized dependency URL rejected');
  if (url.protocol !== 'https:' || !publicHosts.has(url.hostname)) return { status: 'nonpublic_location_omitted' };
  return { status: 'public_https', url: url.href, host: url.hostname };
}
function integrity(value) {
  if (value == null) return [];
  portable(value);
  return value.trim().split(/\s+/).map(item => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(item);
    if (!match) throw new Error('Invalid package integrity');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length !== Number(match[1].slice(3)) / 8 || bytes.toString('base64') !== match[2]) throw new Error('Invalid digest encoding or length');
    return { alg: match[1].replace('sha', 'SHA-'), content: bytes.toString('hex') };
  });
}
function declared(value) {
  const text = typeof value === 'string' ? value : value?.type;
  if (!text) return null;
  portable(text);
  if (text.length > 160 || /@|https?:|[A-Za-z]:\//.test(text)) throw new Error('Unsafe license declaration');
  return text;
}
function licenseChoice(value) {
  if (!value) return [];
  return /^[A-Za-z0-9.+ ()-]+$/.test(value) && !value.startsWith('SEE ') ? [{ expression: value }] : [{ license: { name: value } }];
}
function enumerate(folder, prefix = '') {
  const result = [];
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    parts(rel);
    if (entry.isSymbolicLink()) { result.push({ path: rel, link: true }); continue; }
    if (entry.isDirectory()) result.push(...enumerate(join(folder, entry.name), rel));
    else if (entry.isFile() && (noticeName.test(entry.name) || assetName.test(entry.name))) result.push({ path: rel });
  }
  return result;
}
function readLock(root, rel) {
  const file = plainPath(root, rel);
  if (!file) throw new Error('Missing npm lockfile');
  const raw = bounded(file, 20 * 1024 * 1024);
  const lock = JSON.parse(raw);
  if (lock.lockfileVersion !== 3 || !lock.packages || Array.isArray(lock.packages)) throw new Error('Expected npm v3 lockfile');
  return { lock, sha256: sha(raw) };
}
function resolveEdge(packages, from, name) {
  if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid dependency name');
  let parent = from;
  while (true) {
    const candidate = (parent ? parent + '/' : '') + 'node_modules/' + name;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (!parent) return null;
    const cut = parent.lastIndexOf('/node_modules/');
    parent = cut < 0 ? '' : parent.slice(0, cut);
  }
}

export function collectCompliance(root) {
  const artifacts = new Map(), components = [], installations = [], dependencies = [], locks = {}, unresolved = [];
  for (const [workspace, subfolder] of scopes) {
    const installRoot = join(root, subfolder);
    const lockPath = (subfolder ? subfolder + '/' : '') + 'package-lock.json';
    const { lock, sha256 } = readLock(root, lockPath);
    locks[lockPath] = sha256;
    const refs = new Map([['', 'application:' + workspace]]);
    if (workspace === 'web') components.push({ type: 'application', 'bom-ref': 'application:web', name: 'matching-tool-community-web', version: lock.packages['']?.version ?? 'unreleased' });
    for (const key of ordered(Object.keys(lock.packages).filter(Boolean))) {
      const meta = lock.packages[key], name = packageName(key);
      if (!meta || typeof meta.version !== 'string' || !/^[0-9A-Za-z.+-]{1,100}$/.test(meta.version) || meta.link) throw new Error('Incomplete or linked lock entry');
      const ref = workspace + ':' + key + '@' + meta.version;
      refs.set(key, ref);
      const entry = { ref, workspace, path: key, name, version: meta.version, dependencyKind: meta.dev ? 'development' : 'production', optional: meta.optional === true,
        os: meta.os ?? [], cpu: meta.cpu ?? [], provenance: location(meta.resolved), integrity: meta.integrity ?? null,
        integrityVerification: 'lock_declaration_only_not_downloaded', installed: false, declaredLicense: declared(meta.license), licenseEvidence: meta.license ? 'lockfile_declaration' : 'missing', notices: [], assets: [], gates: [] };
      const folder = plainPath(installRoot, key, 'directory');
      if (folder) {
        const manifest = plainPath(folder, 'package.json');
        if (!manifest) throw new Error('Installed package has no manifest');
        const installed = JSON.parse(bounded(manifest, 1024 * 1024));
        if (installed.name !== name || installed.version !== meta.version) throw new Error('Installed name/version differs from lockfile');
        entry.installed = true;
        entry.manifestSha256 = sha(bounded(manifest, 1024 * 1024));
        if (!entry.declaredLicense) { entry.declaredLicense = declared(installed.license); entry.licenseEvidence = entry.declaredLicense ? 'installed_manifest_declaration' : 'missing'; }
        for (const file of enumerate(folder)) {
          if (file.link) { entry.gates.push('package_contains_unfollowed_link:' + file.path); continue; }
          const actual = plainPath(folder, file.path);
          const bytes = bounded(actual, assetName.test(file.path) ? 256 * 1024 * 1024 : 4 * 1024 * 1024);
          const digest = sha(bytes);
          if (noticeName.test(file.path.split('/').at(-1))) {
            const copy = 'license-texts/' + digest + '.txt';
            artifacts.set(copy, bytes);
            entry.notices.push({ path: file.path, sha256: digest, bytes: bytes.length, copy });
          }
          if (assetName.test(file.path)) entry.assets.push({ path: file.path, sha256: digest, bytes: bytes.length, provenance: 'installed_bytes_not_independent_build_attestation' });
        }
        // node-canvas places its wrapper license at the end of Readme.md.
        if (name === 'canvas') {
          const readme = plainPath(folder, 'Readme.md');
          if (readme) {
            const bytes = bounded(readme), marker = bytes.indexOf('## License');
            if (marker >= 0) { const text = bytes.subarray(marker), digest = sha(text), copy = 'license-texts/' + digest + '.txt'; artifacts.set(copy, text); entry.notices.push({ path: 'Readme.md#License', sha256: digest, bytes: text.length, copy }); }
          }
        }
        if (!entry.declaredLicense) entry.gates.push('no_license_metadata_inspect_actual_texts');
        if (!entry.notices.length) entry.gates.push('no_license_text_found_in_installed_package');
        if (entry.assets.some(f => /\.(?:node|dll|wasm)$/.test(f.path))) entry.gates.push('native_build_sources_linking_and_third_party_notices_need_review');
        if (/\b(?:LGPL|GPL|MPL)-/.test(entry.declaredLicense ?? '')) entry.gates.push('copyleft_source_and_relink_obligations_need_review');
      }
      if (name.startsWith('@tesseract.js-data/')) entry.gates.push('traineddata_is_Apache_2_0_upstream_despite_MIT_package_metadata');
      if (name === 'xlsx') entry.gates.push('SheetJS_exact_CDN_tarball_integrity_requires_independent_verification');
      if (name === 'pdfkit' && entry.installed) entry.gates.push('Adobe_AFM_permission_and_exact_provenance_need_review');
      if (name.startsWith('@napi-rs/canvas') && entry.installed) entry.gates.push('Skia_ICU_and_embedded_library_notices_need_exact_build_mapping');
      if (entry.provenance.status !== 'public_https') entry.gates.push('distribution_location_unverified_or_omitted');
      const props = { workspace, installation_path: key, installed: String(entry.installed), dependency_kind: entry.dependencyKind,
        optional: String(entry.optional), license_evidence: entry.licenseEvidence, integrity_verification: entry.integrityVerification,
        redistribution_rights_verified: 'false' };
      components.push({ type: 'library', 'bom-ref': ref, name, version: meta.version,
        purl: 'pkg:npm/' + name.split('/').map(encodeURIComponent).join('/') + '@' + encodeURIComponent(meta.version),
        ...(entry.declaredLicense ? { licenses: licenseChoice(entry.declaredLicense) } : {}), hashes: integrity(meta.integrity),
        ...(entry.provenance.url ? { externalReferences: [{ type: 'distribution', url: entry.provenance.url }] } : {}),
        properties: Object.entries(props).map(([key, value]) => ({ name: 'matching:' + key, value })) });
      installations.push(entry);
    }
    for (const key of ordered(Object.keys(lock.packages))) {
      const meta = lock.packages[key], edges = new Set();
      const requests = { ...meta.dependencies, ...meta.optionalDependencies, ...meta.peerDependencies, ...(key === '' ? meta.devDependencies : {}) };
      for (const name of ordered(Object.keys(requests))) {
        const target = resolveEdge(lock.packages, key, name);
        if (target) edges.add(refs.get(target));
        else unresolved.push({ workspace, from: refs.get(key), name, optional: Boolean(meta.optionalDependencies?.[name] || meta.peerDependenciesMeta?.[name]?.optional) });
      }
      dependencies.push({ ref: refs.get(key), dependsOn: ordered(edges) });
    }
  }
  dependencies.find(d => d.ref === 'application:root').dependsOn.push('application:web');
  const count = predicate => installations.filter(predicate).length;
  const summary = { format: 'matching-community-compliance-v1', sourceLockSha256: locks, packageInstallations: installations.length,
    installed: count(e => e.installed), absent: count(e => !e.installed), installedWithoutLicenseMetadata: count(e => e.installed && !e.declaredLicense),
    absentWithoutLicenseMetadata: count(e => !e.installed && !e.declaredLicense), noticeFiles: installations.reduce((n, e) => n + e.notices.length, 0),
    distinctNoticeTexts: artifacts.size, assets: installations.reduce((n, e) => n + e.assets.length, 0),
    unresolvedDependencyEdges: unresolved, scope: 'all_root_and_web_locks_including_dev_and_optional; installed_files_only_for_assets_and_notices',
    automatedInventoryOnly: true, sourceOwnershipVerified: false, redistributionRightsVerified: false, releaseAccepted: false };
  const bom = { bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { tools: [{ vendor: 'Matching Tool Community', name: 'create-compliance-inventory', version: '1' }],
      component: { type: 'application', 'bom-ref': 'application:root', name: 'matching-tool-community', version: 'unreleased' },
      properties: [{ name: 'matching:legal_clearance', value: 'not_granted' }, ...Object.entries(locks).map(([name, value]) => ({ name: 'matching:lock_sha256:' + name, value }))] }, components, dependencies };
  return { bom, report: { ...summary, installations }, summary, artifacts };
}

function externalOutput(folder) {
  if (!isAbsolute(folder)) throw new Error('Output must be an absolute external evidence directory');
  const target = resolve(folder);
  if (within(repo, target)) throw new Error('Full license texts must remain outside the source checkout');
  // Reject symlinks in every existing output ancestor as well as existing output files.
  let cursor = target;
  while (true) { if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Output links are forbidden'); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
  return target;
}
function emit(folder, name, bytes) {
  const file = join(folder, ...parts(name));
  if (!within(folder, file)) throw new Error('Invalid output');
  let cursor = dirname(file);
  while (within(folder, cursor)) { if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Output links are forbidden'); if (cursor === folder) break; cursor = dirname(cursor); }
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error('Unsafe existing output file');
  writeFileSync(file, bytes);
}
function selfTest() {
  let count = 0;
  const test = fn => { fn(); count++; };
  test(() => assert.equal(integrity('sha512-' + Buffer.alloc(64, 42).toString('base64'))[0].content, '2a'.repeat(64)));
  test(() => { for (const path of ['node_modules/../escape', 'node_modules/a/b', 'node_modules/a/../../escape']) assert.throws(() => packageName(path)); });
  test(() => { const url = new URL('https://registry.npmjs.org/a.tgz'); url.username = 'synthetic'; url.password = 'fictional'; assert.throws(() => location(url.href)); });
  test(() => assert.throws(() => location('https://registry.npmjs.org/a.tgz?token=fictional')));
  test(() => assert.deepEqual(location('file:///fictional/private'), { status: 'nonpublic_location_omitted' }));
  test(() => assert.throws(() => integrity('sha512-YQ==')));
  test(() => assert.throws(() => externalOutput(join(repo, 'docs'))));
  test(() => assert.equal(resolveEdge({ 'node_modules/a/node_modules/b': {}, 'node_modules/b': {} }, 'node_modules/a', 'b'), 'node_modules/a/node_modules/b'));
  const fixture = mkdtempSync(join(tmpdir(), 'community-compliance-test-'));
  try {
    for (const subfolder of ['', 'web']) {
      const folder = join(fixture, subfolder); mkdirSync(join(folder, 'node_modules', 'fictional'), { recursive: true });
      writeFileSync(join(folder, 'package-lock.json'), json({ lockfileVersion: 3, packages: { '': { name: 'fixture', dependencies: { fictional: '1.0.0' } }, 'node_modules/fictional': { version: '1.0.0', resolved: 'https://registry.npmjs.org/fictional/-/fictional-1.0.0.tgz' }, 'node_modules/absent': { version: '2.0.0', optional: true } } }));
      writeFileSync(join(folder, 'node_modules', 'fictional', 'package.json'), json({ name: 'fictional', version: '1.0.0', license: 'MIT', author: { email: 'not-exported' } }));
      mkdirSync(join(folder, 'node_modules', 'fictional', 'nested')); writeFileSync(join(folder, 'node_modules', 'fictional', 'nested', 'LICENSE'), 'Fictional test license text.');
    }
    const result = collectCompliance(fixture);
    test(() => assert.equal(result.summary.installed, 2));
    test(() => assert.equal(result.summary.absent, 2));
    test(() => assert.equal(result.artifacts.size, 1));
    test(() => assert.equal(result.report.installations.find(e => e.installed).notices[0].path, 'nested/LICENSE'));
    test(() => assert.equal(json(result.report).includes('not-exported'), false));
    test(() => assert.equal(json(result.report).includes(fixture), false));
    test(() => assert.equal(json(result.report), json(collectCompliance(fixture).report)));
    test(() => assert.equal(result.summary.releaseAccepted, false));
    test(() => { writeFileSync(join(fixture, 'node_modules', 'fictional', 'package.json'), json({ name: 'fictional', version: '9.0.0' })); assert.throws(() => collectCompliance(fixture), /differs/); });
    test(() => { symlinkSync(join(fixture, 'web'), join(fixture, 'linked'), 'junction'); assert.throws(() => plainPath(fixture, 'linked/package-lock.json'), /links/); });
  } finally { rmSync(fixture, { recursive: true, force: true }); }
  console.log(json({ selfTestsPassed: count, releaseAccepted: false }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest();
    else {
      if (process.argv.length !== 4 || process.argv[2] !== '--out') throw new Error('Usage: node scripts/create-compliance-inventory.mjs --out <absolute-external-directory> | --self-test');
      const out = externalOutput(process.argv[3]);
      const result = collectCompliance(repo);
      for (const [name, bytes] of result.artifacts) emit(out, name, bytes);
      emit(out, 'sbom.cyclonedx.json', json(result.bom));
      emit(out, 'compliance-inventory.json', json(result.report));
      emit(out, 'summary.json', json(result.summary));
      const all = { 'sbom.cyclonedx.json': sha(json(result.bom)), 'compliance-inventory.json': sha(json(result.report)), 'summary.json': sha(json(result.summary)),
        ...Object.fromEntries([...result.artifacts].map(([name, bytes]) => [name, sha(bytes)])) };
      emit(out, 'SHA256SUMS', ordered(Object.keys(all)).map(name => all[name] + '  ' + name).join('\n') + '\n');
      console.log(json(result.summary));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : 'Compliance collection failed'); process.exitCode = 1; }
}
