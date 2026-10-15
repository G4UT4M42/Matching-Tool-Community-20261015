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
  })],
  ['222f7ad3b205aefdcf004434fd49525054ba822e39266756d8e2633568bb204c', Object.freeze({
    component: '@img/sharp-wasm32', version: '0.35.5',
    packagePath: 'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.wasm',
    binarySha256: '740521302afc687d45443ce86a9182a6a4ecc8f0dd0cffab70db117764e5efc3',
    upstreamSha256: '22f22b41516f08077500b3472fc1c4ee55f9686cbb90cef361b71f0bee94a440',
    evidencePrefix: 'compliance/wasm-replacement/', kind: 'wasm', magic: '0061736d'
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
/** Exact installed binary/source overlay supplements the unchanged upstream npm inventory. */
export function runtimeOverlay({sourceRevision,applicationVersion,nodeVersion,nodeSha256,replacements}) {
  const properties=[{name:'matching:source_revision',value:sourceRevision},{name:'matching:legal_clearance',value:'false'},{name:'matching:release_accepted',value:'false'},{name:'matching:scope',value:'Exact bundled Node and reviewed replacement binaries. Base npm dependency graph remains in sbom.cyclonedx.json; complete source inventories and nested SBOMs remain hash-bound to replacement manifests.'}];
  const components=[{type:'application','bom-ref':'runtime:node',name:'Node.js',version:nodeVersion,hashes:[{alg:'SHA-256',content:nodeSha256}],properties:[{name:'matching:package_path',value:'runtime/node.exe'},{name:'matching:license_evidence',value:'runtime/LICENSE.node'}]}];
  for(const extra of replacements){
    const manifest=extra.manifest,ref='replacement:'+manifest.binary.sha256;
    components.push({type:'file','bom-ref':ref,name:manifest.component,version:manifest.version,hashes:[{alg:'SHA-256',content:manifest.binary.sha256}],properties:[{name:'matching:package_path',value:manifest.packagePath},{name:'matching:reviewed_manifest',value:extra.descriptor.evidencePrefix+extra.manifestSha256+'/manifest.json'},{name:'matching:reviewed_manifest_sha256',value:extra.manifestSha256},{name:'matching:replaced_upstream_sha256',value:manifest.replacedUpstreamSha256},{name:'matching:historical_binary_reproduced',value:'false'},{name:'matching:source_build_qualified',value:'true'},{name:'matching:legal_clearance',value:'false'}]});
    for(const file of extra.files.filter(file=>/\.(?:tar(?:\.[a-z0-9]+)?|tgz|zip|artifact|archive)$/.test(file.path)||/(?:sbom|inventory|versions|inputs)[^/]*\.json$/i.test(file.path))) components.push({type:'file','bom-ref':ref+':evidence:'+file.packagePath,name:file.packagePath,hashes:[{alg:'SHA-256',content:file.sha256}],properties:[{name:'matching:bytes',value:String(file.bytes)},{name:'matching:purpose',value:'Original source/tool input or detailed component inventory; selected linkage and license declarations are described in the reviewed source manifest and nested inventories.'}]});
  }
  return{bomFormat:'CycloneDX',specVersion:'1.5',version:1,metadata:{component:{type:'application','bom-ref':'application:packaged-community',name:'matching-tool-community',version:applicationVersion},properties},components,dependencies:[{ref:'application:packaged-community',dependsOn:components.filter(component=>component['bom-ref']==='runtime:node'||component['bom-ref'].startsWith('replacement:')&&!component['bom-ref'].includes(':evidence:')).map(component=>component['bom-ref'])}]};
}
const canonicalJson=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
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
  const replacementTargets=new Set(),allReplacementEvidence=new Set(),verifiedReplacements=[];
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
    verifiedReplacements.push({manifest:native,manifestSha256:replacement.manifestSha256,descriptor,files:native.files});
  }
  for (const entry of manifest.files) {
    const bytes = readFileSync(join(root, ...safeParts(entry.path)));
    if (!Number.isSafeInteger(entry.bytes) || bytes.length !== entry.bytes || !/^[a-f0-9]{64}$/.test(entry.sha256) || sha256(bytes) !== entry.sha256) throw new Error('Package file integrity mismatch');
  }
  for (const required of ['LICENSE', 'NOTICE', 'PACKAGING.md', 'package.json', 'package-lock.json', 'runtime/node.exe', 'runtime/LICENSE.node', 'src/server/index.ts', 'node_modules/tsx/dist/cli.mjs', 'web/dist/index.html', 'scripts/Start-Community.ps1', 'scripts/Install-Community.ps1', 'scripts/Upgrade-Community.ps1', 'scripts/Uninstall-Community.ps1', 'scripts/verify-community-package.mjs', 'compliance/sbom.cyclonedx.json', 'compliance/compliance-inventory.json', 'compliance/summary.json', 'compliance/SHA256SUMS', 'compliance/runtime-overlay.cyclonedx.json']) {
    if (!expected.includes(required)) throw new Error('Package missing required runtime or compliance file: ' + required);
  }
  for (const language of ['eng', 'deu']) if (!expected.includes('node_modules/@tesseract.js-data/' + language + '/4.0.0_best_int/' + language + '.traineddata.gz')) throw new Error('Offline OCR language data missing');
  if(!manifest.runtime||!/^22\.\d+\.\d+$/.test(manifest.runtime.node)||manifest.runtime.abi!=='127'||manifest.runtime.platform!=='win32'||manifest.runtime.arch!=='x64')throw new Error('Runtime identity is outside the qualified Windows Node22 ABI127 scope');
  const application=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));if(typeof application.version!=='string'||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(application.version))throw new Error('Application SBOM version missing');
  const overlay=JSON.parse(readFileSync(join(root,'compliance/runtime-overlay.cyclonedx.json'),'utf8'));
  const expectedOverlay=runtimeOverlay({sourceRevision:manifest.sourceRevision,applicationVersion:application.version,nodeVersion:manifest.runtime.node,nodeSha256:manifest.files.find(file=>file.path==='runtime/node.exe').sha256,replacements:verifiedReplacements});
  if(canonicalJson(overlay)!==canonicalJson(expectedOverlay))throw new Error('Runtime SBOM overlay differs from actual binary/source inventory or acceptance claims');
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
