import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CommunityBankingService, type BankCallbacks, type ReadOnlyBankAdapter } from '../src/community/banking/service.js';
import { BankCredentialVault } from '../src/community/banking/vault.js';
import type { KeyProtector } from '../src/community/integrations/vault.js';
import type { Principal } from '../src/community/payments/types.js';
import type { MatchingState } from '../src/core/types.js';
import { recordAudit } from '../src/observability/audit.js';

// Only generated RSA keys and fictional account/session identifiers are used.
const owner:Principal={subject:'SYNTHETIC-BANK-OWNER',workspace_id:'SYNTHETIC-BANK-WORKSPACE',session_id:'SYNTHETIC-SESSION',role:'owner',authenticated_at:'2026-10-15T00:00:00Z',permissions:['integrations:read','integrations:configure']};
const credential={applicationId:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222',privateKeyPem:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString()};
const replacement={...credential,sessionId:'33333333-3333-4333-8333-333333333333'};
const protector:KeyProtector={
  protect(plain,context){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',createHash('sha256').update(context).digest(),iv);return Buffer.concat([iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);},
  unprotect(box,context){const decipher=createDecipheriv('aes-256-gcm',createHash('sha256').update(context).digest(),box.subarray(0,12));decipher.setAuthTag(box.subarray(-16));return Buffer.concat([decipher.update(box.subarray(12,-16)),decipher.final()]);},
};
const adapter:ReadOnlyBankAdapter={provider:'enablebanking-ais',environment:'live',capabilities:['accounts','transactions'],accounts:async()=>[],transactions:async()=>[]};
let root:string,state:MatchingState,db:typeof import('../src/storage/db.js'),json:typeof import('../src/storage/json-store.js'),canonical:typeof import('../src/storage/canonical-transaction.js'),vault:BankCredentialVault,service:CommunityBankingService;
let failAt:import('../src/storage/canonical-transaction.js').CanonicalPhase|undefined,authorized:boolean,cleanupFails:boolean,afterStore:(()=>void)|undefined;
const originalRoot=process.env.MATCHING_RUNTIME_ROOT,originalMode=process.env.MATCHING_RUNTIME_MODE;
const row=()=>db.getDb().prepare('SELECT account_ref,vault_ref FROM community_bank_connections WHERE workspace_id=? AND subject=?').get(owner.workspace_id,owner.subject) as {account_ref:string;vault_ref:string}|undefined;
const stateText=()=>readFileSync(join(root,'state','state.json'),'utf8');
const resolve=(ref:string,overrides:Partial<Parameters<BankCredentialVault['resolve']>[0]>={})=>vault.resolve({subject:owner.subject,workspaceId:owner.workspace_id,provider:'enablebanking-ais',environment:'live',vaultRef:ref,...overrides});
function callbacks():BankCallbacks{return{
  storeCredential:async({principal,credential:raw})=>{const ref=await vault.put(principal,raw);afterStore?.();return ref;},
  removeCredential:async(p,ref)=>{if(cleanupFails)throw new Error('SYNTHETIC_CLEANUP_UNAVAILABLE');await vault.remove(p,ref);},
  commitConnection:input=>{
    const result=canonical.commitCanonicalMutation(state,input.principal.subject,()=>{
      input.mutate();const next=structuredClone(state);
      recordAudit(next,'STATE_COMMITTED','Run','BANK-'+randomUUID(),{actor_type:'user',actor_id:input.principal.subject,reason:'Bank connection '+input.action,after:{action:input.action,provider:adapter.provider,environment:adapter.environment,account_ref:input.accountRef??null}});
      return{state:next,result:null};
    },{onPhase:phase=>{if(phase===failAt)throw new Error('SYNTHETIC_BANK_WRITE_FAILURE');}});
    state=result.state;
  },importTransactions:async()=>({imported:0,skipped:0}),
};}
beforeEach(async()=>{
  root=mkdtempSync(join(tmpdir(),'matching-bank-audit-synthetic-'));process.env.MATCHING_RUNTIME_ROOT=root;process.env.MATCHING_RUNTIME_MODE='external-runtime-root';vi.resetModules();
  db=await import('../src/storage/db.js');db.getDb();json=await import('../src/storage/json-store.js');canonical=await import('../src/storage/canonical-transaction.js');
  state=json.createEmptyState('SYNTHETIC_BANK_AUDIT_DATASET');json.saveState(state);canonical.initializeCanonicalState(state);
  vault=new BankCredentialVault(join(root,'identity','bank-vault'),protector);authorized=true;cleanupFails=false;failAt=undefined;afterStore=undefined;
  service=new CommunityBankingService(db.getDb(),()=>authorized,vault,adapter,callbacks());
});
afterEach(()=>{
  db?.closeDb();if(originalRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=originalRoot;
  if(originalMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=originalMode;
  rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});vi.resetModules();
});

describe('bank connection canonical SQL, JSON, audit and immutable credential pointer',()=>{
  it('commits configure and disconnect audit with their SQL, and never serializes credential material',async()=>{
    await service.configure(owner,'SYNTHETIC-ACCOUNT',credential);const ref=row()!.vault_ref;
    expect(await resolve(ref)).toEqual(credential);expect(state.audit_events).toHaveLength(1);
    expect(state.audit_events[0]).toMatchObject({actor_id:owner.subject,reason:'Bank connection configure',after:{action:'configure',account_ref:'SYNTHETIC-ACCOUNT'}});
    const persisted=stateText();expect(persisted).not.toContain(credential.privateKeyPem);expect(persisted).not.toContain(credential.sessionId);expect(persisted).not.toContain(ref);
    expect(JSON.stringify(db.getDb().prepare('SELECT * FROM audit_events').all())).not.toContain(credential.sessionId);
    await service.disconnect(owner);expect(row()).toBeUndefined();expect(state.audit_events).toHaveLength(2);expect(state.audit_events[1].reason).toBe('Bank connection disconnect');
    expect(readdirSync(vault.directory)).toEqual([]);expect(json.loadState()).toEqual(state);expect(canonical.canonicalJournalPending()).toBe(false);
  });
  it.each(['before_journal','after_journal','after_json'] as const)('rolls back reconfiguration and audit at %s, retaining the usable previous secret',async phase=>{
    await service.configure(owner,'SYNTHETIC-ACCOUNT',credential);const before=row()!,text=stateText();failAt=phase;
    await expect(service.configure(owner,'SYNTHETIC-REPLACEMENT',replacement)).rejects.toThrow('SYNTHETIC_BANK_WRITE_FAILURE');
    expect(row()).toEqual(before);expect(stateText()).toBe(text);expect(state.audit_events).toHaveLength(1);expect(await resolve(before.vault_ref)).toEqual(credential);
    expect(readdirSync(vault.directory)).toEqual([before.vault_ref+'.credential']);expect(canonical.canonicalJournalPending()).toBe(false);
  });
  it.each(['before_journal','after_journal','after_json'] as const)('rolls back disconnect and audit at %s without deleting the current secret',async phase=>{
    await service.configure(owner,'SYNTHETIC-ACCOUNT',credential);const before=row()!,text=stateText();failAt=phase;
    await expect(service.disconnect(owner)).rejects.toThrow('SYNTHETIC_BANK_WRITE_FAILURE');
    expect(row()).toEqual(before);expect(stateText()).toBe(text);expect(await resolve(before.vault_ref)).toEqual(credential);expect(state.audit_events).toHaveLength(1);
  });
  it('treats recovered post-commit failure as success and only then removes the previous version',async()=>{
    await service.configure(owner,'SYNTHETIC-ACCOUNT',credential);const old=row()!.vault_ref;failAt='after_commit';
    await expect(service.configure(owner,'SYNTHETIC-REPLACEMENT',replacement)).resolves.toBeUndefined();
    const current=row()!.vault_ref;expect(current).not.toBe(old);expect(await resolve(current)).toEqual(replacement);await expect(resolve(old)).rejects.toThrow('BANK_CREDENTIAL_UNAVAILABLE');
    expect(state.audit_events).toHaveLength(2);expect(json.loadState()).toEqual(state);expect(canonical.canonicalJournalPending()).toBe(false);
    await expect(service.disconnect(owner)).resolves.toBeUndefined();expect(row()).toBeUndefined();expect(state.audit_events).toHaveLength(3);expect(readdirSync(vault.directory)).toEqual([]);
  });
  it('rechecks authorization after the awaited credential write, preserving prior SQL and audit',async()=>{
    await service.configure(owner,'SYNTHETIC-ACCOUNT',credential);const before=row()!,text=stateText();afterStore=()=>{authorized=false;};
    await expect(service.configure(owner,'SYNTHETIC-REPLACEMENT',replacement)).rejects.toThrow('FORBIDDEN');
    expect(row()).toEqual(before);expect(stateText()).toBe(text);expect(await resolve(before.vault_ref)).toEqual(credential);expect(readdirSync(vault.directory)).toEqual([before.vault_ref+'.credential']);
  });
  it('preserves a persisted new pointer if post-commit journal damage prevents automatic recovery',async()=>{
    await service.configure(owner,'SYNTHETIC-ACCOUNT',credential);const previous=row()!.vault_ref,journal=join(root,'state','statement-journal-v1.json');let originalJournal='';
    const cb=callbacks();cb.commitConnection=input=>{
      canonical.commitCanonicalMutation(state,owner.subject,()=>{
        input.mutate();return{state:structuredClone(state),result:null};
      },{onPhase:phase=>{if(phase==='after_commit'){
        originalJournal=readFileSync(journal,'utf8');const damaged=JSON.parse(originalJournal);damaged.after_sha256='SYNTHETIC_CORRUPTION';writeFileSync(journal,JSON.stringify(damaged));throw new Error('SYNTHETIC_POST_COMMIT_INTERRUPTION');
      }}});
    };
    const interrupted=new CommunityBankingService(db.getDb(),()=>true,vault,adapter,cb);
    await expect(interrupted.configure(owner,'SYNTHETIC-REPLACEMENT',replacement)).rejects.toThrow(/checksum/);
    const current=row()!.vault_ref;expect(current).not.toBe(previous);expect(await resolve(current)).toEqual(replacement);expect(await resolve(previous)).toEqual(credential);
    expect(canonical.canonicalJournalPending()).toBe(true);writeFileSync(journal,originalJournal);
    expect(canonical.recoverCanonicalTransaction()?.committed).toBe(true);expect(json.loadState()!.audit_events).toHaveLength(2);expect(row()!.vault_ref).toBe(current);
  });
  it('does not report an effective configure/disconnect as failed when protected-file cleanup fails',async()=>{
    await service.configure(owner,'SYNTHETIC-ACCOUNT',credential);cleanupFails=true;
    await expect(service.configure(owner,'SYNTHETIC-REPLACEMENT',replacement)).resolves.toBeUndefined();expect(row()!.account_ref).toBe('SYNTHETIC-REPLACEMENT');
    await expect(service.disconnect(owner)).resolves.toBeUndefined();expect(row()).toBeUndefined();expect(state.audit_events).toHaveLength(3);expect(service.status(owner).configured).toBe(false);
  });
  it.each((['configure','disconnect'] as const).flatMap(action=>(['after_journal','after_json','after_commit'] as const).map(phase=>({action,phase}))))('recovers real interrupted bank $action at $phase after process restart',async({action,phase})=>{
    await service.configure(owner,'SYNTHETIC-ACCOUNT',credential);const previous=row()!,pending=await vault.put(owner,replacement);db.closeDb();
    const invocation=action==='configure'?"await service.configure(owner,'SYNTHETIC-REPLACEMENT',{synthetic:true})":"await service.disconnect(owner)";
    const code=`const db=await import('./src/storage/db.ts');db.getDb();const json=await import('./src/storage/json-store.ts');const canonical=await import('./src/storage/canonical-transaction.ts');const {CommunityBankingService}=await import('./src/community/banking/service.ts');const {recordAudit}=await import('./src/observability/audit.ts');const {randomUUID}=await import('node:crypto');const before=json.loadState();const owner=${JSON.stringify(owner)};const service=new CommunityBankingService(db.getDb(),()=>true,{resolve:async()=>({synthetic:true})},{provider:'enablebanking-ais',environment:'live',capabilities:['accounts','transactions'],accounts:async()=>[],transactions:async()=>[]},{storeCredential:async()=>${JSON.stringify(pending)},importTransactions:async()=>({imported:0,skipped:0}),commitConnection(input){canonical.commitCanonicalMutation(before,owner.subject,()=>{input.mutate();const next=structuredClone(before);recordAudit(next,'STATE_COMMITTED','Run','BANK-'+randomUUID(),{actor_type:'user',actor_id:owner.subject,reason:'Bank connection '+input.action,after:{action:input.action,account_ref:input.accountRef??null}});return{state:next,result:null};},{onPhase(p){if(p===${JSON.stringify(phase)})process.exit(86);}});}});${invocation};process.exit(87);`;
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env},encoding:'utf8',windowsHide:true,timeout:15000});
    expect(result.status,result.stderr).toBe(86);expect(canonical.canonicalJournalPending()).toBe(true);
    const recovered=canonical.recoverCanonicalTransaction(),committed=phase==='after_commit';expect(recovered?.committed).toBe(committed);
    expect(row()).toEqual(committed?(action==='configure'?{account_ref:'SYNTHETIC-REPLACEMENT',vault_ref:pending}:undefined):previous);
    expect(json.loadState()!.audit_events).toHaveLength(committed?2:1);
    if(row())expect(await resolve(row()!.vault_ref)).toEqual(committed?replacement:credential);
    // A killed process can retain encrypted unreferenced versions, but cannot lose the committed version.
    expect(await resolve(previous.vault_ref)).toEqual(credential);
    expect(canonical.canonicalJournalPending()).toBe(false);canonical.initializeCanonicalState(json.loadState()!);
  },20000);
});

