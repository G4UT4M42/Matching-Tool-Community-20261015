import { createGeorgePaymentController, type GeorgePaymentController } from './browser/george-adapter.js';
import type { AutomationPhase, ReleaseConfirmation } from './browser/types.js';
import {
  PaymentRepository,
  type PaymentAutomationReleaseSafety,
  type PaymentAutomationRun,
} from './repository.js';
import { FIXED_DEBTOR } from './types.js';

export interface PaymentAutomationStatus {
  run_id: string;
  batch_id: string;
  phase: AutomationPhase;
  progress: { current: number; total: number };
  updated_at: string;
  available_action: 'none' | 'request_release' | 'reconcile_release_status';
  evidence: {
    debtor_iban?: string;
    item_count?: number;
    control_sum_minor?: number;
    xml_sha256?: string;
    package_reference?: string;
    package_status?: 'prepared' | 'waiting_release_2fa' | 'released' | 'rejected' | 'unknown';
    url_class?: string;
  };
  error: { code: string; message: string } | null;
}

export class PaymentAutomationServiceError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = 'PaymentAutomationServiceError';
  }
}

const PHASE_PROGRESS: Record<AutomationPhase, number> = {
  queued: 0,
  connecting_browser: 1,
  waiting_login_2fa: 1,
  uploading: 2,
  upload_attempted: 2,
  verifying_import: 3,
  prepared: 4,
  requesting_release: 4,
  release_click_claimed: 4,
  waiting_release_2fa: 5,
  verifying_release: 5,
  released: 6,
  failed: 6,
  unknown: 6,
};

const SAFE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  EXECUTOR_BUSY: 'Die sichere Browsersteuerung ist derzeit belegt.',
  WAITING_LOGIN_2FA: 'Die George-Anmeldung wartet auf Ihre Freigabe in der Banking-App.',
  DATA_IMPORT_ACTIVATION_REQUIRED: 'Der George-Datenimport muss zuerst manuell aktiviert werden.',
  SOURCE_ACCOUNT_MISMATCH: 'Das in George gelesene Schuldnerkonto stimmt nicht überein.',
  GEORGE_PACKAGE_MISMATCH: 'Das gelesene George-Paket stimmt nicht mit dem exportierten Stapel überein.',
  GEORGE_IMPORT_WARNING: 'George meldet eine Warnung für das importierte Paket.',
  PORTAL_LAYOUT_CHANGED: 'Die George-Oberfläche konnte nicht sicher erkannt werden.',
  RELEASE_STATUS_UNKNOWN: 'Der endgültige Freigabestatus ist unbekannt und muss geprüft werden.',
  CORRUPT_AUTOMATION_RUN: 'Der gespeicherte Automationslauf ist beschädigt und wurde gesperrt.',
});

function codeOf(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown };
  if (typeof value?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(value.code)) return value.code;
  if (typeof value?.message === 'string') {
    const code = value.message.split(':', 1)[0].trim();
    if (/^[A-Z0-9_]{1,100}$/.test(code)) return code;
  }
  return 'PAYMENT_AUTOMATION_BACKGROUND_FAILED';
}

function serviceError(code: string): PaymentAutomationServiceError {
  const status = code === 'PAYMENT_BATCH_NOT_FOUND' || code === 'PAYMENT_AUTOMATION_RUN_NOT_FOUND' ? 404
    : ['EXECUTOR_BUSY', 'PAYMENT_RELEASE_IN_PROGRESS'].includes(code) ? 423
      : ['BROWSER_CONNECTION', 'DATA_IMPORT_ACTIVATION_REQUIRED'].includes(code) ? 503
        : 409;
  const message = SAFE_ERROR_MESSAGES[code]
    ?? (status === 404 ? 'Zahlungsstapel oder Automationslauf nicht gefunden.'
      : status === 423 ? 'Die Zahlungsautomation ist derzeit gesperrt.'
        : status === 503 ? 'Die sichere Zahlungsautomation ist derzeit nicht verfügbar.'
          : 'Die Zahlungsautomation ist in diesem Zustand nicht zulässig.');
  return new PaymentAutomationServiceError(code, status, message);
}

