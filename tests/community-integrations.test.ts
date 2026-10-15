import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { CredentialVault, WindowsDpapiProtector, type KeyProtector } from '../src/community/integrations/vault.js';
import { IntegrationService } from '../src/community/integrations/service.js';
import { PayPalClient, normalizePayPal } from '../src/community/integrations/paypal.js';
import { StripeClient, normalizeStripe } from '../src/community/integrations/stripe.js';
import { decimalMinor, type CommitBatch, type Transport } from '../src/community/integrations/types.js';
import { createCommunityIntegrationsRouter } from '../src/server/routes/community-integrations.js';
import { COMMUNITY_PERMISSIONS } from '../src/server/community-permissions.js';

const dirs: string[] = [];
async function directory() { const value = await mkdtemp(path.join(tmpdir(), 'community-integrations-synthetic-')); dirs.push(value); return value; }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
class TestProtector implements KeyProtector {
  private key = randomBytes(32);
  protect(plain: Buffer, context: Buffer): Buffer { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(context); return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]); }
  unprotect(value: Buffer, context: Buffer): Buffer { const decipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(0, 12)); decipher.setAAD(context); decipher.setAuthTag(value.subarray(value.length - 16)); return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]); }
}
const owner = { subject: 'USR-' + randomUUID() }, other = { subject: 'USR-' + randomUUID() };
const workspace = 'WS-' + randomUUID(), session = 'SES-' + randomUUID();
const paypalCredential = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' };
const paypalRow = (id: string, amount = '10.25', fee = '-0.55', currency = 'USD') => ({ transaction_info: { transaction_id: id, transaction_amount: {value: amount, currency_code: currency}, fee_amount: {value: fee, currency_code: currency}, transaction_initiation_date: '2026-10-01T00:00:00Z', transaction_event_code: amount.startsWith('-') ? 'T1107' : 'T0006', paypal_reference_id: 'related-payment' } });

