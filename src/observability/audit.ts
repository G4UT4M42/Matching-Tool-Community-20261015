import type { AuditEvent, AuditAction, MatchingState } from '../core/types.js';
import { auditId } from '../core/ids.js';

/** Create and append an audit event to state. Append-only: events are never edited. */
export function recordAudit(
  state: MatchingState,
  action: AuditAction,
  entity_type: AuditEvent['entity_type'],
  entity_id: string,
  opts: {
    actor_type?: 'system' | 'user';
    actor_id?: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    reason?: string;
    correlation_id?: string;
  } = {},
): AuditEvent {
  const timestamp = new Date().toISOString();
  const event: AuditEvent = {
    audit_id: auditId(timestamp, action, entity_type, entity_id, state.run_id, opts.correlation_id),
    timestamp,
    actor_type: opts.actor_type ?? 'system',
    actor_id: opts.actor_id ?? 'system',
    action,
    entity_type,
    entity_id,
    // Snapshot evidence at recording time. structuredClone(state) preserves
    // aliases, so retaining a live entity here would let a later decision
    // rewrite historical evidence and correctly fail append-only persistence.
    before: opts.before === undefined ? undefined : structuredClone(opts.before),
    after: opts.after === undefined ? undefined : structuredClone(opts.after),
    reason: opts.reason,
    run_id: state.run_id,
    correlation_id: opts.correlation_id,
  };

  state.audit_events.push(event);
  return event;
}
