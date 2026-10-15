/**
 * AI Cost Monitor — tracks token usage and costs per session.
 *
 * Features:
 * - Per-session cost tracking (live + persisted to SQLite)
 * - Optional cost limit with pause-and-ask behavior
 * - Cost history for reporting
 *
 * When the cost limit is reached:
 * - The current AI call completes (current step finishes)
 * - Further AI calls are blocked until the user approves continuation
 * - The UI shows the limit-reached state and offers a "Continue" button
 */
import { randomUUID } from 'crypto';
import { getDb } from '../storage/db.js';
import { getSetting, setSetting, deleteSetting } from '../storage/settings.js';

// Setting keys
const LIMIT_KEY = 'ai_cost_limit_usd';

// ==================== Types ====================

export interface CostSession {
  id: string;
  startedAt: string;
  endedAt: string | null;
  source: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalCostUsd: number;
  callCount: number;
  status: 'active' | 'completed' | 'limit_reached' | 'continued';
}

export interface CostEntry {
  id: number;
  sessionId: string;
  createdAt: string;
  model: string;
  tier: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  source: string;
  context: string | null;
}

export interface CostSnapshot {
  session: CostSession | null;
  limitUsd: number | null;
  limitReached: boolean;
  paused: boolean;
  todayTotalUsd: number;
  todayTotalTokens: number;
  todayCallCount: number;
}

// ==================== In-memory state ====================

let activeSession: CostSession | null = null;
let paused = false; // true when cost limit reached, waiting for user approval

// ==================== Session management ====================

/** Start a new cost tracking session */
export function startSession(source: string = 'invoicerec'): CostSession {
  // End any existing active session first
  if (activeSession) {
    endSession();
  }

  const id = `CS-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  const session: CostSession = {
    id,
    startedAt: now,
    endedAt: null,
    source,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalCostUsd: 0,
    callCount: 0,
    status: 'active',
  };

  getDb().prepare(`
    INSERT INTO ai_cost_sessions (id, started_at, source, status)
    VALUES (@id, @started_at, @source, @status)
  `).run({ id, started_at: now, source, status: 'active' });

  activeSession = session;
  paused = false;
  console.log(`[cost-monitor] Session started: ${id}`);
  return session;
}

/** End the current session */
export function endSession(): CostSession | null {
  if (!activeSession) return null;

  const now = new Date().toISOString();
  activeSession.endedAt = now;
  activeSession.status = activeSession.status === 'limit_reached' ? 'limit_reached' : 'completed';

  getDb().prepare(`
    UPDATE ai_cost_sessions SET
      ended_at = @ended_at, status = @status,
      total_tokens = @total_tokens, prompt_tokens = @prompt_tokens,
      completion_tokens = @completion_tokens, total_cost_usd = @total_cost_usd,
      call_count = @call_count
    WHERE id = @id
  `).run({
    id: activeSession.id,
    ended_at: now,
    status: activeSession.status,
    total_tokens: activeSession.totalTokens,
    prompt_tokens: activeSession.promptTokens,
    completion_tokens: activeSession.completionTokens,
    total_cost_usd: activeSession.totalCostUsd,
    call_count: activeSession.callCount,
  });

  console.log(`[cost-monitor] Session ended: ${activeSession.id} — ${activeSession.callCount} calls, ${activeSession.totalTokens} tokens, $${activeSession.totalCostUsd.toFixed(4)}`);
  const result = { ...activeSession };
  activeSession = null;
  paused = false;
  return result;
}

/** Get or auto-start the active session */
export function ensureSession(source: string = 'invoicerec'): CostSession {
  if (!activeSession) {
    return startSession(source);
  }
  return activeSession;
}

// ==================== Cost recording ====================

/**
 * Record an AI call's cost.
 * Called after each successful AI API call.
 * Returns true if the call is allowed, false if the cost limit was reached
 * (the current call already completed — this signals that FUTURE calls should pause).
 */
export function recordCost(params: {
  model: string;
  tier?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  source?: string;
  context?: string;
}): { allowed: boolean; limitReached: boolean; session: CostSession } {
  const session = ensureSession(params.source ?? 'invoicerec');

  // Record the entry
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO ai_cost_entries (session_id, created_at, model, tier, prompt_tokens, completion_tokens, total_tokens, cost_usd, source, context)
    VALUES (@session_id, @created_at, @model, @tier, @prompt_tokens, @completion_tokens, @total_tokens, @cost_usd, @source, @context)
  `).run({
    session_id: session.id,
    created_at: now,
    model: params.model,
    tier: params.tier ?? null,
    prompt_tokens: params.promptTokens,
    completion_tokens: params.completionTokens,
    total_tokens: params.totalTokens,
    cost_usd: params.costUsd,
    source: params.source ?? 'invoicerec',
    context: params.context ?? null,
  });

  // Update session totals
  session.totalTokens += params.totalTokens;
  session.promptTokens += params.promptTokens;
  session.completionTokens += params.completionTokens;
  session.totalCostUsd += params.costUsd;
  session.callCount++;

  // Persist updated totals
  getDb().prepare(`
    UPDATE ai_cost_sessions SET
      total_tokens = @total_tokens, prompt_tokens = @prompt_tokens,
      completion_tokens = @completion_tokens, total_cost_usd = @total_cost_usd,
      call_count = @call_count
    WHERE id = @id
  `).run({
    id: session.id,
    total_tokens: session.totalTokens,
    prompt_tokens: session.promptTokens,
    completion_tokens: session.completionTokens,
    total_cost_usd: session.totalCostUsd,
    call_count: session.callCount,
  });

  // Check cost limit
  const limit = getCostLimit();
  const limitReached = limit !== null && session.totalCostUsd >= limit;
  if (limitReached && !paused) {
    paused = true;
    session.status = 'limit_reached';
    getDb().prepare('UPDATE ai_cost_sessions SET status = ? WHERE id = ?').run('limit_reached', session.id);
    console.log(`[cost-monitor] Cost limit reached: $${session.totalCostUsd.toFixed(4)} >= $${limit.toFixed(4)}`);
  }

  return { allowed: !paused, limitReached, session };
}

