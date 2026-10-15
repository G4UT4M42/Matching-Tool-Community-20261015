// Explain only the observed Chromium empty-response condition on reviewed routes.
// Functional state and durable outcomes must still be asserted by each journey.
const emptyPostRoutes=new Set(['/api/auth/logout','/api/community-banking/configure','/api/community-banking/disconnect']);
export function classifyFailedRequest({origin,url,method,error,responseStatus,armedInterruptionPath}){
 const target=new URL(url),sameOrigin=target.origin===origin;
 const emptyResponse=sameOrigin&&method==='POST'&&emptyPostRoutes.has(target.pathname)&&responseStatus===204&&error==='net::ERR_ABORTED';
 const interruption=sameOrigin&&method==='POST'&&target.pathname===armedInterruptionPath&&responseStatus===undefined&&/^net::ERR_(EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_REFUSED)$/.test(error??'');
 return{method,path:target.pathname,error,response_status:responseStatus,expected:emptyResponse||interruption,...(emptyResponse?{explanation:'Chromium empty HTTP204 response after headers; the journey independently asserts the operation and durable state'}:{})};
}

// Expectations explain individual observed responses, never a class of routes or
// status codes. Register before the negative action; a response consumes one slot.
export function expectedHttpFailures(origin){
 const expectations=[],responses=[];
 function expect({method,path,status,reason}){
  const target=new URL(path,origin);
  if(typeof method!=='string'||!/^[A-Z]+$/.test(method)||typeof path!=='string'||!path.startsWith('/')||target.origin!==origin||target.pathname+target.search!==path||!Number.isInteger(status)||status<400||status>599||typeof reason!=='string'||!reason.trim()||reason.length>1000)throw new Error('An HTTP failure expectation needs an exact method, same-origin path, error status and reason');
  const entry={id:expectations.length,method,path,status,reason};expectations.push(entry);return entry.id;
 }
 function observe({url,method,status}){
  const target=new URL(url);if(target.origin!==origin||status<400)return;
  const path=target.pathname+target.search;
  const expected=expectations.find(entry=>!responses.some(response=>response.expectation_id===entry.id)&&entry.method===method&&entry.path===path&&entry.status===status);
  const entry={id:responses.length,method,path,status,...(expected?{expectation_id:expected.id,reason:expected.reason}:{})};responses.push(entry);return entry;
 }
 function review(consoleRecords){
  const unexpected_responses=responses.filter(entry=>entry.expectation_id===undefined);
  const unconsumed_expectations=expectations.filter(entry=>!responses.some(response=>response.expectation_id===entry.id));
  const explained_console=[],unexplained_console=[],claimedResponses=new Set();
  const candidates=consoleRecords.map((record,index)=>({record,index:record.index??index,status:Number(/^Failed to load resource: the server responded with a status of ([45]\d\d)(?:\s|$)/.exec(record.text)?.[1])}));
  // URL-bearing records have stronger identity than Chromium's URL-less messages.
  // Claim them first so an unrelated URL-less message cannot steal their slot.
  candidates.sort((a,b)=>Number(Boolean(b.record.url))-Number(Boolean(a.record.url))||a.index-b.index);
  for(const {record,index,status} of candidates){
   let path;if(record.url){try{const target=new URL(record.url);if(target.origin===origin)path=target.pathname+target.search;}catch{}}
   const response=Number.isInteger(status)?responses.find(entry=>entry.expectation_id!==undefined&&!claimedResponses.has(entry.id)&&entry.status===status&&(!record.url||entry.path===path)):undefined;
   if(response){claimedResponses.add(response.id);explained_console.push({index,response_id:response.id,expectation_id:response.expectation_id,reason:response.reason,correlation:record.url?'exact-url-and-status':'exact-status-and-count'});}else unexplained_console.push({index,...record});
  }
  return{expectations:expectations.map(entry=>({...entry})),responses:responses.map(entry=>({...entry})),unexpected_responses,unconsumed_expectations,explained_console:explained_console.sort((a,b)=>a.index-b.index),unexplained_console:unexplained_console.sort((a,b)=>a.index-b.index)};
 }
 return{expect,observe,review};
}
