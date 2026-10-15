import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CredentialVault,type KeyProtector} from '../src/community/integrations/vault.js';
import {IntegrationService,type IntegrationGuards} from '../src/community/integrations/service.js';
import {prepareProviderImport} from '../src/community/integrations/canonical-import.js';
import {providerAccountIdentity} from '../src/community/integrations/provider-account.js';
import type {MatchingState} from '../src/core/types.js';
import type {Transport,Principal,Provider,Environment,CommitBatch} from '../src/community/integrations/types.js';
class SyntheticProtector implements KeyProtector{
 private key=randomBytes(32);
 protect(plain:Buffer,context:Buffer){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(context);return Buffer.concat([iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);}
 unprotect(bytes:Buffer,context:Buffer){const cipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));cipher.setAAD(context);cipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]);}
}
class DeferredVault extends CredentialVault{
 beforeCredentialCommit?:()=>void;beforeRemovalCommit?:()=>void;
 override async put(p:Principal,provider:Provider,environment:Environment,credentials:Record<string,string>,guard?:()=>void){await super.put(p,provider,environment,credentials,()=>{this.beforeCredentialCommit?.();guard?.();});}
 override async remove(p:Principal,provider:Provider,environment:Environment,guard?:()=>void){await super.remove(p,provider,environment,()=>{this.beforeRemovalCommit?.();guard?.();});}
}
const principal={subject:'SYNTHETIC-PROVIDER-RACE-OWNER'},account=providerAccountIdentity('stripe','test','acct_SYNTHETICCOVERAGE');
const credential={apiKey:'rk_test_SYNTHETICORIGINAL'},replacement={apiKey:'rk_test_SYNTHETICREPLACEMENT'};
const previousRoot=process.env.MATCHING_RUNTIME_ROOT,previousMode=process.env.MATCHING_RUNTIME_MODE;
let root:string,runtime:string,vault:DeferredVault,state:MatchingState,authorized:boolean,now:Date,requests:string[],providerRows:Array<Record<string,unknown>>,guards:IntegrationGuards,service:IntegrationService,afterCommit:(()=>void)|undefined;
let db:typeof import('../src/storage/db.js'),json:typeof import('../src/storage/json-store.js'),canonical:typeof import('../src/storage/canonical-transaction.js');
const checkpointPath=()=>join(vault.directory,readdirSync(vault.directory).find(name=>name.endsWith('.checkpoint'))!);
function checkpoint(){const box=JSON.parse(readFileSync(checkpointPath(),'utf8')),plain=vault.openMetadata(principal,'stripe','test',Buffer.from(box.ciphertext,'base64'));try{return JSON.parse(plain.toString('utf8'));}finally{plain.fill(0);}}
function rewriteCheckpoint(value:unknown){const plain=Buffer.from(JSON.stringify(value));try{const cipher=vault.sealMetadata(principal,'stripe','test',plain);writeFileSync(checkpointPath(),JSON.stringify({version:1,ciphertext:cipher.toString('base64')}));cipher.fill(0);}finally{plain.fill(0);}}
const transport:Transport=async request=>{
 if(request.url==='https://api.stripe.com/v1/account')return{status:200,json:{id:'acct_SYNTHETICCOVERAGE',object:'account'}};
 requests.push(request.url);const url=new URL(request.url),start=Number(url.searchParams.get('created[gte]')),end=Number(url.searchParams.get('created[lte]'));
 return{status:200,json:{data:providerRows.filter(row=>Number(row.created)>=start&&Number(row.created)<=end),has_more:false}};
};
const commit:CommitBatch=async batch=>{guards.authorizeMutation?.(principal,'integrations:sync');const result=prepareProviderImport(state,batch);if(result.added)state=canonical.commitCanonicalState(state,result.state,principal.subject);afterCommit?.();return result.importedEvents;};
const makeService=()=>new IntegrationService(vault,commit,transport,()=>now,guards);
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),'provider-race-coverage-synthetic-'));runtime=join(root,'runtime');process.env.MATCHING_RUNTIME_ROOT=runtime;process.env.MATCHING_RUNTIME_MODE='external-runtime-root';vi.resetModules();
 db=await import('../src/storage/db.js');db.getDb();json=await import('../src/storage/json-store.js');canonical=await import('../src/storage/canonical-transaction.js');state=json.createEmptyState('SYNTHETIC-PROVIDER-COVERAGE');json.saveState(state);canonical.initializeCanonicalState(state);
 vault=new DeferredVault(join(runtime,'identity','provider-vault'),new SyntheticProtector());authorized=true;now=new Date('2026-06-15T00:00:00Z');requests=[];afterCommit=undefined;
 providerRows=[{id:'txn_SYN_OLD',type:'charge',amount:1000,fee:0,net:1000,currency:'eur',created:Date.parse('2026-06-01T00:00:00Z')/1000},{id:'txn_SYN_RECENT',type:'charge',amount:2000,fee:0,net:2000,currency:'eur',created:Date.parse('2026-10-01T00:00:00Z')/1000}];
 guards={authorizeMutation:()=>{if(!authorized)throw Error('AUTHENTICATION_REQUIRED');},hasCanonicalCoverage:input=>{
   const keys=new Set([...state.transactions.values()].filter(tx=>tx.source_system===input.provider&&tx.source_account_id===input.account+':'+input.environment&&!tx.tags.includes('provider-fee')).map(tx=>typeof tx.meta.provider_source_event_key==='string'?tx.meta.provider_source_event_key:`${tx.currency_code}:${tx.booking_reference}`));return input.seen.every(key=>keys.has(key));
 }};service=makeService();
});
afterEach(()=>{db?.closeDb();if(previousRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=previousRoot;if(previousMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=previousMode;rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});vi.resetModules();});
async function backupNow(){const backup=await import('../src/community/persistence/backup.js');return backup.createCommunityBackup(runtime,async run=>run());}
async function restoreArchive(path:string){const restore=await import('../src/community/persistence/restore.js'),stage=await restore.stageCommunityRestore(runtime,readFileSync(path),async run=>run());await restore.activateCommunityRestore(runtime,stage.id,stage.fingerprint,async run=>run(),async(change,rollback)=>{db.closeDb();try{change();db.getDb();state=json.loadState()!;canonical.initializeCanonicalState(state);}catch(error){db.closeDb();rollback();db.getDb();throw error;}});}