describe('credential vault', () => {
  it('isolates owner and environment, hides plaintext, fails on tamper and deletes', async () => {
    const dir = await directory(), vault = new CredentialVault(dir, new TestProtector());
    await vault.put(owner, 'paypal', 'sandbox', paypalCredential);
    expect(await vault.get(owner, 'paypal', 'sandbox')).toEqual(paypalCredential);
    expect(await vault.get(other, 'paypal', 'sandbox')).toBeNull();
    expect(await vault.get(owner, 'paypal', 'live')).toBeNull();
    const file = path.join(dir, (await readdir(dir))[0]);
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('synthetic-secret');
    await writeFile(file, raw.replace(/"ciphertext":"[^"]+"/, '"ciphertext":"AAAA"'));
    await expect(vault.get(owner, 'paypal', 'sandbox')).rejects.toThrow('CREDENTIAL_UNAVAILABLE');
    await vault.remove(owner, 'paypal', 'sandbox');
    expect(await vault.get(owner, 'paypal', 'sandbox')).toBeNull();
  });
  it('uses the actual Windows DPAPI boundary when available', async () => {
    if (process.platform !== 'win32') return;
    const protector = new WindowsDpapiProtector(), context = Buffer.from('synthetic-owner\0paypal\0sandbox');
    let encrypted: Buffer;
    try { encrypted = protector.protect(Buffer.from('synthetic-only'), context); }
    catch (error) { expect((error as Error).message).toBe('PROTECTION_UNAVAILABLE'); return; }
    expect(encrypted.toString()).not.toContain('synthetic-only');
    expect(protector.unprotect(encrypted, context).toString()).toBe('synthetic-only');
    expect(() => protector.unprotect(encrypted, Buffer.from('wrong-owner'))).toThrow('PROTECTION_UNAVAILABLE');
  });
});
describe('provider normalization and paging', () => {
  it('parses exact PayPal decimals, refunds, fees and independent currencies', () => {
    expect(decimalMinor('12.34', 'USD')).toBe(1234);
    expect(decimalMinor('12', 'JPY')).toBe(12);
    expect(decimalMinor('12', 'ISK')).toBe(12);
    expect(() => decimalMinor('1.001', 'USD')).toThrow();
    const payment = normalizePayPal(paypalRow('PP1'), 'sandbox', owner.subject)[0];
    expect([payment.amountMinor, payment.feeMinor, payment.netMinor, payment.currency]).toEqual([1025, -55, 970, 'USD']);
    const refund = normalizePayPal(paypalRow('PP2', '-4.25', '0'), 'sandbox', owner.subject)[0];
    expect(refund.classification).toBe('refund'); expect(refund.amountMinor).toBe(-425);
    expect(normalizePayPal(paypalRow('PP2B', '-4.25', '0.25'), 'sandbox', owner.subject)[0].netMinor).toBe(-400);
    expect(normalizePayPal(paypalRow('SAME', '1.00'), 'sandbox', owner.subject)[0].sourceEventKey).not.toBe(normalizePayPal(paypalRow('SAME', '2.00'), 'sandbox', owner.subject)[0].sourceEventKey);
    const fx = paypalRow('PP3'); fx.transaction_info.fee_amount.currency_code = 'EUR';
    const records = normalizePayPal(fx, 'sandbox', owner.subject);
    expect(records.map(x => [x.currency, x.amountMinor, x.classification])).toEqual([['USD', 1025, 'payment'], ['EUR', -55, 'fee']]);
    expect(() => normalizePayPal(paypalRow('BAD', '1.0001'), 'sandbox', owner.subject)).toThrow('INVALID_PROVIDER_AMOUNT');
  });
  it('uses official PayPal hosts, client credentials, finite pages and token cache', async () => {
    const calls: string[] = [];
    const transport: Transport = async request => {
      calls.push(request.url);
      if (request.method === 'POST') { expect(request.headers.Authorization).toMatch(/^Basic /); return {status: 200, json: {access_token:'synthetic-token', expires_in: 3600}}; }
      expect(request.headers.Authorization).toBe('Bearer synthetic-token');
      const page = Number(new URL(request.url).searchParams.get('page'));
      return {status: 200, json: {total_pages: 2, transaction_details: [paypalRow(`PP${page}`)]}};
    };
    const client = new PayPalClient(paypalCredential, 'sandbox', transport);
    const pages = [];
    for await (const page of client.pages(new Date('2026-10-01'), new Date('2026-10-02'), owner.subject)) pages.push(page);
    expect(pages.flatMap(x => x.transactions.map(t => t.reference))).toEqual(['PP1','PP2']);
    await client.testConnection();
    expect(calls.filter(x => x.includes('/oauth2/token'))).toHaveLength(1);
    expect(calls.every(x => x.startsWith('https://api-m.sandbox.paypal.com/'))).toBe(true);
    await expect((async () => { for await (const _ of client.pages(new Date('2026-01-01'), new Date('2026-03-01'), owner.subject)) {} })()).rejects.toThrow('INVALID_DATE_WINDOW');
  });
  it('normalizes Stripe payout as non-revenue and rejects mismatched totals', async () => {
    const row = { id:'txn_1', type:'charge', amount:1000, fee:30, net:970, currency:'usd', created:1760000000, source:'ch_1' };
    expect(normalizeStripe(row, 'test', owner.subject).revenue).toBe(true);
    expect(normalizeStripe({...row, id:'txn_2', type:'payout', amount:-970, fee:0, net:-970}, 'test', owner.subject).revenue).toBe(false);
    expect(() => normalizeStripe({...row, net:971}, 'test', owner.subject)).toThrow('INVALID_PROVIDER_AMOUNT');
    let calls = 0;
    const transport: Transport = async request => { calls++; expect(request.url).toMatch(/^https:\/\/api\.stripe\.com\/v1\/balance_transactions/); return {status: 200, json: {data:[row], has_more:true}}; };
    const client = new StripeClient('rk_test_synthetic1234', 'test', transport);
    await expect((async () => { for await (const _ of client.pages(new Date('2025-01-01'), new Date('2026-01-01'), owner.subject)) {} })()).rejects.toThrow('PROVIDER_PAGINATION_LOOP');
    expect(calls).toBe(2);
  });
  it('bounds rate limits and transport failures without exposing provider text', async () => {
    const transport: Transport = async () => ({status: 429, json:{message:'synthetic-sensitive-provider-text'}});
    const client = new StripeClient('rk_test_synthetic1234', 'test', transport);
    await expect(client.testConnection()).rejects.toThrow('PROVIDER_RATE_LIMITED');
    const timeout: Transport = async () => { throw new Error('synthetic-secret'); };
    await expect(new StripeClient('rk_test_synthetic1234', 'test', timeout).testConnection()).rejects.toThrow('PROVIDER_UNAVAILABLE');
  });
  it('rejects repeated PayPal pages and confirms search permission during connection test', async () => {
    let searchCalls = 0;
    const transport: Transport = async request => request.method === 'POST'
      ? {status:200,json:{access_token:'synthetic-token',expires_in:3600}}
      : (searchCalls++, {status:200,json:{total_pages:2,transaction_details:[paypalRow('SAME_PAGE')]}});
    const client = new PayPalClient(paypalCredential,'sandbox',transport);
    await expect((async () => { for await (const _ of client.pages(new Date('2026-10-01'),new Date('2026-10-02'),owner.subject)) {} })()).rejects.toThrow('PROVIDER_PAGINATION_LOOP');
    expect(searchCalls).toBe(2);
    const denied: Transport = async request => request.method === 'POST' ? {status:200,json:{access_token:'synthetic-token',expires_in:3600}} : {status:403,json:{secret:'never-expose'}};
    await expect(new PayPalClient(paypalCredential,'sandbox',denied).testConnection()).rejects.toThrow('PROVIDER_PERMISSION_DENIED');
  });
  it('refreshes an unexpectedly expired PayPal bearer token once', async () => {
    let tokens = 0, searches = 0;
    const transport: Transport = async request => request.method === 'POST'
      ? {status:200,json:{access_token:`token-${++tokens}`,expires_in:3600}}
      : (++searches === 1 ? {status:401,json:{message:'expired'}} : {status:200,json:{total_pages:1,transaction_details:[]}});
    const client = new PayPalClient(paypalCredential,'sandbox',transport);
    await client.testConnection();
    expect([tokens,searches]).toEqual([2,2]);
  });
});
describe('orchestration and router', () => {
  it('commits Stripe payment, refund and payout once without treating settlement as revenue', async () => {
    const dir = await directory(), vault = new CredentialVault(dir,new TestProtector());
    const rows = [
      {id:'txn_charge',type:'charge',amount:1000,fee:30,net:970,currency:'eur',created:1790000000,source:'ch_1'},
      {id:'txn_refund',type:'refund',amount:-200,fee:0,net:-200,currency:'eur',created:1790000000,source:'re_1'},
      {id:'txn_payout',type:'payout',amount:-770,fee:0,net:-770,currency:'eur',created:1790000000,source:'po_1'},
    ];
    const batches: Array<{references:string[]; revenue:number; net:number}> = [];
    const service = new IntegrationService(vault,async ({transactions}) => { batches.push({references:transactions.map(t=>t.reference),revenue:transactions.filter(t=>t.revenue).reduce((sum,t)=>sum+t.amountMinor,0),net:transactions.reduce((sum,t)=>sum+t.netMinor,0)}); },async () => ({status:200,json:{data:rows,has_more:false}}),() => new Date('2026-10-14T00:00:00Z'));
    await service.configure(owner,'stripe','test',{apiKey:'rk_test_synthetic1234'});
    expect((await service.synchronize(owner,'stripe','test')).imported).toBe(3);
    expect(batches[0]).toEqual({references:['txn_charge','txn_refund','txn_payout'],revenue:800,net:0});
    expect((await service.synchronize(owner,'stripe','test')).imported).toBe(0);
    expect(batches[1].references).toEqual([]);
  });
  it('rolls cursor back after failed durable callback and deduplicates restart', async () => {
    const dir = await directory(), protector = new TestProtector(), vault = new CredentialVault(dir, protector);
    const commits: string[][] = []; let fail = true;
    const callback: CommitBatch = async ({transactions}) => { if (fail) throw new Error('SYNTHETIC_COMMIT_FAILURE'); commits.push(transactions.map(x => x.reference)); };
    const transport: Transport = async request => request.method === 'POST' ? {status:200,json:{access_token:'token',expires_in:3600}} : {status:200,json:{total_pages:1,transaction_details:[paypalRow('PP1'),paypalRow('PP1'),paypalRow('PP2','-2.00','0')]}};
    const now = () => new Date('2026-10-14T00:00:00Z');
    const service = new IntegrationService(vault, callback, transport, now);
    await service.configure(owner, 'paypal', 'sandbox', paypalCredential);
    await expect(service.synchronize(owner,'paypal','sandbox')).rejects.toThrow('INTEGRATION_FAILED');
    expect((await service.status(owner,'paypal','sandbox')).lastSuccess).toBeNull();
    fail = false;
    expect((await service.synchronize(owner,'paypal','sandbox')).imported).toBe(2);
    expect(commits).toEqual([['PP1','PP2']]);
    const restarted = new IntegrationService(new CredentialVault(dir, protector), callback, transport, now);
    expect((await restarted.synchronize(owner,'paypal','sandbox')).imported).toBe(0);
    expect(await restarted.status(other,'paypal','sandbox')).toMatchObject({configured:false});
    const checkpointFile = path.join(dir, (await readdir(dir)).find(name => name.endsWith('.checkpoint'))!);
    const checkpointRaw = await readFile(checkpointFile, 'utf8');
    expect(checkpointRaw).not.toContain('PP1');
    await writeFile(checkpointFile, checkpointRaw.replace(/"ciphertext":"[^"]+"/, '"ciphertext":"AAAA"'));
    await expect(restarted.status(owner,'paypal','sandbox')).rejects.toThrow('CHECKPOINT_UNAVAILABLE');
    await restarted.disconnect(owner,'paypal','sandbox');
    expect((await restarted.status(owner,'paypal','sandbox')).configured).toBe(false);
    await expect(restarted.testConnection(owner,'paypal','sandbox')).rejects.toThrow('NOT_CONFIGURED');
  });
  it('requires trusted principal and permission, never body subject', async () => {
    const dir = await directory(), vault = new CredentialVault(dir, new TestProtector());
    const service = new IntegrationService(vault, async () => {}, async () => { throw new Error('No network'); });
    const app = express(); app.use(express.json()); app.use((req,res,next) => { if (req.header('x-test-principal')) res.locals.communityPrincipal = {subject:req.header('x-test-principal'), workspace_id:workspace, session_id:session, role:'owner', username:'synthetic', authenticated_at:Date.now(), reauthenticated_at:Date.now(), permissions:[...COMMUNITY_PERMISSIONS]}; next(); });
    app.use('/api/community/integrations', createCommunityIntegrationsRouter(service, (principal, permission) => principal.subject === owner.subject && permission !== 'integrations:sync'));
    const server = app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('bad address');
      const url = `http://127.0.0.1:${address.port}/api/community/integrations/paypal/sandbox`;
      const send = (subject: string | null, method = 'GET', body?: unknown) => fetch(url, {method, headers:{'Content-Type':'application/json',...(subject ? {'x-test-principal':subject}:{})},body:body ? JSON.stringify(body):undefined});
      expect((await send(null)).status).toBe(401);
      expect((await send(other.subject)).status).toBe(403);
      expect((await send(owner.subject,'PUT',{subject:other.subject, credentials:paypalCredential})).status).toBe(400);
      expect((await send(owner.subject,'PUT',{credentials:paypalCredential})).status).toBe(200);
      const status = await (await send(owner.subject)).text();
      expect(status).toContain('"configured":true'); expect(status).not.toContain('synthetic-secret');
      expect((await fetch(url+'/sync',{method:'POST',headers:{'x-test-principal':owner.subject}})).status).toBe(403);
      expect((await send(owner.subject,'DELETE')).status).toBe(200);
      expect((await send(owner.subject,'PATCH')).status).toBe(404);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
