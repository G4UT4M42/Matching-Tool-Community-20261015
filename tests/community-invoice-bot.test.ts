import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { MatchingState } from '../src/core/types.js';
import { CommunityDocumentService, type Principal } from '../src/community/documents/service.js';
import { assertPortalLocation, InvoiceBotCoordinator, type BrowserSessionCallbacks, type PortalAdapter } from '../src/community/invoice-bot/coordinator.js';
import { createCommunityInvoiceBotRouter } from '../src/server/routes/community-invoice-bot.js';

const owner: Principal = { subject: 'synthetic-owner', workspace_id: 'synthetic-workspace' };
const emptyState = (): MatchingState => ({ run_id: 'test', transactions: new Map(), documents: new Map(), match_groups: new Map(), exclusion_rules: [], audit_events: [], matched_transaction_ids: new Set(), matched_document_ids: new Set(), excluded_transaction_ids: new Set() });
async function pdf(): Promise<Buffer> {
  const document = new PDFDocument(); const parts: Buffer[] = [];
  document.on('data', piece => parts.push(piece));
  const ready = new Promise<Buffer>(resolve => document.on('end', () => resolve(Buffer.concat(parts))));
  document.text('Invoice number: BOT-001\nSupplier: Local Synthetic Portal\nInvoice date: 2026-10-14\nGrand total: EUR 10.00'); document.end(); return ready;
}

describe('Invoice Bot local portal adapter', () => {
  it('connects, discovers, deduplicates imports and disconnects without secrets', async () => {
    const attachment = await pdf();
    const server = createServer((request, response) => {
      if (request.url === '/invoices') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify([{ source_id: 'BOT-001', filename: 'bot-001.pdf', href: '/invoice/BOT-001' }])); }
      else if (request.url === '/invoice/BOT-001') { response.setHeader('Content-Type', 'application/pdf'); response.end(attachment); }
      else { response.statusCode = 404; response.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const root = await mkdtemp(join(tmpdir(), 'community-bot-'));
    let state = emptyState(); let connected = false;
    const sessions: BrowserSessionCallbacks = { openFreshSession: async () => { connected = true; }, disconnect: async () => { connected = false; }, isConnected: async () => connected };
    const adapter: PortalAdapter = {
      id: 'local-fixture', label: 'Local fake portal', origin,
      connect: async () => {},
      discover: async () => (await (await fetch(`${origin}/invoices`)).json()) as Array<{ source_id: string; filename: string; href: string }>,
      download: async (_principal, _session, invoice) => Buffer.from(await (await fetch(new URL(invoice.href, origin))).arrayBuffer()),
    };
    const documents = new CommunityDocumentService({ root, getState: () => state, persistAndActivate: (_expected, next) => { state = next; } });
    const bot = new InvoiceBotCoordinator([adapter], sessions, documents, true);
    try {
      await expect(bot.discover(owner, adapter.id)).rejects.toMatchObject({ code: 'BOT_DISCONNECTED' });
      await bot.connect(owner, adapter.id);
      const run = await bot.discover(owner, adapter.id);
      expect(run.status).toBe('discovered');
      expect(run.discovered.map(item => item.source_id)).toEqual(['BOT-001']);
      expect((await bot.importSelected(owner, run.id, ['BOT-001'])).imported).toEqual(['BOT-001']);
      await bot.importSelected(owner, run.id, ['BOT-001']);
      expect((await documents.list(owner)).length).toBe(1);
      await bot.disconnect(owner, adapter.id);
      expect((await bot.status(owner, adapter.id)).connected).toBe(false);
    } finally { server.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
  it('blocks hostile navigation and production local origins', () => {
    expect(() => assertPortalLocation('https://billing.example.com', 'https://evil.example/invoice')).toThrow();
    expect(() => assertPortalLocation('https://billing.example.com', 'file:///etc/passwd')).toThrow();
    const empty = {} as BrowserSessionCallbacks;
    expect(() => new InvoiceBotCoordinator([{ id: 'local', label: 'Local', origin: 'http://127.0.0.1:1234', connect: async () => {}, discover: async () => [], download: async () => Buffer.alloc(0) }], empty, {} as CommunityDocumentService)).toThrow();
  });
  it('cancels discovery and sanitizes provider failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'community-bot-cancel-'));
    const sessions: BrowserSessionCallbacks = { openFreshSession: async () => {}, disconnect: async () => {}, isConnected: async () => true };
    let signal: AbortSignal | undefined;
    const adapter: PortalAdapter = { id: 'cancel-fixture', label: 'Cancel fixture', origin: 'http://127.0.0.1:3211', connect: async () => {}, discover: async (_principal, _session, current) => { signal = current; await new Promise(resolve => setTimeout(resolve, 25)); throw Error('password=secret-synthetic-value'); }, download: async () => Buffer.alloc(0) };
    const state = emptyState();
    const bot = new InvoiceBotCoordinator([adapter], sessions, new CommunityDocumentService({ root, getState: () => state, persistAndActivate: () => {} }), true);
    try {
      const pending = bot.discover(owner, adapter.id);
      await new Promise(resolve => setTimeout(resolve, 5));
      const active = bot.listRuns(owner)[0];
      bot.cancel(owner, active.id);
      expect(signal?.aborted).toBe(true);
      expect((await pending).status).toBe('cancelled');
      const failed = await bot.discover(owner, adapter.id);
      expect(failed.status).toBe('failed');
      expect(JSON.stringify(failed)).not.toContain('secret-synthetic-value');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('requires a trusted principal and integration permission at the HTTP router', async () => {
    const sessions: BrowserSessionCallbacks = { openFreshSession: async () => {}, disconnect: async () => {}, isConnected: async () => false };
    const bot = new InvoiceBotCoordinator([], sessions, {} as CommunityDocumentService);
    const app = express(); app.use(express.json());
    app.use((request, response, next) => { if (request.header('x-test-owner')) response.locals.communityPrincipal = owner; next(); });
    app.use('/bot', createCommunityInvoiceBotRouter(bot, (_principal, permission) => permission === 'integrations:read'));
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bot`;
    try {
      expect((await fetch(`${url}/portals`)).status).toBe(401);
      expect((await fetch(`${url}/portals`, { headers: { 'x-test-owner': 'yes' } })).status).toBe(200);
      expect((await fetch(`${url}/portals/unknown/connect`, { method: 'POST', headers: { 'x-test-owner': 'yes' } })).status).toBe(403);
      expect((await fetch(`${url}/portals/unknown/discover`, { method: 'POST', headers: { 'x-test-owner': 'yes' } })).status).toBe(403);
    } finally { server.close(); }
  });
});
