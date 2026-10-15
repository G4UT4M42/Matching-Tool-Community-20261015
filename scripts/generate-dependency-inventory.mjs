#!/usr/bin/env node
/**
 * Generate a factual dependency inventory from the two frozen npm lockfiles.
 * An SPDX identifier in metadata is a claim by a dependency, not a legal review.
 * No downloaded asset, binary, invoice, owner account or secret is scanned.
 */
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function outside(root, folder) {
  if (!isAbsolute(folder)) throw new Error('Specify a writable absolute evidence directory');
  const target = resolve(folder), rel = relative(root, target);
  if (!(rel === '..' || rel.startsWith('..'+sep) || isAbsolute(rel))) throw new Error('The inventory may not be written into source');
  return target;
}
function readLock(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 20*1024*1024) throw new Error('Unexpected dependency lockfile');
  const raw=readFileSync(path);
  const lock=JSON.parse(raw.toString('utf8'));
  if (!lock || lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') throw new Error('Expected npm v3 dependency locks');
  return {lock,digest:sha(raw)};
}
function pkgName(key) {
  const index=key.lastIndexOf('node_modules/');
  if (index < 0) throw new Error('Dependency path outside node_modules');
  const name=key.slice(index+'node_modules/'.length);
  if (!/^(@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)$/.test(name) || name.includes('..') || name === '.') throw new Error('Unexpected package name');
  return name;
}
function provenance(resolved) {
  if (resolved === undefined || resolved === null) return 'missing';
  if (typeof resolved !== 'string' || resolved.length > 2000) throw new Error('Invalid dependency location');
  if (resolved.startsWith('file:') || resolved.startsWith('link:')) return 'local';
  if (/^[A-Za-z0-9]+:/.test(resolved)) {
    const url = new URL(resolved);
    if (url.username || url.password) throw new Error('Lockfile dependency location unexpectedly contains credentials');
    return url.protocol === 'https:' ? url.hostname.toLowerCase() : 'non-https';
  }
  return 'nonstandard';
}
function license(value) {
  if (typeof value === 'string') return value.trim().slice(0,160) || null;
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.type === 'string') return value.type.trim().slice(0,160);
  return null;
}
function installedLicense(installRoot, lockPath, expectedName, expectedVersion) {
  if (!installRoot) return null;
  const parent=resolve(installRoot);
  let folder=parent;
  for (const piece of lockPath.split('/')) {
    if (!piece || piece==='.' || piece==='..') return null;
    folder=join(folder,piece);
    if (!existsSync(folder) || lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory()) return null;
  }
  const file=join(folder,'package.json');
  if (!existsSync(file)) return null;
  const info=lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size>1024*1024) return null;
  const data=JSON.parse(readFileSync(file,'utf8'));
  if (data.name!==expectedName || data.version!==expectedVersion) return null;
  return license(data.license);
}
export function inventoryFromLock(lock, workspace, installRoot = null) {
  if (!lock || lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') throw new Error('Invalid npm lock inventory');
  const components=[];
  for (const [path, item] of Object.entries(lock.packages)) {
    if (!path) continue; // application root, not a fetched dependency
    if (!path.includes('node_modules/')) continue; // workspace packages are reviewed separately
    const name=pkgName(path);
    const meta=item;
    if (!meta || typeof meta !== 'object' || typeof meta.version !== 'string' || !/^[0-9A-Za-z.+-]{1,100}$/.test(meta.version)) throw new Error('Incomplete dependency metadata');
    const site=provenance(meta.resolved);
    const integrity=meta.integrity;
    const hashes=[];
    if (integrity!==undefined) {
      if (typeof integrity !== 'string' || integrity.length > 500) throw new Error('Unexpected lockfile integrity');
      for (const part of integrity.split(/\s+/)) {
        const matched=/^(sha512|sha384|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(part);
        if (!matched) throw new Error('Unsupported lockfile digest');
        hashes.push({alg:matched[1].toUpperCase().replace('SHA','SHA-'),content:matched[2]});
      }
    }
    const lockLicense=license(meta.license);
    const installed=lockLicense ? null : installedLicense(installRoot,path,name,meta.version);
    const declaredLicense=lockLicense ?? installed;
    const component={
      type:'library', 'bom-ref':`npm:${workspace}:${path}@${meta.version}`,
      name, version:meta.version, purl:`pkg:npm/${name.replace('/','%2F')}@${meta.version}`,
      ...(declaredLicense?{licenses:[{license:{id:declaredLicense}}]}:{}),
      ...(hashes.length?{hashes}:{}),
      properties:[
        {name:'matching:workspace',value:workspace},
        {name:'matching:installation_path',value:path},
        {name:'matching:dependency_kind',value:meta.dev?'development':'production'},
        {name:'matching:package_host',value:site},
        {name:'matching:license_evidence',value:lockLicense?'declared_in_lockfile_only':installed?'declared_in_installed_package_manifest':'missing_from_metadata'},
      ]
    };
    components.push(component);
  }
  return components.sort((left,right)=>left['bom-ref'].localeCompare(right['bom-ref'],'en'));
}
export function summarize(components) {
  const hosts={},licenses={},missing=[], nonHttps=[];
  for (const c of components) {
    const prop=Object.fromEntries(c.properties.map(p=>[p.name,p.value]));
    hosts[prop['matching:package_host']]=(hosts[prop['matching:package_host']]??0)+1;
    const selected=c.licenses?.[0]?.license?.id??'UNDECLARED';
    licenses[selected]=(licenses[selected]??0)+1;
    if(selected==='UNDECLARED')missing.push(`${prop['matching:workspace']}:${c.name}@${c.version}`);
    if(prop['matching:package_host']==='non-https') nonHttps.push(c['bom-ref']);
  }
  return {components:components.length,declared_licenses:licenses,package_hosts:hosts,unknown_license_packages:missing,
    non_https_entries:nonHttps,ownership_or_redistribution_rights_verified:false};
}
if (process.argv[1] && resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length!==3) throw new Error('Usage: node scripts/generate-dependency-inventory.mjs <external-evidence-dir>');
    const evidence=outside(repo,process.argv[2]);
    const locks=[
      ['root',readLock(join(repo,'package-lock.json'))],
      ['web',readLock(join(repo,'web','package-lock.json'))],
    ];
    const components=locks.flatMap(([name,content])=>inventoryFromLock(content.lock,name,name==='root'?repo:join(repo,'web')));
    const summary=summarize(components);
    mkdirSync(evidence,{recursive:true});
    const bom={bomFormat:'CycloneDX',specVersion:'1.5',version:1,
      metadata:{component:{type:'application',name:'matching-tool-community',version:'unreleased-integration-candidate'}},
      components};
    const result={format:'matching-community-dependency-inventory-v1',
      generated_at:new Date().toISOString(),source_lock_hashes:Object.fromEntries(locks.map(([name,value])=>[name,value.digest])),
      ...summary, legal_review_required:true, source_history_privacy_review_required:true, release_accepted:false};
    writeFileSync(join(evidence,'sbom-cyclonedx-draft.json'),JSON.stringify(bom,null,2));
    writeFileSync(join(evidence,'dependency-rights-review.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({components:summary.components, unknown_licenses:summary.unknown_license_packages.length,
      non_https_entries:summary.non_https_entries.length,hosts:summary.package_hosts,
      legal_review_required:true,release_accepted:false},null,2));
  } catch(error) {console.error(error instanceof Error?error.message:'Dependency inventory failed');process.exitCode=1;}
}
