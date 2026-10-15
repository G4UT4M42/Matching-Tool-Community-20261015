/**
 * Run orchestrator — manages background execution of collection runs.
 * Provides a simple in-process job execution model without message queues.
 */
import { executeRun, queueRun } from './collection-service.js';
import * as repo from './repository.js';
import type { CollectionRun } from './types.js';

/** Track currently executing runs to prevent double-execution */
const activeRuns = new Set<string>();

/**
 * Queue a run and start execution asynchronously.
 * Returns immediately with the queued run.
 * Execution happens in the background.
 */
export function startRun(portalId: string, dateStart: string, dateEnd: string): CollectionRun {
  const run = queueRun(portalId, dateStart, dateEnd);

  // Start execution asynchronously — do not block the HTTP request
  setImmediate(() => {
    executeRunInBackground(run.id).catch(err => {
      console.error(`[invoicebot] [orchestrator] Background execution failed for ${run.id}:`, err.message);
    });
  });

  return run;
}

/**
 * Execute a run in the background with guard against double execution.
 */
export async function executeRunInBackground(runId: string): Promise<void> {
  if (activeRuns.has(runId)) {
    console.log(`[invoicebot] [orchestrator] Run ${runId} already executing, skipping`);
    return;
  }

  activeRuns.add(runId);
  try {
    console.log(`[invoicebot] [orchestrator] Starting background execution: ${runId}`);
    await executeRun(runId);
    console.log(`[invoicebot] [orchestrator] Background execution complete: ${runId}`);
  } finally {
    activeRuns.delete(runId);
  }
}

/**
 * Check if a run is currently being executed.
 */
export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

/**
 * Get all currently active run IDs.
 */
export function getActiveRunIds(): string[] {
  return [...activeRuns];
}

/**
 * Handle runs left in non-terminal states after a server restart.
 *
 * Phase 1 behavior (conservative):
 * - 'running', 'downloading', 'importing' → marked 'failed' (were mid-execution, state is uncertain)
 * - 'queued' → marked 'failed' (were scheduled via setImmediate which did not survive restart)
 * - 'waiting_for_login' → left as-is (user action required, not a stale execution)
 * - terminal states ('completed', 'partial', 'failed', 'cancelled') → untouched
 *
 * The user can manually retry any failed run via the UI.
 */
export async function resumeStaleRuns(): Promise<void> {
  const { items } = repo.listRuns(undefined, 500, 0);

  const activeStates = ['queued', 'running', 'downloading', 'importing'] as const;
  const stale = items.filter(r => (activeStates as readonly string[]).includes(r.status));

  if (stale.length === 0) return;

  console.log(`[invoicebot] [orchestrator] Startup: found ${stale.length} non-terminal run(s)`);
  for (const run of stale) {
    const reason = run.status === 'queued'
      ? 'Run war in der Warteschlange als der Server heruntergefahren wurde'
      : `Run war im Status "${run.status}" als der Server heruntergefahren wurde`;

    repo.updateRunStatus(run.id, 'failed', { errorMessage: reason });
    repo.createEvent(run.id, 'warn', 'RUN_INTERRUPTED',
      `${reason}. Bitte manuell über "Retry" erneut starten.`);
    console.log(`[invoicebot] [orchestrator] Marked ${run.id} (${run.status}) as failed`);
  }
}
