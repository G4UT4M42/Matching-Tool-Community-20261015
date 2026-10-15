#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** Fixed source-reviewed binaries. This verifier stays self-contained for installer bootstrap hashing. */
const reviewedReplacements = new Map([
  ['907cdd47091358e832c3765610ee61da12145635917655f5b7b23022395a3b58', Object.freeze({
    component: '@napi-rs/canvas-win32-x64-msvc', version: '0.1.97',
    packagePath: 'node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node',
    binarySha256: '0ea4e2558a21542e4364537cfbf06f3cc950f009cd9e740d159ca9edae250209',
    upstreamSha256: '2f73f296e1aacec88e4600d97182d8cf13cfbfe8a0e5c27c6e60b7b33918158d',
    evidencePrefix: 'compliance/native-replacement/', kind: 'canvas', magic: '4d5a'
  })]
]);
export function reviewedReplacement(manifestSha256) {
  const descriptor = reviewedReplacements.get(manifestSha256);
  if (!descriptor) throw new Error('Native replacement has not passed independent source review');
  return descriptor;
}
export function checkReplacementIdentity(native, descriptor) {
  if (native.format !== 'matching-community-native-replacement-v1' || native.component !== descriptor.component || native.version !== descriptor.version || native.packagePath !== descriptor.packagePath || native.binary?.sha256 !== descriptor.binarySha256 || native.replacedUpstreamSha256 !== descriptor.upstreamSha256 || native.sourceBuildQualified !== true || native.legalClearance !== false || native.releaseAccepted !== false || native.historicalBinaryReproduced !== false || !Array.isArray(native.files) || native.files.length < 3 || native.files.length > 4096) throw new Error('Invalid replacement engineering identity or legal claim');
}
export function checkReplacementProof(qualification, descriptor) {
  const checks = descriptor.kind === 'canvas' ? ['native_load','png','jpeg','webp','font','pdf_render','offline_ocr'] : ['wasm_load','png','jpeg','webp','svg','tiff','gif','avif','icc'];
  if (qualification.result !== 'PASS' || qualification.binarySha256 !== descriptor.binarySha256 || checks.some(key => qualification.checks?.[key] !== true)) throw new Error('Replacement functional/source qualification missing');
  if (descriptor.kind === 'canvas' && (qualification.sourceSkiaRebuilt !== true || qualification.offlineOcr?.expected !== 'COMMUNITY 12345' || qualification.offlineOcr?.observed !== 'COMMUNITY 12345')) throw new Error('Replacement canvas source/OCR qualification missing');
  if (descriptor.kind === 'wasm' && qualification.fullLibrarySourceRebuild !== true) throw new Error('Replacement full library source qualification missing');
}
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
  // Approve exact replacement descriptors/manifests before reading arbitrary package payloads.
  if(manifest.nativeReplacements&&!Array.isArray(manifest.nativeReplacements))throw new Error('Invalid native replacements');
  if((manifest.nativeReplacements??[]).length>2)throw new Error('At most two independently reviewed replacements are supported');
  const replacementTargets=new Set(),allReplacementEvidence=new Set();
  for(const replacement of manifest.nativeReplacements??[]){
    const descriptor=reviewedReplacement(replacement.manifestSha256);
    if(Object.keys(replacement).some(key=>!['component','manifestPath','manifestSha256','binarySha256','replacedUpstreamSha256','sourceBuildQualified','legalClearance','historicalBinaryReproduced','releaseAccepted'].includes(key))||replacement.component!==descriptor.component||replacement.binarySha256!==descriptor.binarySha256||replacement.replacedUpstreamSha256!==descriptor.upstreamSha256||replacement.releaseAccepted!==false||replacement.legalClearance!==false||replacement.sourceBuildQualified!==true||replacement.historicalBinaryReproduced!==false)throw new Error('Native replacement lacks independent review or contradicts its acceptance claim');
    if(replacementTargets.has(descriptor.packagePath))throw new Error('Duplicate replacement target');replacementTargets.add(descriptor.packagePath);
    if(replacement.manifestPath!==descriptor.evidencePrefix+replacement.manifestSha256+'/manifest.json'||!expected.includes(replacement.manifestPath))throw new Error('Replacement manifest is not bound to package');
    const nativeFile=join(root,replacement.manifestPath);if(lstatSync(nativeFile).size>20*1024*1024)throw new Error('Replacement manifest exceeds bounds');const nativeBytes=readFileSync(nativeFile);if(nativeBytes.length>20*1024*1024||sha256(nativeBytes)!==replacement.manifestSha256)throw new Error('Replacement manifest checksum or bounds mismatch');const native=JSON.parse(nativeBytes.toString('utf8'));checkReplacementIdentity(native,descriptor);
    const binary=manifest.files.find(file=>file.path===descriptor.packagePath);if(!binary||binary.sha256!==descriptor.binarySha256||binary.bytes!==native.binary.bytes)throw new Error('Packaged replacement binary differs from qualification');
    const evidencePaths=new Set();
    for(const file of native.files){safeParts(file.packagePath);if(!file.packagePath.startsWith(descriptor.evidencePrefix)||evidencePaths.has(file.packagePath.toLowerCase())||allReplacementEvidence.has(file.packagePath.toLowerCase()))throw new Error('Invalid replacement evidence path');evidencePaths.add(file.packagePath.toLowerCase());allReplacementEvidence.add(file.packagePath.toLowerCase());const stored=manifest.files.find(entry=>entry.path===file.packagePath);if(!stored||stored.sha256!==file.sha256||stored.bytes!==file.bytes)throw new Error('Replacement source or notice differs from evidence');}
    const proof=native.files.find(file=>file.path===native.qualification.path);if(!proof||proof.sha256!==native.qualification.sha256)throw new Error('Packaged replacement qualification is missing');
    const proofFile=join(root,proof.packagePath);if(lstatSync(proofFile).size>20*1024*1024)throw new Error('Replacement proof exceeds bounds');const proofBytes=readFileSync(proofFile);if(proofBytes.length>20*1024*1024||sha256(proofBytes)!==proof.sha256)throw new Error('Replacement proof checksum or bounds mismatch');checkReplacementProof(JSON.parse(proofBytes.toString('utf8')),descriptor);
  }
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
  return { ok: true, files: observed.length, runtimePackages: manifest.runtimePackages.length, distributable: false, releaseAccepted: false, manifestSha256: manifestDigest };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) throw new Error('Specify an absolute package directory'); console.log(JSON.stringify(verifyPackage(process.argv[2]), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Package verification failed'); process.exitCode = 1; }
}
