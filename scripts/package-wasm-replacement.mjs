#!/usr/bin/env node
/** Package measured source-build evidence without modifying any installed runtime. */
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const checkout=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(a,b)=>{const p=relative(a,b);return !p||!p.startsWith('..')&&!isAbsolute(p);};
function regular(p){for(let q=resolve(p);;){if(existsSync(q)&&lstatSync(q).isSymbolicLink())throw Error('Linked package storage unsupported');const parent=dirname(q);if(parent===q)break;q=parent;}return p;}
function external(p){if(!p||!isAbsolute(p)||inside(checkout,resolve(p)))throw Error('Use absolute external evidence directories');return regular(resolve(p));}
const args=process.argv.slice(2),o={};for(let i=0;i<args.length;i++){if(args[i]==='--self-test')o.selftest=true;else if(['--out','--evidence','--wasm-supplement','--native-supplement','--installed-root'].includes(args[i])&&args[i+1])o[args[i].slice(2)]=args[++i];else throw Error('Unsupported package argument');}
if(o.selftest){if(sha('abc')!=='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')throw Error('Hash self-test failed');console.log('WASM_REPLACEMENT_PACKAGE_SELF_TEST_PASS');process.exit(0);}
const out=external(o.out),evidence=external(o.evidence),wasm=external(o['wasm-supplement']),native=external(o['native-supplement']),installed=regular(resolve(o['installed-root']??''));
for(const input of[evidence,wasm,native,installed])if(inside(input,out)||inside(out,input))throw Error('Package output must be independent of its inputs');
if(existsSync(out))throw Error('Use a new bundle directory; existing bundles are never overwritten');
const build=join(evidence,'sharp-full-attempt-004'),phase1=join(evidence,'sharp-full-attempt-001'),wrapper=join(evidence,'sharp-attempt-002');
const binaryName='sharp-wasm32-0.35.5.node.wasm',glueName='sharp-wasm32-0.35.5.node.js';
const replacementSha='740521302afc687d45443ce86a9182a6a4ecc8f0dd0cffab70db117764e5efc3',originalSha='22f22b41516f08077500b3472fc1c4ee55f9686cbb90cef361b71f0bee94a440',glueSha='1904293fc3f6b0d2abfec1fce156e43f2c309ee13f79498d4efdf0a931b52e5f';
const json=p=>JSON.parse(readFileSync(regular(p),'utf8'));
const inputBytes=readFileSync(join(build,'full-source-inputs.json'));
if(sha(inputBytes)!=='cbecd9dfd57cc209373d65738ffcebaff1202aea0b9a125091e3f8a887e05302')throw Error('Unreviewed source-input catalog');
const inputs=JSON.parse(inputBytes).inputs,result=json(join(build,'result.json')),linux=json(join(build,'functional-validation.json')),host=json(join(build,'host-functional-validation.json')),extra=json(join(build,'extended-codec-functional.json')),closure=json(join(build,'static-closure-review.json')),runtime=json(join(evidence,'runtime-source-comparison-reviewed.json'));
if(!result.passed||!result.installedWasmUnchanged||!linux.passed||!linux.localRebuiltBindingSelected||!host.passed||host.node!=='v22.23.3'||!extra.passed||!extra.svgExactPixels||!extra.p3ProfileTransform||!closure.passed||closure.checkedSourceBuiltArchives!==28||closure.publisherStaticArchiveSelected!==false||!runtime.passed||!runtime.suppliedRuntimeSourceMatched)throw Error('Required measured qualification is missing');
for(const key of['pngExactPixels','jpeg','webp','svg'])if(linux[key]!==true||host[key]!==true)throw Error('Missing measured codec check');
for(const format of['tiff','gif','avif']){const measured=extra.formats.find(x=>x.format===format);if(!measured||measured.width!==8||measured.height!==6||measured.maxPixelDifference>3)throw Error('Missing extended codec check');}
const installedBinary=join(installed,'@img','sharp-wasm32','lib',binaryName),installedGlue=join(installed,'@img','sharp-wasm32','lib',glueName);
if(sha(readFileSync(installedBinary))!==originalSha||sha(readFileSync(join(build,'rebuilt',binaryName)))!==replacementSha||sha(readFileSync(installedGlue))!==glueSha||sha(readFileSync(join(build,'rebuilt',glueName)))!==glueSha)throw Error('Runtime or installed glue does not match the reviewed artifacts');
const versions=json(join(build,'full-library-versions.json')),installedVersions=json(join(installed,'@img','sharp-wasm32','versions.json'));
const ordered=x=>Object.entries(x).sort(([a],[b])=>a.localeCompare(b));if(JSON.stringify(ordered(versions))!==JSON.stringify(ordered(installedVersions))||Object.keys(versions).length!==19)throw Error('Component version mismatch');
mkdirSync(out,{recursive:true});let total=0;const files=[];
function safe(p){if(typeof p!=='string'||p.includes('\\')||!p||p.startsWith('/')||p.split('/').some(x=>!x||x==='.'||x==='..'||x.includes(':')||x.includes('\0')))throw Error('Invalid portable package path');return p;}
function put(path,bytes,packageFile=true){safe(path);if(bytes.length>512*1024*1024||total+bytes.length>2*1024*1024*1024)throw Error('Replacement material exceeds the reviewed bounds');const p=join(out,...path.split('/'));mkdirSync(dirname(p),{recursive:true});writeFileSync(p,bytes,{flag:'wx'});total+=bytes.length;const item={path,bytes:bytes.length,sha256:sha(bytes)};if(packageFile)files.push({...item,packagePath:'compliance/wasm-replacement/'+path});return item;}
function copy(root,path,destination=path,expected){safe(path);const p=regular(join(root,...path.split('/')));if(!lstatSync(p).isFile())throw Error('Non-file source');const bytes=readFileSync(p);if(expected&&(sha(bytes)!==expected.sha256||expected.bytes!==undefined&&bytes.length!==expected.bytes))throw Error('Source evidence hash mismatch: '+path);return put(destination,bytes);}
for(const input of inputs){const source=input.bundle==='native'?native:input.bundle==='wasm'?wasm:null;if(!source)throw Error('Unknown source bundle');copy(source,input.path,'source/'+input.bundle+'/'+input.path,input);}
copy(native,'sources/sharp-source.archive','source/native/sources/sharp-source.archive',{sha256:'d600bcbdd550ea096a384391a474907e6aa8138f97ea472bf5228b07ae75f779'});
copy(wasm,'link-inputs/sharp-libvips-dev-wasm32-1.3.4.tgz','vendor/publisher-staticdev-bootstrap.tgz',{sha256:'23f797d1d182d6e768eff78f69baa6abecbb224119f3c3f93f8e43a24b01b445'});
for(const[root,namespace]of[[native,'native'],[wasm,'wasm']])for(const item of json(join(root,'manifest.json')).files.filter(x=>x.path.startsWith('notices/')))copy(root,item.path,'notices/'+namespace+'/'+item.path.slice(8),item);
copy(installed,'@img/sharp-wasm32/LICENSE','notices/installed-sharp-wasm32-LICENSE.txt');
for(const[source,path,destination]of[
 [wrapper,'sharp-frozen-build-inputs.tar.gz','vendor/sharp-frozen-build-inputs.tar.gz'],
 [phase1,'cargo-frozen-inputs.tar.gz','vendor/cargo-frozen-inputs.tar.gz'],
 [phase1,'new-frozen-source-inputs.tar.gz','vendor/new-frozen-source-inputs.tar.gz'],
 [build,'full-source-static-libraries.tar.gz','link/source-built-static-libraries.tar.gz'],
 [build,'sharp-link-objects.tar.gz','link/sharp-link-objects.tar.gz'],
 [build,'sharp-link.map','qualification/sharp-link.map'],[build,'sharp-why-extract.tsv','qualification/sharp-why-extract.tsv'],
 [build,'source-built-archive-SHA256SUMS','qualification/source-built-archive-SHA256SUMS'],
 [build,'static-closure-review.json','qualification/static-closure-review.json'],
 [build,'full-source-inputs.json','metadata/full-source-inputs.json'],[build,'full-library-versions.json','metadata/versions.json'],
 [build,'functional-validation.json','qualification/linux-functional.json'],[build,'host-functional-validation.json','qualification/windows-node22-functional.json'],
 [build,'extended-codec-functional.json','qualification/extended-codec-functional.json'],
 [evidence,'runtime-source-comparison-reviewed.json','qualification/runtime-source-comparison.json'],
 [evidence,'compare-runtime-source-reviewed.py','recipes/compare-runtime-source.py'],[evidence,'inspect-static-closure.py','recipes/inspect-static-closure.py'],[evidence,'validate-extended-codecs.cjs','recipes/validate-extended-codecs.cjs'],
 [wrapper,'package-lock.json','metadata/npm-package-lock.json'],[wrapper,'frozen-package.json','metadata/frozen-package.json'],[wrapper,'npm-dependency-tree.json','metadata/npm-dependency-tree.json'],
 [phase1,'full-toolchain-packages.txt','metadata/full-toolchain-packages.txt'],[phase1,'rustc-version.txt','metadata/rustc-version.txt'],[phase1,'cargo-version.txt','metadata/cargo-version.txt'],[phase1,'full-compiler-version.txt','metadata/compiler-version.txt'],
 [phase1,'new-source-SHA256SUMS','metadata/frozen-source-SHA256SUMS'],[phase1,'new-source-urls.txt','metadata/frozen-source-urls.txt'],
 [build,'build-full-source.sh','recipes/build-full-source.sh'],[build,'build-sharp-wrapper.sh','recipes/build-sharp-wrapper.sh'],
 [phase1,'original-wasm-vips-build.sh','recipes/upstream-wasm-vips-build.sh'],
 [checkout,'scripts/qualify-wasm-rebuild.mjs','recipes/qualify-wasm-rebuild.mjs'],[checkout,'scripts/package-wasm-replacement.mjs','recipes/package-wasm-replacement.mjs'],
 [checkout,'docs/compliance/WASM_REBUILD_QUALIFICATION.md','metadata/WASM_REBUILD_QUALIFICATION.md'],
 [evidence,'portable-tools/meson-1.9.1-py3-none-any.whl','tools/meson-1.9.1-py3-none-any.whl'],
 [wasm,'evidence/wasm-rust-nightly-channel.json-or-text','tools/rust-nightly-channel.toml'],
 ])copy(source,path,destination);
