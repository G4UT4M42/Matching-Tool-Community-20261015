#!/usr/bin/env node
/** Isolated engineering qualification. Never replaces an installed runtime. */
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const checkout=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const baseImage='emscripten/emsdk@sha256:a73e14e25eac4d15d094a9688438ba0ea84e79867ab42365e14abec3a36635bf';
const pins={
 'sources/xmllint-source.archive':'3f5e23386d4fd6d1a9c1727796a3ada36a42e8d2471e450213e9ffdf1824f378',
 'sources/xmllint-libxml-source.archive':'91c8519c7c4c69d2d0b8462494c4066b3a97af0ac2ce225bddc196236fe42ef9',
 'sources/emscripten-4-source.archive':'2013bcdd6793073d8bf68b65585b46c507430eb79e47f0f69a05879d22ac2ec8',
};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(parent,child)=>{const path=relative(parent,child);return !path||!path.startsWith('..')&&!isAbsolute(path);};
function regular(path){let current=resolve(path);for(;;){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error('Linked qualification storage is unsupported');const parent=dirname(current);if(parent===current)break;current=parent;}return path;}
function external(path){if(!isAbsolute(path)||inside(checkout,resolve(path)))throw Error('Use an absolute output directory outside the checkout');return regular(resolve(path));}
const args=process.argv.slice(2),options={};
for(let index=0;index<args.length;index++){const arg=args[index];if(arg==='--self-test'||arg==='--resume')options[arg.slice(2)]=true;else if(['--out','--supplement','--installed-root','--target','--native-supplement','--full-cache-from'].includes(arg)&&args[index+1])options[arg.slice(2)]=args[++index];else throw Error('Unsupported qualification argument');}
if(options['self-test']){if(hash('abc')!=='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')throw Error('Hash self-test failed');if(!inside(checkout,join(checkout,'scripts'))||inside(checkout,dirname(checkout)))throw Error('Boundary self-test failed');console.log('WASM_REBUILD_SELF_TEST_PASS');process.exit(0);}
if(!options.out||!options.supplement||!options['installed-root'])throw Error('Required: --out <new absolute directory> --supplement <bundle> --installed-root <node_modules> [--resume]');
const root=external(options.out),supplement=external(options.supplement),installed=regular(resolve(options['installed-root']));
if(options.target!==undefined&&!['xmllint','sharp','sharp-full'].includes(options.target))throw Error('Unsupported qualification target');
if(inside(root,supplement)||inside(supplement,root)||inside(root,installed)||inside(installed,root))throw Error('Build output must be independent of source and installed inputs');
if(existsSync(root)&&!options.resume)throw Error('Existing evidence requires explicit --resume; every attempt remains separate');
if(!existsSync(root))mkdirSync(root,{recursive:true});
const marker=join(root,'qualification-root.json');
if(existsSync(marker)){if(JSON.parse(readFileSync(marker,'utf8')).format!=='matching-wasm-rebuild-v1')throw Error('Unrecognized qualification output');}else writeFileSync(marker,JSON.stringify({format:'matching-wasm-rebuild-v1',legalClearance:false,runtimeReplacement:false},null,2),{flag:'wx'});
const manifest=JSON.parse(readFileSync(join(supplement,'manifest.json'),'utf8'));
const inputs=Object.entries(pins).map(([path,sha256])=>{const entry=manifest.files.find(item=>item.path===path);const file=regular(join(supplement,...path.split('/'))),bytes=readFileSync(file);if(!entry||entry.sha256!==sha256||bytes.length!==entry.bytes||hash(bytes)!==sha256)throw Error('Frozen source input hash mismatch: '+path);return{path,bytes:bytes.length,sha256};});
const wasmInstalled=options.target?.startsWith('sharp')?join(installed,'@img','sharp-wasm32','lib','sharp-wasm32-0.35.5.node.wasm'):join(installed,'xmllint-wasm','xmllint.wasm'),installedHash=hash(readFileSync(wasmInstalled));
const prefix=options.target==='sharp-full'?'sharp-full-attempt-':options.target==='sharp'?'sharp-attempt-':'attempt-';
const attempt=prefix+String(readdirSync(root).filter(name=>name.startsWith(prefix)&&/^\d{3}$/.test(name.slice(prefix.length))).length+1).padStart(3,'0'),directory=join(root,attempt);mkdirSync(directory);
writeFileSync(join(directory,'qualification-recipe.mjs'),readFileSync(fileURLToPath(import.meta.url)),{flag:'wx'});
function sealAttempt(){
 const files=[];function visit(parent){for(const name of readdirSync(parent).sort()){const path=join(parent,name),info=lstatSync(path);if(info.isSymbolicLink())throw Error('Linked output cannot be sealed');if(info.isDirectory())visit(path);else if(info.isFile())files.push({path:relative(directory,path).replaceAll('\\','/'),bytes:info.size,sha256:hash(readFileSync(path))});else throw Error('Unexpected output type');}}
 visit(directory);writeFileSync(join(directory,'artifact-manifest.json'),JSON.stringify({format:'matching-wasm-rebuild-artifacts-v1',files},null,2),{flag:'wx'});
}
writeFileSync(join(directory,'inputs.json'),JSON.stringify({inputs,baseImage,installedWasmSha256:installedHash,node:process.version,cpus:2,networkDuringBuild:'none',sourceCommits:{xmllint:'83b814cdc39625af5c34370c627599d973d28b07',libxml2:'eb0a2f2b91566384f378d870ffcd69c0a24162cc',emscripten:'1ddaae4d2d6dfbb678ecc193bc988820d1fc4633'}},null,2));
async function run(label,command,argv){
 const stdout=openSync(join(directory,label+'.stdout.txt'),'wx'),stderr=openSync(join(directory,label+'.stderr.txt'),'wx'),started=Date.now();
 console.log('Running '+label);
 const outcome=await new Promise(resolveRun=>{const child=spawn(command,argv,{cwd:checkout,windowsHide:true,stdio:['ignore',stdout,stderr]});child.once('error',error=>resolveRun({exitCode:null,error:String(error)}));child.once('exit',(exitCode,signal)=>resolveRun({exitCode,signal}));});
 closeSync(stdout);closeSync(stderr);writeFileSync(join(directory,label+'.json'),JSON.stringify({command,arguments:argv,...outcome,elapsedMs:Date.now()-started},null,2));
 if(outcome.exitCode!==0)throw Error(label+' failed; original logs preserved');return readFileSync(join(directory,label+'.stdout.txt'),'utf8').trim();
}
async function validateHostXml(){
 const script=String.raw`const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const directory=process.argv[2],schema='<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="amount" type="xs:integer"/></xs:schema>';
(async()=>{const results=[];for(const variant of ['with-libz','without-libz']){const api=require(path.join(directory,variant,'index-node.js'));const valid=await api.validateXML({xml:'<amount>123</amount>',schema}),invalid=await api.validateXML({xml:'<amount>invalid</amount>',schema}),malformed=await api.validateXML({xml:'<amount>',schema});assert.equal(valid.valid,true);assert.equal(invalid.valid,false);assert.equal(malformed.valid,false);results.push({variant,validAccepted:valid.valid,invalidRejected:!invalid.valid,malformedRejected:!malformed.valid});}const result={passed:true,node:process.version,platform:process.platform,results};fs.writeFileSync(path.join(directory,'host-functional-validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));})().catch(error=>{console.error(error);process.exitCode=1;});`;
 const path=join(directory,'validate-host.cjs');writeFileSync(path,script);await run('host-functional-command',process.execPath,[path,directory]);return JSON.parse(readFileSync(join(directory,'host-functional-validation.json'),'utf8'));
}
async function validateHostSharp(){
 const script=String.raw`const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const directory=process.argv[2],dependencies=process.argv[3];process.env.NODE_PATH=dependencies;Module._initPaths();
const addon=require(path.join(directory,'rebuilt','sharp-wasm32-0.35.5.node.js')),bindingPath=path.join(dependencies,'sharp','dist','sharp.cjs');
const injected=new Module(bindingPath);injected.filename=bindingPath;injected.loaded=true;injected.exports=addon;require.cache[bindingPath]=injected;
const sharp=require(path.join(dependencies,'sharp'));assert.strictEqual(require(bindingPath),addon);
(async()=>{const pixel=Buffer.from([31,73,109]),png=await sharp(pixel,{raw:{width:1,height:1,channels:3}}).resize(8,6,{kernel:'nearest'}).png().toBuffer();const metadata=await sharp(png).metadata();assert.equal(metadata.width,8);assert.equal(metadata.height,6);const raw=await sharp(png).removeAlpha().raw().toBuffer();for(let i=0;i<raw.length;i++)assert.equal(raw[i],pixel[i%3]);const jpeg=await sharp(png).jpeg().toBuffer(),webp=await sharp(png).webp().toBuffer();assert.equal((await sharp(jpeg).metadata()).width,8);assert.equal((await sharp(webp).metadata()).height,6);const svg=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="4"><rect width="3" height="4" fill="#204060"/></svg>')).png().toBuffer();assert.equal((await sharp(svg).metadata()).height,4);const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');const result={passed:true,node:process.version,platform:process.platform,rebuiltBindingInjectedInMemory:true,pngExactPixels:true,jpeg:true,webp:true,svg:true,pngSha256:digest(png),jpegSha256:digest(jpeg),webpSha256:digest(webp),svgSha256:digest(svg)};fs.writeFileSync(path.join(directory,'host-functional-validation.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));})().catch(error=>{console.error(error);process.exitCode=1;});`;
 const path=join(directory,'validate-host.cjs');writeFileSync(path,script);await run('host-functional-command',process.execPath,[path,directory,installed]);return JSON.parse(readFileSync(join(directory,'host-functional-validation.json'),'utf8'));
}
if(options.target==='sharp-full'){
 if(!options['native-supplement'])throw Error('Full sharp qualification requires --native-supplement');
 const native=external(options['native-supplement']);
 if(inside(root,native)||inside(native,root))throw Error('Native source input and output must be independent');
 const previous=JSON.parse(readFileSync(join(root,'sharp-toolchain.json'),'utf8'));
 if(!/^sha256:[a-f0-9]{64}$/.test(previous.image)||!/^sharp-attempt-\d{3}$/.test(previous.preparationAttempt))throw Error('Invalid wrapper toolchain reference');
 const sourceMap={
  'sources/glib-source.archive':'17d15cac2af80a33271127408e0abc2748eb297c595c2a26409e81e14e7d1b8f',
  'sources/libexif-release-source.archive':'4a055ed6575e61ca46c3172be3c753cc16c9becd0f99ec71d58dd0e471476c0c',
  'sources/libheif-source.archive':'fd9036064c4432f0550d15072ddf34956a248279ee9aeaff0fba3fa0f77d8f1a',
  'sources/libvips-source.archive':'5baaead3b0bb20ffdb9e9ff09aa9fda08620923df77b63b436654cb5e0b3bf94',
  'sources/vips-aom-source.archive':'8ca0c52746174603500f0adb6f2a215d69c9ca2aab2acb3caa06fb791d8d01bf',
  'sources/vips-cgif-source.archive':'83a70a15bc2da41f081a44ebc58ee48e2e1d524a6d3fdb4a24064afa08d5ad4d',
  'sources/vips-expat-source.archive':'952c03c33a6b337f12dae7a9b0f9dee86f867550d35c994d6bdaaddd37dc8454',
  'sources/vips-ffi-source.archive':'7da3e2d9a171eb0a038f592ecad3ff2bb2550f3496d87b3b29ad0cf4430c0db4',
  'sources/vips-highway-release-source.archive':'36f672ab48ddb3c8555e9e89e16fe400cd7d16c6eb455a1a3d0c146a63ababdc',
  'sources/vips-imagequant-source.archive':'47d2a84b7b1052975c9d50a3d4e3cacbf57b43d84a4c3131210848ead9964dfb',
  'sources/vips-lcms-release-source.archive':'bfc54f7bab59fbc921012014a8032e4cba4abd46db47d46b76416a8c0b2815c8',
  'sources/vips-mozjpeg-source.archive':'b680167bd5d9afebdd576a12f8c49d2c9066a3b92ef96a2b2c5f7829b8600fe5',
  'sources/mxe-cache-png-source.archive':'28eb403f51f0f7405249132cecfe82ea5c0ef97f1b32c5a65828814ae0d34775',
  'sources/vips-tiff-source.archive':'4996f0c4f93094719b1ca5c6279b20e588773ba8a247533e486416fb662ddb88',
  'sources/vips-uhdr-source.archive':'aa8d193bb887c348c419780511dd03b374f4e07af8812b6d3f80c8537cf1ef2c',
  'sources/vips-webp-source.archive':'e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564',
  'sources/vips-zlib-ng-source.archive':'f9c65aa9c852eb8255b636fd9f07ce1c406f061ec19a2e7d508b318ca0c907d1',
 };
 const wasmSources={
  'sources/wasm-vips-inferred-source.archive':'37e18bb8d1a7469587a645d1418bfb7f9b9590516f8e04e629a7ea3ec748cac5',
  'sources/resvg-release-source.archive':'13ed5a2bae7a01156288ecae5bf944cf7d1c572742c19fc68027947a4d87294c',
  'sources/emscripten-6-source.archive':'de630b2a6b736d1bac03b1016a21e365db29b4a3ca6e1457fb0281e1b72e7d59',
  'sources/wasm-rust-std-source.archive':'9960c4bd878cfdc6acfe4a01b428c33ff6a5527f6f5e4a8b426cbe19236bded0',
  'evidence/wasm-emscripten-observed-patches.json-or-text':'8e5a81a90cbcebc0b502cf774d3653890f068bd26fcb6959231068cda3251bbd',
 };
 const fullInputs=[];for(const [inputRoot,catalog]of [[native,sourceMap],[supplement,wasmSources]])for(const[path,sha256]of Object.entries(catalog)){const bytes=readFileSync(regular(join(inputRoot,...path.split('/'))));if(hash(bytes)!==sha256)throw Error('Full source input mismatch: '+path);fullInputs.push({bundle:inputRoot===native?'native':'wasm',path,bytes:bytes.length,sha256});}
 writeFileSync(join(directory,'full-source-inputs.json'),JSON.stringify({inputs:fullInputs,newlyFrozenReplacement:true,historicalNestedHeadAttested:false},null,2));
 writeFileSync(join(directory,'build-sharp-wrapper.sh'),readFileSync(join(root,previous.preparationAttempt,'build-sharp.sh')));
 const prepare=String.raw`set -euo pipefail
export DEBIAN_FRONTEND=noninteractive MAKEFLAGS=-j2 CARGO_BUILD_JOBS=2
apt-get update
apt-get install -y --no-install-recommends build-essential libglib2.0-dev pkgconf ninja-build python3-pip python3-venv autoconf automake libtool gettext bzip2 unzip
python3 -m venv /opt/meson
/opt/meson/bin/pip install meson==1.9.1
export PATH=/opt/meson/bin:$PATH RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
mkdir -p /frozen /prepare/glib /prepare/resvg /work/wasm-vips
tar -xf /inputs/sources/wasm-vips-inferred-source.archive --strip-components=1 -C /work/wasm-vips
cp /work/wasm-vips/build.sh /evidence/original-wasm-vips-build.sh
patch -p1 -d /emsdk/upstream/emscripten < /inputs/evidence/wasm-emscripten-observed-patches.json-or-text
emcc --clear-cache
embuilder build sysroot --force
fetch() { curl --fail --show-error --location --proto '=https' --tlsv1.2 --max-time 300 "$1" --output "/frozen/$2"; printf '%s  %s\n' "$1" "$2" >> /evidence/new-source-urls.txt; }
fetch https://github.com/GNOME/glib/compare/2.90.0...kleisauke:wasm-vips-2.90.0.patch glib.patch
fetch https://github.com/kleisauke/libjpeg-turbo/commit/a60fb467fc7601b008741d42e98268c8a7bcb5b4.patch mozjpeg.patch
fetch https://github.com/libvips/libvips/compare/v8.18.7...kleisauke:wasm-vips-8.18.7.patch vips.patch
fetch https://gitlab.gnome.org/GNOME/gvdb/-/archive/2b42fc75f09dbe1cd1057580b5782b08f2dcb400/gvdb-2b42fc75f09dbe1cd1057580b5782b08f2dcb400.tar.gz gvdb.tar.gz
fetch https://github.com/PCRE2Project/pcre2/releases/download/pcre2-10.46/pcre2-10.46.tar.bz2 pcre2-10.46.tar.bz2
fetch https://wrapdb.mesonbuild.com/v2/pcre2_10.46-1/get_patch pcre2_10.46-1_patch.zip
echo 'e57b5b8bc485d74dbdacd56432b9a98cb3889b4ed46007c6bfe210275a4cc2be  /frozen/glib.patch' | sha256sum -c -
echo 'f0475206df39214377821faae087a2ee9eef58660f272bf0b4874c1783930cab  /frozen/mozjpeg.patch' | sha256sum -c -
echo '6c9039a65d5853dd2918c5a308b0e1f7db0f05d8b2cf9cab0b79376348b65df7  /frozen/vips.patch' | sha256sum -c -
echo '069a00aa1fc893f18423602f4e095583be5a220429f6e8a58d70511490b4b019  /frozen/gvdb.tar.gz' | sha256sum -c -
echo '15fbc5aba6beee0b17aecb04602ae39432393aba1ebd8e39b7cabf7db883299f  /frozen/pcre2-10.46.tar.bz2' | sha256sum -c -
echo '761d16c89b9c13812842916b7ee970650ee7c1810f83bc567351faf7365b66be  /frozen/pcre2_10.46-1_patch.zip' | sha256sum -c -
tar -xf /native/sources/glib-source.archive --strip-components=1 -C /prepare/glib
mkdir -p /prepare/glib/subprojects/gvdb /prepare/glib/subprojects/packagecache
tar -xf /frozen/gvdb.tar.gz --strip-components=1 -C /prepare/glib/subprojects/gvdb
cp /frozen/pcre2-10.46.tar.bz2 /frozen/pcre2_10.46-1_patch.zip /prepare/glib/subprojects/packagecache/
cp -a /prepare/glib/subprojects /frozen/glib-subprojects
fetch https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init rustup-init
fetch https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init.sha256 rustup-init.sha256
cd /frozen
sha256sum -c rustup-init.sha256
chmod +x rustup-init
./rustup-init -y --no-modify-path --profile minimal --target wasm32-unknown-emscripten --default-toolchain nightly-2026-09-26 --component rust-src
export PATH=/opt/cargo/bin:/opt/meson/bin:$PATH
rustc -vV > /evidence/rustc-version.txt
cargo -vV > /evidence/cargo-version.txt
tar -xf /inputs/sources/resvg-release-source.archive --strip-components=1 -C /prepare/resvg
cd /prepare/resvg
python3 - <<'PY'
from pathlib import Path
Path('.cargo/config').rename('.cargo/config.original-vendoring')
PY
cargo fetch --manifest-path crates/c-api/Cargo.toml --target wasm32-unknown-emscripten --locked -Zbuild-std=std,panic_abort
cd /frozen
sha256sum * 2>/dev/null > /evidence/new-source-SHA256SUMS || test -s /evidence/new-source-SHA256SUMS
tar -czf /evidence/new-frozen-source-inputs.tar.gz -C /frozen .
tar -czf /evidence/cargo-frozen-inputs.tar.gz -C /opt/cargo registry
dpkg-query -W > /evidence/full-toolchain-packages.txt
emcc --version > /evidence/full-compiler-version.txt
meson --version > /evidence/meson-version.txt
`;
 const aliases={
  'https://github.com/zlib-ng/zlib-ng/archive/refs/tags/2.3.3.tar.gz':'/native/sources/vips-zlib-ng-source.archive',
  'https://github.com/libffi/libffi/releases/download/v3.8.0/libffi-3.8.0.tar.gz':'/native/sources/vips-ffi-source.archive',
  'https://download.gnome.org/sources/glib/2.90/glib-2.90.0.tar.xz':'/native/sources/glib-source.archive',
  'https://github.com/GNOME/glib/compare/2.90.0...kleisauke:wasm-vips-2.90.0.patch':'/frozen/glib.patch',
  'https://github.com/libexpat/libexpat/releases/download/R_2_8_5/expat-2.8.5.tar.xz':'/tmp/full-source-expat.tar.xz',
  'https://github.com/libexif/libexif/releases/download/v0.6.26/libexif-0.6.26.tar.xz':'/native/sources/libexif-release-source.archive',
  'https://github.com/mm2/Little-CMS/releases/download/lcms2.19.1/lcms2-2.19.1.tar.gz':'/native/sources/vips-lcms-release-source.archive',
  'https://github.com/google/highway/archive/refs/tags/1.4.0.tar.gz':'/native/sources/vips-highway-release-source.archive',
  'https://github.com/mozilla/mozjpeg/archive/0826579.tar.gz':'/native/sources/vips-mozjpeg-source.archive',
  'https://github.com/kleisauke/libjpeg-turbo/commit/a60fb467fc7601b008741d42e98268c8a7bcb5b4.patch':'/frozen/mozjpeg.patch',
  'https://github.com/google/libultrahdr/archive/refs/tags/v2.0.2.tar.gz':'/native/sources/vips-uhdr-source.archive',
  'https://github.com/pnggroup/libpng/archive/refs/tags/v1.6.58.tar.gz':'/tmp/full-source-png.tar.gz',
  'https://github.com/lovell/libimagequant/archive/refs/tags/v2.4.1.tar.gz':'/native/sources/vips-imagequant-source.archive',
  'https://github.com/dloebl/cgif/archive/refs/tags/v0.5.4.tar.gz':'/native/sources/vips-cgif-source.archive',
  'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz':'/native/sources/vips-webp-source.archive',
  'https://gitlab.com/libtiff/libtiff/-/archive/v4.7.2/libtiff-v4.7.2.tar.gz':'/tmp/full-source-tiff.tar.gz',
  'https://github.com/linebender/resvg/releases/download/v0.48.1/resvg-0.48.1.tar.xz':'/inputs/sources/resvg-release-source.archive',
  'https://storage.googleapis.com/aom-releases/libaom-3.15.1.tar.gz':'/native/sources/vips-aom-source.archive',
  'https://github.com/strukturag/libheif/releases/download/v1.23.5/libheif-1.23.5.tar.gz':'/native/sources/libheif-source.archive',
  'https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz':'/native/sources/libvips-source.archive',
  'https://github.com/libvips/libvips/compare/v8.18.7...kleisauke:wasm-vips-8.18.7.patch':'/frozen/vips.patch',
 };
 const shim='curl() { local url="${!#}"; case "$url" in\n'+Object.entries(aliases).map(([url,file])=>` '${url}') cat '${file}';;`).join('\n')+'\n *) echo "Unfrozen source URL: $url" >&2; return 1;; esac; }; export -f curl\n';
 const build=String.raw`set -euo pipefail
export PATH=/opt/cargo/bin:/opt/meson/bin:$PATH RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo CARGO_BUILD_JOBS=2 CARGO_NET_OFFLINE=true
export MAKEFLAGS=-j2 CMAKE_BUILD_PARALLEL_LEVEL=2 NINJAFLAGS=-j2 LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH=1740000000
mkdir -p /opt/task-bin
cat > /opt/task-bin/ninja <<'NINJA'
#!/bin/sh
exec /usr/bin/ninja -j2 "$@"
NINJA
chmod +x /opt/task-bin/ninja
export PATH=/opt/task-bin:$PATH
xz -dc /native/sources/mxe-cache-png-source.archive | gzip -n > /tmp/full-source-png.tar.gz
xz -dc /native/sources/vips-tiff-source.archive | gzip -n > /tmp/full-source-tiff.tar.gz
bzip2 -dc /native/sources/vips-expat-source.archive | xz -T2 > /tmp/full-source-expat.tar.xz
cd /work/wasm-vips
python3 - <<'PY'
from pathlib import Path
import re
p=Path('build.sh');s=p.read_text();s=re.sub(r'^DEPS=.*$', 'DEPS=$SOURCE_DIR/build/deps-${attempt}', s, flags=re.M);s=s.replace('export MAKEFLAGS="-j$(nproc)"','export MAKEFLAGS="-j2"');s=s.replace('rm -rf $DEPS/','test ! -e "$DEPS"');s=s.replace('  cd $DEPS/glib\n','  cd $DEPS/glib\n  cp -a /frozen/glib-subprojects/. subprojects/\n')
s=s.replace('  cd $DEPS/uhdr\n', '''  cd $DEPS/uhdr
  cp CMakeLists.txt /evidence/original-uhdr-CMakeLists.txt
  sed -i 's@set(CMAKE_REQUIRED_FLAGS "--use-port=libjpeg")@set(CMAKE_REQUIRED_FLAGS "-pthread -fwasm-exceptions")@;s@set(CMAKE_REQUIRED_LINK_OPTIONS "--use-port=libjpeg")@set(CMAKE_REQUIRED_LIBRARIES "/work/wasm-vips/build/target/lib/libjpeg.a")\\n    set(CMAKE_REQUIRED_INCLUDES "/work/wasm-vips/build/target/include")@' CMakeLists.txt
  cp CMakeLists.txt /evidence/reviewed-uhdr-CMakeLists.txt
''')
s=s.replace('-DUHDR_BUILD_EXAMPLES=OFF', '-DCMAKE_FIND_ROOT_PATH=$TARGET -DJPEG_LIBRARY=$TARGET/lib/libjpeg.a -DJPEG_INCLUDE_DIR=$TARGET/include -DUHDR_BUILD_EXAMPLES=OFF')
p.write_text(s)
PY
`+shim+String.raw`bash build.sh --disable-bindings --disable-modules --disable-jxl --enable-libvips-cpp > /evidence/full-library-build.stdout.txt 2> /evidence/full-library-build.stderr.txt
cp build.sh /evidence/reviewed-wasm-vips-build.sh
cp build/target/versions.json /evidence/full-library-versions.json
tar -czf /evidence/full-source-static-libraries.tar.gz -C build/target include lib versions.json
find build -type f \( -name meson-log.txt -o -name CMakeCache.txt -o -name config.log -o -name CMakeConfigureLog.yaml \) > /evidence/full-build-config-files.txt
tar -czf /evidence/full-build-configurations.tar.gz -T /evidence/full-build-config-files.txt
cd /work/sharp/node_modules/@img/sharp-libvips-dev-wasm32
test -d lib.publisher || mv lib lib.publisher
test -d include.publisher || mv include include.publisher
cp -a /work/wasm-vips/build/target/lib /work/wasm-vips/build/target/include .
cp lib.publisher/index.js lib/index.js
cp include.publisher/index.js include/index.js
find /work/wasm-vips/build/target/lib -name '*.a' -exec sha256sum {} \; | sort > /evidence/source-built-archive-SHA256SUMS
for library in /work/wasm-vips/build/target/lib/*.a; do cmp "$library" "lib/$(basename "$library")"; done
cp /work/wasm-vips/build/target/versions.json .
bash /evidence/build-sharp-wrapper.sh
`;
 writeFileSync(join(directory,'prepare-full-source.sh'),prepare);writeFileSync(join(directory,'build-full-source.sh'),build);
 let result;
 try{
  const frozen=join(root,'sharp-full-toolchain.json');let image;
  if(existsSync(frozen)){image=JSON.parse(readFileSync(frozen,'utf8')).image;if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Invalid full source toolchain');}
  else{const container='matching-sharp-full-prepare-'+randomUUID();await run('prepare-full','docker',['run','--name',container,'--cpus=2','--memory=6g','--pids-limit=256','--mount',`type=bind,source=${native},target=/native,readonly`,'--mount',`type=bind,source=${supplement},target=/inputs,readonly`,'--mount',`type=bind,source=${directory},target=/evidence`,previous.image,'bash','/evidence/prepare-full-source.sh']);image=await run('freeze-full-toolchain','docker',['commit','--message','Newly frozen full sharp WASM source-build environment',container]);writeFileSync(frozen,JSON.stringify({image,baseImage:previous.image,container,preparationAttempt:attempt,historicalNestedHeadAttested:false},null,2),{flag:'wx'});}
  if(options['full-cache-from']){
   const prior=options['full-cache-from'];if(!/^sharp-full-attempt-\d{3}$/.test(prior)||prior===attempt)throw Error('Invalid prior source-build attempt');
   const priorDirectory=regular(join(root,prior)),priorInputs=JSON.parse(readFileSync(join(priorDirectory,'full-source-inputs.json'),'utf8'));
   if(JSON.stringify(priorInputs.inputs)!==JSON.stringify(fullInputs))throw Error('Cached source build input mismatch');
   const command=JSON.parse(readFileSync(join(priorDirectory,'build-full.json'),'utf8')),nameIndex=command.arguments.indexOf('--name'),container=command.arguments[nameIndex+1];
   if(command.command!=='docker'||command.exitCode===null||nameIndex<0||!/^matching-sharp-full-build-[a-f0-9-]{36}$/.test(container))throw Error('Invalid completed source-build cache');
   image=await run('freeze-completed-source-cache','docker',['commit','--message','Preserved completed stages from '+prior,container]);
   writeFileSync(join(directory,'source-build-cache.json'),JSON.stringify({image,priorAttempt:prior,priorResultSha256:hash(readFileSync(join(priorDirectory,'result.json'))),inputsUnchanged:true},null,2),{flag:'wx'});
  }
  await run('build-full','docker',['run','--name','matching-sharp-full-build-'+randomUUID(),'--cpus=2','--memory=6g','--pids-limit=256','--network=none','--mount',`type=bind,source=${native},target=/native,readonly`,'--mount',`type=bind,source=${supplement},target=/inputs,readonly`,'--mount',`type=bind,source=${directory},target=/evidence`,image,'bash','/evidence/build-full-source.sh']);
  const rebuilt=readFileSync(join(directory,'rebuilt','sharp-wasm32-0.35.5.node.wasm'));result={passed:true,attempt,image,inputs:fullInputs,installedWasmSha256:installedHash,rebuiltWasmSha256:hash(rebuilt),installedByteIdentical:hash(rebuilt)===installedHash,newlyFrozenReplacement:true,historicalNestedHeadAttested:false,functionalValidation:JSON.parse(readFileSync(join(directory,'functional-validation.json'),'utf8')),hostFunctionalValidation:await validateHostSharp(),legalClearance:false,runtimeReplacement:false};
 }catch(error){result={passed:false,attempt,error:String(error),inputs:fullInputs,newlyFrozenReplacement:true,historicalNestedHeadAttested:false,legalClearance:false,runtimeReplacement:false};process.exitCode=1;}
 result.installedWasmUnchanged=hash(readFileSync(wasmInstalled))===installedHash;if(!result.installedWasmUnchanged){result.passed=false;result.error='Installed reference changed during qualification';process.exitCode=1;}writeFileSync(join(directory,'result.json'),JSON.stringify(result,null,2));sealAttempt();console.log(JSON.stringify(result));process.exit(process.exitCode??0);
}
if(options.target==='sharp'){
 if(!options['native-supplement'])throw Error('Sharp qualification requires --native-supplement');
 const native=external(options['native-supplement']),sharpBase='emscripten/emsdk@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65';
 const sharpInputs=[{root:native,path:'sources/sharp-source.archive',sha256:'d600bcbdd550ea096a384391a474907e6aa8138f97ea472bf5228b07ae75f779'},{root:supplement,path:'link-inputs/sharp-libvips-dev-wasm32-1.3.4.tgz',sha256:'23f797d1d182d6e768eff78f69baa6abecbb224119f3c3f93f8e43a24b01b445'}].map(input=>{const bytes=readFileSync(regular(join(input.root,...input.path.split('/'))));if(hash(bytes)!==input.sha256)throw Error('Sharp frozen input hash mismatch');return{path:input.path,sha256:input.sha256,bytes:bytes.length};});
 writeFileSync(join(directory,'sharp-inputs.json'),JSON.stringify({inputs:sharpInputs,baseImage:sharpBase,installedWasmSha256:installedHash,originalSourceCommit:'51a990faa26ade5586a4934ac9673c98d8893326',independentlyFrozenDependencyLock:true,publisherDependencyLockReconstruction:false},null,2));
 const prepare=String.raw`set -euo pipefail
export DEBIAN_FRONTEND=noninteractive MAKEFLAGS=-j2 npm_config_jobs=2
apt-get update
apt-get install -y --no-install-recommends pkg-config
mkdir -p /work/sharp
tar -xzf /native/sources/sharp-source.archive --strip-components=1 -C /work/sharp
cd /work/sharp
cp package.json /evidence/original-package.json
node <<'NODE'
const fs=require('fs'),pkg=require('./package.json');
pkg.devDependencies['@img/sharp-libvips-dev-wasm32']='file:/inputs/link-inputs/sharp-libvips-dev-wasm32-1.3.4.tgz';
delete pkg.devDependencies['@img/sharp-libvips-dev'];
for(const[name,version]of Object.entries({'emnapi':'1.11.3','@emnapi/runtime':'1.11.3','node-addon-api':'8.9.2','node-gyp':'12.4.0','patch-package':'8.0.1'}))pkg.devDependencies[name]=version;
fs.writeFileSync('package.json',JSON.stringify(pkg,null,2));
NODE
npm install --ignore-scripts --no-audit --no-fund
cp package.json /evidence/frozen-package.json
cp package-lock.json /evidence/package-lock.json
npm ls --all --json > /evidence/npm-dependency-tree.json
npx --no-install patch-package
dpkg-query -W > /evidence/toolchain-packages.txt
emcc --version > /evidence/compiler-version.txt
node --version > /evidence/build-node-version.txt
tar -czf /evidence/sharp-frozen-build-inputs.tar.gz -C /work/sharp .
`;
 const build=String.raw`set -euo pipefail
export MAKEFLAGS=-j2 npm_config_jobs=2 VIPS_CONCURRENCY=1
cd /work/sharp
npm run build:dist > /evidence/build-dist.stdout.txt 2> /evidence/build-dist.stderr.txt
EMCC_CFLAGS='-Wl,-Map,/evidence/sharp-link.map -Wl,--why-extract=/evidence/sharp-why-extract.tsv' emmake npm run build > /evidence/compile.stdout.txt 2> /evidence/compile.stderr.txt
mkdir -p /evidence/rebuilt
cp src/build/Release/sharp-wasm32-0.35.5.node.js src/build/Release/sharp-wasm32-0.35.5.node.wasm /evidence/rebuilt/
node <<'NODE'
const fs=require('fs'),assert=require('assert').strict,crypto=require('crypto');
const addon=require('./src/build/Release/sharp-wasm32-0.35.5.node.js'),sharp=require('./');
assert.strictEqual(require('./dist/sharp.cjs'),addon);
(async()=>{
 const pixel=Buffer.from([31,73,109]),png=await sharp(pixel,{raw:{width:1,height:1,channels:3}}).resize(8,6,{kernel:'nearest'}).png().toBuffer();
 const metadata=await sharp(png).metadata();assert.equal(metadata.width,8);assert.equal(metadata.height,6);
 const raw=await sharp(png).removeAlpha().raw().toBuffer();for(let i=0;i<raw.length;i++)assert.equal(raw[i],pixel[i%3]);
 const jpeg=await sharp(png).jpeg().toBuffer(),webp=await sharp(png).webp().toBuffer();assert.equal((await sharp(jpeg).metadata()).width,8);assert.equal((await sharp(webp).metadata()).height,6);
 const svg=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="4"><rect width="3" height="4" fill="#204060"/></svg>')).png().toBuffer();assert.equal((await sharp(svg).metadata()).height,4);
 const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');fs.writeFileSync('/evidence/functional-validation.json',JSON.stringify({passed:true,localRebuiltBindingSelected:true,pngExactPixels:true,jpeg:true,webp:true,svg:true,pngSha256:digest(png),jpegSha256:digest(jpeg),webpSha256:digest(webp),svgSha256:digest(svg)},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
NODE
tar -czf /evidence/sharp-link-objects.tar.gz -C src/build Release/obj.target
`;
 writeFileSync(join(directory,'prepare-sharp.sh'),prepare);writeFileSync(join(directory,'build-sharp.sh'),build);
 let sharpResult;
 try{
  const frozen=join(root,'sharp-toolchain.json');let image;
  if(existsSync(frozen)){image=JSON.parse(readFileSync(frozen,'utf8')).image;if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Invalid frozen sharp toolchain');}
  else{
   await run('base-image','docker',['image','inspect',sharpBase]);const container='matching-sharp-wasm-toolchain-'+randomUUID();
   await run('prepare','docker',['run','--name',container,'--cpus=2','--memory=4g','--pids-limit=256','--mount',`type=bind,source=${native},target=/native,readonly`,'--mount',`type=bind,source=${supplement},target=/inputs,readonly`,'--mount',`type=bind,source=${directory},target=/evidence`,sharpBase,'bash','/evidence/prepare-sharp.sh']);
   image=await run('freeze-toolchain','docker',['commit','--message','Independent frozen sharp WASM source relink environment',container]);writeFileSync(frozen,JSON.stringify({image,baseImage:sharpBase,container,preparationAttempt:attempt,publisherLock:false},null,2),{flag:'wx'});
  }
  await run('build','docker',['run','--name','matching-sharp-wasm-build-'+randomUUID(),'--cpus=2','--memory=4g','--pids-limit=256','--network=none','--mount',`type=bind,source=${directory},target=/evidence`,image,'bash','/evidence/build-sharp.sh']);
  const rebuilt=readFileSync(join(directory,'rebuilt','sharp-wasm32-0.35.5.node.wasm')),why=readFileSync(join(directory,'sharp-why-extract.tsv'),'utf8');
  const archives=[...new Set([...why.matchAll(/([^\s\t]+\.a)\(/g)].map(match=>match[1]))].sort();
  sharpResult={passed:true,attempt,image,inputs:sharpInputs,installedWasmSha256:installedHash,rebuiltWasmSha256:hash(rebuilt),installedByteIdentical:rebuilt.equals(readFileSync(wasmInstalled)),linkedArchiveInputs:archives,functionalValidation:JSON.parse(readFileSync(join(directory,'functional-validation.json'),'utf8')),hostFunctionalValidation:await validateHostSharp(),publisherNestedSourceIdentityProven:false,allStaticLibrariesRebuiltFromSource:false,legalClearance:false,runtimeReplacement:false};
 }catch(error){sharpResult={passed:false,attempt,inputs:sharpInputs,error:String(error),legalClearance:false,runtimeReplacement:false};process.exitCode=1;}
 sharpResult.installedWasmUnchanged=hash(readFileSync(wasmInstalled))===installedHash;if(!sharpResult.installedWasmUnchanged){sharpResult.passed=false;sharpResult.error='Installed reference changed during qualification';process.exitCode=1;}writeFileSync(join(directory,'result.json'),JSON.stringify(sharpResult,null,2));sealAttempt();console.log(JSON.stringify(sharpResult));process.exit(process.exitCode??0);
}
const toolchainScript=`set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends gawk apt-utils libtool pkg-config autotools-dev autoconf automake
emcc --version
dpkg-query -W -f='\${Package} \${Version}\\n' > /evidence/toolchain-packages.txt
cp /etc/os-release /evidence/toolchain-os-release.txt
`;
writeFileSync(join(directory,'prepare-toolchain.sh'),toolchainScript);
const buildScript=String.raw`set -euo pipefail
export MAKEFLAGS=-j2 LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH=1740000000
mkdir -p /work/xmllint/libxml2 /evidence/with-libz /evidence/without-libz
tar -xzf /inputs/sources/xmllint-source.archive --strip-components=1 -C /work/xmllint
tar -xzf /inputs/sources/xmllint-libxml-source.archive --strip-components=1 -C /work/xmllint/libxml2
cd /work/xmllint
emcc --version > /evidence/compiler-version.txt
/emsdk/upstream/bin/wasm-ld --version > /evidence/linker-version.txt
/emsdk/upstream/bin/llvm-ar t libz.a > /evidence/committed-libz-members.txt
sha256sum libz.a > /evidence/committed-libz.sha256
cp script/libxml2 /evidence/original-libxml2-build.sh
cp script/compile /evidence/original-compile.sh
bash script/libxml2 > /evidence/libxml2-build.stdout.txt 2> /evidence/libxml2-build.stderr.txt
cp build/config.log /evidence/libxml2-config.log
cp build/config.h /evidence/libxml2-config.h
EMCC_CFLAGS='-Wl,-Map,/evidence/with-libz/link.map -Wl,--why-extract=/evidence/with-libz/why-extract.tsv' bash script/compile > /evidence/with-libz/compile.stdout.txt 2> /evidence/with-libz/compile.stderr.txt
cp xmllint.wasm xmllint-node.js xmllint-browser.mjs index-node.js index-browser.mjs /evidence/with-libz/
node test/test.js > /evidence/with-libz/upstream-tests.stdout.txt 2> /evidence/with-libz/upstream-tests.stderr.txt
sed 's@ ./libz.a@@' script/compile > script/compile-without-libz
EMCC_CFLAGS='-Wl,-Map,/evidence/without-libz/link.map -Wl,--why-extract=/evidence/without-libz/why-extract.tsv' bash script/compile-without-libz > /evidence/without-libz/compile.stdout.txt 2> /evidence/without-libz/compile.stderr.txt
cp xmllint.wasm xmllint-node.js xmllint-browser.mjs index-node.js index-browser.mjs /evidence/without-libz/
node test/test.js > /evidence/without-libz/upstream-tests.stdout.txt 2> /evidence/without-libz/upstream-tests.stderr.txt
node <<'NODE'
const fs=require('fs'),assert=require('assert').strict,crypto=require('crypto');
const schema='<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="amount" type="xs:integer"/></xs:schema>';
(async()=>{const results=[];for(const variant of ['with-libz','without-libz']){const api=require('/evidence/'+variant+'/index-node.js');const good=await api.validateXML({xml:'<amount>123</amount>',schema});const bad=await api.validateXML({xml:'<amount>invalid</amount>',schema});const malformed=await api.validateXML({xml:'<amount>',schema});assert.equal(good.valid,true);assert.equal(bad.valid,false);assert.equal(malformed.valid,false);results.push({variant,validAccepted:good.valid,invalidRejected:!bad.valid,malformedRejected:!malformed.valid,sha256:crypto.createHash('sha256').update(fs.readFileSync('/evidence/'+variant+'/xmllint.wasm')).digest('hex')});}fs.writeFileSync('/evidence/functional-validation.json',JSON.stringify({passed:true,results},null,2));})().catch(error=>{console.error(error);process.exitCode=1;});
NODE
sha256sum /evidence/with-libz/xmllint.wasm /evidence/without-libz/xmllint.wasm > /evidence/rebuilt-SHA256SUMS
tar -czf /evidence/libxml2-link-objects.tar.gz build/.libs/libxml2.a build/xmllint-xmllint.o libz.a
`;
writeFileSync(join(directory,'build-xmllint.sh'),buildScript);
let result;
try{
 let image;const frozen=join(root,'toolchain.json');
 if(existsSync(frozen)){image=JSON.parse(readFileSync(frozen,'utf8')).image;if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Invalid frozen toolchain image');}
 else{
  const inspected=JSON.parse(await run('base-image','docker',['image','inspect',baseImage]));
  writeFileSync(join(directory,'base-image-metadata.json'),JSON.stringify(inspected,null,2));
  const container='matching-wasm-toolchain-'+randomUUID();
  await run('prepare-toolchain','docker',['run','--name',container,'--cpus=2','--memory=4g','--pids-limit=256','--mount',`type=bind,source=${directory},target=/evidence`,baseImage,'bash','/evidence/prepare-toolchain.sh']);
  image=await run('freeze-toolchain','docker',['commit','--message','Frozen xmllint 5.3.0 engineering build environment',container]);
  writeFileSync(frozen,JSON.stringify({image,baseImage,container,preparationAttempt:attempt,legalClearance:false},null,2),{flag:'wx'});
 }
 await run('build','docker',['run','--name','matching-wasm-build-'+randomUUID(),'--cpus=2','--memory=4g','--pids-limit=256','--network=none','--mount',`type=bind,source=${supplement},target=/inputs,readonly`,'--mount',`type=bind,source=${directory},target=/evidence`,image,'bash','/evidence/build-xmllint.sh']);
 const withBytes=readFileSync(join(directory,'with-libz','xmllint.wasm')),withoutBytes=readFileSync(join(directory,'without-libz','xmllint.wasm'));
 const why=readFileSync(join(directory,'with-libz','why-extract.tsv'),'utf8'),map=readFileSync(join(directory,'with-libz','link.map'),'utf8');
 result={passed:true,attempt,image,inputs,installedWasmSha256:installedHash,rebuiltWasmSha256:hash(withBytes),installedByteIdentical:withBytes.equals(readFileSync(wasmInstalled)),withoutLibzByteIdentical:withBytes.equals(withoutBytes),committedLibzMembersExtracted:why.split(/\r?\n/).filter(line=>/libz\.a\(/.test(line)),committedLibzMembersInMap:map.split(/\r?\n/).filter(line=>/libz\.a\(/.test(line)),functionalValidation:JSON.parse(readFileSync(join(directory,'functional-validation.json'),'utf8')),hostFunctionalValidation:await validateHostXml(),legalClearance:false,runtimeReplacement:false};
}catch(error){result={passed:false,attempt,inputs,error:String(error),legalClearance:false,runtimeReplacement:false};process.exitCode=1;}
result.installedWasmUnchanged=hash(readFileSync(wasmInstalled))===installedHash;
if(!result.installedWasmUnchanged){result.passed=false;result.error='Installed reference changed during qualification';process.exitCode=1;}
writeFileSync(join(directory,'result.json'),JSON.stringify(result,null,2));sealAttempt();console.log(JSON.stringify(result));
