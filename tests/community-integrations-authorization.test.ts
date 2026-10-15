import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCommunityIntegrationsRouter } from '../src/server/routes/community-integrations.js';
import { IntegrationService } from '../src/community/integrations/service.js';
import { CredentialVault, type KeyProtector } from '../src/community/integrations/vault.js';
import { permissionsForRole, type CommunityPrincipal, type CommunityRole } from '../src/server/community-permissions.js';
import type { Transport } from '../src/community/integrations/types.js';

class FakeProtector implements KeyProtector {
  private key = randomBytes(32);
  protect(plain: Buffer, context: Buffer): Buffer {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(context);
    return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }
  unprotect(data: Buffer, context: Buffer): Buffer {
    const decipher = createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));
    decipher.setAAD(context); decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(12,-16)),decipher.final()]);
  }
}
const workspace = 'WS-' + randomUUID();
const otherWorkspace = 'WS-' + randomUUID();
function principal(role: CommunityRole, target = workspace): CommunityPrincipal {
  const now = Date.now();
  return {
    subject: 'USR-'+randomUUID(), workspace_id: target, session_id: 'SES-'+randomUUID(),
    username: 'synthetic-'+role, role, authenticated_at:now, reauthenticated_at:now,
    permissions: [...permissionsForRole(role)],
  };
}
const accounts = {
  owner: principal('owner'), bookkeeper:principal('bookkeeper'),
  viewer:principal('viewer'), payment:principal('payment_approver'),
  foreign:principal('owner',otherWorkspace),
  forged: { ...principal('viewer'), permissions:[...permissionsForRole('owner')] },
  incomplete: { subject:'USR-'+randomUUID() },
};
const sent: Array<{ subject:string; workspace_id:string; role:string; permission:string }> = [];
const root = mkdtempSync(path.join(tmpdir(),'community-integrations-auth-synthetic-'));
const fakeTransport: Transport = async request => request.method === 'POST'
  ? {status:200,json:{access_token:'synthetic-only-bearer',expires_in:3600}}
  : {status:200,json:{account_number:'SYNTHETICMERCHANT',total_pages:1,transaction_details:[]}};
const service = new IntegrationService(new CredentialVault(path.join(root,'vault'),new FakeProtector()),
  async () => {},fakeTransport,()=>new Date('2026-10-14T00:00:00Z'));
let server: Server, endpoint = '';
beforeAll(async () => {
  const app = express(); app.use(express.json({limit:'8kb'}));
  app.use((request,response,next) => {
    const id=request.get('X-Synthetic-Account') as keyof typeof accounts | undefined;
    if (id && Object.hasOwn(accounts,id)) response.locals.communityPrincipal=accounts[id];
    next();
  });
  app.use('/api/integrations', createCommunityIntegrationsRouter(service, (context,permission) => {
    sent.push({subject:context.subject,workspace_id:context.workspace_id,role:context.role,permission});
    return context.workspace_id===workspace;
  }));
  app.use('/api/denied',createCommunityIntegrationsRouter(service));
  server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test listener');
  endpoint=`http://127.0.0.1:${address.port}/api`;
});
afterAll(async()=> {
  if(server) await new Promise<void>(resolve=>server.close(()=>resolve()));
  rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
});
function call(account: keyof typeof accounts | undefined, suffix: string, method='GET', body?: object) {
  return fetch(endpoint+suffix,{
    method,
    headers:{...(account?{'X-Synthetic-Account':account}:{}),...(body?{'Content-Type':'application/json'}:{})},
    body: body?JSON.stringify(body):undefined,
  });
}
describe('Real integration router with trusted workspace and per-role permissions',()=>{
  it('requires a full trusted session, never a subject-only marker',async()=>{
    expect((await call(undefined,'/integrations/paypal/sandbox')).status).toBe(401);
    expect((await call('incomplete','/integrations/paypal/sandbox')).status).toBe(401);
  });
  it('denies every role by default without the additional workspace predicate',async()=>{
    expect((await call('owner','/denied/paypal/sandbox')).status).toBe(403);
    expect((await call('owner','/denied/paypal/sandbox','PUT',{credentials:{clientId:'fictional',clientSecret:'synthetic'}})).status).toBe(403);
  });
  it('passes full server-owned identity to the predicate and enforces target workspace',async()=>{
    expect((await call('owner','/integrations/paypal/sandbox')).status).toBe(200);
    expect(sent.at(-1)).toMatchObject({subject:accounts.owner.subject,workspace_id:workspace,role:'owner',permission:'integrations:read'});
    expect((await call('foreign','/integrations/paypal/sandbox')).status).toBe(403);
    expect(sent.at(-1)).toMatchObject({workspace_id:otherWorkspace,role:'owner'});
  });
  it('rejects viewer, payment approver and forged capabilities independent of body fields',async()=>{
    for(const account of ['viewer','payment','forged'] as const) {
      expect((await call(account,'/integrations/paypal/sandbox')).status).toBe(403);
      expect((await call(account,'/integrations/paypal/sandbox','PUT',{credentials:{clientId:'fictional',clientSecret:'synthetic'}})).status).toBe(403);
    }
    expect((await call('owner','/integrations/paypal/sandbox','PUT',{credentials:{clientId:'fictional',clientSecret:'synthetic'},role:'owner'})).status).toBe(400);
  });
  it('allows an owner to configure and disconnect, but never discloses credentials on status',async()=>{
    const credentials={clientId:'synthetic-client',clientSecret:'synthetic-vault-secret'};
    expect((await call('owner','/integrations/paypal/sandbox','PUT',{credentials})).status).toBe(200);
    const read=await call('owner','/integrations/paypal/sandbox');
    expect(read.status).toBe(200);
    const text=await read.text();expect(text).toContain('"configured":true');
    expect(text).not.toContain(credentials.clientSecret);
    expect((await call('bookkeeper','/integrations/paypal/sandbox')).status).toBe(200);
    expect((await call('bookkeeper','/integrations/paypal/sandbox','PUT',{credentials})).status).toBe(403);
    expect((await call('owner','/integrations/paypal/sandbox','DELETE')).status).toBe(200);
    expect((await (await call('owner','/integrations/paypal/sandbox')).json())).toMatchObject({configured:false});
  });
  it('guards synchronization with the separate sync permission',async()=>{
    expect((await call('viewer','/integrations/paypal/sandbox/sync','POST')).status).toBe(403);
    // An authorized user still cannot sync without user-owned credentials.
    expect((await call('owner','/integrations/paypal/sandbox/sync','POST')).status).toBe(404);
    expect((await call('owner','/integrations/paypal/sandbox','PUT',{credentials:{
      clientId:'synthetic-owned-client',clientSecret:'synthetic-owned-secret',
    }})).status).toBe(200);
    // User-owned API secrets never cross subjects, even for an otherwise
    // authorized workspace bookkeeper. A separately configured own credential
    // is required before synchronization is enabled.
    expect((await call('bookkeeper','/integrations/paypal/sandbox/sync','POST')).status).toBe(404);
    await service.configure({subject:accounts.bookkeeper.subject},'paypal','sandbox',{
      clientId:'synthetic-bookkeeper-client',clientSecret:'synthetic-bookkeeper-secret',
    });
    const synchronized=await call('bookkeeper','/integrations/paypal/sandbox/sync','POST');
    expect(synchronized.status).toBe(200);
    expect(await synchronized.json()).toMatchObject({imported:0});
    expect(sent.at(-1)).toMatchObject({role:'bookkeeper',permission:'integrations:sync',workspace_id:workspace});
  });
});
