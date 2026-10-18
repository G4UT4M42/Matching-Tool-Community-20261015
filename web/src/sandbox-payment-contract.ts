export type SandboxBank={name:string;country:string};
export type SandboxBatchView={id:string;revision:number;detailDigest:string;provider:string;environment:string;status:string;debtorName:string;debtorIban:string;items:{id:string;documentId:string;creditorName:string;creditorIban:string;amountMinor:number;currency:string;reference:string;dueDate:string}[]};
export type SandboxIntent={digest:string;executionDate:string;chargeBearer:'SLEV';deferSubmission:false;applicationId:string;environment:'sandbox'};
export type SandboxConfirmation={token:string;flowId:string;expiresAt:string;bank:SandboxBank;psuType:'personal'|'business';intent:SandboxIntent};
export type SandboxFlow={batchId:string;flowId:string;stage:'confirmation_ready'|'awaiting_callback'|'callback_received';expiresAt:string};
const fail=():never=>{throw Error('PIS_RESPONSE_INVALID');};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const text=(x:unknown,max=256):x is string=>typeof x==='string'&&x.length>0&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const date=(x:unknown):x is string=>text(x,40)&&Number.isFinite(Date.parse(x));
const day=(x:unknown):x is string=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
const digest=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function bank(x:unknown):SandboxBank{if(!object(x)||!text(x.name,200)||typeof x.country!=='string'||!/^[A-Z]{2}$/.test(x.country))return fail();return{name:x.name,country:x.country};}
export function sandboxBanks(x:unknown):SandboxBank[]{if(!object(x)||x.environment!=='sandbox'||!Array.isArray(x.items)||x.items.length>1000)return fail();const result=x.items.map(bank),seen=new Set<string>();for(const value of result){const id=value.country+'\0'+value.name;if(seen.has(id))return fail();seen.add(id);}return result;}
export function sandboxStatus(x:unknown,origin:string){
 if(!object(x)||x.provider!=='enablebanking-pis'||x.environment!=='sandbox'||x.productionEnabled!==false||typeof x.applicationConfigured!=='boolean'||!['sandbox','live',null].includes(x.applicationEnvironment as any)||x.callbackUrl!==origin+'/api/community-payments/sandbox/callback'||!Array.isArray(x.pending)||x.pending.length>100)return fail();
 const seen=new Set<string>();const pending=x.pending.map(raw=>{if(!object(raw)||!text(raw.batchId,128)||!uuid(raw.flowId)||!['confirmation_ready','awaiting_callback','callback_received'].includes(raw.stage as string)||!date(raw.expiresAt)||seen.has(raw.flowId))return fail();seen.add(raw.flowId);return{batchId:raw.batchId,flowId:raw.flowId,stage:raw.stage as SandboxFlow['stage'],expiresAt:raw.expiresAt};});
 return{applicationConfigured:x.applicationConfigured,applicationEnvironment:x.applicationEnvironment as 'sandbox'|'live'|null,callbackUrl:x.callbackUrl as string,pending};
}
function batch(x:unknown,expected:SandboxBatchView,statuses:string[]):void{
 if(!object(x)||x.id!==expected.id||x.provider!=='enablebanking-pis'||x.environment!=='sandbox'||x.detailDigest!==expected.detailDigest||!Number.isSafeInteger(x.revision)||(x.revision as number)<expected.revision||!statuses.includes(x.status as string)||x.debtorName!==expected.debtorName||x.debtorIban!==expected.debtorIban||!Array.isArray(x.items)||x.items.length!==expected.items.length)return fail();
 const fields=['id','documentId','creditorName','creditorIban','amountMinor','currency','reference','dueDate'];for(let i=0;i<expected.items.length;i++)for(const field of fields)if(!object(x.items[i])||x.items[i][field]!==expected.items[i][field as keyof SandboxBatchView['items'][number]])return fail();
}
export function sandboxConfirmation(x:unknown,expected:SandboxBatchView,selected:SandboxBank,psuType:'personal'|'business'):SandboxConfirmation{
 if(!object(x)||!text(x.token,512)||x.token.length<30||!uuid(x.flowId)||!date(x.expiresAt)||x.psuType!==psuType||!object(x.intent)||!digest(x.intent.digest)||!day(x.intent.executionDate)||x.intent.chargeBearer!=='SLEV'||x.intent.deferSubmission!==false||!uuid(x.intent.applicationId)||x.intent.environment!=='sandbox')return fail();
 batch(x.batch,expected,['approved']);const chosen=bank(x.bank);if(chosen.name!==selected.name||chosen.country!==selected.country)return fail();
 return{token:x.token,flowId:x.flowId,expiresAt:x.expiresAt,bank:chosen,psuType,intent:{digest:x.intent.digest,executionDate:x.intent.executionDate,chargeBearer:'SLEV',deferSubmission:false,applicationId:x.intent.applicationId,environment:'sandbox'}};
}
export function sandboxAuthorizationUrl(x:unknown):string{
 if(!text(x,4096))return fail();let url:URL;try{url=new URL(x);}catch{return fail();}if(url.protocol!=='https:'||url.hostname!=='auth.enablebanking.com'||url.username||url.password||url.hash||url.port)return fail();return url.href;
}
export function sandboxAuthorization(x:unknown,expected:SandboxBatchView,flowId:string){if(!object(x)||x.environment!=='sandbox'||x.flowId!==flowId||!date(x.expiresAt))return fail();batch(x.batch,expected,['unknown','submission_claimed']);return{flowId,expiresAt:x.expiresAt,authorizationUrl:sandboxAuthorizationUrl(x.authorizationUrl)};}
const statuses=new Set(['ACCC','ACCP','ACCR','ACPT','ACSC','ACSP','ACTC','ACWC','ACWP','CNCL','NULL','PACR','PART','PDCR','PDNG','RCVD','RJCR','RJCT']);
export function sandboxCompletion(x:unknown,expected:SandboxBatchView){if(!object(x)||x.verifiedDetails!==true||typeof x.finalStatus!=='boolean'||!text(x.providerStatus,16)||!statuses.has(x.providerStatus)||x.transactionStatus!==undefined&&(typeof x.transactionStatus!=='string'||!statuses.has(x.transactionStatus)||x.providerStatus==='ACCC'&&x.transactionStatus!=='ACCC'||x.providerStatus==='RJCT'&&x.transactionStatus!=='RJCT'))return fail();batch(x.batch,expected,['unknown','submission_claimed','acknowledged','failed']);return{providerStatus:x.providerStatus,finalStatus:x.finalStatus,...(x.transactionStatus===undefined?{}:{transactionStatus:x.transactionStatus as string})};}
export function sandboxRecoveredBatch(x:unknown,expected:SandboxBatchView):void{batch(x,expected,['unknown','submission_claimed','acknowledged','failed']);}
