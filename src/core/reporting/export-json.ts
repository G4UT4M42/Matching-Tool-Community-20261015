/**
 * JSON export: authoritative full report.
 * Deterministically sorted, no secrets, reproducible from inputs + Run-ID.
 */
import type { ReportWithExtras } from './generate-report.js';

export function exportJson(report: ReportWithExtras): string {
  return JSON.stringify(report, null, 2) + '\n';
}