describe('provider mutation authorization at the filesystem commit boundary',()=>{
 it('rejects revocation during configure preparation and preserves the previous active credential and checkpoint bytes',async()=>{
  await service.configure(principal,'stripe','test',credential);await service.synchronize(principal,'stripe','test');const before=readFileSync(checkpointPath());vault.beforeCredentialCommit=()=>{authorized=false;};
  await expect(service.configure(principal,'stripe','test',replacement)).rejects.toThrow('AUTHENTICATION_REQUIRED');expect(await vault.get(principal,'stripe','test')).toEqual(credential);expect(readFileSync(checkpointPath())).toEqual(before);expect(readdirSync(vault.directory)).toHaveLength(2);
 });
 it('rejects revocation during disconnect preparation without deleting either protected member',async()=>{
  await service.configure(principal,'stripe','test',credential);await service.synchronize(principal,'stripe','test');const before=readFileSync(checkpointPath());vault.beforeRemovalCommit=()=>{authorized=false;};
  await expect(service.disconnect(principal,'stripe','test')).rejects.toThrow('AUTHENTICATION_REQUIRED');expect(await vault.get(principal,'stripe','test')).toEqual(credential);expect(readFileSync(checkpointPath())).toEqual(before);
 });
 it('does not advance the active checkpoint after revocation immediately following a proved accounting commit',async()=>{
  await service.configure(principal,'stripe','test',credential);await service.synchronize(principal,'stripe','test');const before=readFileSync(checkpointPath());now=new Date('2026-10-15T00:00:00Z');afterCommit=()=>{authorized=false;};
  await expect(service.synchronize(principal,'stripe','test')).rejects.toThrow('INTEGRATION_FAILED');expect(readFileSync(checkpointPath())).toEqual(before);expect(state.transactions.size).toBe(1);expect(json.loadState()).toEqual(state);
 });
});

