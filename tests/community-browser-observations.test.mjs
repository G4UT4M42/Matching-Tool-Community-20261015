import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyFailedRequest,expectedHttpFailures} from './helpers/browser-observations.mjs';
const origin='http://127.0.0.1:49123';
test('source-only receipt fixture refuses an installed package claim before touching package paths',async()=>{
 const {mainBrowser}=await import('./helpers/main-browser.mjs');
 await assert.rejects(mainBrowser('source-only-receipt-guard',{entrypoint:'tests/helpers/portal-evidence-server.mjs',packageDirectory:'SYNTHETIC-NEVER-ACCESSED'}),/source-only/);
});
test('explain Chromium empty204 only for reviewed same-origin POST routes with received204 headers',()=>{
 for(const path of ['/api/auth/logout','/api/community-banking/configure','/api/community-banking/disconnect']){
  const result=classifyFailedRequest({origin,url:origin+path,method:'POST',error:'net::ERR_ABORTED',responseStatus:204});
  assert.equal(result.expected,true);assert.match(result.explanation,/independently asserts/);assert.equal(result.response_status,204);
 }
});

const httpConsole=(status,url='')=>({text:`Failed to load resource: the server responded with a status of ${status} (Synthetic failure)`,url});
const denied={method:'POST',path:'/api/accounting/proposals',status:403,reason:'Synthetic viewer denial independently asserted'};

test('expected HTTP failures are one-use, pre-registered and exact in method/path/query/status',()=>{
 const tracker=expectedHttpFailures(origin);tracker.expect(denied);
 tracker.observe({url:origin+denied.path,method:'POST',status:403});
 let result=tracker.review([httpConsole(403,origin+denied.path)]);
 assert.deepEqual(result.unexpected_responses,[]);assert.deepEqual(result.unconsumed_expectations,[]);assert.deepEqual(result.unexplained_console,[]);assert.equal(result.explained_console[0].correlation,'exact-url-and-status');assert.equal(result.responses[0].reason,denied.reason);
 tracker.observe({url:origin+denied.path,method:'POST',status:403});
 result=tracker.review([httpConsole(403),httpConsole(403)]);
 assert.equal(result.unexpected_responses.length,1);assert.equal(result.unexplained_console.length,1,'One expected response cannot explain duplicate console errors');
 for(const change of [{method:'GET'},{url:origin+denied.path+'/other'},{url:origin+denied.path+'?unexpected=1'},{status:401}]){
  const strict=expectedHttpFailures(origin);strict.expect(denied);strict.observe({url:origin+denied.path,method:'POST',status:403,...change});
  const observed=strict.review([]);assert.equal(observed.unexpected_responses.length,1);assert.equal(observed.unconsumed_expectations.length,1);
 }
 const late=expectedHttpFailures(origin);late.observe({url:origin+denied.path,method:'POST',status:403});late.expect(denied);
 assert.equal(late.review([]).unexpected_responses.length,1);assert.equal(late.review([]).unconsumed_expectations.length,1,'Registering after the response cannot explain it');
});

test('HTTP console correlation never explains another URL, status, extra count, or arbitrary error',()=>{
 for(const wrong of [httpConsole(403,origin+'/api/auth/users'),httpConsole(401,origin+denied.path),httpConsole(403,'http://127.0.0.1:49124'+denied.path),{text:'Application failure',url:''}]){
  const tracker=expectedHttpFailures(origin);tracker.expect(denied);tracker.observe({url:origin+denied.path,method:'POST',status:403});
  assert.equal(tracker.review([wrong]).unexplained_console.length,1);
 }
 const tracker=expectedHttpFailures(origin);tracker.expect(denied);tracker.observe({url:origin+denied.path,method:'POST',status:403});
 const result=tracker.review([httpConsole(403),httpConsole(403,origin+denied.path)]);
 assert.deepEqual(result.explained_console.map(entry=>entry.index),[1],'Exact URL claims its response before URL-less fallback');assert.equal(result.unexplained_console.length,1);
 assert.equal(tracker.review([httpConsole(403)]).explained_console[0].correlation,'exact-status-and-count');
});

test('every same-origin failure includes auth and static resources and unused declarations fail',()=>{
 const tracker=expectedHttpFailures(origin);tracker.expect(denied);
 for(const path of ['/api/auth/session','/missing-icon.svg','/health'])tracker.observe({url:origin+path,method:'GET',status:404});
 tracker.observe({url:'http://127.0.0.1:49124/api/auth/session',method:'GET',status:404});
 tracker.observe({url:origin+'/success',method:'GET',status:200});
 const result=tracker.review([]);assert.equal(result.unexpected_responses.length,3);assert.equal(result.unconsumed_expectations.length,1);
 for(const change of [{path:'//other.invalid/api'},{path:'/api/x#fragment'},{path:'https://other.invalid/api'},{method:'post'},{status:200},{reason:''}])assert.throws(()=>tracker.expect({...denied,...change}),/exact method/);
});
test('empty-response explanation preserves real failures, unknown routes, missing responses and foreign origins',()=>{
 const baseline={origin,url:origin+'/api/community-banking/configure',method:'POST',error:'net::ERR_ABORTED',responseStatus:204};
 for(const change of [{responseStatus:undefined},{responseStatus:200},{responseStatus:500},{error:'net::ERR_CONNECTION_RESET'},{method:'GET'},{url:origin+'/api/community/persistence/restore/unknown/activate'},{url:'http://127.0.0.1:49124/api/community-banking/configure'}]){
  const result=classifyFailedRequest({...baseline,...change});assert.equal(result.expected,false);assert.equal(result.explanation,undefined);
 }
});
test('armed cutover correlation requires the exact same-origin POST and remains separately verified',()=>{
 const path='/api/community/persistence/restore/11111111-1111-4111-8111-111111111111/activate';
 const baseline={origin,url:origin+path,method:'POST',error:'net::ERR_EMPTY_RESPONSE',armedInterruptionPath:path};
 assert.equal(classifyFailedRequest(baseline).expected,true);
 for(const change of [{responseStatus:500},{error:'net::ERR_ABORTED'},{method:'GET'},{url:origin+path+'/other'},{url:'http://127.0.0.1:49124'+path},{armedInterruptionPath:undefined}])assert.equal(classifyFailedRequest({...baseline,...change}).expected,false);
});
