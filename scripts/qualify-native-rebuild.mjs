#!/usr/bin/env node
/** Isolated canvas rebuild preparation and qualification. Never changes the candidate runtime. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = data => createHash('sha256').update(data).digest('hex');
const format = 'matching-isolated-native-rebuild-v1';
const arguments_ = process.argv.slice(2), opts = {};
while (arguments_.length) { const name = arguments_.shift(); if (!['--out','--evidence','--phase','--target-root'].includes(name) || !arguments_.length || opts[name]) throw new Error('Use --out <absolute-external-directory> --phase tools|prepare|freeze|inventory|build|qualify [--evidence <absolute-source-evidence-directory>] [--target-root <short-absolute-external-directory>]'); opts[name] = arguments_.shift(); }
export function externalPath(value) {
  if (!value || !isAbsolute(value)) throw new Error('An absolute external rebuild directory is required');
  const out = resolve(value), rel = relative(root, out);
  if (!(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))) throw new Error('Rebuilds must remain outside the checkout');
  for (let current = out;; current = dirname(current)) { if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Linked rebuild directory rejected'); if (dirname(current) === current) break; }
  return out;
}
const out = externalPath(opts['--out']), phase = opts['--phase'];
if (!['tools','prepare','freeze','inventory','build','qualify'].includes(phase)) throw new Error('Unknown rebuild phase');
if (phase === 'tools') { if (existsSync(out)) throw new Error('Use a new rebuild directory'); mkdirSync(out, { recursive: true }); writeFileSync(join(out,'workspace.json'), JSON.stringify({ format, releaseAccepted:false, runtimeReplaced:false })+'\n'); }
else if (JSON.parse(readFileSync(join(out,'workspace.json'),'utf8')).format !== format) throw new Error('Not an owned rebuild workspace');
for (const folder of ['logs','home','tmp','cargo-home','tools']) mkdirSync(join(out,folder),{recursive:true});
writeFileSync(join(out,'empty-git-config'),'');
function baseEnv() {
  const env = {};
  for (const name of ['SystemRoot','WINDIR','COMSPEC','ProgramFiles','ProgramFiles(x86)','ProgramW6432','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','PATHEXT']) if (process.env[name]) env[name]=process.env[name];
  Object.assign(env,{HOME:join(out,'home'),USERPROFILE:join(out,'home'),TEMP:join(out,'tmp'),TMP:join(out,'tmp'),CARGO_HOME:join(out,'cargo-home'),RUSTUP_HOME:join(out,'rustup-home'),CARGO_BUILD_JOBS:'2',CMAKE_BUILD_PARALLEL_LEVEL:'2',CARGO_NET_RETRY:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(out,'empty-git-config'),DISABLE_SYSTEM_FONTS_LOAD:'1'});
  return env;
}
function run(label, executable, args, {cwd=out, env=process.env, timeout=30000, allowFailure=false, verbatim=false}={}) {
  const started=Date.now(), result=spawnSync(executable,args,{cwd,env,encoding:'utf8',timeout,maxBuffer:64*1024*1024,windowsHide:true,windowsVerbatimArguments:verbatim});
  for (const extension of ['.log','.json']) if (existsSync(join(out,'logs',label+extension))) copyFileSync(join(out,'logs',label+extension),join(out,'logs',label+'.previous-'+started+extension));
  writeFileSync(join(out,'logs',label+'.log'),(result.stdout||'')+(result.stderr||''));
  const record={label,executable:executable.split(/[\\/]/).pop(),args,exitCode:result.status,errorCode:result.error?.code||null,elapsedMs:Date.now()-started};
  writeFileSync(join(out,'logs',label+'.json'),JSON.stringify(record,null,2)+'\n');
  if (!allowFailure && (result.error||result.status!==0)) throw new Error(label+' failed; see isolated logs ('+(result.error?.code||result.status)+')');
  return result;
}
const programFiles86=process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)';
const vswhere=join(programFiles86,'Microsoft Visual Studio','Installer','vswhere.exe');
const vs=spawnSync(vswhere,['-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-format','json'],{encoding:'utf8',windowsHide:true,timeout:15000});
const installations=vs.status===0?JSON.parse(vs.stdout):[];
const selected=installations.find(x=>x.installationPath.includes('2022'))||installations[0];
if (!selected) throw new Error('MSVC x64 component not found; no global installation attempted');
const vsRoot=selected.installationPath, clangDir=join(vsRoot,'VC','Tools','Llvm','x64','bin');
const cmakeDir=join(process.env.ProgramFiles||'C:\\Program Files','CMake','bin');
const ninjaDir=join(vsRoot,'Common7','IDE','CommonExtensions','Microsoft','CMake','Ninja');
const python=spawnSync('powershell.exe',['-NoProfile','-Command','(Get-Command python -ErrorAction Stop).Source'],{encoding:'utf8',windowsHide:true,timeout:15000}).stdout.trim();
if (!python || !existsSync(join(clangDir,'clang-cl.exe'))) throw new Error('Python or clang-cl metadata prerequisite missing');
function buildEnv() {
  const env=baseEnv();
  const command='call "'+join(vsRoot,'Common7','Tools','VsDevCmd.bat')+'" -arch=x64 -host_arch=x64 >nul && set PATH && set INCLUDE && set LIB && set LIBPATH';
  const essentialPath=[join(process.env.SystemRoot||'C:\\Windows','System32'),join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0'),dirname(python),join(process.env.ProgramFiles||'C:\\Program Files','Git','cmd')].join(';');
  const result=run('msvc-child-environment','cmd.exe',['/d','/s','/c',command],{env:{...env,PATH:essentialPath},timeout:30000,verbatim:true});
  for (const line of result.stdout.split(/\r?\n/)) { const match=/^(PATH|INCLUDE|LIB|LIBPATH)=(.*)$/i.exec(line); if(match) env[match[1].toUpperCase()]=match[2]; }
  env.PATH=[join(out,'tools','rust','bin'),clangDir,cmakeDir,ninjaDir,dirname(python),join(out,'tools','nasm'),env.PATH,join(process.env.ProgramFiles||'C:\\Program Files','Git','usr','bin')].join(';');
  env.LIBCLANG_PATH=clangDir;
  return env;
}
if (phase==='tools') {
  const results=[];
  for (const [name,exe,args] of [['clang-cl',join(clangDir,'clang-cl.exe'),['--version']],['cmake',join(cmakeDir,'cmake.exe'),['--version']],['ninja',join(ninjaDir,'ninja.exe'),['--version']],['python',python,['--version']],['docker','docker.exe',['version','--format','{{json .Server.Version}}']],['wsl','wsl.exe',['--status']]]) {
    const result=run('tool-'+name,exe,args,{allowFailure:true,timeout:15000});results.push({name,present:!result.error,exitCode:result.status,versionOutput:(result.stdout||result.stderr||'').trim().slice(0,600)});
  }
  writeFileSync(join(out,'toolchain-metadata.json'),JSON.stringify({format,hostPlatform:process.platform,hostArch:process.arch,msvc:{product:selected.productId,version:selected.installationVersion},results,globalConfigurationChanged:false,releaseAccepted:false},null,2)+'\n');
}
if (phase==='prepare') {
  const evidence=externalPath(opts['--evidence']);
  const prepare=String.raw`
from pathlib import Path
import json,hashlib,urllib.request,tarfile,zipfile,concurrent.futures,shutil,sys,posixpath
O=Path(sys.argv[1]);A=Path(sys.argv[2]);sha=lambda b:hashlib.sha256(b).hexdigest();D=O/'downloads';D.mkdir(exist_ok=True)
allowed={'static.rust-lang.org','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','www.nasm.us'}
class SafeRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  from urllib.parse import urlparse
  u=urlparse(newurl)
  if u.scheme!='https' or u.hostname not in allowed or u.username or u.password:raise ValueError('Unapproved tool redirect')
  return super().redirect_request(req,fp,code,msg,headers,newurl)
opener=urllib.request.build_opener(SafeRedirect)
previous={r['id']:r for r in json.loads((O/'download-inputs.json').read_text())} if (O/'download-inputs.json').is_file() else {}
items=[('rustc','https://static.rust-lang.org/dist/2025-12-11/rustc-1.92.0-x86_64-pc-windows-msvc.tar.xz','6aec5aba5384ce1041538e71ebebf671d82e29f4fe697bc7844626d94b0dbfe6'),('cargo','https://static.rust-lang.org/dist/2025-12-11/cargo-1.92.0-x86_64-pc-windows-msvc.tar.xz','f4057534ec58708ed3554957582a6c8e8c6abfee011b5c8ad45c3ab27c0b3076'),('rust-std','https://static.rust-lang.org/dist/2025-12-11/rust-std-1.92.0-x86_64-pc-windows-msvc.tar.xz','b4e53a9c9b96a1a0618364791b7728a1c8978101ec6d1ee78fe930e1ef061994'),('nasm','https://www.nasm.us/pub/nasm/releasebuilds/2.16.03/win64/nasm-2.16.03-win64.zip',None)]
for name in ['skia','skparagraph','skshaper','svg','skunicode_core','skunicode_icu','skottie','skresources','sksg','jsonreader']:items.append((name,'https://github.com/Brooooooklyn/canvas/releases/download/skia-90228207/'+name+'-win32-x64-msvc.lib',None))
def fetch(item):
 id,url,expected=item;p=D/(id+'.artifact')
 if p.exists():b=p.read_bytes()
 else:
  with opener.open(urllib.request.Request(url,headers={'User-Agent':'Matching-Community-Isolated-Rebuild/1.0'}),timeout=60) as response:b=response.read(300*1024*1024+1)
 if len(b)>300*1024*1024:raise ValueError('Tool artifact bound exceeded')
 digest=sha(b)
 if id in previous and digest!=previous[id]['sha256']:raise ValueError('Owned download baseline changed '+id)
 if expected and digest!=expected:raise ValueError('Publisher digest mismatch '+id)
 if not p.exists():p.write_bytes(b)
 return {'id':id,'url':url,'sha256':digest,'bytes':len(b),'expectedSha256':expected,'publisherDigestMatched':digest==expected if expected else None}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:records=list(pool.map(fetch,items))
(O/'download-inputs.json').write_text(json.dumps(records,indent=2)+'\n')
def write_member(dest,rel,b):
 rel=rel.replace('\\','/');parts=rel.split('/')
 if not rel or rel.startswith('/') or ':' in rel or '..' in parts:raise ValueError('Archive traversal rejected')
 p=dest.joinpath(*parts);p.parent.mkdir(parents=True,exist_ok=True)
 if p.exists():
  if p.read_bytes()==b:return
  raise ValueError('Archive destination conflict '+rel)
 p.write_bytes(b)
for id in ['rustc','cargo','rust-std']:
 with tarfile.open(D/(id+'.artifact')) as t:
  for m in t:
   if m.issym() or m.islnk():raise ValueError('Linked tool archive member rejected')
   if m.isfile():
    parts=m.name.split('/')
    if len(parts)>3 and parts[2] in ['bin','lib','share'] and (parts[1]==id or id=='rust-std' and parts[1].startswith('rust-std-')):write_member(O/'tools/rust','/'.join(parts[2:]),t.extractfile(m).read())
with zipfile.ZipFile(D/'nasm.artifact') as z:
 for m in z.infolist():
  if not m.is_dir() and m.filename.endswith(('nasm.exe','ndisasm.exe')):write_member(O/'tools/nasm',m.filename.split('/')[-1],z.read(m))
materialized=[]
for id,expected,target in [('canvas-source','c5cb607e0b4fb99b4301849ed240bd40c3505413a9826a788b2d8f07ca6fe85d','canvas'),('skia-source','7bd743e212a91cff750601fc9e686a5431e35081a46d918aae14f8ce0bfd873f','skia')]:
 p=A/'native-source-02/downloads'/(id+'.bin');b=p.read_bytes();assert sha(b)==expected
 with tarfile.open(p) as t:
  for m in t:
   if m.issym() or m.islnk():
    destination=posixpath.normpath(posixpath.join(posixpath.dirname(m.name),m.linkname)) if m.issym() else posixpath.normpath(m.linkname)
    if not destination.startswith(m.name.split('/')[0]+'/'):raise ValueError('Escaping source archive link rejected')
    referenced=t.getmember(destination)
    if not referenced.isfile():raise ValueError('Chained or non-file source archive link rejected')
    payload=t.extractfile(referenced).read();write_member(O/'src'/target,m.name.split('/',1)[1],payload);materialized.append({'sourceId':id,'member':m.name,'linkTarget':m.linkname,'materializedSha256':sha(payload)})
   if m.isfile():write_member(O/'src'/target,m.name.split('/',1)[1],t.extractfile(m).read())
 records.append({'id':id,'sha256':expected,'bytes':len(b),'sourceArchiveVerified':True})
libs=O/'src/skia/out/Static';libs.mkdir(parents=True,exist_ok=True)
shutil.copyfile(O/'src/canvas/.cargo/config.toml',O/'upstream-cargo-config.toml')
for record in records:
 if record['id'] in ['skia','skparagraph','skshaper','svg','skunicode_core','skunicode_icu','skottie','skresources','sksg','jsonreader']:shutil.copyfile(D/(record['id']+'.artifact'),libs/(record['id']+'.lib'))
(O/'build-inputs.json').write_text(json.dumps({'format':'matching-native-rebuild-inputs-v1','newlyFrozenBuild':True,'publisherHistoricalReproductionProved':False,'skiaStaticLibrariesRebuiltFromSource':False,'materializedSourceLinks':materialized,'inputs':records,'releaseAccepted':False},indent=2)+'\n')
print(json.dumps({'preparedInputs':len(records),'globalInstallationPerformed':False,'releaseAccepted':False}))
`;
  writeFileSync(join(out,'prepare-tools.py'),prepare);run('prepare-tools',python,[join(out,'prepare-tools.py'),out,evidence],{env:{...baseEnv(),PATH:process.env.PATH},timeout:900000});
  const env=buildEnv();run('rustc-version',join(out,'tools/rust/bin/rustc.exe'),['-Vv'],{env});run('cargo-version',join(out,'tools/rust/bin/cargo.exe'),['--version'],{env});
}
if (phase==='freeze') {
  const env=buildEnv(),cwd=join(out,'src','canvas'),cargo=join(out,'tools/rust/bin/cargo.exe');
  const config=join(cwd,'.cargo');mkdirSync(config,{recursive:true});
  const upstreamConfig=readFileSync(join(out,'upstream-cargo-config.toml'),'utf8');
  writeFileSync(join(config,'config.toml'),upstreamConfig+'\n[resolver]\nincompatible-rust-versions = "fallback"\n');
  run('generate-lockfile',cargo,['generate-lockfile'],{cwd,env,timeout:600000});
  const vendor=run('vendor-crates',cargo,['vendor','--locked','--versioned-dirs',join(out,'vendor')],{cwd,env,timeout:900000});
  // Cargo's stdout is the reviewed source replacement configuration, not shell code.
  if (!vendor.stdout.includes('[source.crates-io]') || !vendor.stdout.includes('[source.vendored-sources]')) throw new Error('Cargo vendor source configuration missing');
  writeFileSync(join(config,'config.toml'),upstreamConfig+'\n[resolver]\nincompatible-rust-versions = "fallback"\n'+vendor.stdout);
  copyFileSync(join(cwd,'Cargo.lock'),join(out,'Cargo.lock'));
  writeFileSync(join(out,'frozen-lock.json'),JSON.stringify({sha256:hash(readFileSync(join(out,'Cargo.lock'))),newlyGeneratedLock:true,originalPublisherLockRecovered:false,releaseAccepted:false},null,2)+'\n');
}
if (phase==='freeze'||phase==='inventory') {
  const inventory=String.raw`
from pathlib import Path
import json,tomllib,hashlib,sys,re
O=Path(sys.argv[1]);sha=lambda b:hashlib.sha256(b).hexdigest();lock=tomllib.loads((O/'Cargo.lock').read_text());locked={(p['name'],p['version']):p for p in lock['package']};packages=[];notices=[];count=0
for d in sorted((O/'vendor').iterdir()):
 if not d.is_dir():continue
 manifest=tomllib.loads((d/'Cargo.toml').read_text());pkg=manifest['package'];key=(pkg['name'],pkg['version']);checks=json.loads((d/'.cargo-checksum.json').read_text());assert locked[key]['checksum']==checks['package']
 for path,digest in checks['files'].items():
  if Path(path).is_absolute() or '..' in Path(path).parts:raise ValueError('Vendor traversal rejected')
  f=d/path;assert not f.is_symlink() and f.is_file() and sha(f.read_bytes())==digest;count+=1
 packages.append({'name':key[0],'version':key[1],'license':pkg.get('license'),'licenseFile':pkg.get('license-file'),'registryArchiveSha256':checks['package'],'vendoredFileHashesVerified':len(checks['files'])})
 for f in sorted(d.rglob('*')):
  if f.is_file() and any(x in f.name.upper() for x in ['LICENSE','COPYING','COPYRIGHT','NOTICE','PATENTS']):
   rel=f.relative_to(d).as_posix();flat=re.sub('[^A-Za-z0-9._-]','_',rel);target=O/'legal-notices'/d.name/flat;target.parent.mkdir(parents=True,exist_ok=True);b=f.read_bytes();target.write_bytes(b);notices.append({'package':d.name,'sourceMember':rel,'path':target.relative_to(O).as_posix(),'sha256':sha(b),'bytes':len(b)})
report={'format':'matching-new-frozen-rust-closure-v1','newlyFrozenBuild':True,'originalPublisherLockRecovered':False,'lockSha256':sha((O/'Cargo.lock').read_bytes()),'registryPackages':packages,'vendoredFileHashesVerified':count,'noticeFiles':notices,'legalClearance':False,'releaseAccepted':False}
(O/'frozen-rust-inventory.json').write_text(json.dumps(report,indent=2)+'\n')
components=[{'type':'library','name':p['name'],'version':p['version'],'purl':'pkg:cargo/'+p['name']+'@'+p['version'],'hashes':[{'alg':'SHA-256','content':p['registryArchiveSha256']}],**({'licenses':[{'expression':p['license'].replace('/',' OR ')}]} if p['license'] else {})} for p in packages]
(O/'frozen-rust-sbom.cyclonedx.json').write_text(json.dumps({'bomFormat':'CycloneDX','specVersion':'1.5','version':1,'metadata':{'properties':[{'name':'matching:newly-frozen-closure','value':'true'},{'name':'matching:legal-clearance','value':'false'}]},'components':components},indent=2)+'\n')
print(json.dumps({'registryPackages':len(packages),'vendoredFileHashesVerified':count,'originalNoticeFiles':len(notices),'releaseAccepted':False}))
`;
  writeFileSync(join(out,'inventory-frozen-rust.py'),inventory);run('inventory-frozen-rust',python,[join(out,'inventory-frozen-rust.py'),out],{timeout:180000});
}
if (phase==='build') {
  const env=buildEnv();env.SKIA_DIR=join(out,'src','skia');env.SKIA_LIB_DIR=join(out,'src','skia','out','Static');
  const targetRoot=externalPath(opts['--target-root']||(existsSync(join(out,'build-target.json'))?JSON.parse(readFileSync(join(out,'build-target.json'),'utf8')).path:join(out,'target')));
  const targetMarker=join(targetRoot,'matching-rebuild-target.json'),owner=hash(out);
  if(existsSync(targetRoot)){if(!existsSync(targetMarker)||JSON.parse(readFileSync(targetMarker,'utf8')).owner!==owner)throw new Error('Existing build target is not owned by this rebuild workspace');}
  else{mkdirSync(targetRoot,{recursive:true});writeFileSync(targetMarker,JSON.stringify({format,owner})+'\n');}
  writeFileSync(join(out,'build-target.json'),JSON.stringify({path:targetRoot,owner})+'\n');
  const toolsetRoot=join(vsRoot,'VC','Tools','MSVC');
  const toolsetVersion=readdirSync(toolsetRoot,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^\d+\.\d+\.\d+$/.test(entry.name)).map(entry=>entry.name).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1);
  if(!toolsetVersion)throw new Error('Selected MSVC toolset version is missing');
  const linker=join(toolsetRoot,toolsetVersion,'bin','Hostx64','x64','link.exe');
  if(!existsSync(linker))throw new Error('Selected MSVC x64 linker is missing');
  const cmakeToolchain=join(out,'cmake-static-runtime.cmake');
  writeFileSync(cmakeToolchain,'set(CMAKE_POLICY_DEFAULT_CMP0091 NEW)\nset(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>" CACHE STRING "isolated static runtime" FORCE)\nset(CMAKE_C_FLAGS_RELEASE "/O2 /Ob2 /DNDEBUG" CACHE STRING "isolated release flags" FORCE)\nset(CMAKE_CXX_FLAGS_RELEASE "/O2 /Ob2 /DNDEBUG" CACHE STRING "isolated release flags" FORCE)\n');
  Object.assign(env,{CMAKE_GENERATOR:'Ninja',CARGO_TARGET_DIR:targetRoot,CC:'cl',CXX:'cl',CMAKE_TOOLCHAIN_FILE:cmakeToolchain,CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER:linker});
  run('rustc-version',join(out,'tools/rust/bin/rustc.exe'),['-Vv'],{env});run('cargo-version',join(out,'tools/rust/bin/cargo.exe'),['--version'],{env});
  run('cargo-release-offline',join(out,'tools/rust/bin/cargo.exe'),['build','--release','--locked','--offline','--target','x86_64-pc-windows-msvc','-j','2'],{cwd:join(out,'src','canvas'),env,timeout:1200000});
  const binary=join(targetRoot,'x86_64-pc-windows-msvc','release','canvas.dll');
  writeFileSync(join(out,'build-result.json'),JSON.stringify({rebuiltCanvas:true,binarySha256:hash(readFileSync(binary)),cmakeToolchainSha256:hash(readFileSync(cmakeToolchain)),msvcToolsetVersion:toolsetVersion,frozenLockSha256:hash(readFileSync(join(out,'Cargo.lock'))),skiaStaticLibrariesRebuiltFromSource:false,newFrozenRustClosure:true,runtimeReplaced:false,releaseAccepted:false},null,2)+'\n');
}
if (phase==='qualify') {
  const q=join(out,'qualification');mkdirSync(q,{recursive:true});
  const targetRoot=externalPath(JSON.parse(readFileSync(join(out,'build-target.json'),'utf8')).path);
  const binary=join(q,'skia.win32-x64-msvc.node');copyFileSync(join(targetRoot,'x86_64-pc-windows-msvc','release','canvas.dll'),binary);
  const icu=readFileSync(join(root,'node_modules','@napi-rs','canvas-win32-x64-msvc','icudtl.dat'));
  assert.equal(hash(icu),'9ae98c06cbb0ea43c5cd6b5725310c008c65e46072421a1118cb88e1de9a8b92');writeFileSync(join(q,'icudtl.dat'),icu);
  const qualify=String.raw`
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.argv[2],out=process.argv[3],binary=process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
const canvas=require(path.join(root,'node_modules/@napi-rs/canvas'));
assert.ok(require.cache[binary],'The isolated rebuilt native binary must actually be loaded');
canvas.GlobalFonts.registerFromPath(path.join(root,'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'),'SyntheticAuditFont');
const c=canvas.createCanvas(1100,220),ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1100,220);ctx.fillStyle='black';ctx.font='72px SyntheticAuditFont';ctx.fillText('COMMUNITY 12345',30,130);
const png=c.toBuffer('image/png');fs.writeFileSync(path.join(out,'synthetic-ocr.png'),png);assert.equal(png.subarray(1,4).toString(),'PNG');
const pixels=ctx.getImageData(0,0,20,20).data;assert.equal(pixels[0],255);assert.equal(pixels[3],255);
for(const mime of ['image/jpeg','image/webp'])assert.ok(c.toBuffer(mime).length>100);
(async()=>{
 const loaded=await canvas.loadImage(png);assert.equal(loaded.width,1100);assert.equal(loaded.height,220);
 const {createWorker}=require(path.join(root,'node_modules/tesseract.js'));
 const worker=await createWorker('eng',1,{langPath:path.join(root,'node_modules/@tesseract.js-data/eng/4.0.0'),gzip:true,cacheMethod:'none'});
 let text;
 try{await worker.setParameters({tessedit_pageseg_mode:'7'});const result=await worker.recognize(png);text=result.data.text.trim();assert.match(text,/COMMUNITY/);assert.match(text,/12345/)}finally{await worker.terminate()}
 fs.writeFileSync(path.join(out,'synthetic-image-result.json'),JSON.stringify({rebuiltBinaryLoaded:true,pngJpegWebpEncoded:true,pngRoundTripDimensions:true,fontRendering:true,offlineOcrRecognized:true,syntheticOcrText:text,syntheticOnly:true,releaseAccepted:false},null,2)+'\n');console.log('SYNTHETIC_CANVAS_ABI_IMAGE_OCR_PASS')
})().catch(e=>{console.error(e);process.exitCode=1});
`;
  const script=join(q,'qualify.cjs');writeFileSync(script,qualify);
  const env=baseEnv();env.PATH=process.env.PATH;env.NAPI_RS_NATIVE_LIBRARY_PATH=binary;
  run('qualify-canvas-abi',process.execPath,[script,root,q],{env,timeout:120000});
}
console.log(JSON.stringify({phase,completed:true,runtimeReplaced:false,releaseAccepted:false}));
