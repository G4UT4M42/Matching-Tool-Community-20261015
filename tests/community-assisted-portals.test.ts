import { describe,expect,it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp,rm,readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import puppeteer,{type Browser} from 'puppeteer-core';
import PDFDocument from 'pdfkit';
import { AssistedPortalSessions } from '../src/community/invoice-bot/assisted-portals.js';
import { InvoiceBotCoordinator } from '../src/community/invoice-bot/coordinator.js';
import { CommunityDocumentService } from '../src/community/documents/service.js';
import { createEmptyState } from '../src/storage/json-store.js';
const owner={subject:'USR-synthetic-collector',workspace_id:'WS-synthetic-portal'};
describe('fresh controlled browser download collection',()=>{
 it('discovers an actual user-selected synthetic portal download, imports/deduplicates, preserves source/hash across confirmation/restart, disconnects',async()=>{
   const pdf=new PDFDocument(),chunks:Buffer[]=[];pdf.on('data',x=>chunks.push(x));const done=new Promise<Buffer>(ok=>pdf.on('end',()=>ok(Buffer.concat(chunks))));pdf.text('Invoice SYN-PORTAL-001\nSupplier Synthetic Portal\n2026-10-15\nEUR 12.34');pdf.end();const bytes=await done,hash=createHash('sha256').update(bytes).digest('hex');
   let forbiddenRequests=0;const forbidden=createServer((_request,response)=>{forbiddenRequests++;response.end('Forbidden synthetic origin');});forbidden.on('upgrade',(_req,socket)=>{forbiddenRequests++;socket.destroy();});await new Promise<void>(ok=>forbidden.listen(0,'127.0.0.1',ok));const forbiddenOrigin='http://127.0.0.1:'+(forbidden.address() as {port:number}).port;
   const server=createServer((request,response)=>{if(request.url==='/invoice'){response.setHeader('Content-Type','application/pdf');response.setHeader('Content-Disposition','attachment; filename="synthetic-invoice.pdf"');response.end(bytes);}else{response.setHeader('Content-Type','text/html');response.end('<a id="download" href="/invoice">Download synthetic invoice</a><a id="forbidden" target="_blank" href="'+forbiddenOrigin+'">Forbidden popup</a>');}});
   await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
   const root=await mkdtemp(join(tmpdir(),'assisted-portal-synthetic-'));let browser:Browser|undefined,state=createEmptyState('SYNTHETIC_PORTAL');
   const executablePath=[process.env.MATCHING_TEST_BROWSER,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(x=>x&&existsSync(x));expect(executablePath).toBeTruthy();
   const sessions=new AssistedPortalSessions(join(root,'sessions'),{portals:[{id:'synthetic-portal',label:'Synthetic portal',url:origin,domains:['127.0.0.1'],help:origin}],checkOrigin:async value=>{if(value!==origin)throw new Error('NETWORK_FORBIDDEN');},launch:async (profile,proxy)=>{browser=await puppeteer.launch({executablePath,headless:true,userDataDir:profile,args:['--proxy-server='+proxy,'--proxy-bypass-list=<-loopback>','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});return browser;}});
   const documents=new CommunityDocumentService({root:join(root,'documents'),getState:()=>state,persistAndActivate:(_before,next)=>{state=next;}});
   const bot=new InvoiceBotCoordinator(sessions.adapters(),sessions,documents,true);
   try{
     console.info('portal-stage: first connect');await bot.connect(owner,'synthetic-portal');console.info('portal-stage: first connected');expect(await sessions.isConnected({...owner,subject:'USR-other'},'synthetic-portal')).toBe(false);
     const page=(await browser!.pages())[0];
     console.info('portal-stage: forbidden popup');await page.evaluate(value=>{new WebSocket(value.replace('http:','ws:')+'/forbidden');const blob=new Blob(['fetch('+JSON.stringify(value+'/worker')+')'],{type:'application/javascript'});new Worker(URL.createObjectURL(blob));new SharedWorker(URL.createObjectURL(blob));},forbiddenOrigin);await page.click('#forbidden');console.info('portal-stage: popup click returned');await new Promise(ok=>setTimeout(ok,300));expect(forbiddenRequests).toBe(0);
     const other={...owner,subject:'USR-other'};console.info('portal-stage: second connect');await bot.connect(other,'synthetic-portal');console.info('portal-stage: second connected');expect(await sessions.isConnected(owner,'synthetic-portal')).toBe(true);expect(await sessions.isConnected(other,'synthetic-portal')).toBe(true);await bot.disconnect(other,'synthetic-portal');console.info('portal-stage: second disconnected');
     await page.bringToFront();await page.click('#download');console.info('portal-stage: download clicked');
     let found;for(let n=0;n<100;n++){found=await bot.discover(owner,'synthetic-portal');if(found.discovered.length)break;await new Promise(ok=>setTimeout(ok,50));}
     expect(found!.discovered).toHaveLength(1);expect(found!.discovered[0]).toMatchObject({source_id:hash,filename:'synthetic-invoice.pdf'});
     expect((await bot.importSelected(owner,found!.id,[hash])).status).toBe('imported');await bot.importSelected(owner,found!.id,[hash]);
     const records=await documents.list(owner);expect(records).toHaveLength(1);expect(records[0]).toMatchObject({hash,source_id:'synthetic-portal:'+hash,status:'review'});
     await documents.correct(owner,records[0].id,{invoice_number:'SYN-PORTAL-001',supplier_name:'Synthetic portal',document_date:'2026-10-15',total_amount:'12.34',currency_code:'EUR'});
     await documents.confirm(owner,records[0].id);
     expect(state.documents.get(records[0].id)).toMatchObject({source_document_ref:'synthetic-portal:'+hash,file_hash:hash,meta:{portal_source_id:'synthetic-portal:'+hash}});
     const restarted=new CommunityDocumentService({root:join(root,'documents'),getState:()=>state,persistAndActivate:(_before,next)=>{state=next;}});
     expect((await restarted.list(owner))[0].hash).toBe(hash);expect(state.audit_events.at(-1)?.actor_id).toBe(owner.subject);
     await bot.disconnect(owner,'synthetic-portal');expect(await sessions.isConnected(owner,'synthetic-portal')).toBe(false);expect(await readdir(join(root,'sessions'))).toEqual([]);
   }finally{console.info('portal-stage: cleanup');await sessions.close();console.info('portal-stage: browsers closed');await new Promise<void>((ok,fail)=>server.close(error=>error?fail(error):ok()));await new Promise<void>((ok,fail)=>forbidden.close(error=>error?fail(error):ok()));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 },60000);
});
