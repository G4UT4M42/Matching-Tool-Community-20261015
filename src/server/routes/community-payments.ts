import { Router, type Request, type Response } from 'express';
import type { CommunityPaymentService } from '../../community/payments/service.js';
import type { Principal } from '../../community/payments/types.js';

const principal=(res:Response)=>res.locals.communityPrincipal as Principal|undefined;
const id=(req:Request)=>String(req.params.id);
const status=(code:string)=>code==='UNAUTHENTICATED'?401:code==='FORBIDDEN'?403:code==='BATCH_NOT_FOUND'?404:code.includes('CONFLICT')||code.includes('STALE')?409:400;
function error(res:Response,e:unknown):void {const code=e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)?e.message:'PAYMENT_OPERATION_FAILED';res.status(status(code)).json({code});}
export function createCommunityPaymentsRouter(service:CommunityPaymentService<unknown>):Router {
  const router=Router();
  router.use((req,res,next)=>{if(!principal(res))return res.status(401).json({code:'UNAUTHENTICATED'});next()});
  const csrf=(req:Request,res:Response,next:()=>void)=>{if(!service.d.csrf(principal(res)!,req.get('x-csrf-token')))return res.status(403).json({code:'CSRF_INVALID'});next()};
  router.get('/candidates',(_req,res)=>{try{res.json(service.candidates(principal(res)!))}catch(e){error(res,e)}});
  router.get('/batches',(_req,res)=>{try{service.require(principal(res),'finance:read');res.json(service.repo.list(principal(res)!.workspace_id))}catch(e){error(res,e)}});
  router.get('/batches/:id',(req,res)=>{try{service.require(principal(res),'finance:read');const b=service.repo.get(id(req),principal(res)!.workspace_id);if(!b)throw new Error('BATCH_NOT_FOUND');res.json({batch:b,audit:service.repo.audit(b.id,b.workspaceId)})}catch(e){error(res,e)}});
  router.post('/batches',csrf,(req,res)=>{try{const {documentIds,debtorIban,debtorName}=req.body??{};res.status(201).json(service.createDraft(principal(res)!,documentIds,debtorIban,debtorName))}catch(e){error(res,e)}});
  router.patch('/batches/:id/debtor',csrf,(req,res)=>{try{const {revision,debtorIban,debtorName}=req.body??{};res.json(service.editDebtor(principal(res)!,id(req),revision,debtorIban,debtorName))}catch(e){error(res,e)}});
  const actions={validate:(p:Principal,id:string,revision:number)=>service.validate(p,id,revision),review:(p:Principal,id:string,revision:number)=>service.review(p,id,revision),approve:(p:Principal,id:string,revision:number)=>service.approve(p,id,revision),cancel:(p:Principal,id:string,revision:number)=>service.cancel(p,id,revision),reconciled:(p:Principal,id:string,revision:number,body:Record<string,unknown>)=>service.markReconciled(p,id,revision,String(body.matchId??''))};
  for(const [action,run] of Object.entries(actions))router.post(`/batches/:id/${action}`,csrf,(req,res)=>{try{res.json(run(principal(res)!,id(req),req.body?.revision,req.body??{}))}catch(e){error(res,e)}});
  router.get('/batches/:id/sepa',(req,res)=>{try{const result=service.export(principal(res)!,id(req));res.setHeader('Content-Type','application/xml; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="payment-${encodeURIComponent(id(req))}.xml"`);res.setHeader('X-Content-SHA256',result.sha256);res.send(result.xml)}catch(e){error(res,e)}});
  router.post('/batches/:id/confirmation',csrf,(req,res)=>{try{res.json(service.issueConfirmation(principal(res)!,id(req),req.body?.revision))}catch(e){error(res,e)}});
  router.post('/batches/:id/submit',csrf,async(req,res)=>{try{res.json(await service.submit(principal(res)!,id(req),req.body?.revision,req.body?.token))}catch(e){error(res,e)}});
  router.post('/batches/:id/provider-status',csrf,async(req,res)=>{try{res.json(await service.reconcileProvider(principal(res)!,id(req),req.body?.revision))}catch(e){error(res,e)}});
  return router;
}
