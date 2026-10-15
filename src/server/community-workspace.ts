import { Router } from 'express';
import {applyActiveExclusionsForNewTransactions} from '../community/accounting/ledger.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { recordAudit } from '../observability/audit.js';
import type { MatchingState } from '../core/types.js';
import { CommunityAuthStore } from './community-auth-store.js';
import { REVIEWED_ACCOUNT_ROUTES, sessionTokenFromRequest, type CommunityRouteRule } from './community-auth-http.js';
import { hasCommunityPermission, type CommunityPermission, type CommunityPrincipal } from './community-permissions.js';
import { commitCanonicalState, commitCanonicalMutation, initializeCanonicalState, CanonicalStateError } from '../storage/canonical-transaction.js';
import { closeDb, getDb } from '../storage/db.js';
import { loadState,serializeCommunityState } from '../storage/json-store.js';
import { recoverStatementImport } from '../storage/statement-transaction.js';
import { CommunityDocumentService } from '../community/documents/service.js';
import { createCommunityDocumentsRouter } from './routes/community-documents.js';
import { createCommunityAccountingRouter } from './routes/community-accounting.js';
import { createCommunityPersistenceRouter } from './routes/community-persistence.js';
import type { Exclusive } from '../community/persistence/backup.js';
import { CredentialVault } from '../community/integrations/vault.js';
import { IntegrationService } from '../community/integrations/service.js';
import { prepareProviderImport } from '../community/integrations/canonical-import.js';
import { createCommunityIntegrationsRouter,type IntegrationOperationEntry } from './routes/community-integrations.js';
import type { Transport } from '../community/integrations/types.js';
import { currentPaymentInvoices, provedPaymentReconciliation } from '../community/payments/community-evidence.js';
import { communitySimulatedPaymentAdapter } from '../community/payments/simulated-adapter.js';
import { CommunityPaymentService } from '../community/payments/service.js';
import { PaymentRepository } from '../community/payments/repository.js';
import { createCommunityPaymentsRouter } from './routes/community-payments.js';
import type { Principal as PaymentPrincipal,PaymentAdapter } from '../community/payments/types.js';
import { InvoiceBotCoordinator,type PortalAdapter,type BrowserSessionCallbacks } from '../community/invoice-bot/coordinator.js';
import { createCommunityInvoiceBotRouter } from './routes/community-invoice-bot.js';
import { AssistedPortalSessions } from '../community/invoice-bot/assisted-portals.js';
import { CommunityBankingService } from '../community/banking/service.js';
import { EnableBankingAisAdapter } from '../community/banking/enablebanking-ais.js';
import { BankCredentialVault } from '../community/banking/vault.js';
import { prepareBankImport } from '../community/banking/canonical-import.js';
import { createCommunityBankingRouter } from './routes/community-banking.js';

