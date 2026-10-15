import {createServer,request as httpRequest,type Server,type IncomingMessage,type ServerResponse} from 'node:http';
import {connect} from 'node:net';
import {lookup} from 'node:dns/promises';
import type {Duplex} from 'node:stream';
import {publicPortalAddresses} from './coordinator.js';

/** Session-owned loopback forward proxy. HTTPS stays encrypted end-to-end.
 * Every TCP destination is checked and pinned to the SAME validated DNS result.
 * HTTP Upgrade is rejected; WSS CONNECT obeys the same host/IP/port policy.
 * No credentials, URLs containing tokens or application payloads are logged.
 */
export class PortalEgressProxy{
 private server?:Server;
 private readonly sockets=new Set<Duplex>();
 private readonly addresses=new Map<string,Promise<{address:string;family:number}>>();
 constructor(private readonly domains:readonly string[],private readonly fixtureCheck?:(origin:string)=>Promise<void>){}
 private async destination(url:URL){
   const host=url.hostname.toLowerCase();
   if(url.username||url.password||!this.domains.some(domain=>host===domain||host.endsWith('.'+domain))||(!this.fixtureCheck&&(url.protocol!=='https:'||url.port&&url.port!=='443')))throw new Error('PORTAL_EGRESS_DENIED');
   if(!this.addresses.has(url.origin))this.addresses.set(url.origin,(async()=>{
     if(this.fixtureCheck){await this.fixtureCheck(url.origin);return lookup(host);}
     return(await publicPortalAddresses(url.origin))[0];
   })());
   return this.addresses.get(url.origin)!;
 }
 private track(socket:Duplex){this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));socket.on('error',()=>{});}
 private async forward(input:IncomingMessage,output:ServerResponse){
   try{
     const url=new URL(input.url??'');if(url.protocol!=='http:'||!this.fixtureCheck)throw new Error('PORTAL_EGRESS_DENIED');
     const address=await this.destination(url);const headers:import('node:http').OutgoingHttpHeaders={...input.headers,host:url.host};delete headers['proxy-authorization'];delete headers['proxy-connection'];
     const upstream=httpRequest({host:address.address,family:address.family,port:Number(url.port||80),path:url.pathname+url.search,method:input.method,headers,agent:false},response=>{output.writeHead(response.statusCode??502,response.headers);response.pipe(output);});
     upstream.on('socket',socket=>this.track(socket));upstream.setTimeout(30000,()=>upstream.destroy());upstream.once('error',()=>{if(!output.headersSent)output.writeHead(502);output.end();});input.pipe(upstream);
   }catch{output.writeHead(403);output.end();}
 }
 private async tunnel(input:IncomingMessage,client:Duplex,head:Buffer){
   try{
     const url=new URL('https://'+input.url);if(url.pathname!=='/'||url.search||url.hash||url.port&&url.port!=='443')throw new Error('PORTAL_EGRESS_DENIED');
     const address=await this.destination(url);
     const upstream=connect({host:address.address,family:address.family,port:443});this.track(upstream);upstream.setTimeout(60000,()=>upstream.destroy());
     upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
     upstream.once('error',()=>client.destroy());client.once('close',()=>upstream.destroy());
   }catch{client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
 }
 async start():Promise<string>{
   if(this.server)throw new Error('PORTAL_PROXY_ALREADY_STARTED');
   const server=createServer((input,output)=>{void this.forward(input,output);});this.server=server;server.maxConnections=64;
   server.on('connection',socket=>this.track(socket));server.on('connect',(input,client,head)=>{void this.tunnel(input,client,head);});
   server.on('upgrade',(_input,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
   await new Promise<void>((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
   return'http://127.0.0.1:'+(server.address() as {port:number}).port;
 }
 async close(){const server=this.server;if(!server)return;this.server=undefined;for(const socket of this.sockets)socket.destroy();this.sockets.clear();await new Promise<void>(ok=>server.close(()=>ok()));}
}
