import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { IntegrationService } from '../../community/integrations/service.js';
import { hasCommunityPermission, type CommunityPrincipal } from '../community-permissions.js';
import { assertEnvironment, assertPrincipal, assertProvider, publicErrorCode, type Environment, type Permission, type Principal, type Provider } from '../../community/integrations/types.js';

export type PermissionPredicate = (principal: CommunityPrincipal, permission: Permission) => boolean | Promise<boolean>;
export type IntegrationOperation = 'configure' | 'test' | 'sync' | 'disconnect';
export interface IntegrationHistoryScope { subject:string; workspace_id:string; provider:Provider; environment:Environment }
export interface IntegrationOperationEntry extends IntegrationHistoryScope {
  id:string; operation_id:string; occurred_at:string; operation:IntegrationOperation;
  phase:'started'|'completed'; outcome:'started'|'succeeded'|'failed'; code?:string; imported?:number;
}
export interface IntegrationRouterCallbacks {
  /** Append-only, secret-free events. A failed start prevents the operation. */
  observe?:(entry:Readonly<IntegrationOperationEntry>)=>void|Promise<void>;
  history?:(scope:Readonly<IntegrationHistoryScope>)=>readonly IntegrationOperationEntry[]|Promise<readonly IntegrationOperationEntry[]>;
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
/** Project an explicit allowlist even when the persistence callback returns extra fields. */
function historyEntry(raw:IntegrationOperationEntry,scope:IntegrationHistoryScope):IntegrationOperationEntry|null {
  if(!raw||raw.subject!==scope.subject||raw.workspace_id!==scope.workspace_id||raw.provider!==scope.provider||raw.environment!==scope.environment||
    typeof raw.id!=='string'||!uuid.test(raw.id)||typeof raw.operation_id!=='string'||!uuid.test(raw.operation_id)||typeof raw.occurred_at!=='string'||raw.occurred_at.length>64||!Number.isFinite(Date.parse(raw.occurred_at))||
    !['configure','test','sync','disconnect'].includes(raw.operation)||
    !(raw.phase==='started'&&raw.outcome==='started'||raw.phase==='completed'&&['succeeded','failed'].includes(raw.outcome)))return null;
  return {...scope,id:raw.id,operation_id:raw.operation_id,occurred_at:raw.occurred_at,operation:raw.operation,phase:raw.phase,outcome:raw.outcome,
    ...(raw.phase==='completed'&&raw.outcome==='failed'?{code:publicErrorCode(new Error(typeof raw.code==='string'?raw.code:''))}:{}),
    ...(raw.operation==='sync'&&raw.outcome==='succeeded'&&Number.isSafeInteger(raw.imported)&&raw.imported!>=0?{imported:raw.imported}:{})};
}
/** Mount only after the reviewed community guard and JSON parser. Default permission is deny. */
export function createCommunityIntegrationsRouter(service: IntegrationService, permit: PermissionPredicate = () => false, callbacks:IntegrationRouterCallbacks={}): Router {
  const router = Router();
  const observe=async(entry:IntegrationOperationEntry)=>{
    try{await callbacks.observe?.(Object.freeze(entry));}catch{throw new Error('INTEGRATION_HISTORY_UNAVAILABLE');}
  };
  const route = (permission: Permission, action: (req: Request, principal: Principal, scope:IntegrationHistoryScope) => Promise<unknown>, operation?:IntegrationOperation) =>
    async (req: Request, res: Response, _next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      let principal: Principal;
      try { principal = assertPrincipal(res.locals.communityPrincipal); }
      catch { res.status(401).json({ code: 'UNAUTHENTICATED' }); return; }
      const session = res.locals.communityPrincipal as CommunityPrincipal;
      if (!session || typeof session.workspace_id !== 'string' || typeof session.session_id !== 'string') {
        res.status(401).json({ code: 'UNAUTHENTICATED' }); return;
      }
      // The caller's predicate is additional authorization, not a replacement
      // for authenticated role, capability and workspace membership checks.
      if (!hasCommunityPermission(session, session.workspace_id, permission)) {
        res.status(403).json({ code: 'FORBIDDEN' }); return;
      }
      try { if (!(await permit(session, permission))) { res.status(403).json({ code: 'FORBIDDEN' }); return; } }
      catch { res.status(403).json({ code: 'FORBIDDEN' }); return; }
      try {
        const provider = assertProvider(req.params.provider), environment = assertEnvironment(provider, req.params.environment);
        req.params.provider = provider; req.params.environment = environment;
        const scope=Object.freeze({subject:principal.subject,workspace_id:session.workspace_id,provider,environment});
        const operationId=randomUUID();
        const entry=(phase:'started'|'completed',outcome:IntegrationOperationEntry['outcome'],details:Pick<IntegrationOperationEntry,'code'|'imported'>={}):IntegrationOperationEntry=>({...scope,id:randomUUID(),operation_id:operationId,occurred_at:new Date().toISOString(),operation:operation!,phase,outcome,...details});
        if(operation)await observe(entry('started','started'));
        let result:unknown;
        try{result=await action(req,principal,scope);}
        catch(error){if(operation)await observe(entry('completed','failed',{code:publicErrorCode(error)}));throw error;}
        if(operation){
          const imported=operation==='sync'&&result&&typeof result==='object'?(result as {imported?:unknown}).imported:undefined;
          await observe(entry('completed','succeeded',Number.isSafeInteger(imported)&&Number(imported)>=0?{imported:Number(imported)}:{}));
        }
        res.json(result);
      } catch (error) {
        const code = error instanceof Error&&error.message==='INTEGRATION_HISTORY_UNAVAILABLE'?'INTEGRATION_HISTORY_UNAVAILABLE':publicErrorCode(error);
        const status = code==='INTEGRATION_HISTORY_UNAVAILABLE'?503:code.startsWith('INVALID_') ? 400 : code === 'NOT_CONFIGURED' ? 404 : code === 'INTEGRATION_BUSY' ? 409 : 502;
        res.status(status).json({ code });
      }
    };
  router.get('/:provider/:environment/history', route('integrations:read',async (_req,_principal,scope)=>{
    try{
      const found=await callbacks.history?.(scope)??[];
      if(!Array.isArray(found))throw new Error();
      return{items:found.map(raw=>historyEntry(raw,scope)).filter((item):item is IntegrationOperationEntry=>item!==null).sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)).slice(0,100)};
    }catch{throw new Error('INTEGRATION_HISTORY_UNAVAILABLE');}
  }));
  router.get('/:provider/:environment', route('integrations:read', async (req, principal) => {
    return service.status(principal, assertProvider(req.params.provider), assertEnvironment(assertProvider(req.params.provider), req.params.environment));
  }));
  router.put('/:provider/:environment', route('integrations:configure', async (req, principal) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).sort().join(',') !== 'credentials' || !req.body.credentials || typeof req.body.credentials !== 'object' || Array.isArray(req.body.credentials)) throw new Error('INVALID_CREDENTIALS');
    await service.configure(principal, assertProvider(req.params.provider), assertEnvironment(assertProvider(req.params.provider), req.params.environment), req.body.credentials);
    return { configured: true };
  },'configure'));
  router.post('/:provider/:environment/test', route('integrations:configure', async (req, principal) => {
    await service.testConnection(principal, assertProvider(req.params.provider), assertEnvironment(assertProvider(req.params.provider), req.params.environment));
    return { connected: true };
  },'test'));
  router.post('/:provider/:environment/sync', route('integrations:sync', async (req, principal) => {
    return service.synchronize(principal, assertProvider(req.params.provider), assertEnvironment(assertProvider(req.params.provider), req.params.environment));
  },'sync'));
  router.delete('/:provider/:environment', route('integrations:configure', async (req, principal) => {
    await service.disconnect(principal, assertProvider(req.params.provider), assertEnvironment(assertProvider(req.params.provider), req.params.environment));
    return { configured: false };
  },'disconnect'));
  return router;
}
