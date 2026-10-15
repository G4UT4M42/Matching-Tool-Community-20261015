#!/usr/bin/env node
/** Synthetic, isolated libvips DLL replacement proof. Never changes application binaries. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),opts={},args=process.argv.slice(2);
while(args.length){const key=args.shift();if(!['--out','--phase','--dll','--cpp-dll','--expected-version'].includes(key)||!args.length||opts[key])throw new Error('Use --out <new-absolute-external-directory> --phase proof|qualify [--dll <external-built-DLL>] [--cpp-dll <external-built-C++-DLL>] [--expected-version <semver>]');opts[key]=args.shift();}
const sha=b=>createHash('sha256').update(b).digest('hex');
function external(value){
  if(!value||!isAbsolute(value))throw new Error('An absolute external path is required');
  const path=resolve(value),rel=relative(root,path);
  if(!(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)))throw new Error('Replacement qualification must stay outside the checkout');
  for(let p=path;;p=dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw new Error('Linked external path rejected');if(dirname(p)===p)break;}
  return path;
}
const out=external(opts['--out']),phase=opts['--phase'],format='matching-isolated-libvips-relink-v1';
if(!['proof','qualify'].includes(phase))throw new Error('Unknown phase');
if(phase==='proof'){
  if(existsSync(out))throw new Error('Use a fresh external qualification workspace');
  mkdirSync(out,{recursive:true});writeFileSync(join(out,'workspace.json'),JSON.stringify({format,runtimeReplaced:false,legalClearance:false,releaseAccepted:false})+'\n');
}else if(JSON.parse(readFileSync(join(out,'workspace.json'),'utf8')).format!==format)throw new Error('Not an owned qualification workspace');
for(const d of ['logs','tmp','home'])mkdirSync(join(out,d),{recursive:true});
const packageDir=join(root,'node_modules','@img','sharp-win32-x64','lib');
const bindingName='sharp-win32-x64-0.35.5.node',cppName='libvips-cpp-8.18.7.dll',dllName='libvips-42.dll';
const upstream=readFileSync(join(packageDir,dllName));
function environment(){const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','ProgramFiles','ProgramFiles(x86)','PATHEXT'])if(process.env[key])env[key]=process.env[key];return {...env,HOME:join(out,'home'),USERPROFILE:join(out,'home'),TEMP:join(out,'tmp'),TMP:join(out,'tmp')};}
function run(name,exe,args,{cwd=out,env=environment(),timeout=90000}={}){
  const started=Date.now(),result=spawnSync(exe,args,{cwd,env,timeout,encoding:null,maxBuffer:32*1024*1024,windowsHide:true});
  writeFileSync(join(out,'logs',name+'.log'),Buffer.concat([result.stdout||Buffer.alloc(0),result.stderr||Buffer.alloc(0)]));
  writeFileSync(join(out,'logs',name+'.json'),JSON.stringify({exitCode:result.status,errorCode:result.error?.code||null,elapsedMs:Date.now()-started,executable:exe.split(/[\\/]/).pop(),args},null,2)+'\n');
  if(result.error||result.status!==0)throw new Error(name+' failed; see isolated log');return result;
}
function exportsOf(b){
  const pe=b.readUInt32LE(0x3c);if(b.toString('ascii',pe,pe+4)!=='PE\0\0')throw new Error('Invalid PE signature');
  const count=b.readUInt16LE(pe+6),size=b.readUInt16LE(pe+20),opt=pe+24;if(b.readUInt16LE(opt)!==0x20b)throw new Error('Expected Windows x64 DLL');
  const sections=[];for(let i=0;i<count;i++){const p=opt+size+i*40;sections.push({rva:b.readUInt32LE(p+12),size:Math.max(b.readUInt32LE(p+8),b.readUInt32LE(p+16)),offset:b.readUInt32LE(p+20)});}
  function pos(rva){const s=sections.find(s=>s.rva<=rva&&rva<s.rva+s.size);if(!s)throw new Error('PE RVA outside sections');return s.offset+rva-s.rva;}
  function string(rva){const p=pos(rva),end=b.indexOf(0,p);if(end<0)throw new Error('Unterminated PE export');return b.toString('ascii',p,end);}
  const e=pos(b.readUInt32LE(opt+112)),base=b.readUInt32LE(e+16),functions=b.readUInt32LE(e+20),names=b.readUInt32LE(e+24),nameTable=pos(b.readUInt32LE(e+32)),ordinalTable=pos(b.readUInt32LE(e+36));
  if(functions!==names||names>20000)throw new Error('Unsupported unnamed or excessive PE exports');
  const result=[];for(let i=0;i<names;i++){const name=string(b.readUInt32LE(nameTable+i*4));if(!/^\w+$/.test(name))throw new Error('Unsupported export name');result.push({name,ordinal:base+b.readUInt16LE(ordinalTable+i*2)});}return result;
}
let target=join(out,'recipient-proxy'),expected='8.18.77',fullSourceRebuild=false;
if(phase==='proof'){
  mkdirSync(target);const rows=exportsOf(upstream),overrides=['vips_version','vips_version_string'];
  if(!overrides.every(n=>rows.some(e=>e.name===n)))throw new Error('Version exports missing');
  writeFileSync(join(target,'recipient.c'),'__declspec(dllexport) const char *vips_version_string(void) { return "8.18.7-recipient-probe"; }\n__declspec(dllexport) int vips_version(int flag) { return flag==0?8:flag==1?18:flag==2?77:0; }\n');
  writeFileSync(join(target,'recipient.def'),'LIBRARY "libvips-42"\nEXPORTS\n'+rows.map(e=>' '+e.name+(overrides.includes(e.name)?'':'=vipsoriginal.'+e.name)+' @'+e.ordinal).join('\n')+'\n');
  writeFileSync(join(target,'vipsoriginal.dll'),upstream);
  for(const n of [bindingName,cppName])copyFileSync(join(packageDir,n),join(target,n));
  const vswhere=join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','Microsoft Visual Studio','Installer','vswhere.exe');
  const found=spawnSync(vswhere,['-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-format','json'],{encoding:'utf8',timeout:15000,windowsHide:true});
  if(found.status!==0)throw new Error('MSVC metadata unavailable');
  const all=JSON.parse(found.stdout),vs=all.find(x=>x.installationPath.includes('2022'))||all[0];if(!vs)throw new Error('MSVC unavailable');
  const tools=join(vs.installationPath,'VC','Tools','MSVC'),version=readdirSync(tools).filter(n=>/^\d+\.\d+\.\d+$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1);
  const cl=join(tools,version,'bin','Hostx64','x64','cl.exe'),link=join(vs.installationPath,'VC','Tools','Llvm','x64','bin','lld-link.exe');
  if(!existsSync(link))throw new Error('LLVM COFF linker is required for the forwarding proof');
  run('recipient-compile',cl,['/nologo','/c','/MT','/O2','recipient.c'],{cwd:target});
  run('recipient-link',link,['/NOLOGO','/DLL','/NOENTRY','/NODEFAULTLIB','recipient.obj','/DEF:recipient.def','/OUT:'+dllName],{cwd:target});
  writeFileSync(join(out,'replacement-build.json'),JSON.stringify({upstreamSha256:sha(upstream),recipientDllSha256:sha(readFileSync(join(target,dllName))),forwardedExports:rows.length-2,overriddenExports:overrides,expectedNativeVersion:expected,msvcToolset:version,originalLibraryStillUsed:true,fullSourceRebuild:false,runtimeReplaced:false,legalClearance:false,releaseAccepted:false},null,2)+'\n');
}else if(opts['--dll']){
  const dll=external(opts['--dll']);target=join(out,'source-replacement');if(existsSync(target))throw new Error('Use a fresh source-replacement destination');mkdirSync(target);
  copyFileSync(dll,join(target,dllName));copyFileSync(opts['--cpp-dll']?external(opts['--cpp-dll']):join(packageDir,cppName),join(target,cppName));copyFileSync(join(packageDir,bindingName),join(target,bindingName));
  expected=opts['--expected-version']||'8.18.7';if(!/^\d+\.\d+\.\d+$/.test(expected))throw new Error('Expected version must be numeric semver');
  fullSourceRebuild=false; // A supplied DLL alone cannot establish its source build provenance.
}
const qualify=String.raw`
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict'),Module=require('node:module'),crypto=require('node:crypto');
const [root,out,expected]=process.argv.slice(2),binary=path.join(out,'sharp-win32-x64-0.35.5.node'),original=Module._resolveFilename;
Module._resolveFilename=function(id,...rest){if(id==='@img/sharp-win32-x64/sharp.node')return binary;return original.call(this,id,...rest)};
const sharp=require(path.join(root,'node_modules/sharp/dist/index.cjs'));assert.ok(require.cache[binary]);
const observed=require.cache[binary].exports.libvipsVersion().semver;assert.equal(observed,expected);
(async()=>{const input=await sharp({create:{width:40,height:30,channels:3,background:{r:20,g:100,b:200}}}).png().toBuffer();for(const format of ['png','jpeg','webp']){const output=await sharp(input).resize(13,9)[format]().toBuffer();const meta=await sharp(output).metadata();assert.equal(meta.width,13);assert.equal(meta.height,9);fs.writeFileSync(path.join(out,'synthetic-'+format+'.'+format),output)}
fs.writeFileSync(path.join(out,'qualification.json'),JSON.stringify({result:'PASS',observedNativeVersion:observed,nativeBindingUnchanged:true,syntheticResizePngJpegWebp:true,loadedDlls:process.report.getReport().sharedObjects.filter(p=>/vips|sharp/i.test(p)).map(p=>path.basename(p)),dllSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(out,'libvips-42.dll'))).digest('hex'),syntheticOnly:true,runtimeReplaced:false,legalClearance:false,releaseAccepted:false},null,2)+'\n');console.log('SYNTHETIC_DLL_REPLACEMENT_PASS')})().catch(e=>{console.error(e);process.exitCode=1});
`;
writeFileSync(join(out,'qualify.cjs'),qualify);run('synthetic-dll-qualification',process.execPath,[join(out,'qualify.cjs'),root,target,expected],{timeout:120000});
writeFileSync(join(out,'result.json'),JSON.stringify({phase,result:'PASS',dllSha256:sha(readFileSync(join(target,dllName))),fullSourceRebuild,originalLibraryStillUsed:phase==='proof'||!opts['--dll'],runtimeReplaced:false,legalClearance:false,releaseAccepted:false},null,2)+'\n');
console.log(JSON.stringify({phase,result:'PASS',runtimeReplaced:false,legalClearance:false,releaseAccepted:false}));
