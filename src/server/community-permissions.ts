import type { RequestHandler } from 'express';

/** Capabilities apply to one explicitly owned local accounting workspace. */
export const COMMUNITY_PERMISSIONS = [
  'finance:read', 'finance:import', 'finance:match', 'finance:annotate',
  'documents:read', 'documents:write', 'reports:read', 'audit:read',
  'integrations:read', 'integrations:configure', 'integrations:sync',
  'data:backup', 'data:restore', 'data:migrate',
  'payments:prepare', 'payments:approve', 'payments:submit', 'accounts:manage',
] as const;
export type CommunityPermission = typeof COMMUNITY_PERMISSIONS[number];
export type CommunityRole = 'owner' | 'bookkeeper' | 'viewer' | 'payment_approver';
export interface CommunityPrincipal {
  subject: string;
  workspace_id: string;
  username: string;
  role: CommunityRole;
  session_id: string;
  authenticated_at: number;
  reauthenticated_at: number;
  permissions: readonly CommunityPermission[];
}
const readOnly: readonly CommunityPermission[] = ['finance:read', 'documents:read', 'reports:read', 'audit:read'];
const roles: Readonly<Record<CommunityRole, readonly CommunityPermission[]>> = Object.freeze({
  owner: Object.freeze([...COMMUNITY_PERMISSIONS]),
  bookkeeper: Object.freeze([...readOnly, 'finance:import', 'finance:match', 'finance:annotate', 'documents:write', 'integrations:read', 'integrations:sync', 'data:backup', 'payments:prepare'] as CommunityPermission[]),
  viewer: Object.freeze([...readOnly]),
  payment_approver: Object.freeze([...readOnly, 'payments:approve', 'payments:submit'] as CommunityPermission[]),
});
export function permissionsForRole(role: unknown): readonly CommunityPermission[] {
  return typeof role === 'string' && Object.hasOwn(roles, role) ? roles[role as CommunityRole] : [];
}
export function hasCommunityPermission(principal: unknown, workspaceId: string, permission: CommunityPermission): principal is CommunityPrincipal {
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) return false;
  const value = principal as Partial<CommunityPrincipal>;
  return typeof value.subject === 'string' && /^USR-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.subject)
    && typeof value.session_id === 'string' && /^SES-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.session_id)
    && /^WS-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(workspaceId) && value.workspace_id === workspaceId
    && typeof value.authenticated_at === 'number' && Number.isSafeInteger(value.authenticated_at)
    && typeof value.reauthenticated_at === 'number' && Number.isSafeInteger(value.reauthenticated_at)
    && value.reauthenticated_at >= value.authenticated_at
    && permissionsForRole(value.role).includes(permission)
    && Array.isArray(value.permissions) && value.permissions.includes(permission);
}
export function requireCommunityPermission(workspaceId: string, permission: CommunityPermission): RequestHandler {
  return (_request, response, next) => {
    const principal = response.locals.communityPrincipal;
    if (!principal) { response.status(401).json({ code: 'AUTHENTICATION_REQUIRED', error: 'Authentication is required' }); return; }
    if (!hasCommunityPermission(principal, workspaceId, permission)) {
      response.status(403).json({ code: 'PERMISSION_REQUIRED', error: 'This operation is not permitted for the authenticated account and workspace' }); return;
    }
    next();
  };
}
