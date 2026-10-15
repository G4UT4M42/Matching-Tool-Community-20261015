// Explain only the observed Chromium empty-response condition on reviewed routes.
// Functional state and durable outcomes must still be asserted by each journey.
const emptyPostRoutes=new Set(['/api/auth/logout','/api/community-banking/configure','/api/community-banking/disconnect']);
export function classifyFailedRequest({origin,url,method,error,responseStatus,armedInterruptionPath}){
 const target=new URL(url),sameOrigin=target.origin===origin;
 const emptyResponse=sameOrigin&&method==='POST'&&emptyPostRoutes.has(target.pathname)&&responseStatus===204&&error==='net::ERR_ABORTED';
 const interruption=sameOrigin&&method==='POST'&&target.pathname===armedInterruptionPath&&responseStatus===undefined&&/^net::ERR_(EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_REFUSED)$/.test(error??'');
 return{method,path:target.pathname,error,response_status:responseStatus,expected:emptyResponse||interruption,...(emptyResponse?{explanation:'Chromium empty HTTP204 response after headers; the journey independently asserts the operation and durable state'}:{})};
}
