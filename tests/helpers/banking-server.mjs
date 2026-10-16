// Synthetic AIS transport injected into the actual application. No production test switch.
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {writeFileSync} from 'node:fs';
import {verifyPackage} from '../../scripts/verify-community-package.mjs';
const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
const applicationRoot=process.argv[2]?resolve(process.argv[2]):sourceRoot;
if(applicationRoot!==resolve(sourceRoot))verifyPackage(applicationRoot);
const {createCommunityApplication}=await import(pathToFileURL(join(applicationRoot,'src/server/application.ts')).href);
const appId='33333333-3333-4333-8333-333333333333',sessionId='22222222-2222-4222-8222-222222222222',accountRef='11111111-1111-4111-8111-111111111111';
let authorizationState;
let transportCalls=0;
const callback=`http://127.0.0.1:${process.env.PORT}/api/community-banking/callback`;
const bankTransport=async(input,init)=>{
 writeFileSync(join(process.env.MATCHING_RUNTIME_ROOT,'synthetic-bank-transport-count.json'),JSON.stringify({calls:++transportCalls}));
 const url=new URL(String(input));assert.equal(url.origin,'https://api.enablebanking.com');assert.equal(init.redirect,'error');assert.match(init.headers.Authorization,/^Bearer /);
 const header=JSON.parse(Buffer.from(init.headers.Authorization.slice(7).split('.')[0],'base64url'));assert.equal(header.kid,appId);
 const reply=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
 if(url.pathname==='/application'){assert.equal(init.method,'GET');return reply({kid:appId,active:true,environment:'SANDBOX',services:['AIS'],redirect_urls:[callback]});}
 if(url.pathname==='/aspsps'){assert.equal(init.method,'GET');assert.equal(url.searchParams.get('country'),'AT');return reply({aspsps:[{name:'Synthetic consent bank',country:'AT',maximum_consent_validity:86400}]});}
 if(url.pathname==='/auth'){assert.equal(init.method,'POST');const body=JSON.parse(init.body);assert.equal(body.redirect_url,callback);assert.deepEqual(body.aspsp,{name:'Synthetic consent bank',country:'AT'});assert.match(body.state,/^[A-Za-z0-9_-]{43}$/);authorizationState=body.state;return reply({url:'https://auth.enablebanking.com/ais/start?'+new URLSearchParams({sessionid:authorizationState})});}
 if(url.pathname==='/sessions'){assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(init.body),{code:'synthetic-once-code'});assert.ok(authorizationState);authorizationState=undefined;return reply({session_id:sessionId,accounts:[{uid:accountRef,identification_hash:'SYNTHETIC-STABLE-BANK-IDENTITY',name:'Synthetic consent account',currency:'EUR'}]});}
 if(url.pathname==='/sessions/'+sessionId){assert.equal(init.method,'GET');return reply({status:'AUTHORIZED',access:{valid_until:new Date(Date.now()+86400000).toISOString()},accounts:[accountRef],accounts_data:[{uid:accountRef,identification_hash:'SYNTHETIC-STABLE-BANK-IDENTITY'}]});}
 if(url.pathname==='/accounts/'+accountRef+'/details'){assert.equal(init.method,'GET');return reply({uid:accountRef,name:'Synthetic consent account',currency:'EUR'});}
 if(url.pathname==='/accounts/'+accountRef+'/transactions'){assert.equal(init.method,'GET');return reply({transactions:[{transaction_id:'SYN-CONSENT-EUR-001',booking_date:'2026-10-14',status:'BOOK',credit_debit_indicator:'DBIT',transaction_amount:{currency:'EUR',amount:'12.34'},remittance_information:['Synthetic consent bank import']}]});}
 throw Error('Unexpected synthetic AIS endpoint');
};
const application=createCommunityApplication({bankTransport});
const server=application.app.listen(application.port,application.host);
process.once('SIGTERM',()=>server.close(()=>{void application.close().then(()=>process.exit(0));}));