function packageStatus(run: PaymentAutomationRun): PaymentAutomationStatus['evidence']['package_status'] | undefined {
  if (run.phase === 'released') return 'released';
  if (['waiting_release_2fa', 'verifying_release', 'release_click_claimed'].includes(run.phase)) return 'waiting_release_2fa';
  if (run.phase === 'prepared' || run.phase === 'requesting_release') return 'prepared';
  if (run.phase === 'unknown') return 'unknown';
  if (run.phase === 'failed' && run.errorCode === 'GEORGE_RELEASE_REJECTED') return 'rejected';
  return undefined;
}

function hasReleaseAuthority(safety: PaymentAutomationReleaseSafety): boolean {
  return safety.hasRequestToken || safety.hasClickClaim || safety.hasClick;
}

function hasFailedReleaseAuthority(
  run: PaymentAutomationRun,
  safety: PaymentAutomationReleaseSafety,
): boolean {
  return hasReleaseAuthority(safety)
    || (safety.hasPersistedIntent && run.errorCode !== 'GEORGE_RELEASE_REJECTED');
}

function availableAction(
  run: PaymentAutomationRun,
  batchStatus: string,
  safety: PaymentAutomationReleaseSafety,
): PaymentAutomationStatus['available_action'] {
  if (batchStatus !== 'prepared') return 'none';
  const releaseAuthority = hasReleaseAuthority(safety);
  if (run.phase === 'unknown') return releaseAuthority ? 'reconcile_release_status' : 'request_release';
  if (run.phase === 'prepared') return 'request_release';
  if (run.phase === 'failed' && !hasFailedReleaseAuthority(run, safety)) return 'request_release';
  return 'none';
}

class SafePaymentAutomationService {
  private readonly controller: GeorgePaymentController;
  private readonly repository: PaymentRepository;
  private readonly releaseRequests = new Set<string>();
  private readonly releaseLoops = new Set<string>();
  private readonly importLoops = new Set<string>();

  constructor() {
    this.controller = createGeorgePaymentController();
    this.repository = new PaymentRepository();
  }

  queueImport(batchId: string): PaymentAutomationStatus {
    const batch = this.repository.getBatch(batchId);
    if (!batch) throw serviceError('PAYMENT_BATCH_NOT_FOUND');
    if (batch.status !== 'exported' || !batch.xmlSha256 || !batch.messageId) throw serviceError('PAYMENT_BATCH_NOT_EXPORTED');
    const artifact = this.repository.getExportArtifactData(batchId);
    if (!artifact?.length) throw serviceError('PAYMENT_EXPORT_ARTIFACT_MISSING');
    const current = this.repository.getLatestAutomationRun(batchId);
    if (current && !['failed', 'released'].includes(current.phase)) throw serviceError('PAYMENT_AUTOMATION_RUN_ACTIVE');

    const completion = this.controller.queueImport(batchId);
    const run = this.repository.getLatestAutomationRun(batchId);
    if (!run) {
      void completion.catch(() => undefined);
      throw serviceError('PAYMENT_AUTOMATION_RUN_NOT_FOUND');
    }
    this.startImportLoop(batchId, completion);
    return this.publicStatus(run);
  }

  getStatus(batchId: string): PaymentAutomationStatus | null {
    const run = this.repository.getLatestAutomationRun(batchId);
    return run ? this.publicStatus(run) : null;
  }

