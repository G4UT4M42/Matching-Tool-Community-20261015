import {Router,type Response,type RequestHandler} from 'express';
import {randomUUID} from 'node:crypto';
import type {CommunityBankingService} from '../../community/banking/service.js';
import type {BankConsentCoordinator} from '../../community/banking/consent.js';
import type {Principal} from '../../community/payments/types.js';

const p=(res:Response)=>res.locals.communityPrincipal as Principal|undefined;
const codes=new Set(['UNAUTHENTICATED','FORBIDDEN','BANK_OPERATION_FAILED','INVALID_BANK_CONFIGURATION','INVALID_DATE_RANGE','BANK_CONNECTION_REQUIRED','BANK_CONNECTION_CHANGED','BANK_READ_UNAVAILABLE','BANK_DATA_INVALID','BANK_APPLICATION_INVALID','BANK_APPLICATION_UNAVAILABLE','BANK_APPLICATION_REQUIRED','BANK_APPLICATION_NOT_AUTHORIZED','BANK_ENVIRONMENT_MISMATCH','BANK_RESPONSE_INVALID','BANK_COUNTRY_INVALID','BANK_PROVIDER_UNAVAILABLE','BANK_PROVIDER_PERMISSION_DENIED','BANK_AUTHORIZATION_URL_INVALID','BANK_CONSENT_INVALID','BANK_CONSENT_REQUIRED','BANK_CONSENT_EXPIRED','BANK_CONSENT_REVOKED','BANK_CONSENT_REPLACED','BANK_CONSENT_NOT_FOUND','BANK_CONSENT_BUSY','BANK_CONSENT_NOT_READY','BANK_CONSENT_DENIED','BANK_CONSENT_VALIDITY_INVALID','BANK_CONSENT_CAPACITY','BANK_SELECTION_INVALID','BANK_CURRENCY_UNSUPPORTED','BANK_ACCOUNT_IDENTITY_REQUIRED','BANK_HISTORY_UNAVAILABLE']);
const code=(error:unknown)=>error instanceof Error&&codes.has(error.message)?error.message:'BANK_OPERATION_FAILED';
function respondError(res:Response,error:unknown){const value=code(error);res.status(value==='UNAUTHENTICATED'?401:value==='FORBIDDEN'?403:value==='BANK_CONSENT_BUSY'?409:value==='BANK_HISTORY_UNAVAILABLE'?503:400).json({code:value});}
export interface BankOperationEvent {id:string;operationId:string;operation:string;phase:'started'|'completed';outcome:'started'|'succeeded'|'failed';code?:string}
export interface BankingRouterOptions {consent?:BankConsentCoordinator;selectService?:(p:Principal)=>Promise<CommunityBankingService>;disconnectAll?:(p:Principal)=>Promise<void>;observe?:(p:Principal,event:BankOperationEvent)=>void}
/** Public receipt only: no provider exchange, reflection, cookie reliance or query logging. */
export function bankConsentCallback(consent:BankConsentCoordinator):RequestHandler{return(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method==='GET'&&req.path==='/api/community-banking/callback'&&req.originalUrl.length<=8192&&/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?$/i.test(req.get('host')??''))consent.receive(req.query);
 res.status(303).setHeader('Location','/banking');res.end();
};}
export function createCommunityBankingRouter(service:CommunityBankingService,csrf:(principal:Principal,token:string|undefined)=>boolean,options:BankingRouterOptions={}):Router{
 const r=Router();r.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');if(!p(res))return res.status(401).json({code:'UNAUTHENTICATED'});next();});
 const mutation:RequestHandler=(req,res,next)=>{if(!csrf(p(res)!,req.get('x-csrf-token')))return void res.status(403).json({code:'CSRF_INVALID'});next();};
 const choose=(principal:Principal)=>options.selectService?.(principal)??Promise.resolve(service);
 const run=(operation:string,action:(req:any,principal:Principal)=>Promise<unknown>):RequestHandler=>async(req,res)=>{
  const principal=p(res)!,operationId=randomUUID();const observe=(phase:BankOperationEvent['phase'],outcome:BankOperationEvent['outcome'],failure?:string)=>{try{options.observe?.(principal,{id:randomUUID(),operationId,operation,phase,outcome,...(failure?{code:failure}:{})});}catch{throw new Error('BANK_HISTORY_UNAVAILABLE');}};
  try{observe('started','started');let result;try{result=await action(req,principal);}catch(error){observe('completed','failed',code(error));throw error;}observe('completed','succeeded');if(result===undefined)res.status(204).end();else res.json(result);}catch(error){respondError(res,error);}
 };
 r.get('/status',async(_req,res)=>{try{const principal=p(res)!,selected=await choose(principal);res.json({...selected.status(principal),...(options.consent?await options.consent.status(principal):{})});}catch(error){respondError(res,error);}});
 r.get('/capabilities',async(_req,res)=>{try{const selected=await choose(p(res)!);selected.status(p(res)!);res.json(selected.capabilities());}catch(error){respondError(res,error);}});
 r.get('/accounts',async(_req,res)=>{try{res.json(await(await choose(p(res)!)).accounts(p(res)!));}catch(error){respondError(res,error);}});
 r.post('/configure',mutation,run('configure',async(req,principal)=>{if(options.consent){if(!['sandbox','live'].includes(req.body?.environment))throw new Error('BANK_ENVIRONMENT_MISMATCH');return options.consent.advanced(principal,req.body.environment,req.body.accountRef,req.body.credential);}await service.configure(principal,req.body?.accountRef,req.body?.credential);}));
 r.post('/disconnect',mutation,run('disconnect',async(_req,principal)=>{const disconnect=async()=>{if(options.disconnectAll)await options.disconnectAll(principal);else await(await choose(principal)).disconnect(principal);};if(options.consent)await options.consent.disconnect(principal,disconnect);else await disconnect();}));
 r.post('/sync',mutation,run('sync',async(req,principal)=>(await choose(principal)).sync(principal,req.body?.from,req.body?.to)));
 if(options.consent){const consent=options.consent;
  r.post('/application',mutation,run('application',async(req,principal)=>consent.configureApplication(principal,req.body)));
  r.get('/banks',async(req,res)=>{try{if(typeof req.query.country!=='string')throw new Error('BANK_COUNTRY_INVALID');res.json(await consent.banks(p(res)!,req.query.country));}catch(error){respondError(res,error);}});
  r.post('/consents',mutation,run('consent-start',async(req,principal)=>consent.start(principal,req.body)));
  r.post('/consents/:id/complete',mutation,run('consent-complete',async(req,principal)=>{if(Object.keys(req.body??{}).length)throw new Error('BANK_CONSENT_INVALID');return consent.complete(principal,req.params.id);}));
  r.post('/consents/:id/select',mutation,run('consent-select',async(req,principal)=>{if(!req.body||Object.keys(req.body).join(',')!=='accountRef'||typeof req.body.accountRef!=='string')throw new Error('BANK_SELECTION_INVALID');return consent.select(principal,req.params.id,req.body.accountRef);}));
  r.post('/consents/:id/cancel',mutation,run('consent-cancel',async(req,principal)=>{if(Object.keys(req.body??{}).length)throw new Error('BANK_CONSENT_INVALID');return consent.cancel(principal,req.params.id);}));
 }
 return r;
}