const id='[A-Za-z0-9_-]{1,120}';
const rule=(method:string,pattern:string,permission:CommunityPermission,recentAuthentication=false):CommunityRouteRule=>({method,pattern:new RegExp(pattern),permission,...(recentAuthentication?{recentAuthentication:true}:{})});
export const COMMUNITY_WORKSPACE_ROUTES:readonly CommunityRouteRule[]=[
  rule('GET','^/community/documents/?$','documents:read'),
  rule('GET','^/community/documents/'+id+'(?:/content)?$','documents:read'),
  rule('POST','^/community/documents/upload$','documents:write'),
  rule('POST','^/community/documents/import/(?:income|invoice)$','documents:write'),
  rule('PUT','^/community/documents/'+id+'/fields$','documents:write'),
  rule('POST','^/community/documents/'+id+'/(?:confirm|reject|archive|restore)$','documents:write'),
  rule('GET','^/community/integrations/(?:paypal/(?:sandbox|live)|stripe/(?:test|live))$','integrations:read'),
  rule('GET','^/community/integrations/(?:paypal/(?:sandbox|live)|stripe/(?:test|live))/history$','integrations:read'),
  rule('PUT','^/community/integrations/(?:paypal/(?:sandbox|live)|stripe/(?:test|live))$','integrations:configure'),
  rule('POST','^/community/integrations/(?:paypal/(?:sandbox|live)|stripe/(?:test|live))/test$','integrations:configure'),
  rule('POST','^/community/integrations/(?:paypal/(?:sandbox|live)|stripe/(?:test|live))/sync$','integrations:sync'),
  rule('DELETE','^/community/integrations/(?:paypal/(?:sandbox|live)|stripe/(?:test|live))$','integrations:configure'),
  rule('GET','^/community-payments/(?:candidates|batches)$','finance:read'),
  rule('GET','^/community-banking/(?:status|capabilities|accounts)$','integrations:read'),
  rule('POST','^/community-banking/(?:configure|disconnect)$','integrations:configure',true),
  rule('POST','^/community-banking/sync$','integrations:sync'),
  rule('GET','^/community-payments/batches/'+id+'(?:/sepa)?$','finance:read'),
  rule('POST','^/community-payments/batches$','payments:prepare'),
  rule('PATCH','^/community-payments/batches/'+id+'/debtor$','payments:prepare'),
  rule('POST','^/community-payments/batches/'+id+'/(?:validate|review|cancel|reconciled)$','payments:prepare'),
  rule('POST','^/community-payments/batches/'+id+'/approve$','payments:approve',true),
  rule('POST','^/community-payments/batches/'+id+'/(?:confirmation|submit|provider-status)$','payments:submit',true),
  rule('GET','^/community/invoice-bot/(?:portals|runs)$','integrations:read'),
  rule('GET','^/community/invoice-bot/runs/'+id+'$','integrations:read'),
  rule('GET','^/community/invoice-bot/portals/'+id+'/status$','integrations:read'),
  rule('POST','^/community/invoice-bot/portals/'+id+'/(?:connect|disconnect)$','integrations:configure'),
  rule('POST','^/community/invoice-bot/portals/'+id+'/discover$','integrations:sync'),
  rule('GET','^/community/invoice-bot/portals/'+id+'/receipt-targets$','integrations:sync'),
  rule('POST','^/community/invoice-bot/portals/'+id+'/capture-receipt$','integrations:sync'),
  rule('POST','^/community/invoice-bot/runs/'+id+'/(?:import|cancel)$','integrations:sync'),
  rule('GET','^/accounting$','finance:read'),
  rule('GET','^/accounting/reports(?:/export\\.(?:json|csv))?$','reports:read'),
  rule('GET','^/accounting/audit$','audit:read'),
  rule('POST','^/accounting/(?:allocations|proposals|matches)$','finance:match'),
  rule('DELETE','^/accounting/allocations/'+id+'$','finance:match'),
  rule('PATCH','^/accounting/matches/'+id+'/status$','finance:match'),
  rule('DELETE','^/accounting/matches/'+id+'$','finance:match'),
  rule('POST','^/accounting/(?:classifications|taxes|dispositions|exclusions)$','finance:annotate'),
  rule('PATCH','^/accounting/exclusions/'+id+'$','finance:annotate'),
  rule('GET','^/community/persistence/(?:current|backups)$','data:backup'),
  rule('GET','^/community/persistence/backups/'+id+'/download$','data:backup'),
  rule('POST','^/community/persistence/backups$','data:backup'),
  rule('POST','^/community/persistence/restore/stage$','data:restore',true),
  rule('POST','^/community/persistence/restore/'+id+'/activate$','data:restore',true),
  rule('GET','^/community/persistence/legacy/sources$','data:migrate'),
  rule('POST','^/community/persistence/legacy/sources$','data:migrate',true),
  rule('POST','^/community/persistence/legacy/'+id+'/(?:inspect|stage)$','data:migrate',true),
];
interface RequestContext{token:string;principal:CommunityPrincipal;permission:CommunityPermission;csrf:string|undefined}
export interface WorkspaceOptions{
  runtimeRoot:string;auth:CommunityAuthStore;getState:()=>MatchingState;activate:(state:MatchingState)=>void;
  localLanguageDir?:string;legacySources?:Array<{id:string;label:string;root:string}>;
  /** Test-injected transport; the real server always uses the verified official provider transport. */
  providerTransport?:Transport;
  /** Lifecycle observer for controlled embedding/failure qualification; never configured by HTTP or environment. */
  afterRestoreCutover?:()=>void;
  /** Explicit synthetic composition only; never selected through HTTP or environment. */
  paymentAdapter?:PaymentAdapter;
  /** Explicit synthetic composition dependency. Production never accepts adapter configuration over HTTP/environment. */
  invoiceBot?:{adapters:PortalAdapter[];sessions:BrowserSessionCallbacks;allowLocalFixture?:boolean;close?:()=>Promise<void>};
}

