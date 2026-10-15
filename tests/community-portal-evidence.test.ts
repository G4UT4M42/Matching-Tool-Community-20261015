import {describe,it,expect,vi} from 'vitest';
import {createServer} from 'node:http';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import puppeteer,{type Browser} from 'puppeteer-core';
import {ASSISTED_PORTALS,AssistedPortalSessions,protectedReceiptFrame} from '../src/community/invoice-bot/assisted-portals.js';
import {InvoiceBotCoordinator} from '../src/community/invoice-bot/coordinator.js';
import {CommunityDocumentService} from '../src/community/documents/service.js';
import {createEmptyState} from '../src/storage/json-store.js';
const owner={subject:'USR-SYN-RECEIPT',workspace_id:'WS-SYN-RECEIPT'},signal=()=>new AbortController().signal;
const html='<link rel="icon" href="data:,"><style>body{margin:0;background:rgb(31,73,109);color:white;font:22px sans-serif}main{padding:24px}</style><main>Fictional order receipt SYN-RECEIPT<br>Not a tax invoice<br>EUR 4.25</main>';
async function fixture(receiptSelectionLeaseMs=60000){
 const executablePath=[process.env.MATCHING_TEST_BROWSER,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&existsSync(p));expect(executablePath).toBeTruthy();
 let releasePending:()=>void=()=>{};
 const server=createServer((request,response)=>{if(request.url==='/favicon.ico'){response.statusCode=204;response.end();return;}response.setHeader('Content-Type','text/html');if(request.url==='/p/order/pending'){releasePending=()=>response.end(html);return;}response.end(request.url==='/p/order/credential-frame'?html+'<iframe src="/login"></iframe>':request.url==='/p/order/embedded-credential-frame'?html+'<iframe src="/mini_login.html"></iframe>':request.url==='/p/order/opaque-frame'?html+'<iframe srcdoc="<p>Opaque synthetic page</p>"></iframe>':request.url?.startsWith('/login')||request.url==='/mini_login.html'?'<link rel="icon" href="data:,"><form><input type="password" autocomplete="off"></form>':html);});
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const root=await mkdtemp(join(tmpdir(),'matching-receipt-synthetic-')),browsers:Browser[]=[];
 const sessions=new AssistedPortalSessions(join(root,'sessions'),{receiptSelectionLeaseMs,portals:[{id:'synthetic-receipt',label:'Synthetic receipt',url:origin+'/p/order/index.html',domains:['127.0.0.1'],help:origin,receiptPaths:['/p/order/']}],checkOrigin:async value=>{if(value!==origin)throw new Error('UNEXPECTED_ORIGIN');},launch:async(profile,proxy)=>{const browser=await puppeteer.launch({executablePath,headless:true,userDataDir:profile,args:['--proxy-server='+proxy,'--proxy-bypass-list=<-loopback>','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});browsers.push(browser);return browser;}});
 let state=createEmptyState('SYNTHETIC_RECEIPT'),allowed=true;
 const guard=()=>{if(!allowed)throw new Error('SYNTHETIC_PERMISSION_REVOKED');};
 const documents=new CommunityDocumentService({root:join(root,'documents'),getState:()=>state,persistAndActivate:(_before,next)=>{guard();state=next;}});
 const bot=new InvoiceBotCoordinator(sessions.adapters(),sessions,documents,true,60000,guard);
 let closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{
   releasePending();
   try{await sessions.close();}
   finally{
     try{server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));}
     finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
   }
 })();
 try{
   await bot.connect(owner,'synthetic-receipt');const page=(await browsers[0].pages())[0];
   return {root,origin,page,sessions,documents,bot,guard,state:()=>state,revoke:()=>{allowed=false;},allow:()=>{allowed=true;},releasePending:()=>releasePending(),async stagedCount(){const dirs=await readdir(join(root,'sessions'));return (await Promise.all(dirs.map(d=>readdir(join(root,'sessions',d,'downloads'))))).flat().length;},close};
 }catch(error){
   try{await close();}catch{console.error('Synthetic receipt fixture cleanup failed after setup failure');}
   throw error;
 }
}
describe('explicit owned receipt evidence',()=>{
 it('retains all11 controlled portals and distinguishes consumer Post, ELLA and Ali receipt support',()=>{
   expect(ASSISTED_PORTALS).toHaveLength(11);expect(new Set(ASSISTED_PORTALS.map(p=>p.id)).size).toBe(11);
   expect(ASSISTED_PORTALS.find(p=>p.id==='austrian-post-orders')?.url).toBe('https://services.post.at/store/meine-bestellungen');
   expect(ASSISTED_PORTALS.find(p=>p.id==='austrian-post-ella')?.url).toBe('https://ella.post.at/');
   expect(ASSISTED_PORTALS.find(p=>p.id==='bambulab-eu')?.url).toBe('https://eu.store.bambulab.com/account');
   expect(ASSISTED_PORTALS.filter(p=>p.receiptPaths?.length).map(p=>p.id)).toEqual(['aliexpress']);
   for(const url of ['https://login.aliexpress.com/','https://passport.aliexpress.com/','https://www.aliexpress.com/mini_login.html','https://www.aliexpress.com/member/sign_in.htm','https://www.aliexpress.com/account_selection'])expect(protectedReceiptFrame(url),url).toBe(true);
   const syntheticUserinfo=new URL('https://www.aliexpress.com/order');syntheticUserinfo.username='synthetic';syntheticUserinfo.password='synthetic';
   for(const url of ['about:blank','about:srcdoc','data:text/html,opaque','blob:https://www.aliexpress.com/synthetic','https://www.aliexpress.com/mini_%6cogin.html','https://www.aliexpress.com/order#credentials',syntheticUserinfo.href])expect(protectedReceiptFrame(url),url).toBe(true);
 });
 it('captures only explicitly selected visible synthetic receipt pixels, imports unconfirmed evidence, deduplicates and preserves audited provenance on restart',async()=>{
   const f=await fixture();try{
     const targets=await f.bot.receiptTargets(owner,'synthetic-receipt');expect(targets).toHaveLength(1);expect(Object.keys(targets[0]).sort()).toEqual(['id','origin','tab_number']);
     await expect(f.bot.captureReceipt(owner,'synthetic-receipt',{tab_id:targets[0].id,confirm_receipt_only:false} as never)).rejects.toMatchObject({code:'INVALID_SELECTION'});expect(await f.stagedCount()).toBe(0);
     const run=await f.bot.captureReceipt(owner,'synthetic-receipt',{tab_id:targets[0].id,confirm_receipt_only:true,clip:{x:0,y:0,width:320,height:200}});
     expect(run.discovered).toHaveLength(1);const evidence=run.discovered[0];expect(evidence).toMatchObject({evidence_kind:'receipt-capture',source_origin:f.origin,capture:{width:320,height:200,scope:'selected-viewport',unconfirmed:true}});expect(evidence.filename).toContain('-receipt-evidence-');
     const bytes=await f.sessions.download(owner,'synthetic-receipt',evidence,signal()),hash=createHash('sha256').update(bytes).digest('hex');expect(evidence.source_id).toBe('receipt-capture:127.0.0.1:'+evidence.capture!.captured_at.replace(/[-:.]/g,'')+':'+hash);expect(bytes.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
     const repeatedTargets=await f.bot.receiptTargets(owner,'synthetic-receipt');expect(repeatedTargets).toHaveLength(1);const repeated=await f.bot.captureReceipt(owner,'synthetic-receipt',{tab_id:repeatedTargets[0].id,confirm_receipt_only:true,clip:{x:0,y:0,width:320,height:200}});expect(repeated.discovered[0].source_id).toBe(evidence.source_id);expect(await f.stagedCount()).toBe(1);
     await expect(f.sessions.download({...owner,subject:'USR-OTHER'},'synthetic-receipt',evidence,signal())).rejects.toMatchObject({code:'BOT_DISCONNECTED'});
     await f.bot.importSelected(owner,run.id,[evidence.source_id]);await f.bot.importSelected(owner,run.id,[evidence.source_id]);const records=await f.documents.list(owner);expect(records).toHaveLength(1);expect(records[0]).toMatchObject({status:'review',hash,source_id:'synthetic-receipt:'+evidence.source_id,source_kind:'invoice-bot'});
     expect(f.state().documents.size).toBe(0);expect(f.state().audit_events.some(e=>JSON.stringify(e).includes(evidence.source_id))).toBe(true);
     const restarted=new CommunityDocumentService({root:join(f.root,'documents'),getState:f.state,persistAndActivate:()=>{throw new Error('READ_ONLY_RESTART');}});expect((await restarted.list(owner))[0]).toMatchObject({status:'review',hash,source_id:'synthetic-receipt:'+evidence.source_id});
     await expect(f.sessions.captureReceipt(owner,'synthetic-receipt',{tab_id:targets[0].id,confirm_receipt_only:true},signal())).rejects.toMatchObject({code:'INVALID_SELECTION'});
   }finally{await f.close();}
 },60000);
 it('rejects credentials/auth pages, cross-scope or expired tokens and invalid crop without staging pixels',async()=>{
   const f=await fixture(1000);try{
     const idleErrors:string[]=[],pending=new Set<import('puppeteer-core').HTTPRequest>(),idle=f.page.waitForNetworkIdle.bind(f.page);f.page.on('request',request=>pending.add(request));f.page.on('requestfinished',request=>pending.delete(request));f.page.on('requestfailed',request=>pending.delete(request));vi.spyOn(f.page,'waitForNetworkIdle').mockImplementation(async options=>{try{return await idle(options);}catch(error){idleErrors.push(String(error));throw error;}});
     await expect(f.bot.receiptTargets({...owner,workspace_id:'WS-OTHER'},'synthetic-receipt')).rejects.toMatchObject({code:'BOT_DISCONNECTED'});
     await f.page.goto(f.origin+'/login');expect(await f.bot.receiptTargets(owner,'synthetic-receipt')).toEqual([]);
     await f.page.goto(f.origin+'/p/order/detail.html?auth_token=SYNTHETIC-NOT-A-SECRET');expect(await f.bot.receiptTargets(owner,'synthetic-receipt')).toEqual([]);
     await f.page.goto(f.origin+'/p/order/credential-frame',{waitUntil:'networkidle0'});expect(await f.bot.receiptTargets(owner,'synthetic-receipt')).toEqual([]);
     await f.page.goto(f.origin+'/p/order/embedded-credential-frame',{waitUntil:'networkidle0'});expect(await f.bot.receiptTargets(owner,'synthetic-receipt')).toEqual([]);
     await f.page.goto(f.origin+'/p/order/opaque-frame',{waitUntil:'networkidle0'});expect(await f.bot.receiptTargets(owner,'synthetic-receipt')).toEqual([]);
     await f.page.goto(f.origin+'/p/order/index.html');let targets=await f.bot.receiptTargets(owner,'synthetic-receipt');
     expect(targets,JSON.stringify({url:f.page.url(),frames:f.page.frames().map(frame=>({url:frame.url(),protected:protectedReceiptFrame(frame.url(),true)})),pendingRequests:[...pending].map(request=>({url:request.url(),frame:request.frame()?.url()})),idleErrors})).toHaveLength(1);await new Promise(ok=>setTimeout(ok,1100));await expect(f.bot.captureReceipt(owner,'synthetic-receipt',{tab_id:targets[0].id,confirm_receipt_only:true})).rejects.toMatchObject({code:'INVALID_SELECTION'});
     targets=await f.bot.receiptTargets(owner,'synthetic-receipt');expect(targets).toHaveLength(1);await expect(f.bot.captureReceipt(owner,'synthetic-receipt',{tab_id:targets[0].id,confirm_receipt_only:true,clip:{x:0,y:0,width:5000,height:20}})).rejects.toMatchObject({code:'CAPTURE_LIMIT'});
     targets=await f.bot.receiptTargets(owner,'synthetic-receipt');expect(targets).toHaveLength(1);await f.bot.disconnect(owner,'synthetic-receipt');await f.bot.connect(owner,'synthetic-receipt');await expect(f.bot.captureReceipt(owner,'synthetic-receipt',{tab_id:targets[0].id,confirm_receipt_only:true})).rejects.toMatchObject({code:'INVALID_SELECTION'});expect(await f.stagedCount()).toBe(0);
   }finally{await f.close();}
 },60000);
 it('rechecks revocation after actual CDP screenshot completion and stages no image',async()=>{
   const f=await fixture();try{
     const original=f.page.createCDPSession.bind(f.page);vi.spyOn(f.page,'createCDPSession').mockImplementation(async()=>{const client=await original(),send=client.send.bind(client);client.send=(async(method:string,params:unknown)=>{const result=await (send as Function)(method,params);if(method==='Page.captureScreenshot')f.revoke();return result;}) as typeof client.send;return client;});
     const targets=await f.bot.receiptTargets(owner,'synthetic-receipt');await expect(f.bot.captureReceipt(owner,'synthetic-receipt',{tab_id:targets[0].id,confirm_receipt_only:true})).rejects.toThrow('SYNTHETIC_PERMISSION_REVOKED');expect(await f.stagedCount()).toBe(0);expect(f.bot.listRuns(owner)).toEqual([]);
   }finally{f.allow();await f.close();}
 },60000);
 it('rejects navigation that starts while screenshot is pending even before the URL commits',async()=>{
   const f=await fixture();try{
     const original=f.page.createCDPSession.bind(f.page);vi.spyOn(f.page,'createCDPSession').mockImplementation(async()=>{const client=await original(),send=client.send.bind(client);client.send=(async(method:string,params:unknown)=>{const result=await (send as Function)(method,params);if(method==='Page.captureScreenshot'){const started=new Promise<void>(ok=>{f.page.once('request',()=>ok());});void f.page.goto(f.origin+'/p/order/pending').catch(()=>{});await started;expect(f.page.url()).toBe(f.origin+'/p/order/index.html');}return result;}) as typeof client.send;return client;});
     const targets=await f.bot.receiptTargets(owner,'synthetic-receipt');await expect(f.bot.captureReceipt(owner,'synthetic-receipt',{tab_id:targets[0].id,confirm_receipt_only:true})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});expect(await f.stagedCount()).toBe(0);expect(f.bot.listRuns(owner)).toEqual([]);
   }finally{f.releasePending();await f.close();}
 },60000);
});
