// Explicit synthetic transport for the actual application; never a production entrypoint.
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {verifyPackage} from '../../scripts/verify-community-package.mjs';
const sourceRoot=fileURLToPath(new URL('../../',import.meta.url)),applicationRoot=process.argv[2]?resolve(process.argv[2]):sourceRoot;
if(applicationRoot!==resolve(sourceRoot))verifyPackage(applicationRoot);
const {createCommunityApplication}=await import(pathToFileURL(join(applicationRoot,'src/server/application.ts')).href);
const runtime=process.env.MATCHING_RUNTIME_ROOT,appId='33333333-3333-4333-8333-333333333333',paymentId='44444444-4444-4444-8444-444444444444',bank={name:'Synthetic PIS Sandbox Bank',country:'AT'};
const origin='http://127.0.0.1:'+process.env.PORT,aisCallback=origin+'/api/community-banking/callback',pisCallback=origin+'/api/community-payments/sandbox/callback',record=join(runtime,'synthetic-pis-transport.json');
let stored=existsSync(record)?JSON.parse(readFileSync(record,'utf8')):{calls:[],created:0,request:null};
const meta={payment_type:'SEPA',psu_type:'personal',max_transactions:1,currencies:['EUR'],debtor_account_schemas:['IBAN'],creditor_account_schemas:['IBAN'],charge_bearer_values:['SLEV'],requested_execution_date_supported:true,requested_execution_date_max_period:365,remittance_information_lines:[{min_length:1,max_length:140,pattern:'^.{1,140}$'}]};
const transport=async(input,init)=>{
 const url=new URL(String(input));assert.equal(url.origin,'https://api.enablebanking.com');assert.equal(init.redirect,'error');assert.match(init.headers.Authorization,/^Bearer /);
 const header=JSON.parse(Buffer.from(init.headers.Authorization.slice(7).split('.')[0],'base64url'));assert.equal(header.kid,appId);
 stored.calls.push({method:init.method,path:url.pathname,queryKeys:[...url.searchParams.keys()]});writeFileSync(record,JSON.stringify(stored));
 const reply=value=>Response.json(value);
 if(url.pathname==='/application'){assert.equal(init.method,'GET');return reply({kid:appId,active:true,environment:'SANDBOX',services:['AIS','PIS'],redirect_urls:[aisCallback,pisCallback]});}
 if(url.pathname==='/aspsps'){assert.equal(init.method,'GET');assert.equal(url.searchParams.get('country'),'AT');return reply({aspsps:[{...bank,required_psu_headers:[],payments:[meta]}]});}
 if(url.pathname==='/payments'&&init.method==='POST'){
  assert.equal(stored.created,0,'Uncertain or completed payment creation may never be repeated');const request=JSON.parse(init.body);assert.equal(request.redirect_url,pisCallback);assert.deepEqual(request.aspsp,bank);assert.equal(request.defer_submission,false);assert.equal(request.payment_type,'SEPA');assert.equal(request.psu_type,'personal');assert.match(request.state,/^[A-Za-z0-9_-]{43}$/);
  const item=request.payment_request.credit_transfer_transaction[0];assert.equal(request.payment_request.credit_transfer_transaction.length,1);assert.deepEqual(item.instructed_amount,{amount:'12.50',currency:'EUR'});assert.equal(item.beneficiary.creditor_account.identification,'DE36'+'0'.repeat(18));assert.equal(item.remittance_information[0],'SYN PIS E2E');stored={...stored,created:1,request};writeFileSync(record,JSON.stringify(stored));return reply({payment_id:paymentId,status:'RCVD',url:'https://auth.enablebanking.com/pis/start?payment_id='+paymentId});
 }
 if(url.pathname==='/payments/'+paymentId&&init.method==='GET'){assert.equal(stored.created,1);return reply({payment_id:paymentId,status:'ACCC',final_status:true,aspsp:stored.request.aspsp,payment_type:'SEPA',payment_details:structuredClone(stored.request.payment_request),psu_id_hash:'SYNTHETIC-PIS-PSU'});}
 throw Error('Unexpected synthetic PIS endpoint');
};
const application=createCommunityApplication({bankTransport:transport,paymentTransport:transport}),server=application.app.listen(application.port,application.host);
process.once('SIGTERM',()=>server.close(()=>{void application.close().then(()=>process.exit(0));}));
