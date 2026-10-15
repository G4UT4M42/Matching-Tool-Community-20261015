import {expect,it} from 'vitest';
import {EventEmitter} from 'node:events';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Browser} from 'puppeteer-core';
import {AssistedPortalSessions} from '../src/community/invoice-bot/assisted-portals.js';
const owner={subject:'USR-synthetic-race',workspace_id:'WS-synthetic-race'};
const portal={id:'synthetic-portal',label:'Synthetic',url:'https://portal.example.com/',domains:['portal.example.com'],help:'https://portal.example.com/'};
it('a cancelled slow attempt closes only its own browser and cannot disconnect a replacement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'portal-lifecycle-'));let finish!:()=>void,started!:()=>void;const startedPromise=new Promise<void>(ok=>started=ok),gate=new Promise<void>(ok=>finish=ok);let calls=0;
 function fake(){const client=Object.assign(new EventEmitter(),{send:async()=>({})});const instance={connected:true,closed:0,target:()=>({createCDPSession:async()=>client}),pages:async()=>[{goto:async()=>{}}],close:async()=>{instance.closed++;instance.connected=false;}};return instance;}
 const old=fake(),replacement=fake();
 const sessions=new AssistedPortalSessions(join(root,'sessions'),{portals:[portal],checkOrigin:async()=>{},launch:async()=>{if(++calls===1){started();await gate;return old as unknown as Browser;}return replacement as unknown as Browser;}});
 try{
   const abort=new AbortController();const pending=sessions.openFreshSession(owner,portal.id,new URL(portal.url).origin,abort.signal);await startedPromise;abort.abort();
   await sessions.openFreshSession(owner,portal.id,new URL(portal.url).origin,new AbortController().signal);finish();await expect(pending).rejects.toMatchObject({code:'BOT_CANCELLED'});
   expect(old.closed).toBe(1);expect(replacement.closed).toBe(0);expect(await sessions.isConnected(owner,portal.id)).toBe(true);expect((await readdir(join(root,'sessions'))).length).toBe(1);
   await sessions.disconnect(owner,portal.id);expect(replacement.closed).toBe(1);expect(await readdir(join(root,'sessions'))).toEqual([]);
 }finally{finish();await sessions.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
