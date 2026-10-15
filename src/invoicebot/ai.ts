/**
 * Invoice Bot AI client — tiered model system.
 *
 * Three model tiers:
 * - simple:   fast + cheap, for dump tasks (classification, OCR quality check, yes/no decisions)
 * - standard: balanced, for regular work (invoice extraction, field parsing)
 * - advanced: capable + expensive, for supervision (when standard fails, complex layouts, verification)
 *
 * Uses a SEPARATE API key from the Belegerkennung module.
 * Falls back to the Belegerkennung key if no dedicated key is configured.
 */
import { getSetting, setSetting, deleteSetting } from '../storage/settings.js';
import { recordCost, isCallAllowed } from './cost-monitor.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';

// Setting keys (separate from invoicerec's openrouter_* keys)
const KEYS = {
  apiKey: 'invoicebot_api_key',
  simple: 'invoicebot_model_simple',
  standard: 'invoicebot_model_standard',
  advanced: 'invoicebot_model_advanced',
} as const;

// Sensible defaults
const DEFAULTS = {
  simple: 'google/gemini-2.0-flash-001',
  standard: 'anthropic/claude-sonnet-4',
  advanced: 'anthropic/claude-opus-4',
} as const;

export type ModelTier = 'simple' | 'standard' | 'advanced';

export interface BotAiConfig {
  enabled: boolean;
  /** A display-only marker, never a raw secret or its prefix/suffix. */
  maskedKey: string | null;
  models: {
    simple: string;
    standard: string;
    advanced: string;
  };
  /** True if using dedicated bot key, false if falling back to Belegerkennung key */
  dedicatedKey: boolean;
}

export interface BotAiCallResult {
  content: string;
  model: string;
  tier: ModelTier;
  tokens: { prompt: number; completion: number; total: number };
  cost: number;
  fallbackUsed: boolean;
}

// ==================== Config ====================

/** Get the effective API key (bot's own key, or fallback to Belegerkennung key) */
export function getApiKey(): string | null {
  return getSetting(KEYS.apiKey) ?? getSetting('openrouter_api_key');
}

/** Check if a dedicated bot key is set (vs falling back to Belegerkennung) */
export function hasDedicatedKey(): boolean {
  return !!getSetting(KEYS.apiKey);
}

/** Get the model ID for a tier */
export function getModel(tier: ModelTier): string {
  switch (tier) {
    case 'simple': return getSetting(KEYS.simple) ?? DEFAULTS.simple;
    case 'standard': return getSetting(KEYS.standard) ?? DEFAULTS.standard;
    case 'advanced': return getSetting(KEYS.advanced) ?? DEFAULTS.advanced;
  }
}

/** Get the full bot AI config for display in UI */
export function getBotAiConfig(): BotAiConfig {
  const botKey = getSetting(KEYS.apiKey);
  const effectiveKey = botKey ?? getSetting('openrouter_api_key');
  return {
    enabled: !!effectiveKey,
    maskedKey: effectiveKey ? '[configured]' : null,
    models: {
      simple: getModel('simple'),
      standard: getModel('standard'),
      advanced: getModel('advanced'),
    },
    dedicatedKey: !!botKey,
  };
}

/** Save bot AI settings */
export function saveBotAiConfig(params: {
  apiKey?: string;
  simple?: string;
  standard?: string;
  advanced?: string;
}): void {
  if (params.apiKey !== undefined) {
    if (params.apiKey) setSetting(KEYS.apiKey, params.apiKey);
    else deleteSetting(KEYS.apiKey);
  }
  if (params.simple) setSetting(KEYS.simple, params.simple);
  if (params.standard) setSetting(KEYS.standard, params.standard);
  if (params.advanced) setSetting(KEYS.advanced, params.advanced);
}

/** Delete the dedicated bot API key */
export function deleteBotApiKey(): void {
  deleteSetting(KEYS.apiKey);
}

// ==================== Pricing ====================

let pricingCache: Map<string, { prompt: number; completion: number }> | null = null;
let pricingFetchedAt = 0;

const FALLBACK_PRICING: Record<string, { prompt: number; completion: number }> = {
  'google/gemini-2.0-flash-001': { prompt: 0.0000001, completion: 0.0000004 },
  'anthropic/claude-sonnet-4': { prompt: 0.000003, completion: 0.000015 },
  'anthropic/claude-4-sonnet': { prompt: 0.000003, completion: 0.000015 },
  'anthropic/claude-opus-4': { prompt: 0.000015, completion: 0.000075 },
  'anthropic/claude-4-opus': { prompt: 0.000015, completion: 0.000075 },
  'anthropic/claude-haiku-4-5-20251001': { prompt: 0.0000008, completion: 0.000004 },
  'anthropic/claude-haiku-4': { prompt: 0.0000008, completion: 0.000004 },
};

