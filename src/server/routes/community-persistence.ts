import { Router, raw, type Request, type Response } from 'express';
import { resolve,isAbsolute,relative,join,sep } from 'node:path';
import { lstatSync,existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { activateCommunityRestore, stageCommunityRestore, type SafeActivate } from '../../community/persistence/restore.js';
import { createCommunityBackup, listCommunityBackups, readCommunityBackup, verifyRuntimePath, type Exclusive } from '../../community/persistence/backup.js';
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
  observe?(entry:{id:string;operation:'backup'|'restore-stage'|'restore-activate'|'legacy-inspect'|'legacy-stage';phase:'started'|'succeeded'|'failed';subject:string}):void;
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
  const observed=async<T>(response:Response,operation:'backup'|'restore-stage'|'restore-activate'|'legacy-inspect'|'legacy-stage',run:()=>Promise<T>):Promise<T>=>{
    const id=randomUUID(),subject=principal(response)!.subject;deps.observe?.({id,operation,phase:'started',subject});
    let value:T;try{value=await run();}catch(error){deps.observe?.({id,operation,phase:'failed',subject});throw error;}
    deps.observe?.({id,operation,phase:'succeeded',subject});return value;
  };
  const selections=new Map<string,{id:string;label:string;root:string}>();
  const selectionKey=(p:CommunityPrincipal)=>JSON.stringify([p.workspace_id??'',p.subject]);
  const choices=(p:CommunityPrincipal)=>[...(deps.legacySources?.()??[]),...(selections.has(selectionKey(p))?[selections.get(selectionKey(p))!]:[])];
  const contains=(parent:string,child:string)=>{const path=relative(parent,child);return !path||path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);};
  const selectedRoot=(raw:string)=>{
    if(!isAbsolute(raw)||raw.length>1024||/[\x00-\x1f]/.test(raw)||raw.startsWith('\\\\'))throw new Error('Invalid local legacy source');
    const root=resolve(raw),active=resolve(deps.activeRuntimeRoot());if(contains(active,root)||contains(root,active))throw new Error('Invalid legacy source overlap with active runtime');
    try{
      verifyRuntimePath(root,root);if(!lstatSync(root).isDirectory())throw new Error();
      const layouts=[['database/matching.db','state/state.json'],['data/matching.db','data/state.json'],['matching.db','state.json']].filter(layout=>layout.every(name=>existsSync(join(root,...name.split('/')))));
      if(layouts.length!==1)throw new Error();
      for(const name of layouts[0]){const path=join(root,...name.split('/'));verifyRuntimePath(root,path);const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error();}
    }catch{throw new Error('Invalid legacy source layout or linked directory');}
    return root;
  };
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
      const result = await observed(response,'backup',()=>createCommunityBackup(resolve(deps.activeRuntimeRoot()), deps.withExclusiveAccess));
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
      const stage = await observed(response,'restore-stage',()=>stageCommunityRestore(resolve(deps.activeRuntimeRoot()), request.body, deps.withExclusiveAccess));
      response.status(201).json(stage);
    } catch (error) { sendError(response, error); }
  });
  router.post('/restore/:id/activate', gate('data:restore'), async (request, response) => {
    try {
      const confirmation = request.body?.fingerprint;
      if (typeof confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation)) throw new Error('Invalid restore confirmation');
      const manifest = await observed(response,'restore-activate',()=>activateCommunityRestore(resolve(deps.activeRuntimeRoot()), String(request.params.id), confirmation, deps.withExclusiveAccess, deps.safeActivate));
      deps.invalidateCheckpoint();
      response.json({ activated: true, manifest });
    } catch (error) { sendError(response, error); }
  });
  const source = (id: string,p:CommunityPrincipal) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid legacy source identifier');
    const item = choices(p).find(candidate => candidate.id === id);
    if (!item) throw new Error('Invalid legacy source selection');
    return selectedRoot(item.root);
  };
  router.post('/legacy/sources',gate('data:migrate'),(request,response)=>{
    try{
      const body=request.body;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['root','label'].includes(key))||typeof body.root!=='string'||typeof body.label!=='string'||!body.label.trim()||body.label.length>120||/[\x00-\x1f]/.test(body.label))throw new Error('Invalid legacy source selection');
      const root=selectedRoot(body.root),item={id:randomUUID(),label:body.label.trim(),root};selections.set(selectionKey(principal(response)!),item);response.status(201).json({id:item.id,label:item.label});
    }catch(error){sendError(response,error);}
  });
  router.get('/legacy/sources', gate('data:migrate'), (_request, response) => {
    response.json({ sources: choices(principal(response)!).map(({ id, label }) => ({ id, label })) });
  });
  router.post('/legacy/:id/inspect', gate('data:migrate'), async (request, response) => {
    try { response.json(await observed(response,'legacy-inspect',()=>inspectLegacy(source(String(request.params.id),principal(response)!)))); }
    catch (error) { sendError(response, error); }
  });
  router.post('/legacy/:id/stage', gate('data:migrate'), async (request, response) => {
    try {
      const fingerprint = request.body?.fingerprint;
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid legacy dry run confirmation');
      const legacy = source(String(request.params.id),principal(response)!);
      const { before, result } = await observed(response,'legacy-stage',()=>deps.withExclusiveAccess(async () => {
        const held: Exclusive = run => run();
        const before = await createCommunityBackup(resolve(deps.activeRuntimeRoot()), held);
        const result = await stageLegacyConversion(resolve(deps.activeRuntimeRoot()), legacy, fingerprint, held);
        return { before, result };
      }));
      response.status(201).json({ ...result, previous_backup_id: before.id });
    } catch (error) { sendError(response, error); }
  });
  return router;
}
