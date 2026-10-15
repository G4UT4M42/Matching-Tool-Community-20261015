import { randomUUID, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { CommunityDocumentService, Principal } from '../documents/service.js';
import { DocumentInputError, MAX_DOCUMENT_BYTES } from '../documents/recognition.js';

export interface PortalInvoice { source_id: string; filename: string; href: string; date?: string }
export interface PortalAdapter {
  id: string; label: string; origin: string;
  connect(principal: Principal, session: BrowserSessionCallbacks, signal: AbortSignal): Promise<void>;
  discover(principal: Principal, session: BrowserSessionCallbacks, signal: AbortSignal): Promise<PortalInvoice[]>;
  download(principal: Principal, session: BrowserSessionCallbacks, invoice: PortalInvoice, signal: AbortSignal): Promise<Buffer>;
}
/** Vault integration owns the browser profile, cookies and credentials. None enter coordinator state. */
export interface BrowserSessionCallbacks {
  openFreshSession(principal: Principal, adapterId: string, origin: string, signal: AbortSignal): Promise<void>;
  disconnect(principal: Principal, adapterId: string): Promise<void>;
  isConnected(principal: Principal, adapterId: string): Promise<boolean>;
}
export interface BotRun {
  id: string; workspace_id: string; actor: string; adapter_id: string;
  status: 'running' | 'discovered' | 'imported' | 'cancelled' | 'failed';
  discovered: PortalInvoice[]; imported: string[]; error?: string; started_at: string; ended_at?: string;
}
const safeOrigin = (raw: string) => {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.pathname !== '/' || url.search || url.hash) throw new DocumentInputError('UNSAFE_PORTAL', 'Portal origin must be a plain HTTPS origin');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) throw new DocumentInputError('UNSAFE_PORTAL', 'Private and literal network addresses are not supported');
  return url.origin;
};
export function assertPortalLocation(origin: string, href: string): void {
  const expected = safeOrigin(origin);
  const url = new URL(href, expected);
  if (url.origin !== expected || url.username || url.password || url.protocol !== 'https:' || url.search || url.hash) throw new DocumentInputError('UNSAFE_NAVIGATION', 'Portal navigation left the configured origin or included unsafe query material');
}
export async function assertPublicPortalDns(origin: string): Promise<void> {
  const hostname = new URL(safeOrigin(origin)).hostname;
  let addresses: Array<{ address: string; family: number }>;
  try { addresses = await lookup(hostname, { all: true }); }
  catch { throw new DocumentInputError('PORTAL_DNS_FAILED', 'Portal DNS lookup failed'); }
  if (!addresses.length || addresses.some(({ address }) => {
    if (address.includes(':')) return /^(::|fc|fd|fe8|fe9|fea|feb|2001:db8)/i.test(address) || address.startsWith('::ffff:');
    const [a,b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19);
  })) throw new DocumentInputError('UNSAFE_PORTAL', 'Portal resolves to a private or reserved address');
}
export class InvoiceBotCoordinator {
  private readonly adapters = new Map<string, PortalAdapter>();
  private readonly runs = new Map<string, BotRun>();
  private readonly active = new Map<string, AbortController>();
  constructor(adapters: PortalAdapter[], private readonly sessions: BrowserSessionCallbacks, private readonly documents: CommunityDocumentService, private readonly allowLocalTestAdapter = false) {
    for (const adapter of adapters) {
      if (!/^[a-z][a-z0-9-]{1,50}$/.test(adapter.id) || this.adapters.has(adapter.id)) throw new Error('Invalid or duplicate portal adapter');
      if (!allowLocalTestAdapter) safeOrigin(adapter.origin);
      this.adapters.set(adapter.id, adapter);
    }
  }
  catalog(): Array<{ id: string; label: string; origin: string }> { return [...this.adapters.values()].map(({ id, label, origin }) => ({ id, label, origin })); }
  private adapter(id: string): PortalAdapter { const found = this.adapters.get(id); if (!found) throw new DocumentInputError('UNSUPPORTED_PORTAL', 'Select a configured supported portal'); return found; }
  private key(principal: Principal, adapterId: string) { return createHash('sha256').update(`${principal.workspace_id}\0${principal.subject}\0${adapterId}`).digest('hex'); }
  async status(principal: Principal, adapterId: string) { this.adapter(adapterId); return { connected: await this.sessions.isConnected(principal, adapterId), active: this.active.has(this.key(principal, adapterId)) }; }
  async connect(principal: Principal, adapterId: string): Promise<void> {
    const adapter = this.adapter(adapterId); const key = this.key(principal, adapterId);
    if (this.active.has(key)) throw new DocumentInputError('BOT_BUSY', 'Portal operation is already running');
    const abort = new AbortController(); this.active.set(key, abort);
    try {
      if (!this.allowLocalTestAdapter) await assertPublicPortalDns(adapter.origin);
      await this.sessions.openFreshSession(principal, adapterId, adapter.origin, abort.signal);
      await adapter.connect(principal, this.sessions, abort.signal);
    } finally { this.active.delete(key); }
  }
  async disconnect(principal: Principal, adapterId: string): Promise<void> {
    this.adapter(adapterId); this.active.get(this.key(principal, adapterId))?.abort();
    await this.sessions.disconnect(principal, adapterId);
  }
  async discover(principal: Principal, adapterId: string): Promise<BotRun> {
    const adapter = this.adapter(adapterId); const key = this.key(principal, adapterId);
    if (this.active.has(key)) throw new DocumentInputError('BOT_BUSY', 'Portal operation is already running');
    if (!await this.sessions.isConnected(principal, adapterId)) throw new DocumentInputError('BOT_DISCONNECTED', 'Connect a fresh browser session first');
    const abort = new AbortController(); this.active.set(key, abort);
    const run: BotRun = { id: randomUUID(), workspace_id: principal.workspace_id, actor: principal.subject, adapter_id: adapterId, status: 'running', discovered: [], imported: [], started_at: new Date().toISOString() };
    this.runs.set(run.id, run);
    try {
      if (!this.allowLocalTestAdapter) await assertPublicPortalDns(adapter.origin);
      const found = await adapter.discover(principal, this.sessions, abort.signal);
      if (abort.signal.aborted) throw new DocumentInputError('BOT_CANCELLED', 'Discovery cancelled');
      if (found.length > 500) throw new DocumentInputError('BOT_LIMIT', 'Portal returned too many invoices');
      const ids = new Set<string>();
      for (const invoice of found) {
        if (!/^[\w.:-]{1,160}$/.test(invoice.source_id) || ids.has(invoice.source_id) || !/^[^\\/\u0000-\u001f]{1,200}$/.test(invoice.filename)) throw new DocumentInputError('INVALID_DISCOVERY', 'Portal returned invalid invoice identifiers');
        ids.add(invoice.source_id);
        if (!this.allowLocalTestAdapter) assertPortalLocation(adapter.origin, invoice.href);
      }
      run.discovered = found; run.status = 'discovered';
    } catch (error) { run.status = abort.signal.aborted ? 'cancelled' : 'failed'; run.error = error instanceof DocumentInputError ? error.message : 'Portal discovery failed'; }
    finally { run.ended_at = new Date().toISOString(); this.active.delete(key); }
    return run;
  }
  listRuns(principal: Principal) { return [...this.runs.values()].filter(run => run.workspace_id === principal.workspace_id && run.actor === principal.subject); }
  getRun(principal: Principal, id: string) { const run = this.runs.get(id); if (!run || run.workspace_id !== principal.workspace_id || run.actor !== principal.subject) throw new DocumentInputError('NOT_FOUND', 'Run not found'); return run; }
  cancel(principal: Principal, id: string): BotRun { const run = this.getRun(principal, id); this.active.get(this.key(principal, run.adapter_id))?.abort(); if (run.status === 'running') run.status = 'cancelled'; return run; }
  async importSelected(principal: Principal, id: string, sourceIds: string[]): Promise<BotRun> {
    const run = this.getRun(principal, id);
    if (run.status !== 'discovered' && run.status !== 'imported') throw new DocumentInputError('INVALID_STATUS', 'Run has no confirmed discovery');
    if (!Array.isArray(sourceIds) || sourceIds.length > 100 || sourceIds.some(x => typeof x !== 'string')) throw new DocumentInputError('INVALID_SELECTION', 'Select up to 100 invoice identifiers');
    const adapter = this.adapter(run.adapter_id);
    const key = this.key(principal, run.adapter_id);
    if (this.active.has(key)) throw new DocumentInputError('BOT_BUSY', 'Portal operation is already running');
    const abort = new AbortController(); this.active.set(key, abort);
    try {
      if (!this.allowLocalTestAdapter) await assertPublicPortalDns(adapter.origin);
      for (const sourceId of [...new Set(sourceIds)]) {
        if (abort.signal.aborted) throw new DocumentInputError('BOT_CANCELLED', 'Import cancelled');
        const invoice = run.discovered.find(item => item.source_id === sourceId);
        if (!invoice) throw new DocumentInputError('INVALID_SELECTION', 'Unknown invoice selection');
        if (run.imported.includes(sourceId)) continue;
        if (!this.allowLocalTestAdapter) assertPortalLocation(adapter.origin, invoice.href);
        const buffer = await adapter.download(principal, this.sessions, invoice, abort.signal);
        if (!Buffer.isBuffer(buffer) || buffer.length > MAX_DOCUMENT_BYTES) throw new DocumentInputError('FILE_LIMIT', 'Portal invoice exceeds file limit');
        await this.documents.upload(principal, buffer, invoice.filename, `${adapter.id}:${sourceId}`);
        run.imported.push(sourceId);
      }
      run.status = 'imported'; run.error = undefined;
    } catch (error) { run.status = abort.signal.aborted ? 'cancelled' : 'failed'; run.error = error instanceof DocumentInputError ? error.message : 'Portal import failed'; }
    finally { run.ended_at = new Date().toISOString(); this.active.delete(key); }
    return run;
  }
}