/** Shared scope and quiescence boundary for both new and retained accounting routes. */
export function createCommunityWorkspace(options:WorkspaceOptions){
  if(options.paymentAdapter&&(options.paymentAdapter.provider!=='community-simulated-bank'||options.paymentAdapter.environment!=='mock'))throw new Error('Only the local simulated payment composition is supported');
  const context=new AsyncLocalStorage<RequestContext>();
  let active=0,exclusiveActive=false;
  let currentRouter:Router;
  const can=(principal:unknown,permission:CommunityPermission)=>hasCommunityPermission(principal,options.auth.workspaceId,permission);
  function requireCurrent(permission?:CommunityPermission):CommunityPrincipal{
    const scope=context.getStore();if(!scope)throw new CanonicalStateError('AUTHENTICATION_REQUIRED','A trusted account request context is required');
    const session=options.auth.authenticate(scope.token);
    if(!session||session.principal.subject!==scope.principal.subject||session.principal.workspace_id!==options.auth.workspaceId)throw new CanonicalStateError('AUTHENTICATION_REQUIRED','The account session is no longer active');
    if(!can(session.principal,permission??scope.permission))throw new CanonicalStateError('PERMISSION_REQUIRED','The account no longer has the required workspace permission');
    return session.principal;
  }
  function commit(before:MatchingState,next:MatchingState,actor:string):void{
    const principal=requireCurrent();if(principal.subject!==actor)throw new CanonicalStateError('AUTHENTICATION_REQUIRED','Accounting actor does not match the active session');
    options.activate(commitCanonicalState(before,applyActiveExclusionsForNewTransactions(before,next,actor),actor));
  }
  const providerVault=new CredentialVault(join(options.runtimeRoot,'identity','provider-vault'));
  const bankVault=new BankCredentialVault(join(options.runtimeRoot,'identity','bank-vault'));
  const portalSessions=new AssistedPortalSessions(join(options.runtimeRoot,'identity','invoice-browsers'));
  const providers=new IntegrationService(providerVault,async batch=>{
    const principal=requireCurrent('integrations:sync');
    if(batch.principal.subject!==principal.subject)throw new CanonicalStateError('AUTHENTICATION_REQUIRED','Provider synchronization principal changed');
    const before=options.getState();
    const prepared=prepareProviderImport(before,batch);
    if(prepared.added)commit(before,prepared.state,principal.subject);
    return prepared.importedEvents;
  },options.providerTransport,undefined,{
    authorizeMutation:(principal,permission)=>{const actor=requireCurrent(permission);if(actor.subject!==principal.subject)throw new CanonicalStateError('AUTHENTICATION_REQUIRED','The provider principal changed');},
    hasCanonicalCoverage:({principal,provider,environment,account,seen})=>{
      const actor=requireCurrent('integrations:sync');if(actor.subject!==principal.subject)throw new CanonicalStateError('AUTHENTICATION_REQUIRED','The provider principal changed');
      const known=new Set<string>();for(const row of options.getState().transactions.values()){
        if(row.source_system!==provider||row.source_account_id!==account+':'+environment||!row.tags.includes('provider-import')||row.tags.includes('provider-fee'))continue;
        if(typeof row.meta.provider_source_event_key==='string')known.add(row.meta.provider_source_event_key);
        else if(typeof row.booking_reference==='string')known.add(row.currency_code+':'+row.booking_reference);
      }return seen.every(key=>known.has(key));
    },
  });
  const withExclusiveAccess:Exclusive=async operation=>{
    requireCurrent();if(exclusiveActive||active>0)throw new CanonicalStateError('WORKSPACE_BUSY','Other accounting operations must finish before backup or restore');
    exclusiveActive=true;try{return await operation();}finally{exclusiveActive=false;}
  };
  const currentPaymentSession=(principal:PaymentPrincipal)=>{
    const scope=context.getStore();
    if(!scope)return null;
    const active=options.auth.authenticate(scope.token);
    return active&&active.principal.subject===principal.subject&&active.principal.session_id===principal.session_id&&
      active.principal.workspace_id===principal.workspace_id?active:null;
  };
  function rebuild():void{
    const routes=Router();
    const documents=new CommunityDocumentService({workspaceId:options.auth.workspaceId,root:join(options.runtimeRoot,'documents'),getState:options.getState,persistAndActivate:commit,localLanguageDir:options.localLanguageDir});
    routes.use('/community/documents',createCommunityDocumentsRouter(documents,can));
    const authorizePortalMutation=(principal:{subject:string;workspace_id:string},permission:'integrations:sync')=>{
      const actor=requireCurrent(permission);
      if(actor.subject!==principal.subject||actor.workspace_id!==principal.workspace_id)throw new CanonicalStateError('AUTHENTICATION_REQUIRED','The portal principal changed');
    };
    const bot=options.invoiceBot
      ?new InvoiceBotCoordinator(options.invoiceBot.adapters,options.invoiceBot.sessions,documents,options.invoiceBot.allowLocalFixture===true,undefined,authorizePortalMutation)
      :new InvoiceBotCoordinator(portalSessions.adapters(),portalSessions,documents,false,undefined,authorizePortalMutation);
    routes.use('/community/invoice-bot',createCommunityInvoiceBotRouter(bot,can));
    routes.use('/community/integrations',createCommunityIntegrationsRouter(providers,(principal,permission)=>can(principal,permission),{
      observe:entry=>{
        const actor=requireCurrent();if(entry.subject!==actor.subject||entry.workspace_id!==actor.workspace_id)throw new CanonicalStateError('AUTHENTICATION_REQUIRED','Integration audit principal changed');
        const before=options.getState(),next=structuredClone(before);
        recordAudit(next,'STATE_COMMITTED','Run','PROVIDER-OPERATION-'+entry.id,{actor_type:'user',actor_id:actor.subject,correlation_id:entry.operation_id,
          reason:'Provider operation '+entry.operation+' '+entry.phase,after:{integration_operation:{...entry}}});commit(before,next,actor.subject);
      },
      history:scope=>options.getState().audit_events.filter(event=>event.actor_type==='user'&&event.actor_id===scope.subject&&event.after?.integration_operation)
        .map(event=>event.after!.integration_operation as IntegrationOperationEntry),
    }));
    const banking=new CommunityBankingService(getDb(),(principal,permission)=>{const current=requireCurrent(permission);return current.subject===principal.subject&&current.workspace_id===principal.workspace_id;},bankVault,new EnableBankingAisAdapter(),{
      storeCredential:async({principal,credential})=>{requireCurrent('integrations:configure');return bankVault.put(principal,credential);},
      removeCredential:async(principal,vaultRef)=>{requireCurrent('integrations:configure');await bankVault.remove(principal,vaultRef);},
      commitConnection:({principal,action,accountRef,mutate})=>{
        const actor=requireCurrent('integrations:configure');if(actor.subject!==principal.subject)throw new CanonicalStateError('AUTHENTICATION_REQUIRED','The bank configuration principal changed');
        const before=options.getState();
        const previous=getDb().prepare('SELECT account_ref FROM community_bank_connections WHERE workspace_id=? AND subject=? AND provider=? AND environment=?').get(actor.workspace_id,actor.subject,'enablebanking-ais','live') as {account_ref:string}|undefined;
        const result=commitCanonicalMutation(before,actor.subject,()=>{
          mutate();const next=structuredClone(before);
          recordAudit(next,'STATE_COMMITTED','Run','BANK-CONNECTION-'+randomUUID(),{actor_type:'user',actor_id:actor.subject,
            reason:action==='configure'?'Bank connection configured':'Bank connection disconnected',
            before:{configured:!!previous,account_ref:previous?.account_ref??null},
            after:{provider:'enablebanking-ais',environment:'live',action,configured:action==='configure',account_ref:accountRef??null}});
          return{state:next,result:null};
        });options.activate(result.state);
      },
      importTransactions:async({principal,transactions})=>{
        const actor=requireCurrent('integrations:sync');if(actor.subject!==principal.subject)throw new Error('AUTHENTICATION_REQUIRED');
        const before=options.getState(),result=prepareBankImport(before,transactions,actor.subject);
        if(result.imported)commit(before,result.state,actor.subject);
        return{imported:result.imported,skipped:result.skipped};
      },
    });
    routes.use('/community-banking',createCommunityBankingRouter(banking,(principal,token)=>{
      const session=currentPaymentSession(principal);return Boolean(session&&options.auth.validateCsrf(session,token));
    }));
    const payments=new CommunityPaymentService<MatchingState>({
      db:getDb(),
      accounting:{
        loadState:options.getState,
        persistAndActivate:commit,
        invoiceEvidence:currentPaymentInvoices,
        confirmedReconciliation:provedPaymentReconciliation,
      },
      authorize:(principal,permission)=>can(principal,permission),
      recentAuth:principal=>{
        const session=currentPaymentSession(principal);
        if(!session)return false;
        try{options.auth.requireRecentAuthentication(session);return true;}catch{return false;}
      },
      csrf:(principal,token)=>{
        const session=currentPaymentSession(principal);
        return Boolean(session&&options.auth.validateCsrf(session,token));
      },
      credentialResolver:{
        resolve:async input=>{
          const actor=requireCurrent('payments:submit');
          if(input.provider!=='community-simulated-bank'||input.environment!=='mock'||
            input.vaultRef!=='SIMULATION_ONLY'||actor.subject!==input.subject||
            actor.workspace_id!==input.workspaceId)throw new Error('SIMULATION_ONLY');
          return{simulation:true};
        },
      },
      adapter:options.paymentAdapter??communitySimulatedPaymentAdapter,
    });
    routes.use('/community-payments',createCommunityPaymentsRouter(payments));
    routes.use(createCommunityAccountingRouter({workspaceId:options.auth.workspaceId,getState:options.getState,can,persistAndActivate:commit}));
    const dataSnapshot=()=>{const state=options.getState();return{sha256:createHash('sha256').update(serializeCommunityState(state)).digest('hex'),transactions:state.transactions.size,documents:state.documents.size,audits:state.audit_events.length};};
    const dataStarts=new Map<string,ReturnType<typeof dataSnapshot>>();
    routes.use('/community/persistence',createCommunityPersistenceRouter({
      observe:entry=>{const scope=context.getStore();const actor=requireCurrent();if(!scope||actor.subject!==entry.subject)throw new Error('Data audit actor changed');const after=dataSnapshot(),before=entry.phase==='started'?after:dataStarts.get(entry.id);if(!before)throw new Error('Data audit start missing');options.auth.recordDataOperation(scope.token,{...entry,before,after});if(entry.phase==='started')dataStarts.set(entry.id,before);else dataStarts.delete(entry.id);},
      activeRuntimeRoot:()=>options.runtimeRoot,withExclusiveAccess,may:can,
      inspectCurrent:()=>({transactions:options.getState().transactions.size,documents:options.getState().documents.size,schema:4,release_ready:false}),
      legacySources:()=>options.legacySources??[],
      invalidateCheckpoint:()=>{rebuild();},
      safeActivate:async(change,rollback)=>{
        requireCurrent('data:restore');closeDb();
        try{
          change();options.afterRestoreCutover?.();getDb();recoverStatementImport();const state=loadState();if(!state)throw new Error('Restored accounting state is missing');initializeCanonicalState(state);new PaymentRepository(getDb()).invalidateActionableOnRestore();options.activate(state);
        }catch(error){
          closeDb();rollback();getDb();recoverStatementImport();const previous=loadState();if(!previous)throw new Error('Prior accounting state could not be reopened');initializeCanonicalState(previous);options.activate(previous);throw error;
        }
      },
    }));
    currentRouter=routes;
  }
  rebuild();
  const router=Router();
  router.use((request,response,next)=>{
    if(exclusiveActive){response.status(503).json({code:'WORKSPACE_BUSY',error:'A backup or restore is running; retry after it completes'});return;}
    const principal=response.locals.communityPrincipal as CommunityPrincipal|undefined;
    const token=sessionTokenFromRequest(request,options.auth.cookieName);
    const policy=[...COMMUNITY_WORKSPACE_ROUTES,...REVIEWED_ACCOUNT_ROUTES].find(item=>item.method===request.method&&item.pattern.test(request.path));
    if(!principal||!token||!policy){response.status(403).json({code:'PERMISSION_REQUIRED',error:'A reviewed authenticated workspace operation is required'});return;}
    const persistence=request.path.startsWith('/community/persistence/');
    if(!persistence){if(active>=16){response.status(503).json({code:'WORKSPACE_BUSY'});return;}active++;let ended=false;const finish=()=>{if(!ended){ended=true;active--;}};response.once('finish',finish);response.once('close',finish);}
    context.run({principal,token,permission:policy.permission,csrf:request.get('X-CSRF-Token')},next);
  });
  router.use((request,response,next)=>currentRouter(request,response,next));
  return{router,commit,withExclusiveAccess,rebuild,requireCurrent,close:async()=>{await portalSessions.close();await options.invoiceBot?.close?.();}};
}