// ==================== Cost limit ====================

/** Check if AI calls are currently paused due to cost limit */
export function isPaused(): boolean {
  return paused;
}

/**
 * Check if the next AI call is allowed.
 * If paused (cost limit reached), returns false.
 * The caller should skip the AI call and return a fallback or error.
 */
export function isCallAllowed(): boolean {
  if (!paused) return true;
  return false;
}

/** User approves continuing past the cost limit */
export function approveContinuation(): void {
  if (!paused || !activeSession) return;
  paused = false;
  activeSession.status = 'continued';
  getDb().prepare('UPDATE ai_cost_sessions SET status = ? WHERE id = ?').run('continued', activeSession.id);
  console.log(`[cost-monitor] User approved continuation past cost limit`);
}

/** Get the cost limit (USD), or null if no limit set */
export function getCostLimit(): number | null {
  const val = getSetting(LIMIT_KEY);
  if (!val) return null;
  const num = parseFloat(val);
  return isNaN(num) || num <= 0 ? null : num;
}

/** Set the cost limit (USD). Pass null/0 to disable. */
export function setCostLimit(usd: number | null): void {
  if (usd === null || usd <= 0) {
    deleteSetting(LIMIT_KEY);
  } else {
    setSetting(LIMIT_KEY, String(usd));
  }
}

// ==================== Query / snapshot ====================

/** Get a live snapshot of the current cost state */
export function getCostSnapshot(): CostSnapshot {
  const today = new Date().toISOString().slice(0, 10);
  const db = getDb();

  // Today's aggregate from all sessions
  const todayRow = db.prepare(`
    SELECT COALESCE(SUM(total_cost_usd), 0) as cost, COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(call_count), 0) as calls
    FROM ai_cost_sessions WHERE started_at >= ?
  `).get(today) as any;

  return {
    session: activeSession ? { ...activeSession } : null,
    limitUsd: getCostLimit(),
    limitReached: paused,
    paused,
    todayTotalUsd: todayRow?.cost ?? 0,
    todayTotalTokens: todayRow?.tokens ?? 0,
    todayCallCount: todayRow?.calls ?? 0,
  };
}

/** Get session history */
export function getSessionHistory(limit = 50): CostSession[] {
  const rows = getDb().prepare(
    'SELECT * FROM ai_cost_sessions ORDER BY started_at DESC LIMIT ?'
  ).all(limit) as any[];
  return rows.map(r => ({
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    source: r.source,
    totalTokens: r.total_tokens,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalCostUsd: r.total_cost_usd,
    callCount: r.call_count,
    status: r.status,
  }));
}

/** Get entries for a session */
export function getSessionEntries(sessionId: string): CostEntry[] {
  const rows = getDb().prepare(
    'SELECT * FROM ai_cost_entries WHERE session_id = ? ORDER BY created_at'
  ).all(sessionId) as any[];
  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    createdAt: r.created_at,
    model: r.model,
    tier: r.tier,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    costUsd: r.cost_usd,
    source: r.source,
    context: r.context,
  }));
}
