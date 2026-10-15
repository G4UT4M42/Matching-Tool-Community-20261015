// Explicit synthetic composition of the production application. Never a production entrypoint.
import {createServer} from 'node:http';
import PDFDocument from 'pdfkit';
import {existsSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {verifyPackage} from '../../scripts/verify-community-package.mjs';
const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
const applicationRoot=process.argv[2]?resolve(process.argv[2]):sourceRoot;
if(applicationRoot!==resolve(sourceRoot))verifyPackage(applicationRoot);
const {createCommunityApplication}=await import(pathToFileURL(join(applicationRoot,'src/server/application.ts')).href);
async function invoiceBytes(reference){const chunks=[],pdf=new PDFDocument({size:'A4'});const done=new Promise(resolve=>{pdf.on('data',chunk=>chunks.push(chunk));pdf.on('end',()=>resolve(Buffer.concat(chunks)));});pdf.fontSize(18).text('Invoice number: '+reference).text('Supplier: Fictional Portal Supplier').text('Invoice date: 2026-01-12').text('Grand total: EUR 4.25');pdf.end();return done;}
const invoices=[{source_id:'SYN-PORTAL-1',filename:'synthetic-portal.pdf',href:'/invoice.pdf'},{source_id:'SYN-PORTAL-2',filename:'synthetic-portal-unknown.pdf',href:'/invoice-unknown.pdf'}];
const documents=new Map([[invoices[0].href,await invoiceBytes('SYN-PORTAL-ACK')],[invoices[1].href,await invoiceBytes('SYN-PORTAL-UNKNOWN')]]);
const portal=createServer((request,response)=>{if(request.url==='/invoices'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify(invoices));}else if(documents.has(request.url)){response.setHeader('Content-Type','application/pdf');response.end(documents.get(request.url));}else{response.writeHead(404);response.end();}});
await new Promise(resolve=>portal.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+portal.address().port;
const connected=new Set(),key=p=>JSON.stringify([p.workspace_id,p.subject]);
const sessions={async openFreshSession(p){connected.add(key(p));},async disconnect(p){connected.delete(key(p));},async isConnected(p){return connected.has(key(p));}};
const adapter={id:'synthetic-portal',label:'Synthetic invoice portal',origin,
  async connect(p,s,signal){const response=await fetch(origin+'/invoices',{signal});if(!response.ok)throw new Error('Synthetic portal connection failed');},
  async discover(p,s,signal){return(await fetch(origin+'/invoices',{signal})).json();},
  async download(p,s,invoice,signal){if(!documents.has(invoice.href))throw new Error('Unexpected synthetic invoice');const response=await fetch(origin+invoice.href,{signal});if(!response.ok)throw new Error('Synthetic download failed');return Buffer.from(await response.arrayBuffer());}};
const providerTransport=async request=>{
  const url=new URL(request.url);
  if(url.origin==='https://api-m.sandbox.paypal.com'&&url.pathname==='/v1/oauth2/token')return{status:200,json:{access_token:'synthetic-runtime-only',expires_in:3600}};
  if(url.origin==='https://api-m.sandbox.paypal.com'&&url.pathname==='/v1/reporting/transactions')return{status:200,json:{account_number:'SYNTHETICPAYPALACCOUNT',total_pages:1,transaction_details:[{transaction_info:{transaction_id:'SYN-PAYPAL-PAYMENT',transaction_amount:{value:'10.00',currency_code:'EUR'},fee_amount:{value:'-0.50',currency_code:'EUR'},transaction_event_code:'T0006',transaction_status:'S',transaction_initiation_date:'2026-10-14T12:00:00Z'}},{transaction_info:{transaction_id:'SYN-PAYPAL-REFUND',transaction_amount:{value:'-2.00',currency_code:'EUR'},transaction_event_code:'T1107',transaction_status:'S',transaction_initiation_date:'2026-10-14T13:00:00Z'}}]}};
  if(url.origin==='https://api.stripe.com'&&url.pathname==='/v1/account')return{status:200,json:{id:'acct_SYNTHETICINTEGRATED',object:'account'}};
  if(url.origin==='https://api.stripe.com'&&url.pathname==='/v1/balance_transactions')return{status:200,json:{has_more:false,data:[{id:'SYN_STRIPE_CHARGE',amount:2000,fee:100,net:1900,currency:'eur',created:1791979200,type:'charge',source:'SYN_CHARGE'},{id:'SYN_STRIPE_REFUND',amount:-300,fee:0,net:-300,currency:'eur',created:1791982800,type:'refund',source:'SYN_REFUND'},{id:'SYN_STRIPE_PAYOUT',amount:-1600,fee:0,net:-1600,currency:'eur',created:1791986400,type:'payout',source:'SYN_PAYOUT'}]}};
  throw new Error('Unexpected outbound provider request in synthetic composition');
};
const claimed=new Set();const paymentAdapter={provider:'community-simulated-bank',environment:'mock',async submit({claimId,batch}){if(claimed.has(claimId))throw new Error('Duplicate synthetic submission');claimed.add(claimId);return batch.items.some(item=>item.reference.includes('UNKNOWN'))?{outcome:'unknown'}:{outcome:'acknowledged',reference:'SYN-'+claimId};},async readStatus(){return{outcome:'unknown'};}};
const interruption=join(process.env.MATCHING_RUNTIME_ROOT,'synthetic-cutover-interruption.json');
const afterRestoreCutover=()=>{if(!existsSync(interruption))return;const armed=JSON.parse(readFileSync(interruption,'utf8'));if(armed.run_id!=='SYNTHETIC-COMPLETE-LEGACY')throw new Error('Invalid synthetic interruption');unlinkSync(interruption);writeFileSync(interruption+'.occurred',JSON.stringify({phase:'after-directory-cutover-before-reopen',exit_code:86}));process.exit(86);};
const application=createCommunityApplication({afterRestoreCutover,providerTransport,invoiceBot:{adapters:[adapter],sessions,allowLocalFixture:true,close:()=>new Promise(resolve=>portal.close(resolve))},paymentAdapter});
const server=application.app.listen(application.port,application.host);
process.once('SIGTERM',()=>server.close(()=>{void application.close().then(()=>process.exit(0));}));
