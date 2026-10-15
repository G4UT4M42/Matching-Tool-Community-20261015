import pino from 'pino';
import { generateRunId, generateCorrelationId } from '../core/ids.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type EventType =
  | 'RUN_STARTED' | 'RUN_FINISHED'
  | 'INPUT_FILE_DISCOVERED' | 'INPUT_FILE_HASHED'
  | 'CONTRACT_VALIDATION_PASSED' | 'CONTRACT_VALIDATION_FAILED'
  | 'NORMALIZATION_STARTED' | 'NORMALIZATION_FINISHED'
  | 'MATCHING_STARTED' | 'RULE_APPLIED' | 'MATCH_CONFLICT_DETECTED' | 'MATCHING_FINISHED'
  | 'REPORT_GENERATION_STARTED' | 'REPORT_GENERATION_FINISHED'
  | 'AUDIT_EVENT_RECORDED';

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
});

export interface LogContext {
  run_id: string;
  correlation_id: string;
}

export function createLogContext(): LogContext {
  return {
    run_id: generateRunId(),
    correlation_id: generateCorrelationId(),
  };
}

export function log(
  ctx: LogContext,
  level: LogLevel,
  event_type: EventType,
  component: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    run_id: ctx.run_id,
    correlation_id: ctx.correlation_id,
    event_type,
    component,
    ...extra,
  };

  pinoLogger[level](entry, message);
}
