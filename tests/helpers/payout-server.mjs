// Synthetic read-only Stripe transport composed with the actual application.
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {existsSync,writeFileSync} from 'node:fs';
import {verifyPackage} from '../../scripts/verify-community-package.mjs';
const sourceRoot=fileURLToPath(new URL('../../',import.meta.url)),applicationRoot=process.argv[2]?resolve(process.argv[2]):sourceRoot;
if(applicationRoot!==resolve(sourceRoot))verifyPackage(applicationRoot);
const {createCommunityApplication}=await import(pathToFileURL(join(applicationRoot,'src/server/application.ts')).href);
const runtime=process.env.MATCHING_RUNTIME_ROOT,calls=[];
const rows=payoutId=>{
 const suffix=payoutId==='po_SYNTPENDING'?'LATE':'';
 return[{id:'txn_SYNTCHARGE'+suffix,object:'balance_transaction',type:'charge',reporting_category:'charge',amount:1000,fee:30,net:970,currency:'eur',created:Date.parse('2026-08-01T12:00:00Z')/1000,source:'ch_SYNTCHARGE'+suffix},{id:'txn_SYNTREFUND'+suffix,object:'balance_transaction',type:'refund',reporting_category:'refund',amount:-200,fee:0,net:-200,currency:'eur',created:Date.parse('2026-10-14T12:00:00Z')/1000,source:'re_SYNTREFUND'+suffix},{id:'txn_SYNTOWN'+suffix,object:'balance_transaction',type:'payout',reporting_category:'payout',amount:-750,fee:20,net:-770,currency:'eur',created:Date.parse('2026-10-14T13:00:00Z')/1000,source:payoutId}];
};
const providerTransport=async request=>{
 assert.equal(request.method,'GET');const url=new URL(request.url);assert.equal(url.origin,'https://api.stripe.com');assert.match(request.headers.Authorization,/^Bearer rk_test_/);
 calls.push({path:url.pathname,queryKeys:[...url.searchParams.keys()]});writeFileSync(join(runtime,'synthetic-payout-transport.json'),JSON.stringify(calls));
 const reply=json=>({status:200,json});
 if(url.pathname==='/v1/account')return reply({object:'account',id:'acct_SYNTPAYOUT'});
 if(url.pathname.startsWith('/v1/payouts/')){const id=url.pathname.split('/').at(-1);assert.ok(['po_SYNTAUTO','po_SYNTMANUAL','po_SYNTPENDING'].includes(id));const pending=id==='po_SYNTPENDING'&&!existsSync(join(runtime,'synthetic-payout-ready.json'));return reply({id,object:'payout',amount:750,currency:'eur',livemode:false,automatic:id!=='po_SYNTMANUAL',method:'standard',status:pending?'pending':'paid',reconciliation_status:id==='po_SYNTMANUAL'?'not_applicable':pending?'in_progress':'completed',balance_transaction:pending?null:rows(id)[2].id});}
 if(url.pathname.startsWith('/v1/balance_transactions/')){const row=[...rows('po_SYNTAUTO'),...rows('po_SYNTPENDING')].find(row=>url.pathname.endsWith('/'+row.id));assert.ok(row);return reply(row);}
 if(url.pathname==='/v1/balance_transactions'){
  const payoutId=url.searchParams.get('payout');
  if(payoutId){assert.ok(['po_SYNTAUTO','po_SYNTPENDING'].includes(payoutId));assert.equal([...url.searchParams.keys()].some(key=>key.startsWith('created')),false);const members=rows(payoutId),after=url.searchParams.get('starting_after');if(!after)return reply({object:'list',url:'/v1/balance_transactions',data:[members[0],members[2]],has_more:true});assert.equal(after,members[2].id);return reply({object:'list',url:'/v1/balance_transactions',data:[members[1]],has_more:false});}
  const from=Number(url.searchParams.get('created[gte]')),to=Number(url.searchParams.get('created[lte]'));return reply({object:'list',url:'/v1/balance_transactions',data:rows('po_SYNTAUTO').filter(row=>row.created>=from&&row.created<=to),has_more:false});
 }
 throw Error('Unexpected synthetic Stripe endpoint');
};
const application=createCommunityApplication({providerTransport}),server=application.app.listen(application.port,application.host);
process.once('SIGTERM',()=>server.close(()=>{void application.close().then(()=>process.exit(0));}));
