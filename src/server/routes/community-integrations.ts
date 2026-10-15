import { Router, type Request, type Response, type NextFunction } from 'express';
import { IntegrationService } from '../../community/integrations/service.js';
import { hasCommunityPermission, type CommunityPrincipal } from '../community-permissions.js';
import { assertEnvironment, assertPrincipal, assertProvider, publicErrorCode, type Permission, type Principal } from '../../community/integrations/types.js';

export type PermissionPredicate = (principal: CommunityPrincipal, permission: Permission) => boolean | Promise<boolean>;
/** Mount only after the reviewed community guard and JSON parser. Default permission is deny. */
export function createCommunityIntegrationsRouter(service: IntegrationService, permit: PermissionPredicate = () => false): Router {
  const router = Router();
  const route = (permission: Permission, action: (req: Request, res: Response, principal: Principal) => Promise<void>) =>
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
        await action(req, res, principal);
      } catch (error) {
        const code = publicErrorCode(error);
        const status = code.startsWith('INVALID_') ? 400 : code === 'NOT_CONFIGURED' ? 404 : code === 'INTEGRATION_BUSY' ? 409 : 502;
        res.status(status).json({ code });
      }
    };
  router.get('/:provider/:environment', route('integrations:read', async (req, res, principal) => {
    res.json(await service.status(principal, assertProvider(req.params.provider), assertEnvironment(assertProvider(req.params.provider), req.params.environment)));
  }));
  router.put('/:provider/:environment', route('integrations:configure', async (req, res, principal) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).sort().join(',') !== 'credentials' || !req.body.credentials || typeof req.body.credentials !== 'object' || Array.isArray(req.body.credentials)) throw new Error('INVALID_CREDENTIALS');
    await service.configure(principal, assertProvider(req.params.provider), assertEnvironment(assertProvider(req.params.provider), req.params.environment), req.body.credentials);
    res.json({ configured: true });
  }));
  router.post('/:provider/:environment/test', route('integrations:configure', async (req, res, principal) => {
    await service.testConnection(principal, assertProvider(req.params.provider), assertEnvironment(assertProvider(req.params.provider), req.params.environment));
    res.json({ connected: true });
  }));
  router.post('/:provider/:environment/sync', route('integrations:sync', async (req, res, principal) => {
    res.json(await service.synchronize(principal, assertProvider(req.params.provider), assertEnvironment(assertProvider(req.params.provider), req.params.environment)));
  }));
  router.delete('/:provider/:environment', route('integrations:configure', async (req, res, principal) => {
    await service.disconnect(principal, assertProvider(req.params.provider), assertEnvironment(assertProvider(req.params.provider), req.params.environment));
    res.json({ configured: false });
  }));
  return router;
}
