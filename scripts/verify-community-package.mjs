#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function safeParts(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes(':') || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe package path');
  return path.split('/');
}
export function packageFiles(root, prefix = '') {
  const files = [];
  for (const entry of readdirSync(join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    safeParts(path);
    const stat = lstatSync(join(root, ...safeParts(path)));
    if (stat.isSymbolicLink()) throw new Error('Package links are forbidden');
    if (stat.isDirectory()) files.push(...packageFiles(root, path));
    else if (stat.isFile()) files.push(path);
    else throw new Error('Unsupported package file');
  }
  return files;
}
export function verifyPackage(folder) {
  const root = resolve(folder);
  if (lstatSync(root).isSymbolicLink()) throw new Error('Package root cannot be a link');
  const file = join(root, 'community-package.json');
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Package manifest must be regular');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.format !== 'matching-community-package-v1' || manifest.kind !== 'development-candidate' || manifest.distributable !== false || manifest.releaseAccepted !== false || !Array.isArray(manifest.files)) throw new Error('Unsupported package or unsupported acceptance claim');
  if(!/^[a-f0-9]{40}$/.test(manifest.sourceRevision)||typeof manifest.sourceDirty!=='boolean')throw new Error('Package source revision or dirty-state evidence missing');
  const manifestDigest = sha256(readFileSync(file));
  const observed = packageFiles(root).filter(p => {
    if (p === 'community-package.json') return false;
    if (p === '.community-install.json') {
      const marker = JSON.parse(readFileSync(join(root, p), 'utf8').replace(/^\uFEFF/, ''));
      if (marker.format !== 'matching-community-install-v1' || marker.packageManifestSha256 !== manifestDigest || marker.distributable !== false || marker.releaseAccepted !== false) throw new Error('Installation marker is not bound to this package');
      return false;
    }
    return true;
  });
  const expected = manifest.files.map(entry => entry.path);
  if (expected.length !== new Set(expected).size || JSON.stringify([...expected].sort()) !== JSON.stringify([...observed].sort())) throw new Error('Package manifest does not cover exact file set');
  for (const entry of manifest.files) {
    const bytes = readFileSync(join(root, ...safeParts(entry.path)));
    if (!Number.isSafeInteger(entry.bytes) || bytes.length !== entry.bytes || !/^[a-f0-9]{64}$/.test(entry.sha256) || sha256(bytes) !== entry.sha256) throw new Error('Package file integrity mismatch');
  }
  for (const required of ['LICENSE', 'NOTICE', 'PACKAGING.md', 'package.json', 'package-lock.json', 'runtime/node.exe', 'runtime/LICENSE.node', 'src/server/index.ts', 'node_modules/tsx/dist/cli.mjs', 'web/dist/index.html', 'scripts/Start-Community.ps1', 'scripts/Install-Community.ps1', 'scripts/Upgrade-Community.ps1', 'scripts/Uninstall-Community.ps1', 'scripts/verify-community-package.mjs', 'compliance/sbom.cyclonedx.json', 'compliance/compliance-inventory.json', 'compliance/summary.json', 'compliance/SHA256SUMS']) {
    if (!expected.includes(required)) throw new Error('Package missing required runtime or compliance file: ' + required);
  }
  for (const language of ['eng', 'deu']) if (!expected.includes('node_modules/@tesseract.js-data/' + language + '/4.0.0_best_int/' + language + '.traineddata.gz')) throw new Error('Offline OCR language data missing');
  const report = JSON.parse(readFileSync(join(root, 'compliance/compliance-inventory.json'), 'utf8'));
  if (report.releaseAccepted !== false || report.redistributionRightsVerified !== false) throw new Error('Development evidence cannot claim legal clearance');
  if (sha256(readFileSync(join(root, 'package-lock.json'))) !== report.sourceLockSha256['package-lock.json']) throw new Error('Packaged lock and compliance evidence differ');
  const notices = new Set(manifest.runtimePackages.flatMap(ref => {
    const entry = report.installations.find(item => item.ref === ref);
    if (!entry?.installed) throw new Error('Runtime package is not backed by installed evidence');
    return entry.notices.map(notice => notice.copy);
  }));
  for (const path of notices) if (!expected.includes('compliance/' + path)) throw new Error('Runtime legal-text evidence missing');
  if(manifest.nativeSupplements&&!Array.isArray(manifest.nativeSupplements))throw new Error('Invalid source supplements');
  for(const supplement of manifest.nativeSupplements??[]){
    const nativePath=supplement.manifestPath;safeParts(nativePath);if(!nativePath.startsWith('compliance/source-evidence/'))throw new Error('Invalid source evidence path');if(!expected.includes(nativePath)||sha256(readFileSync(join(root,nativePath)))!==supplement.manifestSha256)throw new Error('Native supplement manifest not bound to package');
    const native=JSON.parse(readFileSync(join(root,nativePath),'utf8'));
    if(native.format!=='matching-community-supplemental-native-v1'||native.releaseAccepted!==false||native.legalClearance!==false||native.correspondingSourceComplete!==false||native.relinkQualificationComplete!==false||native.files.length!==supplement.files)throw new Error('Invalid native supplement claim');
    for(const entry of native.files){const stored=manifest.files.find(file=>file.path===entry.packagePath);if(!stored||stored.sha256!==entry.sha256||stored.bytes!==entry.bytes)throw new Error('Packaged native source or notice differs from evidence');}
  }
  if(manifest.nativeReplacements&&!Array.isArray(manifest.nativeReplacements))throw new Error('Invalid native replacements');
  if((manifest.nativeReplacements??[]).length>1)throw new Error('Only one reviewed canvas replacement is supported');
  for(const replacement of manifest.nativeReplacements??[]){
    if(Object.keys(replacement).some(key=>!['component','manifestPath','manifestSha256','binarySha256','replacedUpstreamSha256','sourceBuildQualified','legalClearance','historicalBinaryReproduced','releaseAccepted'].includes(key))||replacement.component!=='@napi-rs/canvas-win32-x64-msvc'||replacement.releaseAccepted!==false||replacement.manifestSha256!=='5d791594cb4ed6dba342c85522b928a53cad3151f2d47cc83acb09ecb89052b4'||replacement.binarySha256!=='e113eda0affe2217592fcf3ce690ab6c780e52904d3546ae8be15f6cbc3ca065')throw new Error('Native replacement lacks independent review or contradicts its acceptance claim');
    safeParts(replacement.manifestPath);if(!replacement.manifestPath.startsWith('compliance/native-replacement/')||!expected.includes(replacement.manifestPath)||sha256(readFileSync(join(root,replacement.manifestPath)))!==replacement.manifestSha256)throw new Error('Replacement manifest is not bound to package');
    const native=JSON.parse(readFileSync(join(root,replacement.manifestPath),'utf8'));
    if(native.format!=='matching-community-native-replacement-v1'||native.component!=='@napi-rs/canvas-win32-x64-msvc'||native.version!=='0.1.97'||native.packagePath!=='node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node'||native.sourceBuildQualified!==true||native.legalClearance!==false||native.releaseAccepted!==false||native.historicalBinaryReproduced!==false||replacement.legalClearance!==false||replacement.sourceBuildQualified!==true||replacement.historicalBinaryReproduced!==false||native.binary.sha256!==replacement.binarySha256||native.replacedUpstreamSha256!==replacement.replacedUpstreamSha256||!Array.isArray(native.files))throw new Error('Invalid replacement engineering or legal claim');
    const binary=manifest.files.find(file=>file.path===native.packagePath);if(!binary||binary.sha256!==native.binary.sha256||binary.bytes!==native.binary.bytes)throw new Error('Packaged replacement binary differs from qualification');
    for(const file of native.files){safeParts(file.packagePath);if(!file.packagePath.startsWith('compliance/native-replacement/'))throw new Error('Invalid replacement evidence path');const stored=manifest.files.find(entry=>entry.path===file.packagePath);if(!stored||stored.sha256!==file.sha256||stored.bytes!==file.bytes)throw new Error('Replacement source or notice differs from evidence');}
    const proof=native.files.find(file=>file.path===native.qualification.path);if(!proof||proof.sha256!==native.qualification.sha256)throw new Error('Packaged replacement qualification is missing');
    const qualification=JSON.parse(readFileSync(join(root,proof.packagePath),'utf8'));
    if(qualification.result!=='PASS'||qualification.binarySha256!==binary.sha256||qualification.sourceSkiaRebuilt!==true||qualification.offlineOcr?.expected!=='COMMUNITY 12345'||qualification.offlineOcr?.observed!=='COMMUNITY 12345'||['native_load','png','jpeg','webp','font','pdf_render','offline_ocr'].some(key=>qualification.checks?.[key]!==true))throw new Error('Packaged replacement functional proof invalid');
  }
  return { ok: true, files: observed.length, runtimePackages: manifest.runtimePackages.length, distributable: false, releaseAccepted: false, manifestSha256: manifestDigest };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) throw new Error('Specify an absolute package directory'); console.log(JSON.stringify(verifyPackage(process.argv[2]), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Package verification failed'); process.exitCode = 1; }
}
