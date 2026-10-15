/**
 * AI-assisted invoice field extraction via OpenRouter API.
 * Two-model strategy: fast model first (Gemini Flash), fallback model for difficult cases.
 */
import { getSetting } from '../storage/settings.js';
import { recordCost, isCallAllowed } from '../invoicebot/cost-monitor.js';
import type { ExtractedFields, FieldConfidence, TaxLine } from './types.js';
import { toMinor } from '../core/normalization/amount.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';
const DEFAULT_FALLBACK_MODEL = 'anthropic/claude-sonnet-4';

// Cached model pricing (fetched on demand, refreshed every 30min)
let pricingCache: Map<string, { prompt: number; completion: number }> | null = null;
let pricingFetchedAt = 0;

/** Fetch and cache pricing from OpenRouter models endpoint */
async function ensurePricingCache(apiKey: string): Promise<void> {
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
          prompt: parseFloat(m.pricing.prompt ?? '0'),       // cost per token
          completion: parseFloat(m.pricing.completion ?? '0'),
        });
      }
    }
    pricingFetchedAt = Date.now();
  } catch { /* ignore - will use fallback pricing */ }
}

// Fallback pricing per token (USD) if OpenRouter API is unavailable.
// Keys include both the request model ID and common returned model IDs.
const FALLBACK_PRICING: Record<string, { prompt: number; completion: number }> = {
  'google/gemini-2.0-flash-001': { prompt: 0.0000001, completion: 0.0000004 },
  'anthropic/claude-sonnet-4': { prompt: 0.000003, completion: 0.000015 },
  'anthropic/claude-4-sonnet': { prompt: 0.000003, completion: 0.000015 },
  'anthropic/claude-opus-4': { prompt: 0.000015, completion: 0.000075 },
  'anthropic/claude-4-opus': { prompt: 0.000015, completion: 0.000075 },
  'anthropic/claude-haiku-4-5-20251001': { prompt: 0.0000008, completion: 0.000004 },
  'anthropic/claude-haiku-4': { prompt: 0.0000008, completion: 0.000004 },
};

/**
 * Normalize a model ID for matching.
 * OpenRouter may return e.g. "anthropic/claude-4-sonnet-20250522"
 * for a request to "anthropic/claude-sonnet-4".
 * We strip date suffixes and normalize the family name.
 */
function normalizeModelId(id: string): string {
  // Remove date suffix: -20250522, -20251001 etc.
  let norm = id.replace(/-\d{8}$/, '');
  // Normalize claude model family: "claude-4-sonnet" <-> "claude-sonnet-4"
  norm = norm.replace(/claude-(\d+)-(\w+)/, 'claude-$2-$1');
  return norm;
}

/** Estimate cost from cached or fallback pricing. */
function estimateCostFromPricing(modelId: string, promptTokens: number, completionTokens: number): number {
  const normId = normalizeModelId(modelId);

  // Try cached pricing first (exact match, then normalized)
  if (pricingCache) {
    const exact = pricingCache.get(modelId);
    if (exact) return promptTokens * exact.prompt + completionTokens * exact.completion;

    for (const [id, p] of pricingCache.entries()) {
      if (normalizeModelId(id) === normId) {
        return promptTokens * p.prompt + completionTokens * p.completion;
      }
    }
  }

  // Fallback to hardcoded pricing (exact match, then normalized)
  const fb = FALLBACK_PRICING[modelId];
  if (fb) return promptTokens * fb.prompt + completionTokens * fb.completion;

  for (const [k, p] of Object.entries(FALLBACK_PRICING)) {
    if (normalizeModelId(k) === normId) {
      return promptTokens * p.prompt + completionTokens * p.completion;
    }
  }

  console.warn(`[extract-ai] No pricing found for model "${modelId}" (normalized: "${normId}"). Cost will be 0.`);
  return 0;
}

