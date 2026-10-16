export type BankEnvironment='sandbox'|'live';
export type BankAccount={accountRef:string;currency:string;name:string;iban?:string};
export type Consent={flowId:string;stage:'awaiting_callback'|'callback_received'|'accounts_ready';expiresAt:string;accounts?:BankAccount[]};
export type BankingStatus={configured:boolean;provider:string;accountRef:string|null;capabilities:Array<{paymentInitiation:boolean;qualification:string}>;applicationConfigured:boolean;applicationEnvironment:BankEnvironment|null;callbackUrl:string;pendingConsent:Consent|null};
export type Bank={name:string;country:string;maximumConsentSeconds:number};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const text=(x:unknown,max=200):x is string=>typeof x==='string'&&x.length>0&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
const date=(x:unknown):x is string=>text(x,64)&&Number.isFinite(Date.parse(x));
export function bankEnvironment(x:unknown):x is BankEnvironment{return x==='sandbox'||x==='live';}
export function bankAccounts(x:unknown):BankAccount[]{
 if(!Array.isArray(x)||x.length>100)throw Error('BANK_RESPONSE_INVALID');
 const seen=new Set<string>();
 return x.map(row=>{if(!object(row)||!text(row.accountRef,200)||seen.has(row.accountRef)||!text(row.name)||typeof row.currency!=='string'||!/^[A-Z]{3}$/.test(row.currency)||row.iban!==undefined&&!text(row.iban,64))throw Error('BANK_RESPONSE_INVALID');seen.add(row.accountRef);return{accountRef:row.accountRef,name:row.name,currency:row.currency,...(row.iban?{iban:row.iban as string}:{})};});
}
export function bankingStatus(x:unknown,origin:string):BankingStatus{
 if(!object(x)||typeof x.configured!=='boolean'||!text(x.provider)||x.accountRef!==null&&!text(x.accountRef)||!Array.isArray(x.capabilities)||x.capabilities.length>10||typeof x.applicationConfigured!=='boolean'||x.applicationEnvironment!==null&&!bankEnvironment(x.applicationEnvironment)||!text(x.callbackUrl,2048))throw Error('BANK_RESPONSE_INVALID');
 const callback=new URL(x.callbackUrl);
 if(callback.origin!==origin||callback.pathname!=='/api/community-banking/callback'||callback.search||callback.hash||callback.username||callback.password)throw Error('BANK_RESPONSE_INVALID');
 const capabilities=x.capabilities.map(row=>{if(!object(row)||typeof row.paymentInitiation!=='boolean'||!text(row.qualification))throw Error('BANK_RESPONSE_INVALID');return{paymentInitiation:row.paymentInitiation,qualification:row.qualification};});
 let pendingConsent:Consent|null=null;
 if(x.pendingConsent!==null){const p=x.pendingConsent;if(!object(p)||!text(p.flowId,200)||!['awaiting_callback','callback_received','accounts_ready'].includes(String(p.stage))||!date(p.expiresAt))throw Error('BANK_RESPONSE_INVALID');pendingConsent={flowId:p.flowId,stage:p.stage as Consent['stage'],expiresAt:p.expiresAt,...(p.accounts!==undefined?{accounts:bankAccounts(p.accounts)}:{})};if(pendingConsent.stage==='accounts_ready'&&!pendingConsent.accounts?.length)throw Error('BANK_RESPONSE_INVALID');}
 return{configured:x.configured,provider:x.provider,accountRef:x.accountRef as string|null,capabilities,applicationConfigured:x.applicationConfigured,applicationEnvironment:x.applicationEnvironment as BankEnvironment|null,callbackUrl:callback.href,pendingConsent};
}
export function availableBanks(x:unknown,expected:BankEnvironment,country:string):Bank[]{
 if(!object(x)||x.environment!==expected||!Array.isArray(x.items)||x.items.length>1000)throw Error('BANK_RESPONSE_INVALID');
 const seen=new Set<string>();return x.items.map(row=>{if(!object(row)||!text(row.name)||row.country!==country||!Number.isSafeInteger(row.maximumConsentSeconds)||Number(row.maximumConsentSeconds)<60||seen.has(row.name))throw Error('BANK_RESPONSE_INVALID');seen.add(row.name);return{name:row.name,country,maximumConsentSeconds:Number(row.maximumConsentSeconds)};});
}
export function consentAuthorization(x:unknown,expected:BankEnvironment):{flowId:string;authorizationUrl:string;expiresAt:string}{
 if(!object(x)||x.environment!==expected||!text(x.flowId,200)||!text(x.authorizationUrl,4096)||!date(x.expiresAt))throw Error('BANK_RESPONSE_INVALID');
 const url=new URL(x.authorizationUrl);
 if(url.protocol!=='https:'||url.hostname!=='auth.enablebanking.com'||url.port||url.username||url.password||url.hash)throw Error('BANK_AUTHORIZATION_URL_INVALID');
 return{flowId:x.flowId,authorizationUrl:url.href,expiresAt:x.expiresAt};
}
