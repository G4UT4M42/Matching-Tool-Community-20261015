/**
 * Browser-Use portal adapter.
 *
 * Delegates to the Python browser-use worker via browser-use-runner.ts.
 * Implements the same PortalAdapter interface as the Amazon adapter.
 */
import type {
  PortalConfig, PortalAdapter, SessionCheckResult,
  OpenclawRunResult, PortalType,
} from '../types.js';
import { runBrowserUseWorker } from '../browser-use-runner.js';

export class BrowserUseAdapter implements PortalAdapter {
  readonly portalType: PortalType = 'browser_use';

  async checkSession(portal: PortalConfig): Promise<SessionCheckResult> {
    const result: SessionCheckResult = {
      browserReachable: true, // Python manages its own browser
      portalReachable: false,
      loggedIn: false,
      invoiceAreaAccessible: false,
      message: '',
      details: [],
    };

    try {
      // Session check doesn't persist events, use a non-FK runId
      // (events will fail FK check, but worker handles errors gracefully)
      const fakeRunId = `CHK-${Date.now()}`; // Not in invoice_bot_runs — events won't persist
      const workerResult = await runBrowserUseWorker(portal, fakeRunId, {
        mode: 'check_session',
        headless: false, // visible for session check
      });

      if (workerResult.status === 'completed') {
        result.portalReachable = true;
        result.loggedIn = true;
        result.invoiceAreaAccessible = true;
        result.message = 'Portal erreichbar und eingeloggt';
      } else if (workerResult.status === 'waiting_for_login') {
        result.portalReachable = true;
        result.message = workerResult.errorMessage ?? 'Login erforderlich';
      } else {
        result.message = workerResult.errorMessage ?? 'Session-Check fehlgeschlagen';
      }
      result.details.push(result.message);
    } catch (err: any) {
      result.message = `Browser-Use Fehler: ${err.message}`;
      result.details.push(result.message);
    }

    return result;
  }

  async collectInvoices(
    portal: PortalConfig,
    dateRange: { start: string; end: string },
    downloadDir: string,
    onProgress?: (msg: string) => void,
  ): Promise<OpenclawRunResult> {
    // Generate a temporary run ID for the adapter call
    // The real run ID is managed by the collection service
    const runId = `BU-${Date.now()}`;

    try {
      const result = await runBrowserUseWorker(portal, runId, {
        mode: 'collect_invoices',
        dateRange,
        headless: false, // visible for debugging
        onEvent: (event) => {
          // Relay progress messages to the collection service
          if (event.type === 'run.progress' || event.type === 'browser.message') {
            onProgress?.((event.payload as any).message ?? (event.payload as any).step);
          }
        },
      });

      return result;
    } catch (err: any) {
      return {
        status: 'failed',
        files: [],
        errorMessage: `Browser-Use Fehler: ${err.message}`,
      };
    }
  }
}
