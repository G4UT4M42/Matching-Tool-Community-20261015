import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyFailedRequest} from './helpers/browser-observations.mjs';
const origin='http://127.0.0.1:49123';
test('explain Chromium empty204 only for reviewed same-origin POST routes with received204 headers',()=>{
 for(const path of ['/api/auth/logout','/api/community-banking/configure','/api/community-banking/disconnect']){
  const result=classifyFailedRequest({origin,url:origin+path,method:'POST',error:'net::ERR_ABORTED',responseStatus:204});
  assert.equal(result.expected,true);assert.match(result.explanation,/independently asserts/);assert.equal(result.response_status,204);
 }
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
