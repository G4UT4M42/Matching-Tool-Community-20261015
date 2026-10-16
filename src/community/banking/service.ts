import type Database from 'better-sqlite3';
import type { CredentialResolver, PaymentPermission, Principal } from '../payments/types.js';

export interface BankAccountRow { accountRef:string; currency:string; name:string; iban?:string }
export interface BankTransactionRow { providerId:string; accountRef:string; accountIdentity?:string; providerEnvironment?:'sandbox'|'live'; bookedAt:string; amountMinor:number; currency:string; description:string }
export interface ReadOnlyBankAdapter {
  readonly provider:'enablebanking-ais'; readonly environment:'live'|'sandbox'|'mock'; readonly capabilities:readonly ['accounts','transactions'];
  accounts(credential:unknown,accountRef:string):Promise<BankAccountRow[]>;
  transactions(credential:unknown,accountRef:string,from:string,to:string):Promise<BankTransactionRow[]>;
}
export interface BankCallbacks {
  storeCredential(input:{principal:Principal;provider:'enablebanking-ais';environment:'live'|'sandbox'|'mock';credential:unknown}):Promise<string>;
  removeCredential?(principal:Principal,vaultRef?:string):Promise<void>;
  /** Synchronously commits the SQL mutation and its audit event together. */
  commitConnection?(input:{principal:Principal;action:'configure'|'disconnect';accountRef?:string;mutate:()=>void}):void;
  importTransactions(input:{principal:Principal;transactions:BankTransactionRow[];guard?:()=>void}):Promise<{imported:number;skipped:number}>;
}
const deny=(code:string):never=>{throw new Error(code)};
export class CommunityBankingService {
  constructor(readonly db:Database.Database,readonly authorize:(p:Principal,permission:PaymentPermission)=>boolean,readonly vault:CredentialResolver,readonly adapter:ReadOnlyBankAdapter,readonly callbacks:BankCallbacks) {}
  private require(p:Principal|undefined,permission:PaymentPermission):Principal { if(!p?.subject || !p.workspace_id || !p.session_id) return deny('UNAUTHENTICATED');if(!this.authorize(p,permission))return deny('FORBIDDEN');return p; }
  capabilities() { return [{provider:'enablebanking-ais',accountInformation:true,paymentInitiation:false,environment:this.adapter.environment,qualification:this.adapter.environment==='mock'?'MOCK_SOFTWARE_QUALIFIED':this.adapter.environment==='sandbox'?'SANDBOX_AUTHORIZATION_REQUIRED':'LIVE_AUTHORIZATION_REQUIRED'}]; }
  status(p:Principal) {this.require(p,'integrations:read');const row=this.db.prepare('SELECT account_ref,configured_at FROM community_bank_connections WHERE workspace_id=? AND subject=? AND provider=? AND environment=?').get(p.workspace_id,p.subject,this.adapter.provider,this.adapter.environment) as {account_ref:string;configured_at:string}|undefined;return {configured:!!row,provider:this.adapter.provider,accountRef:row?.account_ref??null,configuredAt:row?.configured_at??null,capabilities:this.capabilities()};}
  async configure(p:Principal,accountRef:string,credential:unknown,guard:()=>void=()=>{}):Promise<void> {
    this.require(p,'integrations:configure');
    guard();
    if(typeof accountRef!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(accountRef) || credential===null || credential===undefined) return deny('INVALID_BANK_CONFIGURATION');
    const vaultRef=await this.callbacks.storeCredential({principal:p,provider:this.adapter.provider,environment:this.adapter.environment,credential});
    let previous:string|undefined;
    try{
      this.require(p,'integrations:configure');
      guard();
      if(!vaultRef || !/^[A-Za-z0-9:_-]{1,200}$/.test(vaultRef)) return deny('VAULT_UNAVAILABLE');
      const mutate=()=>{
        this.require(p,'integrations:configure');guard();previous=this.currentConnection(p)?.vault_ref;
        this.db.prepare('INSERT INTO community_bank_connections(workspace_id,subject,provider,environment,account_ref,vault_ref,configured_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,subject,provider,environment) DO UPDATE SET account_ref=excluded.account_ref,vault_ref=excluded.vault_ref,configured_at=excluded.configured_at')
          .run(p.workspace_id,p.subject,this.adapter.provider,this.adapter.environment,accountRef,vaultRef,new Date().toISOString());
      };
      if(this.callbacks.commitConnection)this.callbacks.commitConnection({principal:p,action:'configure',accountRef,mutate});else this.db.transaction(mutate).immediate();
    }catch(error){
      // A failed recovery may leave an already committed pointer: never delete it.
      if(this.currentConnection(p)?.vault_ref!==vaultRef)await this.cleanupCredential(p,vaultRef);
      throw error;
    }
    if(previous&&previous!==vaultRef)await this.cleanupCredential(p,previous);
  }
  private currentConnection(p:Principal):{account_ref:string;vault_ref:string}|undefined{
    const row=this.db.prepare('SELECT account_ref,vault_ref FROM community_bank_connections WHERE workspace_id=? AND subject=? AND provider=? AND environment=?').get(p.workspace_id,p.subject,this.adapter.provider,this.adapter.environment) as {account_ref:string;vault_ref:string}|undefined;
    return row;
  }
  private connection(p:Principal):{account_ref:string;vault_ref:string}{
    const row=this.currentConnection(p);if(!row)return deny('BANK_CONNECTION_REQUIRED');return row;
  }
  private current(p:Principal,permission:PaymentPermission,c:{account_ref:string;vault_ref:string}):void{this.require(p,permission);const current=this.currentConnection(p);if(current?.vault_ref!==c.vault_ref||current.account_ref!==c.account_ref)deny('BANK_CONNECTION_CHANGED');}
  private async cleanupCredential(p:Principal,vaultRef:string):Promise<void>{
    // The durable connection decides success. Cleanup cannot undo or disguise it.
    try{await this.callbacks.removeCredential?.(p,vaultRef);}catch{/* Unreferenced, protected material remains inaccessible through the service. */}
  }
  async disconnect(p:Principal):Promise<void>{
    this.require(p,'integrations:configure');
    let previous:string|undefined;
    const mutate=()=>{
      this.require(p,'integrations:configure');previous=this.currentConnection(p)?.vault_ref;
      this.db.prepare('DELETE FROM community_bank_connections WHERE workspace_id=? AND subject=? AND provider=? AND environment=?').run(p.workspace_id,p.subject,this.adapter.provider,this.adapter.environment);
    };
    if(this.callbacks.commitConnection)this.callbacks.commitConnection({principal:p,action:'disconnect',mutate});else this.db.transaction(mutate).immediate();
    if(previous)await this.cleanupCredential(p,previous);
  }
  async accounts(p:Principal):Promise<BankAccountRow[]> {this.require(p,'integrations:read');const c=this.connection(p);const secret=await this.vault.resolve({subject:p.subject,workspaceId:p.workspace_id,provider:this.adapter.provider,environment:this.adapter.environment,vaultRef:c.vault_ref});this.current(p,'integrations:read',c);let rows:BankAccountRow[];try{rows=await this.adapter.accounts(secret,c.account_ref)}catch{return deny('BANK_READ_UNAVAILABLE')}this.current(p,'integrations:read',c);return rows;}
  async sync(p:Principal,from:string,to:string):Promise<{imported:number;skipped:number}> {
    const date=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
    this.require(p,'integrations:sync');if(!date(from)||!date(to)||from>to||Date.parse(to)-Date.parse(from)>366*86400000)return deny('INVALID_DATE_RANGE');
    const c=this.connection(p),secret=await this.vault.resolve({subject:p.subject,workspaceId:p.workspace_id,provider:this.adapter.provider,environment:this.adapter.environment,vaultRef:c.vault_ref});
    this.current(p,'integrations:sync',c);
    let transactions:BankTransactionRow[];try{transactions=await this.adapter.transactions(secret,c.account_ref,from,to)}catch{return deny('BANK_READ_UNAVAILABLE')}
    const guard=()=>this.current(p,'integrations:sync',c);guard();
    if(transactions.some(t=>!Number.isSafeInteger(t.amountMinor)||!t.providerId||t.accountRef!==c.account_ref))return deny('BANK_DATA_INVALID');
    return this.callbacks.importTransactions({principal:p,transactions,guard});
  }
}