for(let n=1;n<=4;n++){const source=join(evidence,'sharp-full-attempt-'+String(n).padStart(3,'0'));for(const name of['result.json','full-library-build.stdout.txt','full-library-build.stderr.txt','compile.stdout.txt','compile.stderr.txt','build-full-source.sh'])if(existsSync(join(source,name)))copy(source,name,'qualification/history/attempt-'+n+'/'+name);}
const binary=put('replacement/'+binaryName,readFileSync(join(build,'rebuilt',binaryName)),false);
put('recipes/prepare-portable-toolchain.sh',Buffer.from(String.raw`set -euo pipefail
export DEBIAN_FRONTEND=noninteractive MAKEFLAGS=-j2 EMCC_CORES=2 BINARYEN_CORES=2
apt-get update
python3 - <<'PY' > /tmp/selected-tools.txt
from pathlib import Path
versions={line.split()[0].split(':')[0]:line.split()[1] for line in Path('/metadata/full-toolchain-packages.txt').read_text().splitlines()}
for name in ['build-essential','libglib2.0-dev','pkgconf','ninja-build','python3-pip','python3-venv','autoconf','automake','libtool','gettext','bzip2','unzip']:
 print(name+'='+versions[name])
PY
apt-get install -y --no-install-recommends $(cat /tmp/selected-tools.txt)
python3 -m venv /opt/meson
/opt/meson/bin/pip install --no-index /tools/meson-1.9.1-py3-none-any.whl
mkdir -p /work/sharp /work/wasm-vips /frozen /opt/cargo
tar -xf /vendor/sharp-frozen-build-inputs.tar.gz -C /work/sharp
tar -xf /inputs/sources/wasm-vips-inferred-source.archive --strip-components=1 -C /work/wasm-vips
tar -xf /vendor/new-frozen-source-inputs.tar.gz -C /frozen
tar -xf /vendor/cargo-frozen-inputs.tar.gz -C /opt/cargo
cd /frozen
sha256sum -c /metadata/frozen-source-SHA256SUMS
patch -p1 -d /emsdk/upstream/emscripten < /inputs/evidence/wasm-emscripten-observed-patches.json-or-text
emcc --clear-cache
embuilder build sysroot --force
curl --fail --show-error --location --proto '=https' --tlsv1.2 https://static.rust-lang.org/dist/2026-09-26/channel-rust-nightly.toml -o /tmp/rust-channel.toml
cmp /tmp/rust-channel.toml /tools/rust-nightly-channel.toml
export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
chmod +x /frozen/rustup-init
/frozen/rustup-init -y --no-modify-path --profile minimal --target wasm32-unknown-emscripten --default-toolchain nightly-2026-09-26 --component rust-src
`));
put('metadata/toolchain.json',Buffer.from(JSON.stringify({publicBaseImage:'emscripten/emsdk@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65',frozenPreparedImage:'sha256:cc5147caac32486d592c671368e6221be4811c5c65097f3f6b9a8123e91a321d',frozenPreparedImagePubliclyHosted:false,buildImage:result.image,rustSourceCommit:'5ceaf6608eb354c2f5bbb3b8d974caa367dac81c',compilerBootstrapRebuiltFromSource:false,linkedRuntimeSourceCompared:true,compilerSourceReference:'https://github.com/emscripten-core/emscripten/tree/d6c521a7f05449857c76bd99e396895583cf2083',cpus:2,makeJobs:2,ninjaJobs:2,buildNetwork:'none'},null,2)));
put('metadata/glue-compatibility.json',Buffer.from(JSON.stringify({passed:true,installedGlueSha256:glueSha,rebuiltGlueSha256:glueSha,byteIdentical:true,binaryOnlyReplacementQualified:true},null,2)));
const qualification=put('qualification/qualification.json',Buffer.from(JSON.stringify({format:'matching-community-native-replacement-qualification-v1',result:'PASS',binarySha256:replacementSha,fullLibrarySourceRebuild:true,checks:{wasm_load:true,png:true,jpeg:true,webp:true,svg:true,tiff:true,gif:true,avif:true,icc:true},sourceBuiltStaticArchives:28,linkedSourceArchives:25,sourceArchiveCopiesVerified:true,installedGlueByteIdentical:true,linkedRuntimeSourceCompared:true,componentVersionsMatched:19,ultraHdrGainMapRuntimeTested:false,syntheticOnly:true,legalClearance:false,releaseAccepted:false,historicalBinaryReproduced:false},null,2)));
put('README.txt',Buffer.from(`This is a newly frozen full-source sharp WASM replacement qualification. No installed runtime was changed. The new binary is not byte-identical to the publisher binary. All nine declared checks passed on Windows Node 22.23.3 with byte-identical installed JavaScript glue. Source/library/runtime inputs, original notices, frozen vendors, exact compiler image/source identifiers, link maps, archive equality and measured proofs are supplied. The owner-only multi-GB Docker image export is intentionally outside this portable bundle.

The public compiler base is emscripten/emsdk@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65. Docker can pull that immutable public OCI reference. The prepared and source-stage cache images in metadata are owner-local, not public registry promises. The compiler bootstrap itself was not rebuilt; exact supplied source for linked Emscripten runtimes and Rust standard libraries was compared to the actual image. The seven excluded editor/git-ignore metadata files remain in the original source archive.

Rebuild stages use isolated containers, at most two CPUs and two Make/Ninja jobs. Prepare external standard tools with network access, then compile without network. Mount source/native at /native and source/wasm at /inputs (read only); mount vendor at /vendor, tools at /tools and metadata at /metadata (read only). Run recipes/prepare-portable-toolchain.sh with those mounts in the digest-pinned base image. It uses supplied frozen npm and Cargo inputs, supplied Meson wheel, exact captured patches, pinned apt tool versions and the checksum-bound Rust nightly channel. Preserve its logs and commit the prepared container to an immutable local image. No source-library or Rust crate downloads are required during compilation.

Create a fresh external output directory and copy recipes/build-sharp-wrapper.sh into it. Run recipes/build-full-source.sh in a new container from the prepared image with the same read-only source mounts and that output mounted at /evidence, using --network=none --cpus=2 --memory=6g --pids-limit=256. Copy the build script into the output too, or mount the recipes directory read only and invoke it there. The script restores only the supplier's two JavaScript path resolvers; every linked native library is source-built. Compile logs, configuration, source archive equality, WASM and JS glue are emitted externally. On Windows Node22, run recipes/validate-extended-codecs.cjs with the output directory and a read-only sharp0.35.5 node_modules directory. The main qualification helper contains the PNG/JPEG/WebP/SVG load harness. The capture-specific closure-review helpers document paths in the original frozen image; adapt their evidence argument paths when rerunning elsewhere.

qualification/history preserves the actual successful source-stage cache chain and genuine repaired failures. A cold build uses a new source working-directory name; byte determinism of a separate cold rebuild is not asserted. The qualified shipped binary and each actual source-built archive are bound by hashes. Recipients may modify/recompile/relink the supplied sources and verify functionality. This is engineering evidence, not legal advice or a grant of rights.

Original source archives and notice text remain unchanged. Notice collections also cover unused supplier/build inputs; the actual link map identifies selected code. Full original notices remain inside frozen source/vendor archives as well. UltraHDR was built and linked; a gain-map runtime fixture was not tested. This material does not grant legal clearance or release acceptance.
`));
files.sort((a,b)=>a.path.localeCompare(b.path));const manifest={format:'matching-community-native-replacement-v1',component:'@img/sharp-wasm32',version:'0.35.5',packagePath:'node_modules/@img/sharp-wasm32/lib/'+binaryName,binary,replacedUpstreamSha256:originalSha,sourceBuildQualified:true,legalClearance:false,releaseAccepted:false,historicalBinaryReproduced:false,qualification:{path:qualification.path,sha256:qualification.sha256},files};
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');writeFileSync(join(out,'manifest.json'),bytes,{flag:'wx'});console.log(JSON.stringify({passed:true,manifestSha256:sha(bytes),qualificationSha256:qualification.sha256,binarySha256:binary.sha256,binaryBytes:binary.bytes,fileCount:files.length,totalBytes:total,legalClearance:false,releaseAccepted:false}));
