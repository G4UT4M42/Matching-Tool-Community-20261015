/**
 * Custom error types for the Invoice Bot module.
 */

export class InvoiceBotError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'InvoiceBotError';
  }
}

export class PortalNotFoundError extends InvoiceBotError {
  constructor(portalId: string) {
    super(`Portal nicht gefunden: ${portalId}`, 'PORTAL_NOT_FOUND');
  }
}

export class RunNotFoundError extends InvoiceBotError {
  constructor(runId: string) {
    super(`Run nicht gefunden: ${runId}`, 'RUN_NOT_FOUND');
  }
}

export class InvalidRunStateError extends InvoiceBotError {
  constructor(runId: string, currentStatus: string, attemptedAction: string) {
    super(
      `Run ${runId} ist im Status "${currentStatus}" — "${attemptedAction}" nicht möglich`,
      'INVALID_RUN_STATE',
    );
  }
}

export class DuplicateFileError extends InvoiceBotError {
  constructor(sha256: string) {
    super(`Datei bereits archiviert (SHA256: ${sha256.slice(0, 16)}...)`, 'DUPLICATE_FILE');
  }
}

export class OpenclawConnectionError extends InvoiceBotError {
  constructor(message: string) {
    super(`OpenClaw Verbindungsfehler: ${message}`, 'OPENCLAW_CONNECTION');
  }
}

/** Browser/Chrome not reachable or CDP connection failed */
export class BrowserConnectionError extends InvoiceBotError {
  constructor(message: string) {
    super(message, 'BROWSER_CONNECTION');
  }
}

/** Portal session expired or login required mid-flow */
export class SessionExpiredError extends InvoiceBotError {
  constructor(portal: string) {
    super(`Session bei ${portal} abgelaufen — bitte erneut einloggen`, 'SESSION_EXPIRED');
  }
}

/** Portal HTML structure changed — adapter selectors no longer match */
export class PortalLayoutChangedError extends InvoiceBotError {
  constructor(portal: string, detail: string) {
    super(`Portal-Layout geändert bei ${portal}: ${detail}. Adapter muss aktualisiert werden.`, 'PORTAL_LAYOUT_CHANGED');
  }
}

/** Download of a specific invoice failed */
export class DownloadFailedError extends InvoiceBotError {
  constructor(orderId: string, reason: string) {
    super(`Download fehlgeschlagen für ${orderId}: ${reason}`, 'DOWNLOAD_FAILED');
  }
}

/** Another collection run is currently using the browser — exclusive access required */
export class ExecutorBusyError extends InvoiceBotError {
  constructor() {
    super('Browser wird bereits von einer laufenden Sammlung verwendet. Bitte warten bis der aktuelle Run abgeschlossen ist.', 'EXECUTOR_BUSY');
  }
}