describe('bank credential version and scope safety',()=>{
  it.skipIf(process.platform!=='win32')('round-trips generated synthetic material through real Windows DPAPI and strict vault ACL checks',async()=>{
    const windowsVault=new BankCredentialVault(join(root,'identity','windows-bank-vault'));
    const ref=await windowsVault.put(owner,credential),request={subject:owner.subject,workspaceId:owner.workspace_id,provider:'enablebanking-ais',environment:'live' as const,vaultRef:ref};
    expect(await windowsVault.resolve(request)).toEqual(credential);
    const sealed=readFileSync(join(windowsVault.directory,ref+'.credential'),'utf8');expect(sealed).not.toContain(credential.sessionId);expect(sealed).not.toContain('PRIVATE KEY');
    await expect(windowsVault.resolve({...request,subject:'SYNTHETIC-OTHER'})).rejects.toThrow('BANK_CREDENTIAL_UNAVAILABLE');
    await windowsVault.remove(owner,ref);expect(readdirSync(windowsVault.directory)).toEqual([]);
  },30000);
  it('keeps immutable versions independently readable and rejects wrong user, workspace, provider, environment and deletion',async()=>{
    const first=await vault.put(owner,credential),second=await vault.put(owner,replacement);expect(first).not.toBe(second);
    expect(await resolve(first)).toEqual(credential);expect(await resolve(second)).toEqual(replacement);
    for(const overrides of [{subject:'SYNTHETIC-OTHER'},{workspaceId:'SYNTHETIC-OTHER'},{provider:'other-provider'},{environment:'mock' as const}])await expect(resolve(first,overrides)).rejects.toThrow('BANK_CREDENTIAL_UNAVAILABLE');
    await expect(vault.remove({...owner,subject:'SYNTHETIC-OTHER'},first)).rejects.toThrow('BANK_CREDENTIAL_UNAVAILABLE');
    expect(existsSync(join(vault.directory,first+'.credential'))).toBe(true);
    await vault.remove(owner,first);await vault.remove(owner,first);expect(await resolve(second)).toEqual(replacement);
  });
  it('rejects ciphertext moved to a different opaque reference and preserves legacy scoped credentials until replaced',async()=>{
    const first=await vault.put(owner,credential),second=await vault.put(owner,replacement),secondFile=join(vault.directory,second+'.credential');
    writeFileSync(secondFile,readFileSync(join(vault.directory,first+'.credential')));await expect(resolve(second)).rejects.toThrow('BANK_CREDENTIAL_UNAVAILABLE');
    const context=Buffer.from(JSON.stringify(['bank-v1',owner.workspace_id,owner.subject,'enablebanking-ais','live'])),legacy=createHash('sha256').update(context).digest('hex');
    writeFileSync(join(vault.directory,legacy+'.credential'),JSON.stringify({version:1,ciphertext:protector.protect(Buffer.from(JSON.stringify(credential)),context).toString('base64')}));
    expect(await resolve(legacy)).toEqual(credential);const fresh=await vault.put(owner,replacement);expect(await resolve(legacy)).toEqual(credential);expect(await resolve(fresh)).toEqual(replacement);
    await vault.remove(owner);expect(existsSync(join(vault.directory,legacy+'.credential'))).toBe(false);expect(await resolve(fresh)).toEqual(replacement);
  });
});