const SYSTEM_PROMPT = `Du bist ein Rechnungserkennungs-Assistent. Extrahiere strukturierte Daten aus dem Rechnungstext.

Antworte NUR mit validem JSON in diesem Format (keine Erklärungen):
{
  "invoice_number": "string oder null",
  "invoice_date": "YYYY-MM-DD oder null",
  "seller_name": "string oder null",
  "seller_country": "ISO 2-Letter Code oder null",
  "seller_vat_id": "string oder null",
  "currency": "EUR/USD/CHF",
  "net_amount": number oder null (Dezimalzahl, z.B. 100.00),
  "vat_amount": number oder null,
  "vat_rate_percent": number oder null (z.B. 20 für 20%),
  "gross_amount": number oder null,
  "tax_lines": [{"rate_percent": number, "net": number, "vat": number}],
  "document_type": "invoice" | "credit_note" | "receipt" | "other",
  "seller_email": "string oder null"
}

Regeln:
- Beträge als Dezimalzahlen (nicht Cent)
- Datum im ISO-Format YYYY-MM-DD
- Land als ISO 3166 Alpha-2 Code
- USt-Satz als Prozentzahl (20 statt 0.20)
- Wenn ein Feld nicht erkennbar ist, setze null
- Bei Alibaba.com Rechnungen/Receipts: seller_name MUSS "Alibaba.com" sein (nicht der chinesische Verkäufer). Verwende das Order date als invoice_date, NICHT das Receipt-Erstellungsdatum. Wenn ein EUR-Betrag als "Paid ... EUR X.XX" vorhanden ist, verwende diesen als gross_amount mit currency EUR.`;

export interface AiTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;  // estimated cost in USD (from OpenRouter or calculated from pricing)
}

export interface AiExtractionResult {
  fields: Partial<ExtractedFields>;
  confidence: Record<string, FieldConfidence>;
  model_used: string;
  fallback_used: boolean;
  raw_response: string;
  usage: AiTokenUsage;
}

/**
 * Get models for invoice extraction.
 * Priority:
 * 1. Belegerkennung-specific settings (openrouter_model / openrouter_fallback_model)
 * 2. Bot tiered models (invoicebot_model_standard / invoicebot_model_advanced)
 * 3. Hardcoded defaults
 *
 * For invoice extraction:
 * - primary = standard tier (balanced cost/quality)
 * - fallback = advanced tier (when standard fails to extract enough fields)
 */
function getModels(): { primary: string; fallback: string } {
  // Belegerkennung-specific settings take precedence
  const explicitPrimary = getSetting('openrouter_model');
  const explicitFallback = getSetting('openrouter_fallback_model');

  if (explicitPrimary || explicitFallback) {
    return {
      primary: explicitPrimary ?? DEFAULT_MODEL,
      fallback: explicitFallback ?? DEFAULT_FALLBACK_MODEL,
    };
  }

  // Fall back to bot tiered models
  const botStandard = getSetting('invoicebot_model_standard');
  const botAdvanced = getSetting('invoicebot_model_advanced');

  return {
    primary: botStandard ?? DEFAULT_MODEL,
    fallback: botAdvanced ?? DEFAULT_FALLBACK_MODEL,
  };
}

/**
 * Get the effective API key.
 * Priority: Belegerkennung key → Bot key
 */
function getEffectiveApiKey(): string | null {
  return getSetting('openrouter_api_key') ?? getSetting('invoicebot_api_key');
}

interface OpenRouterCallResult {
  content: string;
  model: string;
  usage: AiTokenUsage;
}