  requestRelease(batchId: string, confirmation: ReleaseConfirmation): PaymentAutomationStatus {
    if (this.releaseRequests.has(batchId)) throw serviceError('PAYMENT_RELEASE_IN_PROGRESS');
    const batch = this.repository.getBatch(batchId);
    const run = this.repository.getLatestAutomationRun(batchId);
    const releaseSafety = run ? this.repository.getAutomationReleaseSafety(run.runId) : null;
    if (run?.phase === 'failed' && releaseSafety && hasFailedReleaseAuthority(run, releaseSafety)) {
      throw serviceError('PAYMENT_RELEASE_IN_PROGRESS');
    }
    const recoverablePhase = !!run && ['prepared', 'requesting_release', 'unknown', 'failed'].includes(run.phase);
    if (!batch || !run || !releaseSafety || batch.status !== 'prepared' || !recoverablePhase) {
      throw serviceError('PAYMENT_BATCH_NOT_PREPARED');
    }
    if (confirmation.debtorIban !== FIXED_DEBTOR.iban
      || confirmation.debtorIban !== batch.debtorIban
      || confirmation.itemCount !== batch.itemCount
      || confirmation.controlSumMinor !== batch.controlSumMinor
      || !batch.xmlSha256
      || confirmation.xmlSha256 !== batch.xmlSha256) {
      throw serviceError('RELEASE_CONFIRMATION_MISMATCH');
    }
    if (run.phase === 'requesting_release') {
      const persisted = releaseSafety.confirmation;
      if (hasReleaseAuthority(releaseSafety)) throw serviceError('PAYMENT_RELEASE_IN_PROGRESS');
      if (!persisted || persisted.revision !== batch.revision
        || persisted.debtorIban !== confirmation.debtorIban
        || persisted.itemCount !== confirmation.itemCount
        || persisted.controlSumMinor !== confirmation.controlSumMinor
        || persisted.xmlSha256 !== confirmation.xmlSha256) {
        throw serviceError('RELEASE_CONFIRMATION_MISMATCH');
      }
      if (this.releaseLoops.has(batchId)) return this.publicStatus(run);
    }

    this.releaseRequests.add(batchId);
    const completion = this.controller.requestRelease(batchId, confirmation);
    this.startReleaseLoop(batchId, confirmation, completion);
    const accepted = this.repository.getLatestAutomationRun(batchId);
    if (!accepted) throw serviceError('PAYMENT_AUTOMATION_RUN_NOT_FOUND');
    return this.publicStatus(accepted);
  }

  async resumeNonFinalRuns(): Promise<void> {
    await this.controller.resumeNonFinalRuns();
    for (const run of this.repository.listNonFinalAutomationRuns()) {
      if (['queued', 'connecting_browser', 'waiting_login_2fa', 'uploading', 'upload_attempted', 'verifying_import'].includes(run.phase)) {
        this.startImportLoop(run.batchId, Promise.resolve(run));
      }
    }
  }

  private startReleaseLoop(
    batchId: string,
    confirmation: ReleaseConfirmation,
    initial: Promise<PaymentAutomationRun>,
  ): void {
    if (this.releaseLoops.has(batchId)) return;
    this.releaseLoops.add(batchId);
    void this.runReleaseLoop(batchId, confirmation, initial).finally(() => {
      this.releaseRequests.delete(batchId);
      this.releaseLoops.delete(batchId);
    });
  }

  private async runReleaseLoop(
    batchId: string,
    confirmation: ReleaseConfirmation,
    initial: Promise<PaymentAutomationRun>,
  ): Promise<void> {
    let pending: Promise<unknown> = initial;
    let attempt = 0;
    try {
      while (true) {
        await pending;
        this.releaseRequests.delete(batchId);
        const run = this.repository.getLatestAutomationRun(batchId);
        if (!run || run.phase !== 'requesting_release') return;
        const safety = this.repository.getAutomationReleaseSafety(run.runId);
        if (hasReleaseAuthority(safety)) return;
        const delay = Math.min(2_000 * (2 ** Math.min(attempt, 3)), 15_000);
        attempt += 1;
        await new Promise<void>(resolve => setTimeout(resolve, delay));
        const current = this.repository.getLatestAutomationRun(batchId);
        if (!current || current.runId !== run.runId || current.phase !== 'requesting_release') return;
        const currentSafety = this.repository.getAutomationReleaseSafety(current.runId);
        if (hasReleaseAuthority(currentSafety)) return;
        this.releaseRequests.add(batchId);
        pending = this.controller.requestRelease(batchId, confirmation);
      }
    } catch (error) {
      const run = this.repository.getLatestAutomationRun(batchId);
      if (run) {
        try { this.repository.recordAutomationBackgroundFailure(run.runId, codeOf(error)); } catch { /* keep rejection contained */ }
      }
    }
  }

