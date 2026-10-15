#!/usr/bin/env node
/** Build an external development candidate; unresolved licensing never becomes release acceptance. */
import {execFileSync} from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageFiles, safeParts, sha256, verifyPackage, reviewedReplacement, checkReplacementIdentity, checkReplacementProof, runtimeOverlay } from './verify-community-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inside = (base, file) => { const path = relative(base, file); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)); };
function absolute(value) { if (!value || !isAbsolute(value)) throw new Error('Use absolute external package/evidence paths'); return resolve(value); }
function noLinks(folder) {
  let cursor = folder;
  while (true) { if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Package/evidence paths cannot traverse links'); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
}
function readJson(file, expectedSha256) { if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).size > 20 * 1024 * 1024) throw new Error('Invalid evidence JSON'); const bytes=readFileSync(file); if(bytes.length>20*1024*1024||(expectedSha256&&sha256(bytes)!==expectedSha256))throw new Error('Evidence JSON checksum or bounds mismatch');return JSON.parse(bytes.toString('utf8')); }
function copyTree(from, to, omitNestedDependencies = false) {
  if (lstatSync(from).isSymbolicLink()) throw new Error('Package sources cannot contain links');
  if (lstatSync(from).isFile()) { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { dereference: false }); return; }
  mkdirSync(to, { recursive: true });
  for (const item of readdirSync(from, { withFileTypes: true })) {
    if (item.name === '.git' || (omitNestedDependencies && item.name === 'node_modules')) continue;
    safeParts(item.name); copyTree(join(from, item.name), join(to, item.name), omitNestedDependencies);
  }
}
export function runtimeClosure(report, bom, manifest, additionalSeeds = []) {
  const byRef = new Map(report.installations.map(e => [e.ref, e]));
  const dependencies = new Map(bom.dependencies.map(e => [e.ref, e.dependsOn]));
  const roots = [...Object.keys(manifest.dependencies ?? {}), 'tsx', ...additionalSeeds];
  const queue = roots.map(name => { const entry=report.installations.find(e => e.workspace === 'root' && e.path === 'node_modules/' + name);if(additionalSeeds.includes(name)&&!entry?.installed)throw new Error('Reviewed replacement seed is not installed in compliance evidence');return entry?.ref; });
  if (queue.some(e => !e)) throw new Error('Required runtime seed missing from evidence');
  const selected = new Set();
  while (queue.length) {
    const ref = queue.shift();
    if (selected.has(ref)) continue;
    const entry = byRef.get(ref);
    if (!entry) throw new Error('Runtime dependency graph references missing evidence');
    if (!entry.installed) { if (entry.optional) continue; throw new Error('Required runtime dependency is not installed'); }
    if (entry.workspace !== 'root') throw new Error('Unexpected cross-workspace runtime dependency');
    selected.add(ref);
    for (const child of dependencies.get(ref) ?? []) queue.push(child);
  }
  const unresolved = report.unresolvedDependencyEdges.filter(edge => selected.has(edge.from) && !edge.optional);
  if (unresolved.length) throw new Error('Runtime dependency graph has unresolved required edges');
  return [...selected].sort().map(ref => byRef.get(ref));
}
/** Unchanged upstream sources/notices remain external to Git and hash-bound to the package. */
export function validateNativeSupplement(folder){
  noLinks(folder);const file=join(folder,'manifest.json');noLinks(file);const manifest=readJson(file);
  if(manifest.format!=='matching-community-supplemental-native-v1'||manifest.noticeWordingModified!==false||manifest.correspondingSourceComplete!==false||manifest.relinkQualificationComplete!==false||manifest.legalClearance!==false||manifest.releaseAccepted!==false||!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>1024)throw new Error('Unsupported native supplement or acceptance claim');
  const destinations=new Set(),sources=new Set();let total=0;
  for(const entry of manifest.files){
    safeParts(entry.path);safeParts(entry.packagePath);
    if(!entry.packagePath.startsWith('compliance/native-source/')&&!entry.packagePath.startsWith('compliance/native-notices/')&&!entry.packagePath.startsWith('compliance/wasm-source/')&&!entry.packagePath.startsWith('compliance/wasm-notices/')&&entry.packagePath!=='node_modules/pdfkit/js/data/MustRead.html')throw new Error('Unreviewed native supplement destination');
    if(destinations.has(entry.packagePath.toLowerCase())||sources.has(entry.path.toLowerCase()))throw new Error('Duplicate native supplement destination or input');destinations.add(entry.packagePath.toLowerCase());sources.add(entry.path.toLowerCase());
    const input=join(folder,...safeParts(entry.path));noLinks(input);const info=lstatSync(input);total+=info.size;
    if(!info.isFile()||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||info.size!==entry.bytes||entry.bytes>256*1024*1024||total>2*1024*1024*1024||!/^[a-f0-9]{64}$/.test(entry.sha256)||sha256(readFileSync(input))!==entry.sha256)throw new Error('Native supplement checksum or bounds mismatch');
  }
  for(const name of ['comparisons.json','retrieval-history.json','SHA256SUMS']){const input=join(folder,name);noLinks(input);if(!lstatSync(input).isFile()||lstatSync(input).size>20*1024*1024)throw new Error('Native supplement evidence missing or oversized');}
  return{root:folder,files:manifest.files,manifestSha256:sha256(readFileSync(file))};
}
/** Admit only fixed independently reviewed source-built replacements before reading payloads. */
export function validateNativeReplacement(folder){
 noLinks(folder);const manifestFile=join(folder,'manifest.json');noLinks(manifestFile);const manifestStat=lstatSync(manifestFile);if(!manifestStat.isFile()||manifestStat.size>20*1024*1024)throw new Error('Invalid replacement manifest');
 const manifestBytes=readFileSync(manifestFile);if(manifestBytes.length>20*1024*1024)throw new Error('Replacement manifest exceeds bounds');const manifestSha256=sha256(manifestBytes);
 const descriptor=reviewedReplacement(manifestSha256),manifest=JSON.parse(manifestBytes.toString('utf8'));
 checkReplacementIdentity(manifest,descriptor);const binaryPath=descriptor.packagePath;
 const installed=readJson(join(root,'node_modules',...manifest.component.split('/'),'package.json'));
 if(installed.name!==manifest.component||installed.version!==manifest.version||manifest.replacedUpstreamSha256!==sha256(readFileSync(join(root,binaryPath))))throw new Error('Replacement is not bound to the installed upstream binary');
 const checked=(entry,maxBytes,allowEmpty=false)=>{safeParts(entry.path);const input=join(folder,...safeParts(entry.path));noLinks(input);const stat=lstatSync(input);if(!stat.isFile()||!Number.isSafeInteger(entry.bytes)||entry.bytes!==stat.size||entry.bytes<(allowEmpty?0:1)||entry.bytes>maxBytes||!/^[a-f0-9]{64}$/.test(entry.sha256)||sha256(readFileSync(input))!==entry.sha256)throw new Error('Replacement file checksum or bounds mismatch');return input;};
 const binary=checked(manifest.binary,128*1024*1024);if(readFileSync(binary).subarray(0,descriptor.magic.length/2).toString('hex')!==descriptor.magic||manifest.binary.sha256===manifest.replacedUpstreamSha256)throw new Error('Replacement must be a distinct qualified binary');
 const sourceNames=new Set([manifest.binary.path.toLowerCase()]),destinations=new Set();let total=manifest.binary.bytes;
 for(const file of manifest.files){safeParts(file.packagePath);if(!file.packagePath.startsWith(descriptor.evidencePrefix)||sourceNames.has(file.path.toLowerCase())||destinations.has(file.packagePath.toLowerCase()))throw new Error('Conflicting or unreviewed replacement source destination');checked(file,512*1024*1024,true);sourceNames.add(file.path.toLowerCase());destinations.add(file.packagePath.toLowerCase());total+=file.bytes;if(total>2*1024*1024*1024)throw new Error('Replacement evidence exceeds package bounds');}
 safeParts(manifest.qualification.path);const proof=manifest.files.find(file=>file.path===manifest.qualification.path);if(!proof||proof.sha256!==manifest.qualification.sha256)throw new Error('Replacement qualification is not included and hash-bound');
 const qualification=readJson(join(folder,...safeParts(proof.path)),proof.sha256);
 checkReplacementProof(qualification,descriptor);
 return{root:folder,manifest,binary,files:manifest.files,manifestSha256,descriptor};
}
export function buildPackage({ out, compliance, supplement, replacement, mode = 'development', node = process.execPath }) {
  out = absolute(out); compliance = absolute(compliance); node = absolute(node);
  noLinks(out); noLinks(compliance); noLinks(node);
  if (inside(root, out) || inside(root, compliance) || inside(compliance, out) || inside(out, compliance) || existsSync(out)) throw new Error('Package output and full legal evidence must be external and independent; output must be new');
  if (process.platform !== 'win32' || process.arch !== 'x64' || !process.versions.node.startsWith('22.') || process.versions.modules !== '127') throw new Error('Build with qualified Windows x64 Node22 ABI127');
  if (resolve(node) !== resolve(process.execPath)) throw new Error('Use the running qualified Node executable; alternate runtime injection is not supported');
  const report = readJson(join(compliance, 'compliance-inventory.json'));
  const bom = readJson(join(compliance, 'sbom.cyclonedx.json'));
  if (report.format !== 'matching-community-compliance-v1') throw new Error('Unsupported compliance evidence');
  for (const [path, hash] of Object.entries(report.sourceLockSha256)) {
    safeParts(path); if (sha256(readFileSync(join(root, ...path.split('/')))) !== hash) throw new Error('Compliance evidence is stale for current lockfiles');
  }
  const manifest = readJson(join(root, 'package.json'));
  const replacementFolders=replacement?(Array.isArray(replacement)?replacement:[replacement]):[];
  if(replacementFolders.length>2)throw new Error('At most two independently reviewed replacements are supported');
  const nativeReplacements=replacementFolders.map(folder=>validateNativeReplacement(absolute(folder)));
  const selected = runtimeClosure(report, bom, manifest, nativeReplacements.map(extra=>extra.manifest.component));
  if (mode !== 'development') throw new Error('Distributable packaging is blocked: ownership, native source/relink and asset provenance obligations remain unresolved. This builder creates development candidates only.');
  for (const line of readFileSync(join(compliance, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line); if (!match) throw new Error('Invalid legal-bundle checksum manifest');
    const file = join(compliance, ...safeParts(match[2])); noLinks(file);
    if (sha256(readFileSync(file)) !== match[1]) throw new Error('Legal-bundle checksum mismatch');
  }
  for (const entry of selected) {
    const folder = join(root, ...safeParts(entry.path)); noLinks(folder);
    if (sha256(readFileSync(join(folder, 'package.json'))) !== entry.manifestSha256) throw new Error('Installed dependency manifest changed after compliance collection');
    for (const notice of entry.notices) {
      const file = join(compliance, ...safeParts(notice.copy)); noLinks(file);
      if (sha256(readFileSync(file)) !== notice.sha256) throw new Error('Runtime notice evidence missing or modified');
    }
    for (const asset of entry.assets) if (sha256(readFileSync(join(folder, ...safeParts(asset.path)))) !== asset.sha256) throw new Error('Runtime asset changed after compliance collection');
  }
  const runtimeLicense = join(dirname(node), 'LICENSE');
  if (!existsSync(runtimeLicense)) throw new Error('Qualified runtime must retain its upstream LICENSE');
  const extras = (supplement?Array.isArray(supplement)?supplement:[supplement]:[]).map(folder=>validateNativeSupplement(absolute(folder)));
  const extraDestinations=new Set();for(const extra of extras)for(const entry of extra.files){const target=entry.packagePath.toLowerCase();if(extraDestinations.has(target))throw new Error('Conflicting source supplement destinations');extraDestinations.add(target);}
  const replacementTargets=new Set();
  for(const extra of nativeReplacements){
    if(inside(extra.root,out)||inside(out,extra.root))throw new Error('Replacement evidence and output must be independent');
    if(replacementTargets.has(extra.manifest.packagePath))throw new Error('Duplicate replacement target');replacementTargets.add(extra.manifest.packagePath);
    for(const file of extra.files){if(extraDestinations.has(file.packagePath.toLowerCase()))throw new Error('Replacement conflicts with source supplement');extraDestinations.add(file.packagePath.toLowerCase());}
  }
  // All validation precedes writing. A failed build leaves its named output for inspection.
  mkdirSync(out, { recursive: false });
  copyTree(join(root, 'src'), join(out, 'src'));
  copyTree(join(root, 'web', 'dist'), join(out, 'web', 'dist'));
  for (const name of ['LICENSE', 'NOTICE', 'package.json', 'package-lock.json']) copyTree(join(root, name), join(out, name));
  copyTree(join(root, 'docs', 'compliance', 'PACKAGING.md'), join(out, 'PACKAGING.md'));
  for (const name of ['Start-Community.ps1', 'Install-Community.ps1', 'Upgrade-Community.ps1', 'Uninstall-Community.ps1', 'verify-community-package.mjs']) copyTree(join(root, 'scripts', name), join(out, 'scripts', name));
  copyTree(node, join(out, 'runtime', 'node.exe')); copyTree(runtimeLicense, join(out, 'runtime', 'LICENSE.node'));
  for (const entry of selected) copyTree(join(root, ...safeParts(entry.path)), join(out, ...safeParts(entry.path)), true);
  for (const name of ['sbom.cyclonedx.json', 'compliance-inventory.json', 'summary.json', 'SHA256SUMS']) copyTree(join(compliance, name), join(out, 'compliance', name));
  const textNames = new Set(report.installations.flatMap(entry => entry.notices.map(notice => notice.copy)));
  for (const name of textNames) copyTree(join(compliance, ...safeParts(name)), join(out, 'compliance', ...safeParts(name)));
  for(const extra of extras){
    for(const entry of extra.files){const target=join(out,...safeParts(entry.packagePath));if(existsSync(target))throw new Error('Supplement destination already exists');copyTree(join(extra.root,...safeParts(entry.path)),target);}
    for(const name of ['manifest.json','comparisons.json','retrieval-history.json','SHA256SUMS'])copyTree(join(extra.root,name),join(out,'compliance/source-evidence',extra.manifestSha256,name));
  }
  for(const extra of nativeReplacements){
    const target=join(out,...safeParts(extra.manifest.packagePath));
    if(!existsSync(target)||sha256(readFileSync(target))!==extra.manifest.replacedUpstreamSha256)throw new Error('Packaged replacement target differs from reviewed upstream');
    copyTree(extra.binary,target);
    for(const file of extra.files){const destination=join(out,...safeParts(file.packagePath));if(existsSync(destination))throw new Error('Replacement evidence destination already exists');copyTree(join(extra.root,...safeParts(file.path)),destination);}
    copyTree(join(extra.root,'manifest.json'),join(out,extra.descriptor.evidencePrefix,extra.manifestSha256,'manifest.json'));
  }
  const gates = selected.flatMap(entry => entry.gates.map(gate => ({ ref: entry.ref, gate })));
  const sourceRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),sourceDirty=!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
  if(!/^[a-f0-9]{40}$/.test(sourceRevision))throw new Error('Package source revision unavailable');
  writeFileSync(join(out,'compliance/runtime-overlay.cyclonedx.json'),JSON.stringify(runtimeOverlay({sourceRevision,applicationVersion:manifest.version,nodeVersion:process.versions.node,nodeSha256:sha256(readFileSync(node)),replacements:nativeReplacements}),null,2)+'\n');
  const packageManifest = { sourceRevision,sourceDirty,format: 'matching-community-package-v1', kind: 'development-candidate', distributable: false, releaseAccepted: false,
    runtime: { node: process.versions.node, abi: process.versions.modules, platform: process.platform, arch: process.arch },
    nativeReplacements:nativeReplacements.map(extra=>({component:extra.manifest.component,manifestPath:extra.descriptor.evidencePrefix+extra.manifestSha256+'/manifest.json',manifestSha256:extra.manifestSha256,binarySha256:extra.manifest.binary.sha256,replacedUpstreamSha256:extra.manifest.replacedUpstreamSha256,sourceBuildQualified:true,legalClearance:false,historicalBinaryReproduced:false,releaseAccepted:false})),
    nativeSupplements:extras.map(extra=>({manifestPath:'compliance/source-evidence/'+extra.manifestSha256+'/manifest.json',manifestSha256:extra.manifestSha256,files:extra.files.length,correspondingSourceComplete:false,relinkQualificationComplete:false,legalClearance:false})),
    sourceLockSha256: report.sourceLockSha256, sourceOwnershipVerified: false, redistributionRightsVerified: false,
    runtimePackages: selected.map(e => e.ref), excludedInstalledRootPackages: report.installations.filter(e => e.workspace === 'root' && e.installed && !selected.some(s => s.ref === e.ref)).map(e => e.ref),
    unresolvedObligations: gates, files: packageFiles(out).map(path => { const bytes = readFileSync(join(out, ...safeParts(path))); return { path, bytes: bytes.length, sha256: sha256(bytes) }; }) };
  writeFileSync(join(out, 'community-package.json'), JSON.stringify(packageManifest, null, 2) + '\n');
  return verifyPackage(out);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) { const name = args.shift(); if (!['--out', '--compliance', '--supplement', '--replacement', '--mode'].includes(name) || !args.length) throw new Error('Usage: node scripts/package-community.mjs --out <new-external-directory> --compliance <external-evidence-directory> [--supplement <external-native-evidence-directory>] [--replacement <external-reviewed-source-bundle>] [--mode development]'); const value=args.shift();if(name==='--supplement'||name==='--replacement')options[name.slice(2)]=[...(options[name.slice(2)]??[]),value];else options[name.slice(2)]=value; }
    console.log(JSON.stringify(buildPackage(options), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Package build failed'); process.exitCode = 1; }
}
