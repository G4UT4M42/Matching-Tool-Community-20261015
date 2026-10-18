import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiRouter } from './routes/api.js';
import { resolveHttpHost } from './host.js';
import { createCommunityDemoState } from './community-demo-state.js';
import { communityDemoProjection, ensureCommunityDemoDraft } from './community-demo-preview.js';
import { createCommunityGuard } from './community-guard.js';
import { CommunityAuthStore } from './community-auth-store.js';
import { createCommunityAccountGuard, createCommunityAuthRouter, createCommunityTransportGuard } from './community-auth-http.js';
import { loadState, saveState, createEmptyState } from '../storage/json-store.js';
import { getDb, closeDb } from '../storage/db.js';
import { recoverStatementImport, statementRecoveryPending } from '../storage/statement-transaction.js';
import { initializeCanonicalState, commitCanonicalState } from '../storage/canonical-transaction.js';
import { createCommunityWorkspace, COMMUNITY_WORKSPACE_ROUTES } from './community-workspace.js';
import { recoverInterruptedRestore } from '../community/persistence/restore.js';
import { resolveAccountingPaths } from '../storage/paths.js';
import type { Document, MatchingState } from '../core/types.js';


export type CommunityApplicationOptions=Pick<import('./community-workspace.js').WorkspaceOptions,'providerTransport'|'bankTransport'|'paymentTransport'|'invoiceBot'|'paymentAdapter'|'afterRestoreCutover'>;
/** Production composition root. Test transports are explicit code dependencies, never HTTP/environment switches. */
export function createCommunityApplication(options:CommunityApplicationOptions={}){
if (process.env.MATCHING_RUNTIME_MODE !== 'external-runtime-root') throw new Error('Community requires an isolated external runtime root');
const paths = resolveAccountingPaths();
const demoEnabled = process.env.MATCHING_DEMO_MODE === 'true';
const accessToken = process.env.MATCHING_LOCAL_ACCESS_TOKEN ?? '';
const authMode = process.env.MATCHING_AUTH_MODE ?? (demoEnabled && accessToken ? 'synthetic-preview' : 'accounts');
if (authMode !== 'accounts' && authMode !== 'synthetic-preview') throw new Error('Select a supported local authentication mode');
if (authMode === 'synthetic-preview' && (!demoEnabled || accessToken.length < 32)) throw new Error('Token access requires an explicitly configured synthetic demonstration');
if (process.env.MATCHING_ENABLE_BANK_AUTOMATION === 'true') throw new Error('Bank automation requires the separately qualified provider and payment authorization integration');
if (process.env.MATCHING_SETUP_TOKEN !== undefined && !/^[A-Za-z0-9_-]{43,128}$/.test(process.env.MATCHING_SETUP_TOKEN)) throw new Error('A valid random local setup code is required');
const portText = process.env.PORT ?? '3000';
if (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535) throw new Error('A valid local listener port is required');
const port = Number(portText), host = resolveHttpHost();
recoverInterruptedRestore(paths.runtimeRoot);
const statePath = join(paths.stateRoot, 'state.json');
if (existsSync(statePath) !== existsSync(paths.databaseFile)) throw new Error('An incomplete accounting store requires a verified migration or restore before activation');
if (authMode === 'synthetic-preview' && existsSync(join(paths.runtimeRoot, 'identity'))) throw new Error('Synthetic token access cannot open an account-owned installation');

// Verify SQLite before reading any financial snapshot, and recover a pending participant journal.
getDb();
recoverStatementImport();
let state: MatchingState;
const existing = loadState();
if (existing) state = existing;
else {
  state = demoEnabled ? createCommunityDemoState() : createEmptyState('COMMUNITY_ACCOUNTING_' + randomUUID());
  saveState(state);
}
if (authMode === 'synthetic-preview' && state.run_id !== 'COMMUNITY_SYNTHETIC_DEMO_V1') throw new Error('Synthetic token access cannot open an ordinary accounting workspace');

// Canonical initialization verifies every persisted SQL/JSON source field.
// Do not hydrate selected SQL columns over the authoritative source snapshot.
initializeCanonicalState(state);
if (authMode === 'synthetic-preview') ensureCommunityDemoDraft(getDb(), state);
const authStore = authMode === 'accounts' ? new CommunityAuthStore({ runtimeRoot: paths.runtimeRoot, setupToken: process.env.MATCHING_SETUP_TOKEN }) : undefined;
const bankCallbackUrl=`http://${host==='::1'?'[::1]':host}:${port}/api/community-banking/callback`;
const workspace = authStore ? createCommunityWorkspace({runtimeRoot:paths.runtimeRoot,auth:authStore,getState:()=>state,activate:value=>{state=value;},localLanguageDir:process.env.MATCHING_OCR_LANGUAGE_DIR,providerTransport:options.providerTransport,bankTransport:options.bankTransport,bankCallbackUrl,paymentTransport:options.paymentTransport,paymentCallbackUrl:`http://${host==='::1'?'[::1]':host}:${port}/api/community-payments/sandbox/callback`,invoiceBot:options.invoiceBot,paymentAdapter:options.paymentAdapter,afterRestoreCutover:options.afterRestoreCutover}) : undefined;
const app = express();
app.disable('x-powered-by');
app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('X-Frame-Options', 'DENY'); next();
});
app.get('/health', (_request, response) => response.json({ ok: true, auth_mode: authMode, release_ready: false }));
if (authStore) {
  // Only a one-use AIS receipt is public. Completion remains behind unchanged
  // same-origin, authenticated, recent-authentication and CSRF guards below.
  app.get('/api/community-banking/callback',workspace!.bankCallback);
  app.get('/api/community-payments/sandbox/callback',workspace!.paymentCallback);
  app.use('/api', createCommunityTransportGuard());
  app.use('/api', createCommunityAuthRouter(authStore));
  app.use('/api', createCommunityAccountGuard(authStore, COMMUNITY_WORKSPACE_ROUTES));
} else {
  app.get('/api/auth/session', createCommunityTransportGuard(), (_request, response) => response.json({ mode: 'synthetic-preview', authenticated: false, setup_required: false }));
  app.use('/api', createCommunityGuard(accessToken));
}
app.use('/api', (_request, response, next) => {
  if (statementRecoveryPending()) { response.status(503).json({ code: 'RECOVERY_REQUIRED', error: 'Complete pending statement recovery before further accounting operations' }); return; }
  next();
});
// Authentication JSON has its own 8 KiB bound. Financial bodies are parsed only after authorization.
app.use('/api', express.json({ limit: '1mb', strict: true }));
app.get('/api/community/session', (_request, response) => response.json({
  ok: true, mode: authMode, demo: demoEnabled, banking_enabled: false, release_ready: false,
  ...(authStore ? { workspace_id: authStore.workspaceId, role: response.locals.communityPrincipal.role } : {}),
}));
if (workspace) app.use('/api', workspace.router);
if (authMode === 'synthetic-preview') app.get('/api/community/demo', (_request, response) => response.json(communityDemoProjection(getDb(), state)));
app.use('/api', createApiRouter(() => state, value => { state = value; }, (before, next, actor) => {
  if (workspace) workspace.commit(before, next, actor);
  else state = commitCanonicalState(before, next, actor);
}));
app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
  if (response.headersSent) { next(error); return; }
  const type = typeof error === 'object' && error !== null ? (error as { type?: unknown }).type : undefined;
  const status = type === 'entity.too.large' ? 413 : type === 'entity.parse.failed' ? 400 : 500;
  response.status(status).json({ code: status === 413 ? 'REQUEST_BODY_LIMIT' : status === 400 ? 'REQUEST_JSON_INVALID' : 'APPLICATION_OPERATION_FAILED', error: 'The local application could not complete this request' });
});
const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
app.use(express.static(webDist));
app.get('*', (_request, response) => response.sendFile(join(webDist, 'index.html')));

return {app,port,host,authMode,async close(){try{await workspace?.close();}finally{authStore?.close();closeDb();}}};
}
