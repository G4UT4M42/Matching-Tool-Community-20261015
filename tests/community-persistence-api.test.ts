import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {type CommunityPersistenceDependencies, createCommunityPersistenceRouter } from '../src/server/routes/community-persistence.js';
import type { Server } from 'node:http';

let server: Server | undefined, root: string, closeDb: (() => void) | undefined;
async function fixture(observe?:CommunityPersistenceDependencies['observe']) {
  root = mkdtempSync(join(tmpdir(), 'community-api-'));
  process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root'; process.env.MATCHING_RUNTIME_ROOT = root;
  vi.resetModules();
  const store = await import('../src/storage/db.js'); closeDb = store.closeDb; store.getDb();
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state', 'state.json'), JSON.stringify({
    schema_version: 1, format: 'matching-community-state-v1', run_id: 'SYNTHETIC',
    transactions: {}, documents: {}, match_groups: {}, exclusion_rules: [], audit_events: [],
    matched_transaction_ids: [], matched_document_ids: [], excluded_transaction_ids: [],
  }));
  const app = express(); app.use(express.json());
  app.use((request, response, next) => { const user=request.headers['x-test-subject'];if (user === 'owner'||user==='second-owner') response.locals.communityPrincipal = { subject: 'synthetic-'+user,workspace_id:'synthetic-workspace' }; next(); });
  app.use('/api/community/persistence', createCommunityPersistenceRouter({
    activeRuntimeRoot: () => root,observe,
    withExclusiveAccess: run => run(),
    safeActivate: async (change, rollback) => { closeDb?.(); try { change(); } catch (error) { rollback(); throw error; } },
    may: principal => ['synthetic-owner','synthetic-second-owner'].includes(principal.subject),
    invalidateCheckpoint: () => {}, inspectCurrent: () => ({ synthetic: true }),
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server unavailable');
  return `http://127.0.0.1:${address.port}/api/community/persistence`;
}
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
  closeDb?.(); closeDb = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  delete process.env.MATCHING_RUNTIME_MODE; delete process.env.MATCHING_RUNTIME_ROOT; vi.resetModules();
});
describe('authenticated persistence router', () => {
  it('audits data operations before mutation and before success, and refuses mutation when durable start fails',async()=>{
    const events:Array<{id:string;operation:string;phase:string;subject:string}>=[];let refuse=false;const base=await fixture(entry=>{if(refuse)throw new Error('SYNTHETIC_AUDIT_UNAVAILABLE');events.push(entry);}),headers={'x-test-subject':'owner'};
    expect((await fetch(base+'/backups',{method:'POST',headers})).status).toBe(201);expect(events.map(entry=>entry.phase)).toEqual(['started','succeeded']);expect(events[0].id).toBe(events[1].id);expect(events[0]).toMatchObject({operation:'backup',subject:'synthetic-owner'});
    refuse=true;expect((await fetch(base+'/backups',{method:'POST',headers})).status).toBe(500);expect((await(await fetch(base+'/backups',{headers})).json()).backups).toHaveLength(1);
    refuse=false;expect((await fetch(base+'/legacy/unknown/inspect',{method:'POST',headers})).status).toBe(422);expect(events.slice(-2).map(entry=>entry.phase)).toEqual(['started','failed']);
  });

  it('selects a bounded local source per account without exposing paths or reading source contents',async()=>{
    const base=await fixture(),legacy=mkdtempSync(join(tmpdir(),'community-legacy-selection-'));
    try{
      mkdirSync(join(legacy,'database'));mkdirSync(join(legacy,'state'));
      // Selection validates metadata only. Inspect is the explicit content-reading step.
      writeFileSync(join(legacy,'database','matching.db'),'NOT-A-DATABASE');writeFileSync(join(legacy,'state','state.json'),'NOT-JSON');
      const headers={'x-test-subject':'owner','content-type':'application/json'};
      const select=(body:unknown)=>fetch(base+'/legacy/sources',{method:'POST',headers,body:JSON.stringify(body)});
      expect((await fetch(base+'/legacy/sources',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({root:legacy,label:'Synthetic'})})).status).toBe(401);
      for(const path of [root,join(root,'state'),join(root,'..legacy'),join(root,'..'),'relative/path','\\\\remote\\share'])expect((await select({root:path,label:'Synthetic'})).status).toBe(422);
      expect((await select({root:legacy,label:'Synthetic',forged:true})).status).toBe(422);
      const response=await select({root:legacy,label:'Independent synthetic source'});expect(response.status).toBe(201);
      const selected=await response.json() as {id:string;label:string};expect(selected.id).toMatch(/^[a-f0-9-]{36}$/);expect(Object.keys(selected).sort()).toEqual(['id','label']);
      const list=await(await fetch(base+'/legacy/sources',{headers})).text();expect(list).not.toContain(legacy);expect(JSON.parse(list).sources).toEqual([selected]);
      const otherHeaders={...headers,'x-test-subject':'second-owner'};expect((await(await fetch(base+'/legacy/sources',{headers:otherHeaders})).json()).sources).toEqual([]);
      expect((await fetch(base+'/legacy/'+selected.id+'/inspect',{method:'POST',headers:otherHeaders})).status).toBe(422);
      const next=await(await select({root:legacy,label:'Replacement selection'})).json() as {id:string};expect(next.id).not.toBe(selected.id);
      expect((await fetch(base+'/legacy/'+selected.id+'/inspect',{method:'POST',headers})).status).toBe(422);
      rmSync(join(legacy,'state','state.json'));expect((await fetch(base+'/legacy/'+next.id+'/inspect',{method:'POST',headers})).status).toBe(422);
    }finally{rmSync(legacy,{recursive:true,force:true});}
  });
  it('selects each supported legacy layout through normal API metadata validation and rejects ambiguity',async()=>{
    const base=await fixture(),sources=mkdtempSync(join(tmpdir(),'community-legacy-layout-selection-'));try{
      const headers={'x-test-subject':'owner','content-type':'application/json'};
      for(const names of [['database/matching.db','state/state.json'],['data/matching.db','data/state.json'],['matching.db','state.json']]){
        const folder=join(sources,String(names[0].length));mkdirSync(folder);for(const name of names){const file=join(folder,...name.split('/'));mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,'SYNTHETIC-UNREAD-CONTENT');}
        const select=()=>fetch(base+'/legacy/sources',{method:'POST',headers,body:JSON.stringify({root:folder,label:'Synthetic legacy layout'})});expect((await select()).status).toBe(201);
        if(names[0]!=='matching.db'){writeFileSync(join(folder,'matching.db'),'SYNTHETIC');writeFileSync(join(folder,'state.json'),'SYNTHETIC');expect((await select()).status).toBe(422);}
      }
    }finally{rmSync(sources,{recursive:true,force:true});}
  });
  it('requires a trusted principal and serves a generated ZIP through bounded IDs', async () => {
    const base = await fixture();
    expect((await fetch(base + '/backups')).status).toBe(401);
    expect((await fetch(base + '/backups', { headers: { 'x-test-subject': 'other' } })).status).toBe(401);
    const headers = { 'x-test-subject': 'owner' };
    expect((await fetch(base + '/backups', { headers })).status).toBe(200);
    const created = await fetch(base + '/backups', { method: 'POST', headers });
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string };
    const download = await fetch(`${base}/backups/${body.id}/download`, { headers });
    expect(download.status).toBe(200); expect(download.headers.get('content-type')).toContain('application/zip');
    expect((await fetch(base + '/backups/invalid/download', { headers })).status).toBe(422);
    expect((await fetch(base + '/backups', { method: 'DELETE', headers })).status).toBe(404);
    const stage = await fetch(base + '/restore/stage', { method: 'POST', headers: { ...headers, 'content-type': 'application/zip' }, body: await download.arrayBuffer() });
    expect(stage.status).toBe(201);
    const staged = await stage.json() as { id: string; fingerprint: string };
    const activated = await fetch(`${base}/restore/${staged.id}/activate`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ fingerprint: staged.fingerprint, owner: 'forged' }) });
    expect(activated.status).toBe(200);
  });
});