/** Normalize model ID — strip date suffixes, normalize claude family name order */
function normalizeModelId(id: string): string {
  let norm = id.replace(/-\d{8}$/, '');
  norm = norm.replace(/claude-(\d+)-(\w+)/, 'claude-$2-$1');
  return norm;
}

async function ensurePricing(apiKey: string): Promise<void> {
  if (pricingCache && Date.now() - pricingFetchedAt < 30 * 60_000) return;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!res.ok) return;
    const data = await res.json() as any;
    pricingCache = new Map();
    for (const m of data.data ?? []) {
      if (m.id && m.pricing) {
        pricingCache.set(m.id, {
          prompt: parseFloat(m.pricing.prompt ?? '0'),
          completion: parseFloat(m.pricing.completion ?? '0'),
        });
      }
    }
    pricingFetchedAt = Date.now();
  } catch { /* use fallback */ }
}

function estimateCost(modelId: string, promptTokens: number, completionTokens: number): number {
  const normId = normalizeModelId(modelId);

  if (pricingCache) {
    const exact = pricingCache.get(modelId);
    if (exact) return promptTokens * exact.prompt + completionTokens * exact.completion;
    for (const [id, p] of pricingCache.entries()) {
      if (normalizeModelId(id) === normId) {
        return promptTokens * p.prompt + completionTokens * p.completion;
      }
    }
  }

  const fb = FALLBACK_PRICING[modelId];
  if (fb) return promptTokens * fb.prompt + completionTokens * fb.completion;
  for (const [k, p] of Object.entries(FALLBACK_PRICING)) {
    if (normalizeModelId(k) === normId) {
      return promptTokens * p.prompt + completionTokens * p.completion;
    }
  }
  return 0;
}

// ==================== API call ====================

/**
 * Call the AI with a specific tier.
 * If the requested tier fails or returns poor results, automatically escalates to the next tier.
 *
 * Escalation: simple → standard → advanced (only on failure, not on empty results)
 */
export async function callBotAi(
  systemPrompt: string,
  userMessage: string,
  tier: ModelTier,
  opts?: {
    maxTokens?: number;
    temperature?: number;
    /** If true, escalate to next tier on failure */
    autoEscalate?: boolean;
  },
): Promise<BotAiCallResult | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  await ensurePricing(apiKey);

  const modelId = getModel(tier);
  const maxTokens = opts?.maxTokens ?? 1000;
  const temperature = opts?.temperature ?? 0;

  try {
    const result = await callOpenRouter(apiKey, modelId, systemPrompt, userMessage, maxTokens, temperature);
    return {
      content: result.content,
      model: result.model,
      tier,
      tokens: result.tokens,
      cost: result.cost,
      fallbackUsed: false,
    };
  } catch (err) {
    if (opts?.autoEscalate !== false) {
      // Escalate to next tier
      const nextTier = tier === 'simple' ? 'standard' : tier === 'standard' ? 'advanced' : null;
      if (nextTier) {
        console.log(`[invoicebot] [ai] ${tier} model failed, escalating to ${nextTier}`);
        try {
          const fallbackModel = getModel(nextTier);
          const result = await callOpenRouter(apiKey, fallbackModel, systemPrompt, userMessage, maxTokens, temperature);
          return {
            content: result.content,
            model: result.model,
            tier: nextTier,
            tokens: result.tokens,
            cost: result.cost,
            fallbackUsed: true,
          };
        } catch { /* escalation also failed */ }
      }
    }
    return null;
  }
}

/** Raw OpenRouter API call with cost tracking */
async function callOpenRouter(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number,
): Promise<{ content: string; model: string; tokens: { prompt: number; completion: number; total: number }; cost: number }> {
  // Check cost limit before calling
  if (!isCallAllowed()) {
    throw new Error('KI-Kostenlimit erreicht — Aufruf pausiert');
  }

  const res = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://matching-tool-v2.local',
      'X-Title': 'Matching Tool V2 - Invoice Bot',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const promptTokens = data.usage?.prompt_tokens ?? 0;
  const completionTokens = data.usage?.completion_tokens ?? 0;
  const totalTokens = data.usage?.total_tokens ?? (promptTokens + completionTokens);
  const cost = parseFloat(data.usage?.total_cost) || estimateCost(data.model ?? model, promptTokens, completionTokens);

  // Record cost in monitor
  recordCost({
    model: data.model ?? model,
    promptTokens, completionTokens, totalTokens, costUsd: cost,
    source: 'invoicebot',
  });

  return {
    content: data.choices?.[0]?.message?.content ?? '',
    model: data.model ?? model,
    tokens: { prompt: promptTokens, completion: completionTokens, total: totalTokens },
    cost,
  };
}
