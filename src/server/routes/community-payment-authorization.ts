import {Router,type RequestHandler} from 'express';
import type {SandboxPaymentCoordinator} from '../../community/payments/pis-coordinator.js';
import type {Principal} from '../../community/payments/types.js';

export function sandboxPaymentCallback(get:()=>SandboxPaymentCoordinator):RequestHandler{return(req,res)=>{get().receive(req.query);res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.redirect(303,'/payments');};}
export function createCommunityPaymentAuthorizationRouter(coordinator:SandboxPaymentCoordinator):Router{
 const router=Router(),principal=(res:any)=>res.locals.communityPrincipal as Principal;
 router.use((_req,res,next)=>{if(!principal(res))return res.status(401).json({code:'UNAUTHENTICATED'});next();});
 router.use((req,res,next)=>{if(req.method==='POST'&&!coordinator.payments.d.csrf(principal(res),req.get('x-csrf-token')))return res.status(403).json({code:'CSRF_INVALID'});next();});
 const run=(operation:(req:any,p:Principal)=>Promise<unknown>):RequestHandler=>async(req,res)=>{try{res.json(await operation(req,principal(res)));}catch(error){const code=error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'PIS_OPERATION_FAILED';res.status(code==='FORBIDDEN'?403:code==='UNAUTHENTICATED'?401:code==='BATCH_NOT_FOUND'?404:/CONFLICT|STALE|BUSY/.test(code)?409:400).json({code});}};
 router.get('/sandbox/status',run((_req,p)=>coordinator.status(p)));
 router.get('/sandbox/banks',run((req,p)=>coordinator.banks(p,typeof req.query.country==='string'?req.query.country:'')));
 router.post('/batches/:id/sandbox-confirmation',run((req,p)=>coordinator.confirm(p,String(req.params.id),req.body)));
 router.post('/batches/:id/sandbox-authorization',run((req,p)=>coordinator.authorize(p,String(req.params.id),req.body)));
 router.post('/batches/:id/sandbox-complete',run((req,p)=>{if(!req.body||Object.keys(req.body).sort().join(',')!=='flowId,revision'||!Number.isSafeInteger(req.body.revision))throw new Error('PIS_CONFIRMATION_INVALID');return coordinator.complete(p,String(req.params.id),req.body.revision,req.body.flowId);}));
 return router;
}
