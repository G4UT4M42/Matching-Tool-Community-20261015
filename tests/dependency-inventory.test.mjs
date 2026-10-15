import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryFromLock, summarize } from '../scripts/generate-dependency-inventory.mjs';

const digest='sha512-'+Buffer.alloc(64,42).toString('base64');
const fake=(value={})=>({lockfileVersion:3,packages:{'':{name:'fictional-application',version:'0.0.0'},
  'node_modules/@fictional/package':{version:'1.2.3',resolved:'https://registry.npmjs.org/@fictional/package/-/package-1.2.3.tgz',
    integrity:digest,license:'MIT',...value}}});

test('P17 local lockfile inventory includes exact dependency version, hash, scope and declared license',()=>{
  const items=inventoryFromLock(fake(),'root');
  assert.equal(items.length,1);
  const p=items[0];
  assert.equal(p.name,'@fictional/package');
  assert.equal(p.version,'1.2.3');
  assert.equal(p['bom-ref'],'npm:root:node_modules/@fictional/package@1.2.3');
  assert.equal(p.hashes[0].alg,'SHA-512');
  assert.equal(p.licenses[0].license.id,'MIT');
  assert.equal(summarize(items).unknown_license_packages.length,0);
});
test('P17 distinct workspace or nested version produces a distinct component reference',()=>{
  const first=inventoryFromLock(fake(),'root')[0],second=inventoryFromLock(fake(),'web')[0];
  assert.notEqual(first['bom-ref'],second['bom-ref']);
  assert.equal(first.purl,second.purl);
});
test('P17 undeclared licenses are explicitly reported, never inferred as redistributable',()=>{
  const source=fake();delete source.packages['node_modules/@fictional/package'].license;
  const result=summarize(inventoryFromLock(source,'root'));
  assert.equal(result.unknown_license_packages.length,1);
  assert.equal(result.ownership_or_redistribution_rights_verified,false);
});
test('P17 refuses malformed or unauthorized dependency paths',()=>{
  for(const key of ['node_modules/../unsafe','node_modules/a/b','node_modules/','node_modules/.']) {
    const source={lockfileVersion:3,packages:{[key]:{version:'1.0.0'}}};
    assert.throws(()=>inventoryFromLock(source,'root'));
  }
});
test('P17 rejects credential-bearing package URLs rather than leaking them to an SBOM',()=>{
  const address=new URL('https://registry.npmjs.org/example.tgz');
  address.username='synthetic'; address.password='fictional-only';
  const source=fake({resolved:address.href});
  assert.throws(()=>inventoryFromLock(source,'root'),/credentials/);
});
test('P17 rejects invalid integrity and incomplete package metadata',()=>{
  assert.throws(()=>inventoryFromLock(fake({integrity:'unsupported-hash'}),'root'),/digest/);
  assert.throws(()=>inventoryFromLock(fake({version:null}),'root'),/metadata/);
  assert.throws(()=>inventoryFromLock({lockfileVersion:1,packages:{}},'root'),/Invalid/);
});
test('P17 counts nonregistry hosts without treating them as license certification',()=>{
  const source=fake({resolved:'https://cdn.fictional.example/package.tgz'});
  const summary=summarize(inventoryFromLock(source,'web'));
  assert.deepEqual(summary.package_hosts,{'cdn.fictional.example':1});
  assert.equal(summary.ownership_or_redistribution_rights_verified,false);
});
