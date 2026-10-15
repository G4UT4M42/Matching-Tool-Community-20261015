import { existsSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer-core';
import { secureVaultDirectory } from '../integrations/vault-files.js';
import { DocumentInputError, MAX_DOCUMENT_BYTES } from '../documents/recognition.js';
import type { Principal } from '../documents/service.js';
import { assertPublicPortalDns, type BrowserSessionCallbacks, type PortalAdapter, type PortalInvoice, type ReceiptCaptureTarget, type ReceiptCaptureSelection } from './coordinator.js';
import { PortalEgressProxy } from './egress-proxy.js';

export interface AssistedPortal {id:string;label:string;url:string;domains:readonly string[];help:string;receiptPaths?:readonly string[]}
/** No account IDs, ambient profiles, credentials, automatic login or provider mutation. */
export const ASSISTED_PORTALS:readonly AssistedPortal[]=[
 {id:'amazon-business',label:'Amazon Business (assisted download)',url:'https://www.amazon.de/gp/your-account/order-history',domains:['amazon.de','amazon.com','media-amazon.com','ssl-images-amazon.com'],help:'https://business.amazon.de/de/solutions/payment-options/managing-vat'},
 {id:'openai-platform',label:'OpenAI Platform (assisted download)',url:'https://platform.openai.com/settings/organization/billing/history',domains:['openai.com','oaistatic.com','stripe.com','google.com','gstatic.com','microsoftonline.com'],help:'https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform'},
 {id:'chatgpt',label:'ChatGPT (assisted download)',url:'https://chatgpt.com/',domains:['chatgpt.com','openai.com','oaistatic.com','stripe.com','google.com','gstatic.com','microsoftonline.com'],help:'https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform'},
 {id:'google-cloud',label:'Google Cloud (assisted download)',url:'https://console.cloud.google.com/billing',domains:['google.com','gstatic.com','googleusercontent.com'],help:'https://docs.cloud.google.com/billing/docs/how-to/get-invoice'},
 {id:'spotify',label:'Spotify (assisted download)',url:'https://www.spotify.com/account/order-history/',domains:['spotify.com','scdn.co','spotifycdn.com','google.com','gstatic.com','apple.com'],help:'https://support.spotify.com/au/article/check-receipts/'},
 {id:'fiverr',label:'Fiverr (assisted download)',url:'https://www.fiverr.com/users/receipts',domains:['fiverr.com','fiverrcdn.com','cloudinary.com','google.com','gstatic.com','apple.com'],help:'https://help.fiverr.com/hc/en-us/articles/37554374533649-Downloading-updating-and-troubleshooting-your-Fiverr-invoices'},
 {id:'google-one',label:'Google purchases / Google One (assisted download)',url:'https://payments.google.com/',domains:['google.com','gstatic.com','googleusercontent.com'],help:'https://support.google.com/googlepay/answer/7644144?hl=en'},
 {id:'austrian-post-ella',label:'Austrian Post ELLA (assisted download)',url:'https://ella.post.at/',domains:['post.at'],help:'https://ella.post.at/b/faq'},
 {id:'austrian-post-orders',label:'Austrian Post purchases (assisted download)',url:'https://services.post.at/store/meine-bestellungen',domains:['post.at'],help:'https://www.post.at/g/a/paketmarke-geschaeftlich'},
 {id:'bambulab-eu',label:'Bambu Lab EU orders (assisted download)',url:'https://eu.store.bambulab.com/account',domains:['bambulab.com','shopify.com','shopifycdn.com'],help:'https://wiki.bambulab.com/en/how-to-get-order-id'},
 {id:'aliexpress',label:'AliExpress orders (assisted download / receipt evidence)',url:'https://www.aliexpress.com/p/order/index.html',domains:['aliexpress.com','alicdn.com'],help:'https://helpcenter.aliexpress.com/',receiptPaths:['/p/order/','/p/trade/']},
];
interface Download {guid:string;filename:string;hash:string;bytes:number;evidence?:PortalInvoice}
interface OwnedCapture {page:Page;url:string;epoch:number;expires:number;tab_number:number}
interface OwnedSession {browser:Browser;proxy:PortalEgressProxy;cdp:CDPSession;directory:string;downloads:Map<string,Download>;names:Map<string,string>;pending:Set<Promise<void>>;captures:Map<string,OwnedCapture>;epochs:WeakMap<Page,number>;watched:WeakSet<Page>;capturing:boolean;capturesCreated:number;failure?:string;timer:ReturnType<typeof setTimeout>}
export interface AssistedBrowserOptions {
 /** Composition-root dependency injection only; production never reads this from HTTP or environment. */
 launch?:(profile:string,proxy:string)=>Promise<Browser>;
 checkOrigin?:(origin:string)=>Promise<void>;
 portals?:readonly AssistedPortal[];
 leaseMs?:number;
 /** Trusted composition only; production selection lifetime never exceeds one minute. */
 receiptSelectionLeaseMs?:number;
}
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const invalid=(code:string,message:string):never=>{throw new DocumentInputError(code,message);};
const aborted=(signal:AbortSignal)=>{if(signal.aborted)invalid('BOT_CANCELLED','Portal operation cancelled');};
/** URL metadata only: never inspect a frame's DOM, form values or credentials. */
export function protectedReceiptFrame(raw:string,allowTrustedFixtureHttp=false):boolean{
 try{const url=new URL(raw);return url.protocol!=='https:'&&!(allowTrustedFixtureHttp&&url.protocol==='http:')||Boolean(url.username||url.password||url.hash)||url.pathname.includes('%')||url.hostname.split('.').some(label=>/(?:login|signin|auth|passport|accounts?|captcha|challenge|sso)/i.test(label))||/(?:login|signin|sign[-_]?in|auth|oauth|passport|captcha|challenge|sso|account[-_]?(?:selection|select|choose)|(?:select|choose)[-_]?account)/i.test(url.pathname)||[...url.searchParams.keys()].some(key=>/token|password|credential|auth|sso|session|ticket/i.test(key));}catch{return true;}
}

/** Captures only downloads explicitly selected by the user in a NEW dedicated browser.
 * It never reads cookies, form values, existing tabs or provider account data.
 * PDF discovery is the list of completed downloads, not a financial claim.
 */
export class AssistedPortalSessions implements BrowserSessionCallbacks {
 private readonly sessions=new Map<string,OwnedSession>();
 private readonly attempts=new Map<string,symbol>();
 private readonly disposing=new WeakMap<OwnedSession,Promise<void>>();
 readonly portals:readonly AssistedPortal[];
 constructor(private readonly root:string,private readonly options:AssistedBrowserOptions={}){this.portals=options.portals??ASSISTED_PORTALS;if(!isAbsolute(root))throw new Error('UNSAFE_PORTAL_STORAGE');}
 private key(p:Principal,id:string){if(!p.subject||!p.workspace_id)invalid('AUTHENTICATION_REQUIRED','Account required');return digest(JSON.stringify([p.workspace_id,p.subject,id]));}
 private portal(id:string){const item=this.portals.find(x=>x.id===id);if(!item)return invalid('UNSUPPORTED_PORTAL','Select a supported portal');return item;}
 private current(p:Principal,id:string){const item=this.sessions.get(this.key(p,id));if(!item||!item.browser.connected)return invalid('BOT_DISCONNECTED','Open a fresh portal browser first');return item;}
 private async launch(profile:string,proxy:string){
   if(this.options.launch)return this.options.launch(profile,proxy);
   const executablePath=[join(process.env.ProgramFiles??'C:/Program Files','Google/Chrome/Application/chrome.exe'),join(process.env['ProgramFiles(x86)']??'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe')].find(existsSync);
   if(!executablePath)return invalid('BROWSER_UNAVAILABLE','Install Chrome or Edge to collect portal downloads');
   return puppeteer.launch({executablePath,headless:false,userDataDir:profile,args:['--no-first-run','--no-default-browser-check','--proxy-server='+proxy,'--proxy-bypass-list=<-loopback>','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
 }
 async openFreshSession(p:Principal,id:string,origin:string,signal:AbortSignal){
   const portal=this.portal(id);if(new URL(portal.url).origin!==origin)invalid('UNSAFE_PORTAL','Portal configuration mismatch');aborted(signal);
   const key=this.key(p,id),generation=Symbol('portal-attempt');this.attempts.set(key,generation);
   const previous=this.sessions.get(key);if(previous)await this.dispose(key,previous);
   await secureVaultDirectory(this.root,true,'browser-sessions');aborted(signal);
   if(this.attempts.get(key)!==generation)invalid('BOT_CANCELLED','Portal connection replaced');
   const directory=await mkdtemp(join(this.root,'session-'));await mkdir(join(directory,'downloads'));
   let browser:Browser|undefined,owned:OwnedSession|undefined;
   const proxy=new PortalEgressProxy(portal.domains,this.options.checkOrigin);
   try{
     const proxyUrl=await proxy.start();browser=await this.launch(join(directory,'profile'),proxyUrl);aborted(signal);
     if(this.attempts.get(key)!==generation)invalid('BOT_CANCELLED','Portal connection replaced');
     const cdp=await browser.target().createCDPSession();
     const timer=setTimeout(()=>{if(this.sessions.get(key)===owned)void this.disconnect(p,id).catch(()=>{});},this.options.leaseMs??30*60*1000);timer.unref();
     const session:OwnedSession={browser,proxy,cdp,directory,downloads:new Map(),names:new Map(),pending:new Set(),captures:new Map(),epochs:new WeakMap(),watched:new WeakSet(),capturing:false,capturesCreated:0,timer};owned=session;this.sessions.set(key,session);
     signal.addEventListener('abort',()=>{void this.dispose(key,session).catch(()=>{});},{once:true});
     await cdp.send('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:join(directory,'downloads'),eventsEnabled:true});
     cdp.on('Browser.downloadWillBegin',event=>{
       if(!/^[a-f0-9-]{36}$/i.test(event.guid)||!/^[^\\/\x00-\x1f]{1,200}\.(?:pdf|png|jpe?g)$/i.test(event.suggestedFilename)||session.names.size+session.capturesCreated>=100){void cdp.send('Browser.cancelDownload',{guid:event.guid}).catch(()=>{});session.failure='DOWNLOAD_REJECTED';return;}
       session.names.set(event.guid,event.suggestedFilename);
     });
     cdp.on('Browser.downloadProgress',event=>{
       if(event.totalBytes>MAX_DOCUMENT_BYTES||event.receivedBytes>MAX_DOCUMENT_BYTES){void cdp.send('Browser.cancelDownload',{guid:event.guid}).catch(()=>{});session.failure='DOWNLOAD_LIMIT';return;}
       if(event.state!=='completed')return;
       const pending=this.completed(session,event.guid).catch(()=>{session.failure='DOWNLOAD_REJECTED';});session.pending.add(pending);void pending.finally(()=>session.pending.delete(pending));
     });
     const approved=new Map<string,Promise<void>>();
     const check=this.options.checkOrigin??assertPublicPortalDns;
     const filter=[{type:'page'},{type:'iframe'},{type:'worker'},{type:'service_worker'},{type:'shared_worker'},{exclude:true}];
     const attach=(parent:CDPSession)=>parent.on('Target.attachedToTarget',event=>{void(async()=>{
       const child=parent.connection()?.session(event.sessionId);if(!child)throw new Error('PORTAL_TARGET_UNAVAILABLE');
       await configure(child);await child.send('Runtime.runIfWaitingForDebugger');
     })().catch(()=>{void cdp.send('Target.closeTarget',{targetId:event.targetInfo.targetId}).catch(()=>{});});});
     const configure=async(client:CDPSession)=>{
       client.on('Fetch.requestPaused',event=>{void(async()=>{
         const url=new URL(event.request.url);
         if(['data:','blob:','about:'].includes(url.protocol)){await client.send('Fetch.continueRequest',{requestId:event.requestId});return;}
         const host=url.hostname.toLowerCase();
         if((url.protocol!=='https:'&&!this.options.checkOrigin)||url.username||url.password||!portal.domains.some(domain=>host===domain||host.endsWith('.'+domain))){await client.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});return;}
         if(!approved.has(url.origin))approved.set(url.origin,check(url.origin));
         await approved.get(url.origin);await client.send('Fetch.continueRequest',{requestId:event.requestId});
       })().catch(()=>{void client.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'}).catch(()=>{});});});
       await client.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
       attach(client);await client.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter});
     };
     // Pause every new target before its first script/request; fail closed if interception cannot be installed.
     attach(cdp);await cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter});
     const pages=await browser.pages(),page=pages[0]??await browser.newPage();
     if(portal.receiptPaths?.length)this.watchPage(session,page);
     await page.goto(portal.url,{waitUntil:'domcontentloaded',timeout:30000});aborted(signal);
   }catch(error){if(owned)await this.dispose(key,owned);else{try{await browser?.close();}finally{await proxy.close();await this.removeDirectory(directory);}}if(this.attempts.get(key)===generation)this.attempts.delete(key);throw error;}
 }
 private async completed(session:OwnedSession,guid:string){
   const filename=session.names.get(guid);if(!filename)throw new Error('DOWNLOAD_REJECTED');
   const path=join(session.directory,'downloads',guid),stat=await lstat(path);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>MAX_DOCUMENT_BYTES)throw new Error('DOWNLOAD_REJECTED');
   const bytes=await readFile(path);session.downloads.set(digest(bytes),{guid,filename,hash:digest(bytes),bytes:bytes.length});
 }
 async isConnected(p:Principal,id:string){return this.sessions.get(this.key(p,id))?.browser.connected??false;}
 async discover(p:Principal,id:string,signal:AbortSignal):Promise<PortalInvoice[]>{
   const session=this.current(p,id);await Promise.all(session.pending);aborted(signal);
   if(session.failure)invalid(session.failure,'A portal download was rejected; reconnect and download PDF or image files within the size limit');
   return[...session.downloads.values()].map(item=>item.evidence??({source_id:item.hash,filename:item.filename,href:'/download/'+item.hash,evidence_kind:'provider-download'}));
 }
 async download(p:Principal,id:string,invoice:PortalInvoice,signal:AbortSignal){
   const session=this.current(p,id);aborted(signal);const item=session.downloads.get(invoice.source_id);
   if(!item||invoice.href!=='/download/'+(item.evidence?.source_id??item.hash))return invalid('INVALID_SELECTION','Select a discovered download');
   const path=join(session.directory,'downloads',item.guid),stat=await lstat(path);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==item.bytes)invalid('SOURCE_CONFLICT','Portal download changed');
   const bytes=await readFile(path);aborted(signal);if(digest(bytes)!==item.hash)invalid('SOURCE_CONFLICT','Portal download checksum changed');return bytes;
 }
 private receiptLocation(portal:AssistedPortal,raw:string):boolean{
   try{const url=new URL(raw);return !!portal.receiptPaths?.length&&url.origin===new URL(portal.url).origin&&(url.protocol==='https:'||!!this.options.checkOrigin)&&!url.username&&!url.password&&!url.hash&&!url.pathname.includes('%')&&portal.receiptPaths.some(prefix=>url.pathname===prefix||prefix.endsWith('/')&&url.pathname.startsWith(prefix))&&![...url.searchParams.keys()].some(key=>/token|password|passwd|credential|auth|sso|session|ticket|code|login|redirect|return|email|username/i.test(key));}catch{return false;}
 }
 private watchPage(session:OwnedSession,page:Page){
   if(session.watched.has(page))return;session.watched.add(page);session.epochs.set(page,0);
   const advance=()=>session.epochs.set(page,(session.epochs.get(page)??0)+1);
   // Track navigation starting, including one that has not yet committed a new URL.
   page.on('request',request=>{if(request.isNavigationRequest())advance();});
   page.on('framenavigated',advance);
   page.on('close',advance);
 }
 private receiptView(portal:AssistedPortal,page:Page){
   if(!this.receiptLocation(portal,page.url()))return false;
   return !page.frames().some(frame=>protectedReceiptFrame(frame.url(),!!this.options.checkOrigin));
 }
 async receiptTargets(p:Principal,id:string,signal:AbortSignal,guard?:()=>void):Promise<ReceiptCaptureTarget[]>{
   const portal=this.portal(id),session=this.current(p,id);if(!portal.receiptPaths?.length)invalid('UNSUPPORTED_CAPTURE','This portal supports selected downloads only');
   const pages=await session.browser.pages();aborted(signal);guard?.();if(this.current(p,id)!==session)invalid('BOT_DISCONNECTED','Reconnect the dedicated browser');
   if(pages.length>30)invalid('CAPTURE_LIMIT','Close unused dedicated browser tabs before selecting a receipt');
   session.captures.clear();const result:ReceiptCaptureTarget[]=[];
   for(const [index,page]of pages.entries()){
     this.watchPage(session,page);if(page.isClosed()||!this.receiptView(portal,page))continue;
     try{await page.waitForNetworkIdle({idleTime:100,timeout:2000});}catch{continue;}
     aborted(signal);guard?.();if(this.current(p,id)!==session)invalid('BOT_DISCONNECTED','Reconnect the dedicated browser');
     const url=page.url();if(page.isClosed()||!this.receiptView(portal,page))continue;
     const lifetime=this.options.receiptSelectionLeaseMs??60000;if(!Number.isSafeInteger(lifetime)||lifetime<1||lifetime>60000)invalid('CAPTURE_LIMIT','Receipt selection lifetime is invalid');
     const token=randomUUID();session.captures.set(token,{page,url,epoch:session.epochs.get(page)??0,expires:Date.now()+lifetime,tab_number:index+1});
     result.push({id:token,origin:new URL(url).origin,tab_number:index+1});
   }
   aborted(signal);guard?.();if(this.current(p,id)!==session)invalid('BOT_DISCONNECTED','Reconnect the dedicated browser');return result;
 }
 async captureReceipt(p:Principal,id:string,selection:ReceiptCaptureSelection,signal:AbortSignal,guard?:()=>void):Promise<PortalInvoice>{
   const portal=this.portal(id),session=this.current(p,id);aborted(signal);guard?.();
   if(!portal.receiptPaths?.length)invalid('UNSUPPORTED_CAPTURE','This portal supports selected downloads only');
   if(!selection||selection.confirm_receipt_only!==true||typeof selection.tab_id!=='string'||Object.keys(selection).some(k=>!['tab_id','confirm_receipt_only','clip'].includes(k)))invalid('INVALID_SELECTION','Explicit receipt-only confirmation and a selected dedicated tab are required');
   const target=session.captures.get(selection.tab_id)??invalid('INVALID_SELECTION','Refresh and explicitly select the receipt tab again');session.captures.delete(selection.tab_id);
   if(target.expires<Date.now())invalid('INVALID_SELECTION','Refresh and explicitly select the receipt tab again');
   if(session.capturing)invalid('BOT_BUSY','A receipt capture is already running');session.capturing=true;
   const check=()=>{aborted(signal);guard?.();if(this.current(p,id)!==session||target.page.isClosed()||target.page.url()!==target.url||(session.epochs.get(target.page)??0)!==target.epoch||!this.receiptView(portal,target.page))invalid('SOURCE_CONFLICT','The selected tab navigated or its dedicated session changed; select the receipt again');};
   let client:CDPSession|undefined;
   try{
     check();client=await target.page.createCDPSession();const metrics=await client.send('Page.getLayoutMetrics');check();
     const visible=metrics.cssVisualViewport,width=Math.floor(visible.clientWidth),height=Math.floor(visible.clientHeight);
     const clip=selection.clip??{x:0,y:0,width,height};
     if(!clip||Object.keys(clip).some(k=>!['x','y','width','height'].includes(k))||![clip.x,clip.y,clip.width,clip.height].every(Number.isSafeInteger)||clip.x<0||clip.y<0||clip.width<1||clip.height<1||clip.width>4096||clip.height>4096||clip.width*clip.height>4000000||clip.x+clip.width>width||clip.y+clip.height>height)invalid('CAPTURE_LIMIT','Select a bounded area inside the currently visible receipt viewport');
     // No await between this current-session/tab guard and the screenshot command.
     check();const captured=await client.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false,clip:{x:visible.pageX+clip.x,y:visible.pageY+clip.y,width:clip.width,height:clip.height,scale:1}});check();
     if(captured.data.length>Math.ceil(MAX_DOCUMENT_BYTES*4/3)+4)invalid('CAPTURE_LIMIT','Receipt image exceeds the document limit');
     const bytes=Buffer.from(captured.data,'base64');if(bytes.length<24||bytes.length>MAX_DOCUMENT_BYTES||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))invalid('CAPTURE_LIMIT','Receipt image is invalid');
     const pixelWidth=bytes.readUInt32BE(16),pixelHeight=bytes.readUInt32BE(20);if(pixelWidth<1||pixelHeight<1||pixelWidth>4096||pixelHeight>4096||pixelWidth*pixelHeight>4000000)invalid('CAPTURE_LIMIT','Receipt collection limit exceeded');
     const hash=digest(bytes),source_origin=new URL(target.url).origin,host=new URL(target.url).hostname,guid=randomUUID();
     const prior=[...session.downloads.values()].find(item=>item.hash===hash&&item.evidence?.evidence_kind==='receipt-capture'&&item.evidence.source_origin===source_origin);if(prior?.evidence){check();return structuredClone(prior.evidence);}
     if(session.names.size+session.capturesCreated>=100)invalid('CAPTURE_LIMIT','Receipt collection limit exceeded');
     const captured_at=new Date().toISOString(),source_id='receipt-capture:'+host+':'+captured_at.replace(/[-:.]/g,'')+':'+hash;
     if((id+':'+source_id).length>160)invalid('CAPTURE_LIMIT','Receipt provenance exceeds the source identifier bound');
     const evidence:PortalInvoice={source_id,filename:id+'-receipt-evidence-'+hash.slice(0,12)+'.png',href:'/download/'+source_id,evidence_kind:'receipt-capture',source_origin,capture:{scope:'selected-viewport',width:pixelWidth,height:pixelHeight,captured_at,unconfirmed:true}};
     // Protected owned-session directory exists already. Publication is synchronous after the final guard.
     check();writeFileSync(join(session.directory,'downloads',guid),bytes,{flag:'wx',mode:0o600});session.capturesCreated++;session.downloads.set(source_id,{guid,filename:evidence.filename,hash,bytes:bytes.length,evidence});return evidence;
   }finally{session.capturing=false;await client?.detach().catch(()=>{});}
 }
 private async removeDirectory(directory:string){
   const root=await realpath(this.root),target=await realpath(directory),boundary=relative(root,target);
   const stat=await lstat(directory);
   if(!stat.isDirectory()||stat.isSymbolicLink()||!boundary||boundary.startsWith('..')||isAbsolute(boundary)||/[\\/]/.test(boundary)||!boundary.startsWith('session-'))throw new Error('UNSAFE_PORTAL_STORAGE');
   await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
 async disconnect(p:Principal,id:string){
   const key=this.key(p,id);this.attempts.delete(key);const session=this.sessions.get(key);if(session)await this.dispose(key,session);
 }
 private dispose(key:string,session:OwnedSession):Promise<void>{
   if(this.sessions.get(key)===session)this.sessions.delete(key);clearTimeout(session.timer);
   const existing=this.disposing.get(session);if(existing)return existing;
   const cleanup=(async()=>{await session.proxy.close();try{await session.browser.close();}finally{await this.removeDirectory(session.directory);}})();this.disposing.set(session,cleanup);return cleanup;
 }
 async close(){this.attempts.clear();for(const [key,session]of this.sessions)await this.dispose(key,session);}
 adapters():PortalAdapter[]{return this.portals.map(portal=>({id:portal.id,label:portal.label,origin:new URL(portal.url).origin,help:portal.help,receiptCapture:!!portal.receiptPaths?.length,connect:async(p,_sessions,signal)=>{aborted(signal);this.current(p,portal.id);},discover:(p,_sessions,signal)=>this.discover(p,portal.id,signal),download:(p,_sessions,invoice,signal)=>this.download(p,portal.id,invoice,signal)}));}
}
