import { describe, expect, it, vi, afterEach } from 'vitest';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialVault, type KeyProtector } from '../src/community/integrations/vault.js';
import type { Transport, CommitBatch } from '../src/community/integrations/types.js';
import type { MatchingState } from '../src/core/types.js';

class TestProtector implements KeyProtector {
  private readonly key=randomBytes(32);
  protect(data:Buffer,context:Buffer):Buffer {
    const nonce=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(context);
    return Buffer.concat([nonce,cipher.update(data),cipher.final(),cipher.getAuthTag()]);
  }
  unprotect(value:Buffer,context:Buffer):Buffer {
    const decipher=createDecipheriv('aes-256-gcm',this.key,value.subarray(0,12));decipher.setAAD(context);decipher.setAuthTag(value.subarray(-16));
    return Buffer.concat([decipher.update(value.subarray(12,-16)),decipher.final()]);
  }
}
const oldRoot=process.env.MATCHING_RUNTIME_ROOT,oldMode=process.env.MATCHING_RUNTIME_MODE;
afterEach(()=>{
 if(oldRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=oldRoot;
 if(oldMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=oldMode;
 vi.resetModules();
});
describe('actual durable provider journal and encrypted checkpoint coordination',()=>{
 it('does not advance checkpoint before durable commit, and retries after a post-commit outage without duplicate provider revenue',async()=>{
   const root=mkdtempSync(join(tmpdir(),'provider-durable-synthetic-'));
   process.env.MATCHING_RUNTIME_MODE='external-runtime-root';
   process.env.MATCHING_RUNTIME_ROOT=root;vi.resetModules();
   const db=await import('../src/storage/db.js');
   try{
     const json=await import('../src/storage/json-store.js');
     const canonical=await import('../src/storage/canonical-transaction.js');
     const {prepareProviderImport}=await import('../src/community/integrations/canonical-import.js');
     const {IntegrationService}=await import('../src/community/integrations/service.js');
     db.getDb();
     let state:MatchingState=json.createEmptyState('SYNTHETIC_PROVIDER_DURABLE');
     json.saveState(state);canonical.initializeCanonicalState(state);
     const principal={subject:'USR-synthetic-financial-restart'};
     const protector=new TestProtector();
     const vault=new CredentialVault(join(root,'vault'),protector);
     const rows=[
       {id:'txn_charge_syn',type:'charge',amount:1000,fee:30,net:970,currency:'eur',created:1790000000,source:'ch_synthetic'},
       {id:'txn_refund_syn',type:'refund',amount:-200,fee:0,net:-200,currency:'eur',created:1790000000,source:'re_synthetic'},
       {id:'txn_payout_syn',type:'payout',amount:-770,fee:0,net:-770,currency:'eur',created:1790000000,source:'po_synthetic'},
     ];
     let transportCalls=0;
     const transport:Transport=async request=>{transportCalls++;if(request.url==='https://api.stripe.com/v1/account')return{status:200,json:{id:'acct_SYNTHETIC',object:'account'}};if(!request.url.startsWith('https://api.stripe.com/v1/balance_transactions'))throw new Error('UNEXPECTED_PROVIDER_ENDPOINT');
       return{status:200,json:{data:rows,has_more:false}};};
     const now=()=>new Date('2026-10-15T00:00:00.000Z');
     let faultAfterDurableCommit=true;
     const committed:CommitBatch=async batch=>{
       const result=prepareProviderImport(state,batch);
       if(result.added)state=canonical.commitCanonicalState(state,result.state,principal.subject);
       if(faultAfterDurableCommit){faultAfterDurableCommit=false;throw new Error('SYNTHETIC_AFTER_COMMIT_BEFORE_CHECKPOINT');}
       return result.importedEvents;
     };
     const service=new IntegrationService(vault,committed,transport,now);
     await service.configure(principal,'stripe','test',{apiKey:'rk_test_synthetic12345678'});
     await expect(service.synchronize(principal,'stripe','test')).rejects.toThrow('INTEGRATION_FAILED');
     expect(JSON.parse(readFileSync(join(root,'state','state.json'),'utf8'))).toEqual(JSON.parse(json.serializeCommunityState(state)));
     expect(state.transactions.size).toBe(4);
     expect([...state.transactions.values()].reduce((sum,x)=>sum+x.amount_minor,0)).toBe(0);
     expect((await service.status(principal,'stripe','test')).lastSuccess).toBeNull();
     expect(db.getDb().prepare('SELECT count(*) FROM transactions').pluck().get()).toBe(4);
     expect(db.getDb().prepare('SELECT count(*) FROM audit_events').pluck().get()).toBe(1);
     expect(db.getDb().pragma('user_version',{simple:true})).toBe(4);
     // Simulate a full application process restart, not merely a second request.
     db.closeDb();db.getDb();state=json.loadState()!;canonical.initializeCanonicalState(state);
     // The encrypted cursor was deliberately not advanced, so provider rows
     // are fetched again. The canonical source identity prevents double count.
     const restarted=new IntegrationService(new CredentialVault(join(root,'vault'),protector),committed,transport,now);
     const after=await restarted.synchronize(principal,'stripe','test');
     expect(after.imported).toBe(0);
     expect((await restarted.status(principal,'stripe','test')).lastSuccess).toBe('2026-10-15T00:00:00.000Z');
     expect(db.getDb().prepare('SELECT count(*) FROM transactions').pluck().get()).toBe(4);
     expect(state.audit_events).toHaveLength(1);
     db.closeDb();db.getDb();
     const recovered=json.loadState()!;
     canonical.initializeCanonicalState(recovered);
     expect(JSON.parse(json.serializeCommunityState(recovered))).toEqual(JSON.parse(json.serializeCommunityState(state)));
     const raw=JSON.stringify({json:readFileSync(join(root,'state','state.json'),'utf8')});
     expect(raw).not.toContain('rk_test_');
     expect(transportCalls).toBeGreaterThanOrEqual(2);
   }finally{db.closeDb();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
 },30000);
});
