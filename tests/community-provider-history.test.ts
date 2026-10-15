import {describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {createCommunityIntegrationsRouter,type IntegrationHistoryScope,type IntegrationOperationEntry,type IntegrationRouterCallbacks} from '../src/server/routes/community-integrations.js';
import type {IntegrationService} from '../src/community/integrations/service.js';
import {COMMUNITY_PERMISSIONS} from '../src/server/community-permissions.js';

const owner='USR-'+randomUUID(),other='USR-'+randomUUID(),workspace='WS-'+randomUUID(),session='SES-'+randomUUID();
const scope:IntegrationHistoryScope={subject:owner,workspace_id:workspace,provider:'stripe',environment:'test'};
const record=(extra:Partial<IntegrationOperationEntry>={}):IntegrationOperationEntry=>({...scope,id:randomUUID(),operation_id:randomUUID(),occurred_at:'2026-10-15T00:00:00.000Z',operation:'sync',phase:'completed',outcome:'succeeded',imported:2,...extra});
function fakeService(){
 const calls={configure:0,test:0,sync:0,disconnect:0};let failTest=false;
 const service={status:async()=>({configured:true}),configure:async()=>{calls.configure++;},testConnection:async()=>{calls.test++;if(failTest)throw Error('synthetic-provider-secret');},synchronize:async()=>{calls.sync++;return{imported:2,checkpoint:'synthetic-private-checkpoint'};},disconnect:async()=>{calls.disconnect++;}} as unknown as IntegrationService;
 return{service,calls,fail:()=>{failTest=true;}};
}
async function withRouter(service:IntegrationService,callbacks:IntegrationRouterCallbacks,work:(base:string)=>Promise<void>){
 const app=express();app.use(express.json());app.use((req,res,next)=>{const subject=req.header('x-test-subject');if(subject)res.locals.communityPrincipal={subject,workspace_id:workspace,session_id:session,role:req.header('x-test-role')??'owner',username:'Synthetic',authenticated_at:1,reauthenticated_at:1,permissions:[...COMMUNITY_PERMISSIONS]};next();});
 app.use('/integrations',createCommunityIntegrationsRouter(service,()=>true,callbacks));const server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server.once('listening',ok));
 try{await work('http://127.0.0.1:'+(server.address() as {port:number}).port+'/integrations');}finally{await new Promise<void>(ok=>server.close(()=>ok()));}
}
const headers={'x-test-subject':owner,'Content-Type':'application/json'};
describe('append-only integration operation history',()=>{
 it('records a durable start before service mutation and secret-free completion with stable correlation',async()=>{
  const fake=fakeService(),events:IntegrationOperationEntry[]=[];
  await withRouter(fake.service,{observe:entry=>{if(entry.phase==='started'&&entry.operation==='configure')expect(fake.calls.configure).toBe(0);events.push({...entry});},history:()=>events},async base=>{
   expect((await fetch(base+'/stripe/test',{method:'PUT',headers,body:JSON.stringify({credentials:{apiKey:'synthetic-credential-value',vaultRef:'synthetic-vault-ref'}})})).status).toBe(200);
   expect((await fetch(base+'/stripe/test/sync',{method:'POST',headers})).status).toBe(200);
   expect(events).toHaveLength(4);
   for(let index=0;index<events.length;index+=2){expect(events[index]).toMatchObject({...scope,phase:'started',outcome:'started'});expect(events[index+1]).toMatchObject({...scope,phase:'completed',outcome:'succeeded',operation_id:events[index].operation_id});expect(events[index].id).not.toBe(events[index+1].id);}
   expect(events[3].imported).toBe(2);
   const history=await (await fetch(base+'/stripe/test/history',{headers})).text();
   for(const secret of ['synthetic-credential-value','synthetic-vault-ref','synthetic-private-checkpoint','apiKey','vaultRef','session_id'])expect(history).not.toContain(secret);
   expect(JSON.parse(history).items).toHaveLength(4);
  });
 });
 it('filters exact subject/workspace/provider/environment and strips callback extras and raw error text',async()=>{
  const safe=record(),failed=record({id:randomUUID(),outcome:'failed',code:'synthetic-error-secret',imported:999});
  const records=[{...safe,credential:'synthetic-credential-secret',vault_ref:'synthetic-vault-secret'},failed,record({subject:other}),record({workspace_id:'WS-'+randomUUID()}),record({provider:'paypal',environment:'sandbox'}),record({environment:'live'})];
  await withRouter(fakeService().service,{history:seen=>{expect(seen).toEqual(scope);return records;}},async base=>{
   const response=await fetch(base+'/stripe/test/history',{headers});expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');const text=await response.text(),items=JSON.parse(text).items;
   expect(items).toHaveLength(2);expect(items.find((item:IntegrationOperationEntry)=>item.id===failed.id)).toMatchObject({code:'INTEGRATION_FAILED'});expect(items.find((item:IntegrationOperationEntry)=>item.id===failed.id).imported).toBeUndefined();
   for(const secret of ['synthetic-credential-secret','synthetic-vault-secret','synthetic-error-secret',other])expect(text).not.toContain(secret);
  });
 });
 it('records sanitized failed completions without passing request credentials or provider messages',async()=>{
  const fake=fakeService();fake.fail();const events:IntegrationOperationEntry[]=[];
  await withRouter(fake.service,{observe:entry=>{events.push({...entry});}},async base=>{
   const response=await fetch(base+'/stripe/test/test',{method:'POST',headers});expect(response.status).toBe(502);expect(await response.json()).toEqual({code:'INTEGRATION_FAILED'});
   expect(events.map(entry=>[entry.phase,entry.outcome])).toEqual([['started','started'],['completed','failed']]);expect(events[1].code).toBe('INTEGRATION_FAILED');expect(JSON.stringify(events)).not.toContain('synthetic-provider-secret');
  });
 });
 it('surfaces observer failures and prevents mutation when the start cannot be persisted',async()=>{
  for(const failAt of ['started','completed'] as const){const fake=fakeService();await withRouter(fake.service,{observe:entry=>{if(entry.phase===failAt)throw Error('synthetic-history-secret');}},async base=>{
   const response=await fetch(base+'/stripe/test',{method:'PUT',headers,body:JSON.stringify({credentials:{apiKey:'synthetic-secret'}})});expect(response.status).toBe(503);expect(await response.json()).toEqual({code:'INTEGRATION_HISTORY_UNAVAILABLE'});expect(fake.calls.configure).toBe(failAt==='started'?0:1);
  });}
 });
 it('requires authenticated integration-read permission and handles missing/unavailable history safely',async()=>{
  let reads=0;await withRouter(fakeService().service,{history:()=>{reads++;throw Error('synthetic-storage-secret');}},async base=>{
   expect((await fetch(base+'/stripe/test/history')).status).toBe(401);
   expect((await fetch(base+'/stripe/test/history',{headers:{...headers,'x-test-role':'viewer'}})).status).toBe(403);expect(reads).toBe(0);
   const failed=await fetch(base+'/stripe/test/history',{headers});expect(failed.status).toBe(503);expect(await failed.json()).toEqual({code:'INTEGRATION_HISTORY_UNAVAILABLE'});
  });
  await withRouter(fakeService().service,{},async base=>{const response=await fetch(base+'/stripe/test/history',{headers});expect(response.status).toBe(200);expect(await response.json()).toEqual({items:[]});});
 });
});