async function callOpenRouter(apiKey: string, model: string, rawText: string): Promise<OpenRouterCallResult> {
  // Check cost limit before making the call
  if (!isCallAllowed()) {
    throw new Error('KI-Kostenlimit erreicht — Aufruf pausiert');
  }

  // Ensure pricing cache is loaded (wait on first call, non-blocking after)
  await ensurePricingCache(apiKey);

  const truncated = rawText.slice(0, 6000);

  const res = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://matching-tool-v2.local',
      'X-Title': 'Matching Tool V2 - Belegerkennung',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Extrahiere die Rechnungsdaten aus folgendem Text:\n\n${truncated}` },
      ],
      temperature: 0,
      max_tokens: 1000,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenRouter API ${res.status}: ${errBody}`);
  }

  const data = await res.json() as any;
  const promptTokens = data.usage?.prompt_tokens ?? 0;
  const completionTokens = data.usage?.completion_tokens ?? 0;
  const totalTokens = data.usage?.total_tokens ?? (promptTokens + completionTokens);

  // Calculate cost: OpenRouter may provide it, otherwise estimate from cached/fallback pricing
  let costUsd = parseFloat(data.usage?.total_cost) || 0;
  if (costUsd === 0 && totalTokens > 0) {
    costUsd = estimateCostFromPricing(data.model ?? model, promptTokens, completionTokens);
  }

  const usage: AiTokenUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cost_usd: costUsd,
  };

  // Record cost in monitor (current call already completed — this tracks it and checks limit for NEXT call)
  recordCost({
    model: data.model ?? model,
    promptTokens, completionTokens, totalTokens, costUsd,
    source: 'invoicerec',
    context: 'extract-fields',
  });

  return {
    content: data.choices?.[0]?.message?.content ?? '',
    model: data.model ?? model,
    usage,
  };
}

