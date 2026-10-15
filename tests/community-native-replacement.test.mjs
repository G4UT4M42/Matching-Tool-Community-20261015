import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateNativeReplacement} from '../scripts/package-community.mjs';
import {sha256,reviewedReplacement} from '../scripts/verify-community-package.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function fixture(){
 const folder=mkdtempSync(join(tmpdir(),'community-replacement-metadata-')),packagePath='node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node';
 const add=(path,content)=>{const file=join(folder,path);mkdirSync(dirname(file),{recursive:true});const bytes=Buffer.from(content);writeFileSync(file,bytes);return{path,bytes:bytes.length,sha256:sha256(bytes)};};
 // Synthetic metadata validates admission rules only; this fixture is never loaded as code.
 const binary=add('binary/synthetic.node','MZSYNTHETIC-NOT-EXECUTABLE');
 const qualification={result:'PASS',binarySha256:binary.sha256,sourceSkiaRebuilt:true,offlineOcr:{expected:'COMMUNITY 12345',observed:'COMMUNITY 12345'},checks:{native_load:true,png:true,jpeg:true,webp:true,font:true,pdf_render:true,offline_ocr:true},synthetic_metadata_fixture:true};
 const proof=add('proof/qualification.json',JSON.stringify(qualification));
 const files=[proof,add('source/source.archive','SYNTHETIC SOURCE'),add('source/LICENSE','SYNTHETIC NOTICE')].map(file=>({...file,packagePath:'compliance/native-replacement/fixture/'+file.path}));
 const manifest={format:'matching-community-native-replacement-v1',component:'@napi-rs/canvas-win32-x64-msvc',version:'0.1.97',packagePath,binary,replacedUpstreamSha256:sha256(readFileSync(join(root,packagePath))),sourceBuildQualified:true,qualification:{path:proof.path,sha256:proof.sha256},files,legalClearance:false,releaseAccepted:false,historicalBinaryReproduced:false};
 return{folder,manifest,qualification,write(){writeFileSync(join(folder,'manifest.json'),JSON.stringify(manifest));},close(){assert.ok(resolve(folder).startsWith(resolve(tmpdir())+'\\community-replacement-metadata-'));rmSync(folder,{recursive:true,force:true});}};
}
test('internally consistent self-asserted replacement evidence cannot impersonate the independently reviewed bundle',()=>{
 const f=fixture();try{f.write();assert.throws(()=>validateNativeReplacement(f.folder),/independent source review/);}finally{f.close();}
});
test('the approved manifest cannot authorize substituted native bytes',()=>{
 const f=fixture();try{
  const bytes=readFileSync(join(root,'docs/compliance/canvas-replacement-manifest.json'));assert.equal(sha256(bytes),'907cdd47091358e832c3765610ee61da12145635917655f5b7b23022395a3b58');
  const approved=JSON.parse(bytes);writeFileSync(join(f.folder,'manifest.json'),bytes);const target=join(f.folder,approved.binary.path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,'MZSYNTHETIC-SUBSTITUTED');
  assert.throws(()=>validateNativeReplacement(f.folder),/checksum or bounds/);
 }finally{f.close();}
});

test('the approved full-source WASM manifest rejects empty or substituted modules; retired canvas remains revoked',()=>{
 const bytes=readFileSync(join(root,'docs/compliance/wasm-replacement-manifest.json'));
 assert.equal(sha256(bytes),'222f7ad3b205aefdcf004434fd49525054ba822e39266756d8e2633568bb204c');
 for(const content of [Buffer.alloc(0),Buffer.from('SYNTHETIC-SUBSTITUTED-WASM')]){
  const f=fixture();try{const approved=JSON.parse(bytes);writeFileSync(join(f.folder,'manifest.json'),bytes);const target=join(f.folder,approved.binary.path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,content);assert.throws(()=>validateNativeReplacement(f.folder),/checksum or bounds/);}finally{f.close();}
 }
 assert.throws(()=>reviewedReplacement('5d791594cb4ed6dba342c85522b928a53cad3151f2d47cc83acb09ecb89052b4'),/independent source review/);
});
test('unreviewed metadata variants cannot authorize tampering, path escape, foreign identity or promoted claims',()=>{
 for(const mutate of [f=>f.manifest.packagePath='runtime/node.exe',f=>f.manifest.component='unreviewed-native',f=>f.manifest.replacedUpstreamSha256='0'.repeat(64),f=>f.manifest.binary.path='../escape.node',f=>f.manifest.files[0].packagePath='src/server/index.ts',f=>f.manifest.files[1].packagePath=f.manifest.files[0].packagePath,f=>f.manifest.legalClearance=true,f=>f.manifest.historicalBinaryReproduced=true,f=>writeFileSync(join(f.folder,f.manifest.binary.path),'MZTAMPERED')]){
  const f=fixture();try{mutate(f);f.write();assert.throws(()=>validateNativeReplacement(f.folder));}finally{f.close();}
 }
});
test('self-asserted source and OCR proof cannot gain admission through internally matching hashes',()=>{
 for(const mutate of [q=>q.sourceSkiaRebuilt=false,q=>q.binarySha256='0'.repeat(64),q=>q.offlineOcr.observed='WRONG',q=>q.checks.pdf_render=false]){
  const f=fixture();try{mutate(f.qualification);const bytes=Buffer.from(JSON.stringify(f.qualification));writeFileSync(join(f.folder,'proof/qualification.json'),bytes);f.manifest.files[0].bytes=bytes.length;f.manifest.files[0].sha256=sha256(bytes);f.manifest.qualification.sha256=sha256(bytes);f.write();assert.throws(()=>validateNativeReplacement(f.folder),/independent source review/);}finally{f.close();}
 }
 const f=fixture();try{f.manifest.qualification.sha256='0'.repeat(64);f.write();assert.throws(()=>validateNativeReplacement(f.folder),/independent source review/);}finally{f.close();}
});
