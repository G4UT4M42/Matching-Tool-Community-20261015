import type Database from 'better-sqlite3';
import type { CredentialResolver, PaymentPermission, Principal } from '../payments/types.js';

export interface BankAccountRow { accountRef:string; currency:string; name:string; iban?:string }
export interface BankTransactionRow { providerId:string; accountRef:string; bookedAt:string; amountMinor:number; currency:string; description:string }
export interface ReadOnlyBankAdapter {
  readonly provider:'enablebanking-ais'; readonly environment:'live'|'mock'; readonly capabilities:readonly ['accounts','transactions'];
  accounts(credential:unknown,accountRef:string):Promise<BankAccountRow[]>;
  transactions(credential:unknown,accountRef:string,from:string,to:string):Promise<BankTransactionRow[]>;
}
export interface BankCallbacks { storeCredential(input:{principal:Principal;provider:'enablebanking-ais';environment:'live'|'mock';credential:unknown}):Promise<string>; importTransactions(input:{principal:Principal;transactions:BankTransactionRow[]}):Promise<{imported:number;skipped:number}> }
const deny=(code:string):never=>{throw new Error(code)};
export class CommunityBankingService {
  constructor(readonly db:Database.Database,readonly authorize:(p:Principal,permission:PaymentPermission)=>boolean,readonly vault:CredentialResolver,readonly adapter:ReadOnlyBankAdapter,readonly callbacks:BankCallbacks) {}
  private require(p:Principal|undefined,permission:PaymentPermission):Principal { if(!p?.subject || !p.workspace_id || !p.session_id) return deny('UNAUTHENTICATED');if(!this.authorize(p,permission))return deny('FORBIDDEN');return p; }
  capabilities() { return [{provider:'enablebanking-ais',accountInformation:true,paymentInitiation:false,environment:this.adapter.environment,qualification:this.adapter.environment==='mock'?'MOCK_SOFTWARE_QUALIFIED':'LIVE_AUTHORIZATION_REQUIRED'}]; }
  status(p:Principal) {this.require(p,'integrations:read');const row=this.db.prepare('SELECT account_ref,configured_at FROM community_bank_connections WHERE workspace_id=? AND subject=? AND provider=? AND environment=?').get(p.workspace_id,p.subject,this.adapter.provider,this.adapter.environment) as {account_ref:string;configured_at:string}|undefined;return {configured:!!row,provider:this.adapter.provider,accountRef:row?.account_ref??null,configuredAt:row?.configured_at??null,capabilities:this.capabilities()};}
  async configure(p:Principal,accountRef:string,credential:unknown):Promise<void> {
    this.require(p,'integrations:configure');
    if(typeof accountRef!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(accountRef) || credential===null || credential===undefined) return deny('INVALID_BANK_CONFIGURATION');
    const vaultRef=await this.callbacks.storeCredential({principal:p,provider:this.adapter.provider,environment:this.adapter.environment,credential});
    if(!vaultRef || !/^[A-Za-z0-9:_-]{1,200}$/.test(vaultRef)) return deny('VAULT_UNAVAILABLE');
    this.db.prepare('INSERT INTO community_bank_connections(workspace_id,subject,provider,environment,account_ref,vault_ref,configured_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,subject,provider,environment) DO UPDATE SET account_ref=excluded.account_ref,vault_ref=excluded.vault_ref,configured_at=excluded.configured_at')
      .run(p.workspace_id,p.subject,this.adapter.provider,this.adapter.environment,accountRef,vaultRef,new Date().toISOString());
  }
  private connection(p:Principal):{account_ref:string;vault_ref:string}{
    const row=this.db.prepare('SELECT account_ref,vault_ref FROM community_bank_connections WHERE workspace_id=? AND subject=? AND provider=? AND environment=?').get(p.workspace_id,p.subject,this.adapter.provider,this.adapter.environment) as {account_ref:string;vault_ref:string}|undefined;
    if(!row)return deny('BANK_CONNECTION_REQUIRED');return row;
  }
  async accounts(p:Principal):Promise<BankAccountRow[]> {this.require(p,'integrations:read');const c=this.connection(p);const secret=await this.vault.resolve({subject:p.subject,workspaceId:p.workspace_id,provider:this.adapter.provider,environment:this.adapter.environment,vaultRef:c.vault_ref});try{return await this.adapter.accounts(secret,c.account_ref)}catch{return deny('BANK_READ_UNAVAILABLE')}}
  async sync(p:Principal,from:string,to:string):Promise<{imported:number;skipped:number}> {
    this.require(p,'integrations:sync');if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)return deny('INVALID_DATE_RANGE');
    const c=this.connection(p),secret=await this.vault.resolve({subject:p.subject,workspaceId:p.workspace_id,provider:this.adapter.provider,environment:this.adapter.environment,vaultRef:c.vault_ref});
    let transactions:BankTransactionRow[];try{transactions=await this.adapter.transactions(secret,c.account_ref,from,to)}catch{return deny('BANK_READ_UNAVAILABLE')}
    if(transactions.some(t=>!Number.isSafeInteger(t.amountMinor)||!t.providerId||t.accountRef!==c.account_ref))return deny('BANK_DATA_INVALID');
    return this.callbacks.importTransactions({principal:p,transactions});
  }
}
