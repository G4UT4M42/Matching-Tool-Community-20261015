/**
 * Portal adapter registry.
 * Maps portal types to their concrete adapter implementations.
 */
import type { PortalType, PortalAdapter } from '../types.js';
import { AmazonBusinessAdapter } from './amazon-business.js';
import { BrowserUseAdapter } from './browser-use.js';
import { OpenAIAdapter } from './openai.js';
import { ChatGPTAdapter } from './chatgpt.js';
import { AliExpressAdapter } from './aliexpress.js';
import { GoogleCloudAdapter } from './google-cloud.js';
import { GoogleOneAdapter } from './google-one.js';
import { BambuLabAdapter } from './bambulab.js';
import { PostAtAdapter } from './post-at.js';
import { SpotifyAdapter } from './spotify.js';
import { FiverrAdapter } from './fiverr.js';

const adapters: Map<PortalType, PortalAdapter> = new Map();

// Register known adapters
adapters.set('amazon', new AmazonBusinessAdapter());
adapters.set('browser_use', new BrowserUseAdapter());
adapters.set('openai', new OpenAIAdapter());
adapters.set('chatgpt', new ChatGPTAdapter());
adapters.set('aliexpress', new AliExpressAdapter());
adapters.set('google_cloud', new GoogleCloudAdapter());
adapters.set('google_one', new GoogleOneAdapter());
adapters.set('bambulab', new BambuLabAdapter());
adapters.set('post_at', new PostAtAdapter());
adapters.set('spotify', new SpotifyAdapter());
adapters.set('fiverr', new FiverrAdapter());

/** Get the adapter for a portal type, or null if unsupported */
export function getAdapter(portalType: PortalType): PortalAdapter | null {
  return adapters.get(portalType) ?? null;
}

/** List all supported portal types */
export function getSupportedPortalTypes(): PortalType[] {
  return [...adapters.keys()];
}
