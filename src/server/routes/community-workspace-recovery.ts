import { Router, type Response } from 'express';
import type { CommunityPrincipal } from '../community-permissions.js';

interface RecoveryDependencies {
  currentOwner(recent:boolean):CommunityPrincipal;
  inspect(principal:CommunityPrincipal):Promise<unknown>;
  confirm(principal:CommunityPrincipal,fingerprint:string):Promise<unknown>;
  paymentHistory(principal:CommunityPrincipal):unknown;
}
/** Explicit post-restore adoption preserves original financial ownership evidence. */
export function createCommunityWorkspaceRecoveryRouter(deps:RecoveryDependencies):Router {
  const router=Router();
  const failure=(response:Response,error:unknown)=>{
    const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:'WORKSPACE_RECOVERY_FAILED';
    const status=code==='AUTHENTICATION_REQUIRED'?401:['PERMISSION_REQUIRED','RECENT_AUTH_REQUIRED','REAUTHENTICATION_REQUIRED'].includes(code)?403:code==='WORKSPACE_BUSY'?503:code==='STALE_REVIEW'||code==='NOTHING_TO_RECOVER'?409:code==='WORKSPACE_RECOVERY_FAILED'?500:422;
    response.status(status).json({code,error:status===500?'Workspace recovery failed safely':'Workspace recovery requires a current owner confirmation of unchanged evidence'});
  };
  router.get('/',async(_request,response)=>{
    try{response.json(await deps.inspect(deps.currentOwner(false)));}catch(error){failure(response,error);}
  });
  router.get('/payment-history',(_request,response)=>{
    try{response.json(deps.paymentHistory(deps.currentOwner(false)));}catch(error){failure(response,error);}
  });
  router.post('/',async(request,response)=>{
    try{
      const principal=deps.currentOwner(true),body=request.body;
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==2||typeof body.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(body.fingerprint)||body.confirm_preserve_originals!==true){response.status(422).json({code:'WORKSPACE_RECOVERY_CONFIRMATION_REQUIRED',error:'Review unchanged recovered records and explicitly confirm preserved original ownership'});return;}
      response.json(await deps.confirm(principal,body.fingerprint));
    }catch(error){failure(response,error);}
  });
  return router;
}
