import { Router, type Request, type Response, type NextFunction } from 'express';
import { InvoiceBotCoordinator } from '../../community/invoice-bot/coordinator.js';
import type { Principal } from '../../community/documents/service.js';
import { DocumentInputError } from '../../community/documents/recognition.js';
import { CanonicalStateError } from '../../storage/canonical-transaction.js';

export type BotPermission = 'integrations:read' | 'integrations:configure' | 'integrations:sync';
export function createCommunityInvoiceBotRouter(bot: InvoiceBotCoordinator, authorize: (principal: Principal, permission: BotPermission) => boolean): Router {
  const router = Router();
  const principal = (res: Response) => res.locals.communityPrincipal as Principal | undefined;
  const gate = (permission: BotPermission) => (_request: Request, response: Response, next: NextFunction) => {
    const owner = principal(response);
    if (!owner?.subject || !owner.workspace_id) { response.status(401).json({ code: 'AUTHENTICATION_REQUIRED' }); return; }
    if (!authorize(owner, permission)) { response.status(403).json({ code: 'FORBIDDEN' }); return; }
    next();
  };
  const handle = (work: (req: Request, res: Response) => Promise<unknown> | unknown) => (request: Request, response: Response) => { void Promise.resolve().then(() => work(request, response)).then(result => { if (!response.headersSent) response.json(result ?? { ok: true }); }).catch(error => {
    const trusted=error instanceof DocumentInputError||error instanceof CanonicalStateError;
    const code = trusted ? error.code : 'BOT_OPERATION_FAILED';
    response.status(code==='AUTHENTICATION_REQUIRED'?401:code==='PERMISSION_REQUIRED'?403:code === 'NOT_FOUND' ? 404 : code === 'BOT_BUSY' || code === 'INVALID_STATUS' ? 409 : trusted ? 400 : 500).json({ code, error: trusted ? error.message : 'Invoice Bot operation failed' });
  }); };
  router.get('/portals', gate('integrations:read'), handle(() => ({ items: bot.catalog() })));
  router.get('/runs', gate('integrations:read'), handle((_request, response) => ({ items: bot.listRuns(principal(response)!) })));
  router.get('/runs/:id', gate('integrations:read'), handle((request, response) => bot.getRun(principal(response)!, String(request.params.id))));
  router.get('/portals/:id/status', gate('integrations:read'), handle((request, response) => bot.status(principal(response)!, String(request.params.id))));
  router.post('/portals/:id/connect', gate('integrations:configure'), handle(async (request, response) => { await bot.connect(principal(response)!, String(request.params.id)); return { connected: true }; }));
  router.post('/portals/:id/disconnect', gate('integrations:configure'), handle(async (request, response) => { await bot.disconnect(principal(response)!, String(request.params.id)); return { connected: false }; }));
  router.post('/portals/:id/discover', gate('integrations:sync'), handle((request, response) => bot.discover(principal(response)!, String(request.params.id))));
  router.get('/portals/:id/receipt-targets',gate('integrations:sync'),handle((request,response)=>bot.receiptTargets(principal(response)!,String(request.params.id))));
  router.post('/portals/:id/capture-receipt',gate('integrations:sync'),handle((request,response)=>bot.captureReceipt(principal(response)!,String(request.params.id),request.body)));
  router.post('/runs/:id/import', gate('integrations:sync'), handle((request, response) => bot.importSelected(principal(response)!, String(request.params.id), request.body?.source_ids)));
  router.post('/runs/:id/cancel', gate('integrations:sync'), handle((request, response) => bot.cancel(principal(response)!, String(request.params.id))));
  return router;
}
