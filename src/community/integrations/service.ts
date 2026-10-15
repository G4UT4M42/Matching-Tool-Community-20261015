import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { open, rm } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { readVaultMember, inspectVaultMember } from './vault-files.js';
import path from 'node:path';
import { CredentialVault } from './vault.js';
import { PayPalClient } from './paypal.js';
import { StripeClient } from './stripe.js';
import { providerTransport } from './http.js';
import { isProviderAccountIdentity } from './provider-account.js';
import { assertEnvironment, assertPrincipal, assertProvider, publicErrorCode, type CanonicalTransaction, type Checkpoint, type CommitBatch, type Environment, type Permission, type Principal, type Provider, type Transport } from './types.js';

interface StoredState { identity: string; checkpoint: Checkpoint; account?:string|null; coverageStart?:string|null; lastSuccess: string | null; lastError: string | null }
const blank = (identity: string): StoredState => ({ identity, checkpoint: { cursor: null, seen: [] }, account:null, coverageStart:null, lastSuccess: null, lastError: null });
export interface IntegrationGuards {
  authorizeMutation?(principal:Principal,permission:Permission):void;
  hasCanonicalCoverage?(input:{principal:Principal;provider:Provider;environment:Environment;account:string;seen:readonly string[]}):boolean;
}
const locks = new Set<string>();
export class IntegrationService {
  private sessions = new Map<string, PayPalClient>();
  constructor(readonly vault: CredentialVault, private commitBatch: CommitBatch, private transport: Transport = providerTransport, private now: () => Date = () => new Date(), private guards:IntegrationGuards={}) {}
  private identity(p: Principal, provider: Provider, environment: Environment): string { return `${p.subject}\0${provider}\0${environment}`; }
  private stateFile(p: Principal, provider: Provider, environment: Environment): string { return path.join(this.vault.directory, `${createHash('sha256').update(this.identity(p, provider, environment)).digest('hex')}.checkpoint`); }
  private async readState(p: Principal, provider: Provider, environment: Environment): Promise<StoredState> {
    const id = this.identity(p, provider, environment);
    try {
      const file = this.stateFile(p, provider, environment);
      const raw = await readVaultMember(this.vault.directory, file, 16_000_000);
      if (raw === null) return blank(id);
      const envelope = JSON.parse(raw) as {version:number; ciphertext:string};
      if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 15_000_000) throw new Error();
      const plain = this.vault.openMetadata(p, provider, environment, Buffer.from(envelope.ciphertext, 'base64'));
      let value: StoredState;
      try { value = JSON.parse(plain.toString('utf8')) as StoredState; } finally { plain.fill(0); }
      if (value.identity !== id || !value.checkpoint || (value.checkpoint.cursor !== null && typeof value.checkpoint.cursor !== 'string') || !Array.isArray(value.checkpoint.seen) || value.checkpoint.seen.length > 100000 || value.checkpoint.seen.some(x => typeof x !== 'string')) throw new Error();
      if(value.coverageStart!==null&&value.coverageStart!==undefined&&(typeof value.coverageStart!=='string'||!Number.isFinite(Date.parse(value.coverageStart))||value.checkpoint.cursor!==null&&Date.parse(value.coverageStart)>Date.parse(value.checkpoint.cursor)))throw new Error();
      if(value.account!==null&&value.account!==undefined&&!isProviderAccountIdentity(value.account,provider,environment))throw new Error();
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return blank(id); throw new Error('CHECKPOINT_UNAVAILABLE'); }
  }
  private async prepareState(p: Principal, provider: Provider, environment: Environment, state: StoredState): Promise<{commit:()=>void;dispose:()=>Promise<void>}> {
    const file = this.stateFile(p, provider, environment), temp = path.join(this.vault.directory,createHash('sha256').update(randomUUID()).digest('hex')+'.checkpoint');
    await this.vault.ensureStorage();
    await inspectVaultMember(this.vault.directory, file, 16_000_000);
    const plain = Buffer.from(JSON.stringify(state));
    let cipher: Buffer;
    try { cipher = this.vault.sealMetadata(p, provider, environment, plain); } finally { plain.fill(0); }
    try {
      const handle=await open(temp,'wx',0o600);
      try{await handle.writeFile(JSON.stringify({version:1,ciphertext:cipher.toString('base64')}));await handle.sync();}finally{await handle.close();}
    }
    catch(error){await rm(temp,{force:true});throw error;}finally{cipher.fill(0);}
    return{commit:()=>{renameSync(temp,file);},dispose:()=>rm(temp,{force:true})};
  }
  private async writeState(p: Principal, provider: Provider, environment: Environment, state: StoredState,permission:Permission): Promise<void> {
    const prepared=await this.prepareState(p,provider,environment,state);
    try{this.guards.authorizeMutation?.(p,permission);prepared.commit();}finally{await prepared.dispose();}
  }
  private client(provider: Provider, environment: Environment, credentials: Record<string,string>, id: string): PayPalClient | StripeClient {
    if (provider === 'stripe') return new StripeClient(credentials.apiKey, environment, this.transport);
    let client = this.sessions.get(id);
    if (!client) { client = new PayPalClient({clientId: credentials.clientId, clientSecret: credentials.clientSecret}, environment, this.transport); this.sessions.set(id, client); }
    return client;
  }
  async configure(rawPrincipal: Principal, rawProvider: Provider, rawEnvironment: Environment, credentials: Record<string,string>): Promise<void> {
    const p = assertPrincipal(rawPrincipal), provider = assertProvider(rawProvider), environment = assertEnvironment(provider, rawEnvironment);
    if (provider === 'paypal' ? Object.keys(credentials).sort().join(',') !== 'clientId,clientSecret' : Object.keys(credentials).join(',') !== 'apiKey') throw new Error('INVALID_CREDENTIALS');
    if (provider === 'stripe' && !new RegExp(`^rk_${environment}_[A-Za-z0-9]{8,}$`).test(credentials.apiKey)) throw new Error('INVALID_CREDENTIALS');
    const id = this.identity(p, provider, environment);
    if (locks.has(id)) throw new Error('INTEGRATION_BUSY');
    locks.add(id);
    try {
      const previous=await this.readState(p,provider,environment),reset=blank(id);reset.coverageStart=previous.coverageStart??null;
      // Retain an unknown historical coverage marker. Reconnection must not
      // silently turn a legacy checkpoint into an invented recent-only window.
      if(!reset.coverageStart&&previous.checkpoint.seen.length)reset.checkpoint.seen=previous.checkpoint.seen;
      const prepared=await this.prepareState(p,provider,environment,reset);
      try{
        await this.vault.put(p,provider,environment,credentials,()=>{
          this.guards.authorizeMutation?.(p,'integrations:configure');
          // Reset first: if reset fails, old credentials remain active. If
          // secret replacement fails afterward, old credentials replay safely.
          // New credentials can never inherit a stale account cursor.
          prepared.commit();
        });this.sessions.delete(id);
      }finally{await prepared.dispose();}
    }
    finally { locks.delete(id); }
  }
  async status(rawPrincipal: Principal, rawProvider: Provider, rawEnvironment: Environment): Promise<{provider: Provider; environment: Environment; configured: boolean; lastSuccess: string | null; lastError: string | null}> {
    const p = assertPrincipal(rawPrincipal), provider = assertProvider(rawProvider), environment = assertEnvironment(provider, rawEnvironment);
    const configured = await this.vault.has(p, provider, environment);
    if(!configured)return{provider,environment,configured:false,lastSuccess:null,lastError:null};
    const state = await this.readState(p, provider, environment);
    return { provider, environment, configured, lastSuccess: state.lastSuccess, lastError: state.lastError };
  }
  async testConnection(rawPrincipal: Principal, rawProvider: Provider, rawEnvironment: Environment): Promise<void> {
    const p = assertPrincipal(rawPrincipal), provider = assertProvider(rawProvider), environment = assertEnvironment(provider, rawEnvironment);
    const id = this.identity(p, provider, environment);
    if (locks.has(id)) throw new Error('INTEGRATION_BUSY');
    locks.add(id);
    try {
      const credentials = await this.vault.get(p, provider, environment);
      if (!credentials) throw new Error('NOT_CONFIGURED');
      await this.client(provider, environment, credentials, id).testConnection();
      const state = await this.readState(p, provider, environment); state.lastError = null; await this.writeState(p, provider, environment, state,'integrations:configure');
    } catch (error) {
      const code = publicErrorCode(error);
      if (code !== 'NOT_CONFIGURED') {
        try { const state = await this.readState(p, provider, environment); state.lastError = code; await this.writeState(p, provider, environment, state,'integrations:configure'); } catch { /* preserve provider failure */ }
      }
      throw new Error(code);
    } finally { locks.delete(id); }
  }
  async synchronize(rawPrincipal: Principal, rawProvider: Provider, rawEnvironment: Environment): Promise<{imported: number; checkpoint: string}> {
    const p = assertPrincipal(rawPrincipal), provider = assertProvider(rawProvider), environment = assertEnvironment(provider, rawEnvironment);
    const id = this.identity(p, provider, environment);
    if (locks.has(id)) throw new Error('INTEGRATION_BUSY');
    locks.add(id);
    try {
      const credentials = await this.vault.get(p, provider, environment);
      if (!credentials) throw new Error('NOT_CONFIGURED');
      const state = await this.readState(p, provider, environment), now = this.now();
      if (!Number.isFinite(now.getTime())) throw new Error('INVALID_DATE_WINDOW');
      // Re-read the preceding day: provider reporting can lag and boundary timestamps are inclusive.
      let start = state.checkpoint.cursor ? new Date(new Date(state.checkpoint.cursor).getTime() - 86400000) : new Date(state.coverageStart??now.getTime()-30*86400000);
      if(state.checkpoint.seen.length&&(!state.account||this.guards.hasCanonicalCoverage&&!this.guards.hasCanonicalCoverage({principal:p,provider,environment,account:state.account,seen:state.checkpoint.seen}))){
        if(!state.coverageStart)throw new Error('CHECKPOINT_BACKFILL_REQUIRED');
        start=new Date(state.coverageStart);
      }
      if (!Number.isFinite(start.getTime()) || start > now) throw new Error('CHECKPOINT_UNAVAILABLE');
      if(!state.checkpoint.cursor&&!state.coverageStart){
        // Persist the first observed coverage boundary before any accounting
        // commit. Restore/crash recovery must not invent a later 30-day window.
        state.coverageStart=start.toISOString();await this.writeState(p,provider,environment,state,'integrations:sync');
      }
      const client = this.client(provider, environment, credentials, id);
      let imported = 0;
      let observedAccount:string|undefined=state.account??undefined;
      for (let from = start.getTime(); from < now.getTime();) {
        const to = Math.min(now.getTime(), from + 30 * 86400000);
        const end = new Date(to);
        const pages = client.pages(new Date(from), end);
        const all: CanonicalTransaction[] = [];
        const pageIds = new Map<string,CanonicalTransaction>();
        for await (const page of pages) {
          for (const tx of page.transactions) {
            if(observedAccount!==undefined&&observedAccount!==tx.account)throw new Error('PROVIDER_ACCOUNT_CHANGED');
            observedAccount=tx.account;
            const key = tx.sourceEventKey ?? `${tx.currency}:${tx.reference}`;
            const previous=pageIds.get(key);
            if(previous&&!isDeepStrictEqual(previous,tx))throw new Error('INVALID_PROVIDER_RESPONSE');
            if (!previous) { all.push(tx); pageIds.set(key,tx); }
          }
          if (all.length > 10000) throw new Error('PROVIDER_PAGINATION_LIMIT');
        }
        const known = new Set(state.checkpoint.seen);
        const fresh = all.filter(tx => !known.has(tx.sourceEventKey ?? `${tx.currency}:${tx.reference}`));
        const nextSeen = [...state.checkpoint.seen, ...fresh.map(tx => tx.sourceEventKey ?? `${tx.currency}:${tx.reference}`)];
        if (nextSeen.length > 100000) throw new Error('CHECKPOINT_CAPACITY');
        const checkpoint: Checkpoint = { cursor: end.toISOString(), seen: nextSeen };
        if(observedAccount)state.account=observedAccount;
        // Every observed row must reach the immutable canonical evidence check,
        // including checkpoint-known rows and replay after accounting restore.
        // The coordinator commits idempotently before this checkpoint persists.
        const committedEvents = await this.commitBatch({ principal: p, provider, environment, transactions: all, checkpoint });
        if (committedEvents !== undefined && (!Number.isSafeInteger(committedEvents) || committedEvents < 0 || committedEvents > all.length)) throw new Error('INVALID_PROVIDER_COMMIT');
        state.checkpoint = checkpoint; state.lastSuccess = this.now().toISOString(); state.lastError = null;
        await this.writeState(p, provider, environment, state,'integrations:sync');
        imported += committedEvents ?? fresh.length; from = to;
      }
      return { imported, checkpoint: state.checkpoint.cursor ?? now.toISOString() };
    } catch (error) {
      // Deliberately store only a stable local error code, never provider response text.
      const code = publicErrorCode(error);
      try { const state = await this.readState(p, provider, environment); state.lastError = code; await this.writeState(p, provider, environment, state,'integrations:sync'); } catch { /* original error takes precedence */ }
      throw new Error(code);
    } finally { locks.delete(id); }
  }
  async disconnect(rawPrincipal: Principal, rawProvider: Provider, rawEnvironment: Environment): Promise<void> {
    const p = assertPrincipal(rawPrincipal), provider = assertProvider(rawProvider), environment = assertEnvironment(provider, rawEnvironment), id = this.identity(p, provider, environment);
    if (locks.has(id)) throw new Error('INTEGRATION_BUSY');
    locks.add(id);
    try {
      // Verify both storage members before mutating either. A redirected
      // checkpoint must not partially revoke an otherwise valid connection.
      const checkpoint = this.stateFile(p, provider, environment);
      await inspectVaultMember(this.vault.directory, checkpoint, 16_000_000);
      // Coverage metadata contains no reusable authority and survives disconnect
      // so a later reconnection cannot lose the historical replay boundary.
      await this.vault.remove(p, provider, environment,()=>{this.guards.authorizeMutation?.(p,'integrations:configure');});
      this.sessions.get(id)?.invalidate(); this.sessions.delete(id);
    } finally { locks.delete(id); }
  }
}
