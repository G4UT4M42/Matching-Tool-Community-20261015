import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {validateNativeSupplement} from '../scripts/package-community.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('native source supplement binds unchanged notices and rejects conflicting, corrupt or unreviewed destinations',()=>{
 const root=mkdtempSync(join(tmpdir(),'community-native-supplement-'));
 try{
  const bytes=Buffer.from('Synthetic upstream permission, unchanged.');mkdirSync(join(root,'notices'));writeFileSync(join(root,'notices','permission.txt'),bytes);
  const manifest={format:'matching-community-supplemental-native-v1',noticeWordingModified:false,correspondingSourceComplete:false,relinkQualificationComplete:false,legalClearance:false,releaseAccepted:false,files:[{path:'notices/permission.txt',packagePath:'compliance/native-notices/permission.txt',sha256:sha(bytes),bytes:bytes.length}]};
  for(const name of ['comparisons.json','retrieval-history.json','SHA256SUMS'])writeFileSync(join(root,name),'Synthetic evidence');
  const save=()=>writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest));save();assert.equal(validateNativeSupplement(root).files.length,1);
  assert.equal(validateNativeSupplement(root).manifestSha256,sha(readFileSync(join(root,'manifest.json'))));
  manifest.files.push({...manifest.files[0],path:'notices/Permission.txt'});save();assert.throws(()=>validateNativeSupplement(root),/Duplicate/);manifest.files.pop();
  manifest.files[0].packagePath='src/server/index.ts';save();assert.throws(()=>validateNativeSupplement(root),/destination/);manifest.files[0].packagePath='compliance/native-notices/permission.txt';
  manifest.releaseAccepted=true;save();assert.throws(()=>validateNativeSupplement(root),/claim/);manifest.releaseAccepted=false;save();
  writeFileSync(join(root,'notices','permission.txt'),Buffer.alloc(bytes.length));assert.throws(()=>validateNativeSupplement(root),/checksum/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