function parseAiResponse(content: string): any | null {
  try {
    const jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function mapToFields(parsed: any): { fields: Partial<ExtractedFields>; confidence: Record<string, FieldConfidence> } {
  const confidence: Record<string, FieldConfidence> = {};
  const setConf = (field: string) => {
    confidence[field] = { value: 0.8, source: 'ai_parser' };
  };

  const fields: Partial<ExtractedFields> = {};

  if (parsed.invoice_number) { fields.invoice_number = String(parsed.invoice_number); setConf('invoice_number'); }
  if (parsed.invoice_date) { fields.invoice_date = parsed.invoice_date; setConf('invoice_date'); }
  if (parsed.seller_name) { fields.seller_name = parsed.seller_name; setConf('seller_name'); }
  if (parsed.seller_country) { fields.seller_country = parsed.seller_country.toUpperCase(); setConf('seller_country'); }
  if (parsed.seller_vat_id) { fields.seller_vat_id = parsed.seller_vat_id.replace(/\s/g, ''); setConf('seller_vat_id'); }
  if (parsed.currency) { fields.currency_code = parsed.currency; }

  if (parsed.net_amount != null) { fields.net_amount_minor = toMinor(parsed.net_amount); setConf('net_amount'); }
  if (parsed.vat_amount != null) { fields.vat_amount_minor = toMinor(parsed.vat_amount); setConf('vat_amount'); }
  if (parsed.gross_amount != null) { fields.gross_amount_minor = toMinor(parsed.gross_amount); setConf('gross_amount'); }
  if (parsed.vat_rate_percent != null) { fields.vat_rate = parsed.vat_rate_percent / 100; setConf('vat_rate'); }

  if (parsed.seller_email) { fields.meta = { ...fields.meta, seller_email: parsed.seller_email.toLowerCase() }; }

  if (Array.isArray(parsed.tax_lines) && parsed.tax_lines.length > 0) {
    fields.tax_lines = parsed.tax_lines.map((tl: any): TaxLine => ({
      rate: (tl.rate_percent ?? 0) / 100,
      net_minor: toMinor(tl.net ?? 0),
      vat_minor: toMinor(tl.vat ?? 0),
    }));
  }

  return { fields, confidence };
}

/** Count how many critical fields were extracted */
function countCriticalFields(fields: Partial<ExtractedFields>): number {
  let count = 0;
  if (fields.invoice_number) count++;
  if (fields.invoice_date) count++;
  if (fields.seller_name) count++;
  if (fields.gross_amount_minor != null) count++;
  return count;
}

export async function extractWithAi(rawText: string, scanId: string): Promise<AiExtractionResult | null> {
  const apiKey = getEffectiveApiKey();
  if (!apiKey) return null;

  const models = getModels();
  const zeroUsage: AiTokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };

  function mergeUsage(a: AiTokenUsage, b: AiTokenUsage): AiTokenUsage {
    return {
      prompt_tokens: a.prompt_tokens + b.prompt_tokens,
      completion_tokens: a.completion_tokens + b.completion_tokens,
      total_tokens: a.total_tokens + b.total_tokens,
      cost_usd: (a.cost_usd ?? 0) + (b.cost_usd ?? 0),
    };
  }

  // --- Step 1: Try primary model (fast, cheap) ---
  let primaryResult: OpenRouterCallResult | null = null;
  let primaryParsed: any = null;
  let primaryFields: ReturnType<typeof mapToFields> | null = null;
  let totalUsage = zeroUsage;

  try {
    primaryResult = await callOpenRouter(apiKey, models.primary, rawText);
    totalUsage = primaryResult.usage;
    primaryParsed = parseAiResponse(primaryResult.content);
    if (primaryParsed) {
      primaryFields = mapToFields(primaryParsed);
    }
  } catch {
    // Primary model failed — will try fallback
  }

  // Check if primary result is good enough (at least 3 of 4 critical fields)
  if (primaryFields && countCriticalFields(primaryFields.fields) >= 3) {
    return {
      ...primaryFields,
      model_used: primaryResult!.model,
      fallback_used: false,
      raw_response: primaryResult!.content,
      usage: totalUsage,
    };
  }

  // --- Step 2: Fallback to stronger model ---
  if (models.primary === models.fallback) {
    if (primaryFields) {
      return {
        ...primaryFields,
        model_used: primaryResult!.model,
        fallback_used: false,
        raw_response: primaryResult!.content,
        usage: totalUsage,
      };
    }
    return null;
  }

  try {
    const fallbackResult = await callOpenRouter(apiKey, models.fallback, rawText);
    totalUsage = mergeUsage(totalUsage, fallbackResult.usage);
    const fallbackParsed = parseAiResponse(fallbackResult.content);
    if (fallbackParsed) {
      const fallbackFields = mapToFields(fallbackParsed);

      if (countCriticalFields(fallbackFields.fields) > countCriticalFields(primaryFields?.fields ?? {})) {
        return {
          ...fallbackFields,
          model_used: fallbackResult.model,
          fallback_used: true,
          raw_response: fallbackResult.content,
          usage: totalUsage,
        };
      }

      if (primaryFields) {
        for (const [key, val] of Object.entries(fallbackFields.fields)) {
          if (val != null && (primaryFields.fields as any)[key] == null) {
            (primaryFields.fields as any)[key] = val;
          }
        }
        for (const [key, conf] of Object.entries(fallbackFields.confidence)) {
          if (!primaryFields.confidence[key]) {
            primaryFields.confidence[key] = conf;
          }
        }
        return {
          ...primaryFields,
          model_used: `${primaryResult?.model ?? models.primary} + ${fallbackResult.model}`,
          fallback_used: true,
          raw_response: primaryResult?.content + '\n---FALLBACK---\n' + fallbackResult.content,
          usage: totalUsage,
        };
      }

      return {
        ...fallbackFields,
        model_used: fallbackResult.model,
        fallback_used: true,
        raw_response: fallbackResult.content,
        usage: totalUsage,
      };
    }
  } catch {
    // Fallback also failed
  }

  if (primaryFields) {
    return {
      ...primaryFields,
      model_used: primaryResult!.model,
      fallback_used: false,
      raw_response: primaryResult!.content,
      usage: totalUsage,
    };
  }

  return null;
}

/** List available models from OpenRouter (cached for 5 min) */
let modelCache: { models: any[]; fetchedAt: number } | null = null;

export async function listOpenRouterModels(): Promise<any[]> {
  if (modelCache && Date.now() - modelCache.fetchedAt < 300_000) {
    return modelCache.models;
  }

  const apiKey = getEffectiveApiKey();
  if (!apiKey) return [];

  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });

  if (!res.ok) return [];

  const data = await res.json() as any;
  const models = (data.data ?? [])
    .filter((m: any) => m.id && !m.id.includes('free'))
    .map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      pricing: m.pricing,
      context_length: m.context_length,
    }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));

  modelCache = { models, fetchedAt: Date.now() };
  return models;
}