describe('durable provider coverage across accounting restore and reconnect',()=>{
 it('replays the original coverage after actual backup activation and service restart, using time-filtered provider requests',async()=>{
  const backup=await backupNow();await service.configure(principal,'stripe','test',credential);await service.synchronize(principal,'stripe','test');now=new Date('2026-10-15T00:00:00Z');await service.synchronize(principal,'stripe','test');expect(state.transactions.size).toBe(2);
  const before=checkpoint();expect(before.coverageStart).toBe('2026-05-16T00:00:00.000Z');expect(before.account).toBe(account);await restoreArchive(backup.path);expect(state.transactions.size).toBe(0);
  service=makeService();requests=[];expect((await service.synchronize(principal,'stripe','test')).imported).toBe(2);expect(state.transactions.size).toBe(2);expect(json.loadState()).toEqual(state);
  expect(Number(new URL(requests[0]).searchParams.get('created[gte]'))).toBe(Date.parse(before.coverageStart)/1000);expect(checkpoint().coverageStart).toBe(before.coverageStart);
 });
 it('does not let another provider account with the same reference mask lost current-account evidence',async()=>{
  await service.configure(principal,'stripe','test',credential);await service.synchronize(principal,'stripe','test');const missing=state.transactions.values().next().value!;
  state=canonical.commitCanonicalState(state,{...structuredClone(state),transactions:new Map([...state.transactions])},principal.subject);
  const backup=await backupNow();now=new Date('2026-10-15T00:00:00Z');await service.synchronize(principal,'stripe','test');await restoreArchive(backup.path);
  // Restore contains the older current-account row but lacks the recent row.
  // Add the missing reference under another verified account: it must not count.
  const otherAccount=providerAccountIdentity('stripe','test','acct_SYNTHETICOTHER'),result=prepareProviderImport(state,{principal,provider:'stripe',environment:'test',checkpoint:{cursor:null,seen:[]},transactions:[{provider:'stripe',environment:'test',account:otherAccount,reference:'txn_SYN_RECENT',occurredAt:'2026-10-01T00:00:00.000Z',currency:'EUR',amountMinor:2000,feeMinor:0,netMinor:2000,classification:'payment',revenue:true}]});state=canonical.commitCanonicalState(state,result.state,principal.subject);
  requests=[];expect((await service.synchronize(principal,'stripe','test')).imported).toBe(1);expect(state.transactions.size).toBe(3);expect(state.transactions.has(missing.transaction_id)).toBe(true);expect(new URL(requests[0]).searchParams.get('created[gte]')).toBe(String(Date.parse('2026-05-16T00:00:00Z')/1000));
 });
 it('retains the earliest coverage through disconnect/reconnect instead of forgetting older history',async()=>{
  const backup=await backupNow();await service.configure(principal,'stripe','test',credential);await service.synchronize(principal,'stripe','test');const first=checkpoint().coverageStart;await service.disconnect(principal,'stripe','test');expect((await service.status(principal,'stripe','test')).configured).toBe(false);
  now=new Date('2026-10-15T00:00:00Z');await service.configure(principal,'stripe','test',replacement);expect(checkpoint().coverageStart).toBe(first);await restoreArchive(backup.path);requests=[];
  expect((await service.synchronize(principal,'stripe','test')).imported).toBe(2);expect(state.transactions.size).toBe(2);expect(Number(new URL(requests[0]).searchParams.get('created[gte]'))).toBe(Date.parse(first)/1000);
 });
 it('fails closed for legacy seen references with no recorded account or coverage boundary, including reconnect',async()=>{
  await service.configure(principal,'stripe','test',credential);await service.synchronize(principal,'stripe','test');const legacy=checkpoint();delete legacy.account;delete legacy.coverageStart;rewriteCheckpoint(legacy);
  await expect(service.synchronize(principal,'stripe','test')).rejects.toThrow('CHECKPOINT_BACKFILL_REQUIRED');expect(state.transactions.size).toBe(1);
  await service.configure(principal,'stripe','test',replacement);await expect(service.synchronize(principal,'stripe','test')).rejects.toThrow('CHECKPOINT_BACKFILL_REQUIRED');expect(state.transactions.size).toBe(1);
 });
});