  private startImportLoop(batchId: string, initial: Promise<PaymentAutomationRun>): void {
    if (this.importLoops.has(batchId)) return;
    this.importLoops.add(batchId);
    void this.runImportLoop(batchId, initial).then(
      () => this.importLoops.delete(batchId),
      () => this.importLoops.delete(batchId),
    );
  }

  private async runImportLoop(batchId: string, initial: Promise<PaymentAutomationRun>): Promise<void> {
    let pending: Promise<unknown> = initial;
    let attempt = 0;
    try {
      while (true) {
        await pending;
        const run = this.repository.getLatestAutomationRun(batchId);
        if (!run || !['queued', 'connecting_browser', 'waiting_login_2fa'].includes(run.phase)) return;
        const delay = Math.min(2_000 * (2 ** Math.min(attempt, 3)), 15_000);
        attempt += 1;
        await new Promise<void>(resolve => setTimeout(resolve, delay));
        pending = this.controller.resumeNonFinalRuns();
      }
    } catch (error) {
      const run = this.repository.getLatestAutomationRun(batchId);
      if (run) {
        try { this.repository.recordAutomationBackgroundFailure(run.runId, codeOf(error)); } catch { /* keep rejection contained */ }
      }
    }
  }

  private publicStatus(run: PaymentAutomationRun): PaymentAutomationStatus {
    const batch = this.repository.getBatch(run.batchId);
    if (!batch) throw serviceError('PAYMENT_BATCH_NOT_FOUND');
    const safety = this.repository.getAutomationReleaseSafety(run.runId);
    const action = availableAction(run, batch.status, safety);
    const verifiedPhase = ['prepared', 'requesting_release', 'release_click_claimed', 'waiting_release_2fa', 'verifying_release', 'released'].includes(run.phase)
      || (run.phase === 'failed' && run.errorCode === 'GEORGE_RELEASE_REJECTED')
      || (run.phase === 'unknown' && batch.status === 'prepared' && (run.releaseClickClaimedAt !== null || run.releaseClickedAt !== null));
    const hasVerifiedPackage = run.packageReference !== null && (verifiedPhase || action !== 'none');
    const status = packageStatus(run);
    return {
      run_id: run.runId,
      batch_id: run.batchId,
      phase: run.phase,
      progress: { current: PHASE_PROGRESS[run.phase], total: 6 },
      updated_at: run.updatedAt,
      available_action: action,
      evidence: {
        xml_sha256: batch.xmlSha256 ?? undefined,
        ...(hasVerifiedPackage ? {
          debtor_iban: batch.debtorIban,
          item_count: batch.itemCount,
          control_sum_minor: batch.controlSumMinor,
          package_reference: run.packageReference!,
          ...(status ? { package_status: status } : {}),
        } : {}),
        ...(run.lastVerifiedUrlClass ? { url_class: run.lastVerifiedUrlClass } : {}),
      },
      error: run.errorCode ? {
        code: run.errorCode,
        message: SAFE_ERROR_MESSAGES[run.errorCode] ?? 'Die Automation wurde sicher angehalten. Bitte Status und Paket prüfen.',
      } : null,
    };
  }
}

let defaultService: SafePaymentAutomationService | null = null;

/** Shared parameterless production capability; no authority is caller-injectable. */
export function getPaymentAutomationService(): SafePaymentAutomationService {
  defaultService ??= new SafePaymentAutomationService();
  return defaultService;
}
