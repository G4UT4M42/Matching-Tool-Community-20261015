import { Router, raw, type Request, type Response } from 'express';
import { resolve } from 'node:path';
import { activateCommunityRestore, stageCommunityRestore, type SafeActivate } from '../../community/persistence/restore.js';
import { createCommunityBackup, listCommunityBackups, readCommunityBackup, type Exclusive } from '../../community/persistence/backup.js';
import { inspectLegacy, stageLegacyConversion } from '../../community/persistence/legacy.js';

export interface CommunityPrincipal { subject: string; workspace_id?: string }
export type PersistencePermission = 'data:backup' | 'data:restore' | 'data:migrate';
export interface CommunityPersistenceDependencies {
  activeRuntimeRoot(): string;
  withExclusiveAccess: Exclusive;
  safeActivate: SafeActivate;
  may(principal: CommunityPrincipal, permission: PersistencePermission): boolean;
  invalidateCheckpoint(): void;
  inspectCurrent(): unknown;
  legacySources?(): Array<{ id: string; label: string; root: string }>;
}
function principal(response: Response): CommunityPrincipal | null {
  const value = response.locals.communityPrincipal as CommunityPrincipal | undefined;
  return value && typeof value.subject === 'string' && value.subject.length > 0 ? value : null;
}
function sendError(response: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Persistence operation failed';
  const denied = /Invalid|Unsafe|Unsupported|missing|mismatch|stale|checksum|Pending|changed|relationship|version|exceed|credential|approval|ZIP|archive|journal|recovery|stage|integrity/i.test(message);
  response.status(denied ? 422 : 500).json({ code: denied ? 'PERSISTENCE_REJECTED' : 'PERSISTENCE_FAILED', error: denied ? message : 'Persistence operation failed safely' });
}
export function createCommunityPersistenceRouter(deps: CommunityPersistenceDependencies): Router {
  const router = Router();
  const gate = (permission: PersistencePermission) => (_request: Request, response: Response, next: () => void) => {
    const identity = principal(response);
    if (!identity) { response.status(401).json({ code: 'AUTH_REQUIRED' }); return; }
    if (!deps.may(identity, permission)) { response.status(403).json({ code: 'PERMISSION_DENIED' }); return; }
    next();
  };
  router.get('/current', gate('data:backup'), (_request, response) => {
    try { response.json({ current: deps.inspectCurrent() }); } catch (error) { sendError(response, error); }
  });
  router.get('/backups', gate('data:backup'), (_request, response) => {
    try { response.json({ backups: listCommunityBackups(resolve(deps.activeRuntimeRoot())) }); } catch (error) { sendError(response, error); }
  });
  router.post('/backups', gate('data:backup'), async (_request, response) => {
    try {
      const result = await createCommunityBackup(resolve(deps.activeRuntimeRoot()), deps.withExclusiveAccess);
      response.status(201).json({ id: result.id, manifest: result.manifest });
    } catch (error) { sendError(response, error); }
  });
  router.get('/backups/:id/download', gate('data:backup'), (request, response) => {
    try {
      const id = String(request.params.id);
      const bytes = readCommunityBackup(resolve(deps.activeRuntimeRoot()), id);
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Disposition', `attachment; filename="community-backup-${id}.zip"`);
      response.send(bytes);
    } catch (error) { sendError(response, error); }
  });
  router.post('/restore/stage', gate('data:restore'), raw({ type: 'application/zip', limit: '512mb' }), async (request, response) => {
    try {
      if (!Buffer.isBuffer(request.body)) throw new Error('Invalid backup upload body');
      const stage = await stageCommunityRestore(resolve(deps.activeRuntimeRoot()), request.body, deps.withExclusiveAccess);
      response.status(201).json(stage);
    } catch (error) { sendError(response, error); }
  });
  router.post('/restore/:id/activate', gate('data:restore'), async (request, response) => {
    try {
      const confirmation = request.body?.fingerprint;
      if (typeof confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation)) throw new Error('Invalid restore confirmation');
      const manifest = await activateCommunityRestore(resolve(deps.activeRuntimeRoot()), String(request.params.id), confirmation, deps.withExclusiveAccess, deps.safeActivate);
      deps.invalidateCheckpoint();
      response.json({ activated: true, manifest });
    } catch (error) { sendError(response, error); }
  });
  const source = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid legacy source identifier');
    const item = deps.legacySources?.().find(candidate => candidate.id === id);
    if (!item) throw new Error('Legacy source is not selected by the local server');
    const root = resolve(item.root), active = resolve(deps.activeRuntimeRoot());
    if (root === active || root.startsWith(active + '\\') || active.startsWith(root + '\\')) throw new Error('Legacy source overlaps active runtime');
    return root;
  };
  router.get('/legacy/sources', gate('data:migrate'), (_request, response) => {
    response.json({ sources: (deps.legacySources?.() ?? []).map(({ id, label }) => ({ id, label })) });
  });
  router.post('/legacy/:id/inspect', gate('data:migrate'), async (request, response) => {
    try { response.json(await inspectLegacy(source(String(request.params.id)))); }
    catch (error) { sendError(response, error); }
  });
  router.post('/legacy/:id/stage', gate('data:migrate'), async (request, response) => {
    try {
      const fingerprint = request.body?.fingerprint;
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid legacy dry run confirmation');
      const legacy = source(String(request.params.id));
      const { before, result } = await deps.withExclusiveAccess(async () => {
        const held: Exclusive = run => run();
        const before = await createCommunityBackup(resolve(deps.activeRuntimeRoot()), held);
        const result = await stageLegacyConversion(resolve(deps.activeRuntimeRoot()), legacy, fingerprint, held);
        return { before, result };
      });
      response.status(201).json({ ...result, previous_backup_id: before.id });
    } catch (error) { sendError(response, error); }
  });
  return router;
}
