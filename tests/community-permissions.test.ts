import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  COMMUNITY_PERMISSIONS, permissionsForRole, hasCommunityPermission, requireCommunityPermission,
  type CommunityPrincipal, type CommunityRole,
} from '../src/server/community-permissions.js';

const workspace = 'WS-'+randomUUID();
const anotherWorkspace = 'WS-'+randomUUID();
function principal(role: CommunityRole = 'owner'): CommunityPrincipal {
  const current=Date.now();
  return {
    subject:'USR-'+randomUUID(), workspace_id:workspace, session_id:'SES-'+randomUUID(),
    username:'synthetic-'+role, role, authenticated_at:current, reauthenticated_at:current,
    permissions:[...permissionsForRole(role)],
  };
}
describe('Community capability and workspace authorization boundary',()=>{
  it('publishes unique stable capability names aligned with integration routes',()=>{
    expect(COMMUNITY_PERMISSIONS.length).toBe(new Set(COMMUNITY_PERMISSIONS).size);
    for (const permission of ['integrations:read','integrations:configure','integrations:sync']) {
      expect(COMMUNITY_PERMISSIONS).toContain(permission);
    }
    expect(permissionsForRole('__proto__')).toEqual([]);
    expect(permissionsForRole('constructor')).toEqual([]);
  });
  it('limits ordinary viewers even when the caller fabricates a full capability list',()=>{
    const viewer=principal('viewer');
    expect(hasCommunityPermission(viewer,workspace,'finance:read')).toBe(true);
    expect(hasCommunityPermission(viewer,workspace,'finance:match')).toBe(false);
    expect(hasCommunityPermission(viewer,workspace,'integrations:configure')).toBe(false);
    expect(hasCommunityPermission({...viewer,permissions:[...COMMUNITY_PERMISSIONS]},workspace,'payments:submit')).toBe(false);
  });
  it('separates bookkeeping preparation, provider synchronization and payment approval',()=>{
    const accountant=principal('bookkeeper');
    expect(hasCommunityPermission(accountant,workspace,'finance:import')).toBe(true);
    expect(hasCommunityPermission(accountant,workspace,'integrations:sync')).toBe(true);
    expect(hasCommunityPermission(accountant,workspace,'integrations:configure')).toBe(false);
    expect(hasCommunityPermission(accountant,workspace,'payments:prepare')).toBe(true);
    expect(hasCommunityPermission(accountant,workspace,'payments:approve')).toBe(false);
    expect(hasCommunityPermission(accountant,workspace,'payments:submit')).toBe(false);
  });
  it('allows an explicit payment-approver capability without owner or preparation rights',()=>{
    const approver=principal('payment_approver');
    expect(hasCommunityPermission(approver,workspace,'payments:approve')).toBe(true);
    expect(hasCommunityPermission(approver,workspace,'payments:submit')).toBe(true);
    expect(hasCommunityPermission(approver,workspace,'payments:prepare')).toBe(false);
    expect(hasCommunityPermission(approver,workspace,'accounts:manage')).toBe(false);
  });
  it('requires matching workspace and complete session identity',()=>{
    const owner=principal();
    expect(hasCommunityPermission(owner,workspace,'accounts:manage')).toBe(true);
    expect(hasCommunityPermission(owner,anotherWorkspace,'accounts:manage')).toBe(false);
    expect(hasCommunityPermission({...owner,workspace_id:anotherWorkspace},workspace,'accounts:manage')).toBe(false);
    expect(hasCommunityPermission({...owner,session_id:'SES-'+ '-'.repeat(36)},workspace,'finance:read')).toBe(false);
    expect(hasCommunityPermission({...owner,subject:'USR-'+'-'.repeat(36)},workspace,'finance:read')).toBe(false);
    expect(hasCommunityPermission({...owner,authenticated_at:'today'},workspace,'finance:read')).toBe(false);
    expect(hasCommunityPermission({...owner,permissions:[]},workspace,'finance:read')).toBe(false);
    expect(hasCommunityPermission(null,workspace,'finance:read')).toBe(false);
    expect(hasCommunityPermission(['array'],workspace,'finance:read')).toBe(false);
  });
  it('rejects unknown and prototype-derived roles independent of caller permission arrays',()=>{
    const owner=principal();
    expect(hasCommunityPermission({...owner,role:'administrator'},workspace,'accounts:manage')).toBe(false);
    expect(hasCommunityPermission({...owner,role:'constructor'},workspace,'finance:read')).toBe(false);
  });
});

let server:Server, origin='';
const identities: Record<string, CommunityPrincipal>={
  owner:principal('owner'), viewer:principal('viewer'), bookkeeper:principal('bookkeeper'),
  foreign:{...principal('owner'), workspace_id:anotherWorkspace},
};
beforeAll(async()=>{
  const app=express();app.use(express.json({limit:'1kb'}));
  app.use((req,res,next)=>{
    const key=req.get('X-Synthetic-Account');
    if (key && Object.hasOwn(identities,key)) res.locals.communityPrincipal=identities[key];
    next();
  });
  app.post('/api/financial-import',requireCommunityPermission(workspace,'finance:import'),
    (req,res)=>res.json({actor:res.locals.communityPrincipal.subject, accepted:true}));
  server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('Missing test listener');
  origin=`http://127.0.0.1:${address.port}`;
});
afterAll(async()=>{if(server) await new Promise<void>(resolve=>server.close(()=>resolve()));});
describe('Actual Express route permission middleware',()=>{
  it('rejects anonymous and forged request-body authorization',async()=>{
    const response=await fetch(origin+'/api/financial-import',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({actor:identities.owner.subject,role:'owner',permissions:[...COMMUNITY_PERMISSIONS]})});
    expect(response.status).toBe(401);
  });
  it('refuses viewer and mismatched workspace despite valid local identities',async()=>{
    for(const account of ['viewer','foreign']){
      const response=await fetch(origin+'/api/financial-import',{method:'POST',headers:{'X-Synthetic-Account':account}});
      expect(response.status).toBe(403);
    }
  });
  it('accepts bookkeeper import and uses the authenticated actor rather than body user data',async()=>{
    const response=await fetch(origin+'/api/financial-import',{method:'POST',headers:{'X-Synthetic-Account':'bookkeeper','Content-Type':'application/json'},
      body:JSON.stringify({actor:identities.owner.subject,role:'owner'})});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({accepted:true,actor:identities.bookkeeper.subject});
  });
});
