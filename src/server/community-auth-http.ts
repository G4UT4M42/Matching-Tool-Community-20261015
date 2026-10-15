import express, { Router, type Request, type Response, type RequestHandler } from 'express';
import { CommunityAuthError, CommunityAuthStore, type AuthSession } from './community-auth-store.js';
import { hasAllowedOrigin } from './community-guard.js';
import { hasCommunityPermission, type CommunityPermission } from './community-permissions.js';

function localAuthority(request: Request): boolean {
  const host = request.get('host');
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?$/i.test(host)) return false;
  if (request.protocol !== 'http' && request.protocol !== 'https') return false;
  try { const url = new URL(`${request.protocol}://${host}`); return (!url.port || Number(url.port) <= 65535) && url.pathname === '/'; }
  catch { return false; }
}
/** This middleware must precede all identity and accounting routes. */
export function createCommunityTransportGuard(): RequestHandler {
  return (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (!localAuthority(request)) { response.status(403).json({ code: 'LOCAL_HOST_REQUIRED', error: 'A valid local application host is required' }); return; }
    if (!hasAllowedOrigin(request) || (request.method !== 'GET' && request.method !== 'HEAD' && !request.get('origin'))) {
      response.status(403).json({ code: 'REQUEST_ORIGIN_NOT_ALLOWED', error: 'The request must originate from this local application' }); return;
    }
    if (request.path.includes('%') || request.path.includes('\\') || request.path.includes('//')) {
      response.status(400).json({ code: 'NON_CANONICAL_ROUTE', error: 'Use a canonical application route' }); return;
    }
    next();
  };
}
export function sessionTokenFromRequest(request: Request, cookieName: string): string | undefined {
  const header = request.get('cookie');
  if (!header || header.length > 8192) return undefined;
  const cookies = header.split(';').map(part => part.trim());
  const matches = cookies.filter(part => part.startsWith(cookieName + '='));
  if (matches.length !== 1) return undefined;
  const token = matches[0].slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
function cookie(store: CommunityAuthStore, session: AuthSession | null, request: Request): string {
  const secure = request.protocol === 'https' ? '; Secure' : '';
  const value = session?.token ?? '';
  const age = session ? Math.max(0, Math.floor((session.absoluteExpiresAt - Date.now()) / 1000)) : 0;
  return `${store.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
}
function publicSession(session: AuthSession): Record<string, unknown> {
  return { authenticated: true, principal: session.principal, csrf_token: session.csrfToken, absolute_expires_at: session.absoluteExpiresAt };
}
function strictBody(request: Request, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!request.is('application/json') || !request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new CommunityAuthError(400, 'JSON_BODY_REQUIRED', 'A JSON object is required');
  const body = request.body as Record<string, unknown>;
  if (Object.keys(body).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(body, key))) throw new CommunityAuthError(400, 'AUTHENTICATION_FIELDS_INVALID', 'Unexpected or missing authentication fields');
  return body;
}
function sendError(response: Response, error: unknown): void {
  if (error instanceof CommunityAuthError) {
    if (error.status === 429) response.setHeader('Retry-After', '60');
    response.status(error.status).json({ code: error.code, error: error.message });
  } else response.status(500).json({ code: 'AUTHENTICATION_OPERATION_FAILED', error: 'The local authentication operation failed' });
}

/** No password, setup code or session cookie value is returned in a JSON response. */
export function createCommunityAuthRouter(store: CommunityAuthStore): Router {
  const router = Router();
  router.use('/auth', express.json({ limit: '8kb', strict: true }));
  const session = (request: Request, response: Response, csrf = true): AuthSession => {
    const current = store.authenticate(sessionTokenFromRequest(request, store.cookieName));
    if (!current) throw new CommunityAuthError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
    if (csrf && !store.validateCsrf(current, request.get('X-CSRF-Token'))) throw new CommunityAuthError(403, 'CSRF_TOKEN_REQUIRED', 'The request requires a current session confirmation token');
    response.locals.communityPrincipal = current.principal;
    return current;
  };
  const completeLogin = (current: AuthSession, request: Request, response: Response, status = 200) => {
    response.setHeader('Set-Cookie', cookie(store, current, request)); response.status(status).json(publicSession(current));
  };
  router.get('/auth/session', (request, response) => {
    try {
      const current = store.authenticate(sessionTokenFromRequest(request, store.cookieName));
      response.json(current ? { mode: 'accounts', setup_required: false, ...publicSession(current) } : { mode: 'accounts', authenticated: false, setup_required: store.needsSetup(), setup_available: store.setupAvailable() });
    } catch (error) { sendError(response, error); }
  });
  router.post('/auth/setup', async (request, response) => {
    try {
      const body = strictBody(request, ['username', 'password', 'setup_code']);
      completeLogin(await store.setup({ username: body.username, password: body.password, setupToken: body.setup_code }), request, response, 201);
    } catch (error) { sendError(response, error); }
  });
  router.post('/auth/login', async (request, response) => {
    try {
      const body = strictBody(request, ['username', 'password']);
      completeLogin(await store.login({ username: body.username, password: body.password }), request, response);
    } catch (error) { sendError(response, error); }
  });
  router.post('/auth/logout', (request, response) => {
    try {
      strictBody(request, []); const current = session(request, response);
      store.logout(current.token); response.setHeader('Set-Cookie', cookie(store, null, request)); response.status(204).end();
    } catch (error) { sendError(response, error); }
  });
  router.post('/auth/reauthenticate', async (request, response) => {
    try {
      const body = strictBody(request, ['password']); const current = session(request, response);
      const updated = await store.reauthenticate(current.token, body.password); response.json(publicSession(updated));
    } catch (error) { sendError(response, error); }
  });
  router.put('/auth/password', async (request, response) => {
    try {
      const body = strictBody(request, ['current_password', 'new_password']); const current = session(request, response);
      completeLogin(await store.changePassword(current.token, body.current_password, body.new_password), request, response);
    } catch (error) { sendError(response, error); }
  });
  router.get('/auth/users', (request, response) => {
    try { response.json({ users: store.listUsers(session(request, response, false).token) }); }
    catch (error) { sendError(response, error); }
  });
  router.post('/auth/users', async (request, response) => {
    try {
      const body = strictBody(request, ['username', 'password', 'role']); const current = session(request, response);
      response.status(201).json(await store.createUser(current.token, { username: body.username, password: body.password, role: body.role }));
    } catch (error) { sendError(response, error); }
  });
  router.patch('/auth/users/:userId', (request, response) => {
    try {
      const body = strictBody(request, [], ['role', 'disabled']);
      if (!Object.keys(body).length || !/^USR-[a-f0-9-]{36}$/.test(String(request.params.userId))) throw new CommunityAuthError(400, 'ACCOUNT_CHANGE_INVALID', 'A valid account and change are required');
      const current = session(request, response); store.updateUser(current.token, String(request.params.userId), body);
      response.json({ ok: true });
    } catch (error) { sendError(response, error); }
  });
  router.all(/^\/auth(?:\/|$)/, (_request, response) => response.status(405).json({ code: 'AUTHENTICATION_METHOD_NOT_ALLOWED', error: 'This authentication action is not supported' }));
  router.use((error: unknown, _request: Request, response: Response, next: express.NextFunction) => {
    if (!error) { next(); return; }
    const candidate = error as { type?: string; status?: number };
    if (candidate.type === 'entity.too.large') response.status(413).json({ code: 'AUTHENTICATION_BODY_LIMIT', error: 'The authentication request is too large' });
    else if (candidate.type === 'entity.parse.failed') response.status(400).json({ code: 'AUTHENTICATION_JSON_INVALID', error: 'The authentication request is not valid JSON' });
    else sendError(response, error);
  });
  return router;
}

export interface CommunityRouteRule { method: string; pattern: RegExp; permission: CommunityPermission; recentAuthentication?: boolean }
/** Only source-reviewed routes may enter this registry; authentication is not blanket access. */
export const REVIEWED_ACCOUNT_ROUTES: readonly CommunityRouteRule[] = [
  { method: 'GET', pattern: /^\/community\/session$/, permission: 'finance:read' },
  { method: 'GET', pattern: /^\/summary$/, permission: 'finance:read' },
  { method: 'GET', pattern: /^\/transactions(?:\/[A-Za-z0-9_.-]+)?$/, permission: 'finance:read' },
  { method: 'GET', pattern: /^\/documents(?:\/[A-Za-z0-9_.-]+)?$/, permission: 'documents:read' },
  { method: 'GET', pattern: /^\/matches(?:\/[A-Za-z0-9_.-]+)?$/, permission: 'finance:read' },
  { method: 'GET', pattern: /^\/review-queue$/, permission: 'finance:read' },
  { method: 'GET', pattern: /^\/exclusions$/, permission: 'finance:read' },
  { method: 'GET', pattern: /^\/audit$/, permission: 'audit:read' },
  { method: 'GET', pattern: /^\/report\/(?:summary|json|csv|vat|income-tax)$/, permission: 'reports:read' },
  { method: 'POST', pattern: /^\/matches$/, permission: 'finance:match' },
  { method: 'PATCH', pattern: /^\/matches\/[A-Za-z0-9_.-]+\/status$/, permission: 'finance:match' },
  { method: 'DELETE', pattern: /^\/matches\/[A-Za-z0-9_.-]+$/, permission: 'finance:match' },
  { method: 'POST', pattern: /^\/import\/upload$/, permission: 'finance:import' },
  { method: 'POST', pattern: /^\/import\/(?:preview|commit|discard)$/, permission: 'finance:import' },
];
export function createCommunityAccountGuard(store: CommunityAuthStore, additionalRules: readonly CommunityRouteRule[] = []): RequestHandler {
  const rules = [...REVIEWED_ACCOUNT_ROUTES, ...additionalRules];
  if (rules.some(rule => !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(rule.method) || rule.pattern.global || rule.pattern.sticky || !rule.pattern.source.startsWith('^') || !rule.pattern.source.endsWith('$'))) throw new Error('Every account route requires an explicit anchored method-specific policy');
  return (request, response, next) => {
    try {
      const current = store.authenticate(sessionTokenFromRequest(request, store.cookieName));
      if (!current) throw new CommunityAuthError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
      const rule = rules.find(candidate => candidate.method === request.method && candidate.pattern.test(request.path));
      if (!rule || !hasCommunityPermission(current.principal, store.workspaceId, rule.permission)) throw new CommunityAuthError(403, 'PERMISSION_REQUIRED', 'This action is not permitted for the authenticated account');
      if (request.method !== 'GET' && !store.validateCsrf(current, request.get('X-CSRF-Token'))) throw new CommunityAuthError(403, 'CSRF_TOKEN_REQUIRED', 'The request requires a current session confirmation token');
      if (rule.recentAuthentication) store.requireRecentAuthentication(current);
      response.locals.communityPrincipal = current.principal;
      next();
    } catch (error) { sendError(response, error); }
  };
}
