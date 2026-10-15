/**
 * Default to a local-only HTTP listener. Enabling LAN/public access without
 * authenticated sessions is intentionally unsupported in this release.
 */
export function resolveHttpHost(env: Record<string, string | undefined> = process.env): string {
  const configured = env.MATCHING_HTTP_HOST?.trim();
  if (!configured || configured === 'localhost' || configured === '127.0.0.1') {
    return '127.0.0.1';
  }
  if (configured === '::1') return '::1';
  throw new Error('External HTTP binding requires authenticated LAN mode, which is disabled');
}
