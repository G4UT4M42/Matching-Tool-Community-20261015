import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {buildPackage} from '../../scripts/package-community.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
/** Fresh development package for the one-session acceptance; never a release. */
export function acceptancePackage(){
 const temporary=mkdtempSync(join(tmpdir(),'community-integrated-package-')),compliance=join(temporary,'compliance'),packageDirectory=join(temporary,'package');
 const close=()=>{if(!resolve(temporary).startsWith(resolve(tmpdir())+'\\community-integrated-package-'))throw new Error('Unexpected test package cleanup path');rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});};
 try{
  const inventory=spawnSync(process.execPath,[join(root,'scripts/create-compliance-inventory.mjs'),'--out',compliance],{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000});
  if(inventory.status!==0)throw new Error('Synthetic acceptance package inventory failed: '+(inventory.stderr||inventory.stdout).slice(-1500));
  const result=buildPackage({out:packageDirectory,compliance,replacement:process.env.MATCHING_ACCEPTANCE_NATIVE_REPLACEMENT});
  if(result.distributable!==false||result.releaseAccepted!==false)throw new Error('Unexpected acceptance promotion');
  const manifest=JSON.parse(readFileSync(join(packageDirectory,'community-package.json'),'utf8'));
  return{packageDirectory,result,manifest,close};
 }catch(error){close();throw error;}
}
