// Explicit synthetic composition of the actual application; never a production entrypoint.
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import puppeteer from 'puppeteer-core';
import {AssistedPortalSessions} from '../../src/community/invoice-bot/assisted-portals.ts';
import {createCommunityApplication} from '../../src/server/application.ts';
const receipt='<link rel="icon" href="data:,"><style>body{margin:0;background:#204060;color:white;font:24px sans-serif}main{padding:24px}</style><main>Fictional receipt SYN-UI-RECEIPT<br>Receipt evidence only, not a tax invoice<br>EUR 4.25</main>';
const portal=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end(receipt);});
await new Promise(ok=>portal.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+portal.address().port;
const executablePath=[process.env.MATCHING_TEST_BROWSER,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value=>value&&existsSync(value));
if(!executablePath)throw new Error('Synthetic Chromium executable required');
const sessions=new AssistedPortalSessions(join(process.env.MATCHING_RUNTIME_ROOT,'identity','invoice-browsers'),{
 portals:[{id:'aliexpress',label:'AliExpress synthetic receipt (assisted download / receipt evidence)',url:origin+'/p/order/index.html',domains:['127.0.0.1'],help:origin,receiptPaths:['/p/order/']}],
 checkOrigin:async value=>{if(value!==origin)throw new Error('Unexpected synthetic portal origin');},
 launch:async(profile,proxy)=>puppeteer.launch({executablePath,headless:true,userDataDir:profile,args:['--proxy-server='+proxy,'--proxy-bypass-list=<-loopback>','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']}),
});
const application=createCommunityApplication({invoiceBot:{adapters:sessions.adapters(),sessions,allowLocalFixture:true,close:async()=>{await sessions.close();portal.closeAllConnections();await new Promise(ok=>portal.close(ok));}}});
const server=application.app.listen(application.port,application.host);
process.once('SIGTERM',()=>server.close(()=>{void application.close().then(()=>process.exit(0));}));
