import type { HttpRequest, HttpResponse, Transport } from './types.js';

const allowedHosts = new Set(['api-m.sandbox.paypal.com', 'api-m.paypal.com', 'api.stripe.com']);
export const providerTransport: Transport = async (request: HttpRequest): Promise<HttpResponse> => {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.username || url.password || url.port || url.hash) throw new Error('PROVIDER_REQUEST_BLOCKED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { method: request.method, headers: request.headers, body: request.body, redirect: 'error', signal: controller.signal });
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > 2_000_000) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 2_000_000) { await reader.cancel(); throw new Error('PROVIDER_RESPONSE_TOO_LARGE'); }
        chunks.push(Buffer.from(part.value));
      }
    }
    const text = Buffer.concat(chunks, bytes).toString('utf8');
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { throw new Error('INVALID_PROVIDER_RESPONSE'); }
    return { status: response.status, json };
  } catch { throw new Error('PROVIDER_UNAVAILABLE'); }
  finally { clearTimeout(timer); }
};
export async function requestJson(transport: Transport, request: HttpRequest): Promise<unknown> {
  const pause = (attempt: number) => new Promise<void>(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: HttpResponse;
    try { response = await transport(request); }
    catch { if (attempt === 2) throw new Error('PROVIDER_UNAVAILABLE'); await pause(attempt); continue; }
    if (response.status >= 200 && response.status < 300) return response.json;
    if (response.status === 401) throw new Error('PROVIDER_UNAUTHORIZED');
    if (response.status === 403) throw new Error('PROVIDER_PERMISSION_DENIED');
    if ((response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) && attempt < 2) { await pause(attempt); continue; }
    throw new Error(response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE');
  }
  throw new Error('PROVIDER_UNAVAILABLE');
}
