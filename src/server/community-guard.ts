import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function allowedHost(host: string | undefined): boolean {
  if (!host) return false;
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host);
}

/**
 * Positive, method-specific permissions. An existing source handler is not
 * automatically authorized: a newly enabled route needs its complete request,
 * resource, financial and negative-security qualification first.
 */
const reviewedPreviewRoutes: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/community\/session$/],
  ['GET', /^\/community\/demo$/],
  ['GET', /^\/(?:match|summary|transactions|documents|matches|exclusions|review-queue|audit)$/],
  ['GET', /^\/(?:transactions|documents|matches)\/[^/]+$/],
  ['GET', /^\/report\/(?:json|csv|summary)$/],
  ['POST', /^\/matches$/],
  ['POST', /^\/import\/upload$/],
  ['PATCH', /^\/matches\/[^/]+\/status$/],
  ['DELETE', /^\/matches\/[^/]+$/],
  ['POST', /^\/exclusions$/],
  ['DELETE', /^\/exclusions\/[^/]+$/],
];

/** Local secret is not an identity system; preview is limited to synthetic data. */
export function createCommunityGuard(token: string): RequestHandler {
  if (!token || token.length < 32 || token.length > 512) {
    throw new Error('Set a cryptographically random MATCHING_LOCAL_ACCESS_TOKEN of 32 to 512 characters');
  }
  const expected = sha256(token);

  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    const host = req.get('host');
    if (!allowedHost(host)) {
      res.status(403).json({ error: 'Invalid local hostname' });
      return;
    }
    // The local listener is not a trusted reverse-proxy deployment. Derive
    // transport from the socket, never client-supplied Forwarded headers.
    const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https:' : 'http:';
    if (req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: 'Cross-site requests are not allowed' });
      return;
    }
    const origin = req.get('origin');
    if (origin !== undefined) {
      try {
        const parsed = new URL(origin);
        const expectedOrigin = new URL(`${protocol}//${host}`).origin;
        // A serialized Origin contains no credentials, path, query or fragment.
        // Exact comparison also checks scheme and effective port, not just host.
        if (origin !== parsed.origin || parsed.origin !== expectedOrigin) {
          res.status(403).json({ error: 'Cross-origin requests are not allowed' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'Invalid origin' });
        return;
      }
    }

    const supplied = req.get('x-community-access-token');
    if (typeof supplied !== 'string'
        || supplied.length < 32
        || supplied.length > 512
        || !timingSafeEqual(sha256(supplied), expected)) {
      res.status(401).json({ error: 'Local access token required' });
      return;
    }

    if (!reviewedPreviewRoutes.some(([method, pattern]) =>
      req.method === method && pattern.test(req.path))) {
      res.status(403).json({
        code: 'COMMUNITY_EXTERNAL_ACTION_DISABLED',
        error: 'This endpoint has not been reviewed for synthetic-only Community Preview',
      });
      return;
    }

    res.locals.communityPrincipal = { subject: 'authenticated-local-owner', scope: 'local-runtime-owner' };
    next();
  };
}

/** Account mode shares the preview's direct-socket same-origin contract. */
export function hasAllowedOrigin(request: import('express').Request): boolean {
  const host = request.get('host');
  if (!allowedHost(host) || request.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.get('origin');
  if (origin === undefined) return true;
  const protocol = (request.socket as { encrypted?: boolean }).encrypted ? 'https:' : 'http:';
  try {
    const parsed = new URL(origin);
    return origin === parsed.origin && parsed.origin === new URL(`${protocol}//${host}`).origin;
  } catch { return false; }
}
