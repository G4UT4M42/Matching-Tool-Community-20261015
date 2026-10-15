import { Router, type Response } from 'express';
import type { CommunityBankingService } from '../../community/banking/service.js';
import type { Principal } from '../../community/payments/types.js';

const p=(res:Response)=>res.locals.communityPrincipal as Principal|undefined;
function respondError(res:Response,e:unknown):void{const code=e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'BANK_OPERATION_FAILED';res.status(code==='UNAUTHENTICATED'?401:code==='FORBIDDEN'?403:400).json({code})}
export function createCommunityBankingRouter(service:CommunityBankingService,csrf:(principal:Principal,token:string|undefined)=>boolean):Router {
  const r=Router();r.use((_req,res,next)=>{if(!p(res))return res.status(401).json({code:'UNAUTHENTICATED'});next()});
  const mutation=(req:any,res:Response,next:()=>void)=>{if(!csrf(p(res)!,req.get('x-csrf-token')))return res.status(403).json({code:'CSRF_INVALID'});next()};
  r.get('/status',(_req,res)=>{try{res.json(service.status(p(res)!))}catch(e){respondError(res,e)}});
  r.get('/capabilities',(_req,res)=>{try{service.status(p(res)!);res.json(service.capabilities())}catch(e){respondError(res,e)}});
  r.get('/accounts',async(_req,res)=>{try{res.json(await service.accounts(p(res)!))}catch(e){respondError(res,e)}});
  r.post('/configure',mutation,async(req,res)=>{try{await service.configure(p(res)!,req.body?.accountRef,req.body?.credential);res.status(204).end()}catch(e){respondError(res,e)}});
  r.post('/disconnect',mutation,async(_req,res)=>{try{await service.disconnect(p(res)!);res.status(204).end()}catch(e){respondError(res,e)}});
  r.post('/sync',mutation,async(req,res)=>{try{res.json(await service.sync(p(res)!,req.body?.from,req.body?.to))}catch(e){respondError(res,e)}});
  return r;
}
