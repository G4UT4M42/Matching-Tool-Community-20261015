import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../storage/db.js';
import { FIXED_DEBTOR, type PaymentCandidateInput, type PaymentDraftInput, type PaymentValidationIssue } from './types.js';
import type { AutomationPhase, ObservedPackage, PackageIdentity } from './browser/types.js';
import { isSepaIban, isValidIban, normalizeIban, validatePaymentDraft } from './validation.js';

export type PaymentBatchStatus = 'draft' | 'reviewed' | 'exported' | 'prepared' | 'released' | 'cancelled' | 'failed';

export type PaymentCandidateWriteInput = Omit<PaymentCandidateInput, 'currencyCode'> & {
  currencyCode: string | null;
};

export interface PaymentCandidate extends PaymentCandidateWriteInput {
  candidateId: string;
  validationErrors: PaymentValidationIssue[];
  createdAt: string;
  updatedAt: string;
}

export interface PaymentBatchItem {
  itemId: string;
  batchId: string;
  candidateId: string;
  documentId: string;
  scanId: string;
  creditorName: string | null;
  creditorIban: string | null;
  amountMinor: number | null;
  currencyCode: string | null;
  remittanceInformation: string | null;
  structuredCreditorReference: string | null;
  requestedExecutionDate: string | null;
  invoiceNumber: string | null;
  dueDate: string | null;
  status: PaymentBatchStatus;
  active: boolean;
}

export interface PaymentBatch {
  batchId: string;
  revision: number;
  status: PaymentBatchStatus;
  debtorAccountLabel: string;
  debtorAccountHolder: string;
  debtorIban: string;
  currencyCode: string;
  itemCount: number;
  controlSumMinor: number;
  requestedExecutionDate: string | null;
  reviewedAt: string | null;
  exportedAt: string | null;
  exportArtifactPath: string | null;
  xmlSha256: string | null;
  messageId: string | null;
  georgePackageReference: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  items: PaymentBatchItem[];
}

export interface PaymentStatusEvent {
  eventId: string;
  batchId: string;
  actor: string;
  occurredAt: string;
  previousStatus: PaymentBatchStatus | null;
  newStatus: PaymentBatchStatus;
  reason: string | null;
  georgeEvidence: Record<string, unknown> | null;
  itemId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface PaymentSelectionRepositoryResult {
  accepted: PaymentCandidate[];
  rejected: Array<{ document_id: string; reason_code: string }>;
  batch: PaymentBatch | null;
}


export interface AtomicExportArtifact {
  xml: Buffer;
  sha256: string;
  messageId: string;
  transactionCount: number;
  controlSumMinor: number;
}

export interface AtomicExportResult {
  batch: PaymentBatch;
  artifact: AtomicExportArtifact;
}

export interface PaymentAutomationRun {
  runId: string;
  batchId: string;
  phase: AutomationPhase;
  importFilename: string;
  uploadAttemptedAt: string | null;
  releaseClickClaimedAt: string | null;
  releaseClickedAt: string | null;
  releaseRetryClaimedAt: string | null;
  releaseRetryClickedAt: string | null;
  releaseRetryCount: number;
  packageReference: string | null;
  lastVerifiedUrlClass: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentAutomationReleaseConfirmationSnapshot {
  revision: number;
  debtorIban: string;
  itemCount: number;
  controlSumMinor: number;
  xmlSha256: string;
  recovery: 'none' | 'stable_prepared';
}

export interface PaymentAutomationReleaseSafety {
  hasRequestToken: boolean;
  hasClickClaim: boolean;
  hasClick: boolean;
  hasPersistedIntent: boolean;
  confirmation: PaymentAutomationReleaseConfirmationSnapshot | null;
}

type CandidateRow = Record<string, unknown>;
type BatchRow = Record<string, unknown>;
type ItemRow = Record<string, unknown>;
type EventRow = Record<string, unknown>;

const ALLOWED_TRANSITIONS: Record<PaymentBatchStatus, ReadonlySet<PaymentBatchStatus>> = {
  draft: new Set(['reviewed', 'cancelled', 'failed']),
  reviewed: new Set(['exported', 'cancelled', 'failed']),
  exported: new Set(['prepared', 'cancelled', 'failed']),
  prepared: new Set(['released', 'failed']),
  released: new Set(),
  cancelled: new Set(),
  failed: new Set(['cancelled']),
};

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function assertSafeMinor(value: number | null, errorCode = 'PAYMENT_AMOUNT_MINOR_INVALID'): void {
  if (value !== null && !Number.isSafeInteger(value)) {
    throw new Error(errorCode);
  }
}

function assertSafeInteger(value: number, errorCode: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(errorCode);
  }
}

function assertExecutionDate(value: string | null | undefined): void {
  if (value === undefined || value === null) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('PAYMENT_EXECUTION_DATE_INVALID');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('PAYMENT_EXECUTION_DATE_INVALID');
  }
}

const EXPECTED_SELECTION_ERRORS = new Set([
  'PAYMENT_DOCUMENT_NOT_FOUND',
  'PAYMENT_SCAN_NOT_FOUND',
  'PAYMENT_FIELDS_NOT_FOUND',
  'SCAN_NOT_CONFIRMED',
  'PAYMENT_CANDIDATE_LOCKED',
]);

function codeFromError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(':', 1)[0].trim();
}

function candidateFromRow(row: CandidateRow): PaymentCandidate {
  return {
    candidateId: String(row.candidate_id),
    documentId: String(row.document_id),
    scanId: String(row.scan_id),
    creditorName: row.creditor_name == null ? null : String(row.creditor_name),
    creditorIban: row.creditor_iban == null ? null : String(row.creditor_iban),
    amountMinor: row.amount_minor == null ? null : Number(row.amount_minor),
    currencyCode: row.currency_code == null ? null : String(row.currency_code),
    remittanceInformation: row.remittance_information == null ? null : String(row.remittance_information),
    structuredCreditorReference: row.structured_creditor_reference == null ? null : String(row.structured_creditor_reference),
    requestedExecutionDate: row.requested_execution_date == null ? null : String(row.requested_execution_date),
    invoiceNumber: row.invoice_number == null ? null : String(row.invoice_number),
    dueDate: row.due_date == null ? null : String(row.due_date),
    classification: String(row.classification) as PaymentCandidateInput['classification'],
    reasonCode: row.reason_code == null ? null : String(row.reason_code),
    sourceMeta: parseJson<Record<string, unknown>>(row.source_meta_json),
    validationErrors: parseJson<PaymentValidationIssue[]>(row.validation_errors_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function automationRunFromRow(row: Record<string, unknown>): PaymentAutomationRun {
  const phase = String(row.phase);
  const allowed: AutomationPhase[] = [
    'queued', 'connecting_browser', 'waiting_login_2fa', 'uploading', 'upload_attempted',
    'verifying_import', 'prepared', 'requesting_release', 'release_click_claimed',
    'waiting_release_2fa', 'verifying_release', 'released', 'failed', 'unknown',
  ];
  if (!allowed.includes(phase as AutomationPhase)) throw new Error('PAYMENT_AUTOMATION_STATE_CORRUPT');
  const importFilename = String(row.import_filename ?? '');
  if (!/^(?=.{6,200}$)[-A-Za-z0-9_.]+\.xml$/.test(importFilename)) throw new Error('PAYMENT_AUTOMATION_STATE_CORRUPT');
  const packageReference = row.package_reference == null ? null : String(row.package_reference);
  if (packageReference !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(packageReference)) {
    throw new Error('PAYMENT_AUTOMATION_STATE_CORRUPT');
  }
  const corruptQuarantine = row.error_code === 'CORRUPT_AUTOMATION_RUN'
    && (phase === 'failed' || phase === 'unknown');
  try {
    const expected = corruptQuarantine ? null : parseJson<PackageIdentity>(row.expected_json);
    if (!corruptQuarantine && (!expected
      || !exactKeys(expected, ['artifactSha256', 'messageId', 'importFilename', 'expectedAccount', 'itemCount', 'controlSumMinor'])
      || expected.importFilename !== importFilename || typeof expected.messageId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(expected.messageId)
      || !/^[a-f0-9]{64}$/.test(expected.artifactSha256)
      || !Number.isSafeInteger(expected.itemCount) || expected.itemCount < 1
      || !Number.isSafeInteger(expected.controlSumMinor) || expected.controlSumMinor < 1
      || !validExpectedAccount(expected.expectedAccount))) throw new Error('shape');
    if (!corruptQuarantine && row.observed_json != null) {
      const observed = parseJson<ObservedPackage>(row.observed_json);
      if (!validObserved(observed) || (packageReference !== null && observed.reference !== packageReference)) throw new Error('shape');
    }
  } catch {
    throw new Error('PAYMENT_AUTOMATION_STATE_CORRUPT');
  }
  return {
    runId: String(row.run_id).slice(0, 200),
    batchId: String(row.batch_id).slice(0, 200),
    phase: phase as AutomationPhase,
    importFilename,
    uploadAttemptedAt: row.upload_attempted_at == null ? null : String(row.upload_attempted_at),
    releaseClickClaimedAt: row.release_click_claimed_at == null ? null : String(row.release_click_claimed_at),
    releaseClickedAt: row.release_clicked_at == null ? null : String(row.release_clicked_at),
    releaseRetryClaimedAt: row.release_retry_claimed_at == null ? null : String(row.release_retry_claimed_at),
    releaseRetryClickedAt: row.release_retry_clicked_at == null ? null : String(row.release_retry_clicked_at),
    releaseRetryCount: Number(row.release_retry_count ?? 0),
    packageReference,
    lastVerifiedUrlClass: row.last_verified_url_class == null ? null : String(row.last_verified_url_class).slice(0, 80),
    errorCode: row.error_code == null ? null : String(row.error_code).slice(0, 100),
    errorMessage: corruptQuarantine ? null : row.error_message == null ? null : String(row.error_message).slice(0, 500),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function exactKeys(value: object, keys: string[]): boolean {
  return Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validExpectedAccount(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !exactKeys(value, ['accountLabel', 'accountHolder', 'iban', 'currencyCode'])) return false;
  const account = value as Record<string, unknown>;
  return account.accountLabel === FIXED_DEBTOR.accountLabel && account.accountHolder === FIXED_DEBTOR.accountHolder
    && account.iban === FIXED_DEBTOR.iban && account.currencyCode === 'EUR';
}

function validObserved(value: unknown): value is ObservedPackage {
  if (!value || typeof value !== 'object'
    || !exactKeys(value, ['reference', 'importFilename', 'account', 'itemCount', 'controlSumMinor', 'messageId', 'warnings', 'status'])) return false;
  const observed = value as unknown as Record<string, unknown>;
  const account = observed.account;
  const accountLabel = (account as Record<string, unknown> | null)?.accountLabel;
  const iban = typeof (account as Record<string, unknown> | null)?.iban === 'string'
    ? normalizeIban((account as Record<string, unknown>).iban as string) : '';
  return typeof observed.reference === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(observed.reference)
    && typeof observed.importFilename === 'string' && /^(?=.{6,200}$)[-A-Za-z0-9_.]+\.xml$/.test(observed.importFilename)
    && typeof observed.messageId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(observed.messageId)
    && Number.isSafeInteger(observed.itemCount) && Number(observed.itemCount) > 0
    && Number.isSafeInteger(observed.controlSumMinor) && Number(observed.controlSumMinor) > 0
    && Array.isArray(observed.warnings) && observed.warnings.length <= 20
    && observed.warnings.every(warning => typeof warning === 'string' && warning.length > 0 && warning.length <= 200 && warning.trim() === warning)
    && ['prepared', 'waiting_release_2fa', 'released', 'rejected', 'unknown'].includes(String(observed.status))
    && !!account && typeof account === 'object' && exactKeys(account, ['accountLabel', 'iban'])
    && accountLabel === FIXED_DEBTOR.accountLabel
    && iban.length <= 34 && isValidIban(iban) && isSepaIban(iban);
}

function itemFromRow(row: ItemRow): PaymentBatchItem {
  return {
    itemId: String(row.item_id),
    batchId: String(row.batch_id),
    candidateId: String(row.candidate_id),
    documentId: String(row.document_id),
    scanId: String(row.scan_id),
    creditorName: row.creditor_name == null ? null : String(row.creditor_name),
    creditorIban: row.creditor_iban == null ? null : String(row.creditor_iban),
    amountMinor: row.amount_minor == null ? null : Number(row.amount_minor),
    currencyCode: row.currency_code == null ? null : String(row.currency_code),
    remittanceInformation: row.remittance_information == null ? null : String(row.remittance_information),
    structuredCreditorReference: row.structured_creditor_reference == null ? null : String(row.structured_creditor_reference),
    requestedExecutionDate: row.requested_execution_date == null ? null : String(row.requested_execution_date),
    invoiceNumber: row.invoice_number == null ? null : String(row.invoice_number),
    dueDate: row.due_date == null ? null : String(row.due_date),
    status: String(row.item_status) as PaymentBatchStatus,
    active: Number(row.active) === 1,
  };
}

export class PaymentRepository {
  constructor(
    private readonly db: Database.Database = getDb(),
    private readonly clock: () => Date = () => new Date(),
    private readonly idFactory: () => string = () => randomUUID(),
  ) {}

  upsertCandidate(input: PaymentCandidateWriteInput): PaymentCandidate {
    assertSafeMinor(input.amountMinor);
    const canonicalInput = {
      ...input,
      creditorIban: input.creditorIban == null ? null : normalizeIban(input.creditorIban),
    };
    const now = this.clock().toISOString();
    const validationInput: PaymentDraftInput = {
      creditorName: canonicalInput.creditorName,
      creditorIban: canonicalInput.creditorIban,
      amountMinor: canonicalInput.amountMinor,
      currencyCode: canonicalInput.currencyCode,
      remittanceInformation: canonicalInput.remittanceInformation,
      structuredCreditorReference: canonicalInput.structuredCreditorReference,
    };
    const validationErrors = validatePaymentDraft(validationInput);
    const candidateId = `PAYC-${this.idFactory()}`;
    this.db.prepare(`
      INSERT INTO invoice_payment_candidates (
        candidate_id, document_id, scan_id, creditor_name, creditor_iban, amount_minor,
        currency_code, remittance_information, structured_creditor_reference,
        requested_execution_date, invoice_number, due_date, classification, reason_code,
        source_meta_json, validation_errors_json, created_at, updated_at
      ) VALUES (
        @candidateId, @documentId, @scanId, @creditorName, @creditorIban, @amountMinor,
        @currencyCode, @remittanceInformation, @structuredCreditorReference,
        @requestedExecutionDate, @invoiceNumber, @dueDate, @classification, @reasonCode,
        @sourceMetaJson, @validationErrorsJson, @createdAt, @updatedAt
      )
      ON CONFLICT(document_id) DO UPDATE SET
        scan_id = excluded.scan_id,
        creditor_name = excluded.creditor_name,
        creditor_iban = excluded.creditor_iban,
        amount_minor = excluded.amount_minor,
        currency_code = excluded.currency_code,
        remittance_information = excluded.remittance_information,
        structured_creditor_reference = excluded.structured_creditor_reference,
        requested_execution_date = excluded.requested_execution_date,
        invoice_number = excluded.invoice_number,
        due_date = excluded.due_date,
        classification = excluded.classification,
        reason_code = excluded.reason_code,
        source_meta_json = excluded.source_meta_json,
        validation_errors_json = excluded.validation_errors_json,
        updated_at = excluded.updated_at
    `).run({
      ...canonicalInput,
      structuredCreditorReference: canonicalInput.structuredCreditorReference ?? null,
      invoiceNumber: canonicalInput.invoiceNumber ?? null,
      dueDate: canonicalInput.dueDate ?? null,
      sourceMetaJson: JSON.stringify(canonicalInput.sourceMeta),
      validationErrorsJson: JSON.stringify(validationErrors),
      candidateId,
      createdAt: now,
      updatedAt: now,
    });
    return this.getCandidateByDocumentId(input.documentId)!;
  }

  replaceCandidateForScan(input: PaymentCandidateWriteInput): PaymentCandidate {
    const replace = this.db.transaction(() => this.replaceCandidateForScanInTransaction(input));
    return replace();
  }

  private replaceCandidateForScanInTransaction(input: PaymentCandidateWriteInput): PaymentCandidate {
      const now = this.clock().toISOString();
      const activeBindings = this.db.prepare(`
        SELECT DISTINCT b.batch_id, b.status
        FROM payment_batches b
        JOIN payment_batch_items i ON i.batch_id = b.batch_id
        JOIN invoice_payment_candidates c ON c.candidate_id = i.candidate_id
        WHERE c.scan_id = ? AND c.document_id <> ? AND i.active = 1
      `).all(input.scanId, input.documentId) as Array<{
        batch_id: string;
        status: PaymentBatchStatus;
      }>;
      if (activeBindings.some(binding => ['exported', 'prepared', 'released'].includes(binding.status))) {
        throw new Error('PAYMENT_CANDIDATE_LOCKED');
      }

      for (const binding of activeBindings) {
        if (binding.status !== 'draft' && binding.status !== 'reviewed') continue;
        this.db.prepare(`
          UPDATE payment_batches SET
            status = 'failed', error_code = 'STALE_DOCUMENT_BINDING',
            error_message = 'Die Dokumentbindung eines Zahlungskandidaten ist nicht mehr aktuell.',
            updated_at = ?, revision = revision + 1
          WHERE batch_id = ?
        `).run(now, binding.batch_id);
        this.db.prepare(`
          UPDATE payment_batch_items SET item_status = 'failed', active = 1, updated_at = ?
          WHERE batch_id = ?
        `).run(now, binding.batch_id);
        this.insertEvent(
          binding.batch_id,
          binding.status,
          'failed',
          'payment-candidate-refresh',
          'STALE_DOCUMENT_BINDING',
          null,
          now,
        );
      }

      const staleRows = this.db.prepare(`
        SELECT candidate_id, validation_errors_json
        FROM invoice_payment_candidates
        WHERE scan_id = ? AND document_id <> ?
      `).all(input.scanId, input.documentId) as Array<{
        candidate_id: string;
        validation_errors_json: string;
      }>;
      const markStale = this.db.prepare(`
        UPDATE invoice_payment_candidates SET
          classification = 'unclear', reason_code = 'STALE_DOCUMENT_BINDING',
          validation_errors_json = ?, updated_at = ?
        WHERE candidate_id = ?
      `);
      for (const row of staleRows) {
        const validationErrors = parseJson<PaymentValidationIssue[]>(row.validation_errors_json);
        if (!validationErrors.some(issue => issue.code === 'STALE_DOCUMENT_BINDING')) {
          validationErrors.push({
            code: 'STALE_DOCUMENT_BINDING',
            message: 'Die Dokumentbindung dieses Zahlungskandidaten ist nicht mehr aktuell.',
            field: 'remittanceInformation',
            severity: 'error',
          });
        }
        markStale.run(JSON.stringify(validationErrors), now, row.candidate_id);
      }
      return this.upsertCandidate(input);
  }

  getCandidateByDocumentId(documentId: string): PaymentCandidate | null {
    const row = this.db.prepare('SELECT * FROM invoice_payment_candidates WHERE document_id = ?').get(documentId) as CandidateRow | undefined;
    return row ? candidateFromRow(row) : null;
  }

  createDraftFromSelection(
    documentIds: string[],
    actor: string,
    resolveCandidate: (documentId: string) => PaymentCandidateWriteInput,
  ): PaymentSelectionRepositoryResult {
    const selectAndCreate = this.db.transaction((): PaymentSelectionRepositoryResult => {
      const accepted: PaymentCandidate[] = [];
      const rejected: Array<{ document_id: string; reason_code: string }> = [];

      for (const documentId of [...new Set(documentIds)]) {
        let input: PaymentCandidateWriteInput;
        try {
          input = resolveCandidate(documentId);
        } catch (error) {
          const code = codeFromError(error);
          if (!EXPECTED_SELECTION_ERRORS.has(code)) throw error;
          rejected.push({ document_id: documentId, reason_code: code });
          continue;
        }
        if (input.documentId !== documentId) {
          rejected.push({ document_id: documentId, reason_code: 'PAYMENT_CANDIDATE_MISMATCH' });
          continue;
        }
        let canonical: PaymentCandidate;
        try {
          this.replaceCandidateForScanInTransaction(input);
          const row = this.db.prepare('SELECT * FROM invoice_payment_candidates WHERE document_id = ?')
            .get(documentId) as CandidateRow | undefined;
          if (!row) throw new Error('PAYMENT_CANDIDATE_NOT_FOUND');
          canonical = candidateFromRow(row);
        } catch (error) {
          const code = codeFromError(error);
          if (code === 'PAYMENT_AMOUNT_MINOR_INVALID') {
            rejected.push({ document_id: documentId, reason_code: 'AMOUNT_NOT_POSITIVE' });
            continue;
          }
          if (!EXPECTED_SELECTION_ERRORS.has(code)) throw error;
          rejected.push({ document_id: documentId, reason_code: code });
          continue;
        }

        let reasonCode: string | null = null;
        if (canonical.reasonCode === 'STALE_DOCUMENT_BINDING'
          || canonical.validationErrors.some(issue => issue.code === 'STALE_DOCUMENT_BINDING')) {
          reasonCode = 'STALE_DOCUMENT_BINDING';
        } else if (canonical.classification !== 'unpaid') {
          reasonCode = canonical.reasonCode
            ?? (canonical.classification === 'paid' ? 'ALREADY_PAID' : 'PAYMENT_CANDIDATE_NOT_ELIGIBLE');
        } else if (canonical.currencyCode !== 'EUR') {
          reasonCode = 'CURRENCY_NOT_EUR';
        } else if (!Number.isSafeInteger(canonical.amountMinor) || (canonical.amountMinor ?? 0) <= 0) {
          reasonCode = 'AMOUNT_NOT_POSITIVE';
        } else if (canonical.validationErrors.length > 0) {
          reasonCode = canonical.validationErrors[0].code;
        } else if (this.findActiveBatchStatus(documentId) !== null) {
          reasonCode = 'PAYMENT_ALREADY_ACTIVE';
        }

        if (reasonCode) rejected.push({ document_id: documentId, reason_code: reasonCode });
        else accepted.push(canonical);
      }

      return {
        accepted,
        rejected,
        batch: accepted.length > 0 ? this.getBatch(this.createDraftInTransaction(accepted, actor))! : null,
      };
    });
    return selectAndCreate();
  }

  createDraft(candidates: PaymentCandidate[], actor: string): PaymentBatch {
    if (candidates.length === 0) throw new Error('PAYMENT_DRAFT_EMPTY');
    const create = this.db.transaction(() => this.createDraftInTransaction(candidates, actor));
    try {
      return this.getBatch(create())!;
    } catch (error) {
      if (String(error).includes('payment_batch_items.document_id') || String(error).includes('idx_payment_item_active_document')) {
        throw new Error('PAYMENT_ALREADY_ACTIVE');
      }
      throw error;
    }
  }

  private createDraftInTransaction(candidates: PaymentCandidate[], actor: string): string {
      const batchId = `PAYB-${this.idFactory()}`;
      const now = this.clock().toISOString();
      const canonicalCandidates = candidates.map(candidate => {
        assertSafeMinor(candidate.amountMinor);
        if (typeof candidate.candidateId !== 'string' || candidate.candidateId.length === 0) {
          throw new Error('PAYMENT_CANDIDATE_NOT_FOUND');
        }
        const row = this.db.prepare('SELECT * FROM invoice_payment_candidates WHERE candidate_id = ?')
          .get(candidate.candidateId) as CandidateRow | undefined;
        if (!row) throw new Error('PAYMENT_CANDIDATE_NOT_FOUND');
        const canonical = candidateFromRow(row);
        if (candidate.documentId !== canonical.documentId) {
          throw new Error('PAYMENT_CANDIDATE_MISMATCH');
        }
        if (canonical.reasonCode === 'STALE_DOCUMENT_BINDING'
          || canonical.validationErrors.some(issue => issue.code === 'STALE_DOCUMENT_BINDING')) {
          throw new Error('PAYMENT_CANDIDATE_NOT_ELIGIBLE');
        }
        return canonical;
      });
      assertSafeInteger(canonicalCandidates.length, 'PAYMENT_ITEM_COUNT_INVALID');
      let controlSumMinor = 0;
      for (const candidate of canonicalCandidates) {
        assertSafeMinor(candidate.amountMinor);
        controlSumMinor += candidate.amountMinor ?? 0;
        assertSafeInteger(controlSumMinor, 'PAYMENT_CONTROL_SUM_INVALID');
      }
      const executionDates = new Set(canonicalCandidates.map(candidate => candidate.requestedExecutionDate));
      const requestedExecutionDate = executionDates.size === 1 ? canonicalCandidates[0].requestedExecutionDate : null;
      this.db.prepare(`
        INSERT INTO payment_batches (
          batch_id, status, debtor_account_label, debtor_account_holder, debtor_iban,
          currency_code, item_count, control_sum_minor, requested_execution_date,
          created_at, updated_at
        ) VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId, FIXED_DEBTOR.accountLabel, FIXED_DEBTOR.accountHolder, FIXED_DEBTOR.iban,
        FIXED_DEBTOR.currencyCode, canonicalCandidates.length, controlSumMinor,
        requestedExecutionDate, now, now,
      );
      const insertItem = this.db.prepare(`
        INSERT INTO payment_batch_items (
          item_id, batch_id, candidate_id, document_id, scan_id, creditor_name,
          creditor_iban, amount_minor, currency_code, remittance_information,
          structured_creditor_reference, requested_execution_date, invoice_number,
          due_date, item_status, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)
      `);
      for (const candidate of canonicalCandidates) {
        insertItem.run(
          `PAYI-${this.idFactory()}`, batchId, candidate.candidateId, candidate.documentId,
          candidate.scanId, candidate.creditorName, candidate.creditorIban, candidate.amountMinor,
          candidate.currencyCode, candidate.remittanceInformation,
          candidate.structuredCreditorReference ?? null, candidate.requestedExecutionDate,
          candidate.invoiceNumber ?? null, candidate.dueDate ?? null, now, now,
        );
      }
      this.insertEvent(batchId, null, 'draft', actor, null, null, now);
      return batchId;
  }

  getBatch(batchId: string): PaymentBatch | null {
    const row = this.db.prepare('SELECT * FROM payment_batches WHERE batch_id = ?').get(batchId) as BatchRow | undefined;
    if (!row) return null;
    const items = this.db.prepare('SELECT * FROM payment_batch_items WHERE batch_id = ? ORDER BY created_at, item_id').all(batchId) as ItemRow[];
    return {
      batchId: String(row.batch_id),
      revision: Number(row.revision),
      status: String(row.status) as PaymentBatchStatus,
      debtorAccountLabel: String(row.debtor_account_label),
      debtorAccountHolder: String(row.debtor_account_holder),
      debtorIban: String(row.debtor_iban),
      currencyCode: String(row.currency_code),
      itemCount: Number(row.item_count),
      controlSumMinor: Number(row.control_sum_minor),
      requestedExecutionDate: row.requested_execution_date == null ? null : String(row.requested_execution_date),
      reviewedAt: row.reviewed_at == null ? null : String(row.reviewed_at),
      exportedAt: row.exported_at == null ? null : String(row.exported_at),
      exportArtifactPath: row.export_artifact_path == null ? null : String(row.export_artifact_path),
      xmlSha256: row.xml_sha256 == null ? null : String(row.xml_sha256),
      messageId: row.message_id == null ? null : String(row.message_id),
      georgePackageReference: row.george_package_reference == null ? null : String(row.george_package_reference),
      errorCode: row.error_code == null ? null : String(row.error_code),
      errorMessage: row.error_message == null ? null : String(row.error_message),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      items: items.map(itemFromRow),
    };
  }

  updateDraftItem(
    batchId: string,
    itemId: string,
    patch: Partial<PaymentDraftInput>,
    actor: string,
    expectedRevision: number,
  ): PaymentBatch {
    const update = this.db.transaction(() => {
      this.assertNoReleaseInProgress(batchId);
      const batch = this.requireBatch(batchId);
      if (batch.revision !== expectedRevision) throw new Error('STALE_PAYMENT_REVISION');
      if (batch.status !== 'draft') throw new Error('PAYMENT_ITEMS_IMMUTABLE');
      const item = batch.items.find(value => value.itemId === itemId);
      if (!item) throw new Error('PAYMENT_ITEM_NOT_FOUND');
      assertExecutionDate(patch.requestedExecutionDate);
      const canonicalPatch = {
        ...patch,
        ...(patch.creditorIban !== undefined
          ? { creditorIban: patch.creditorIban == null ? null : normalizeIban(patch.creditorIban) }
          : {}),
        ...(patch.structuredCreditorReference != null
          ? { remittanceInformation: null }
          : patch.remittanceInformation != null ? { structuredCreditorReference: null } : {}),
      };
      const next = { ...item, ...canonicalPatch };
      assertSafeMinor(next.amountMinor);
      const now = this.clock().toISOString();
      this.db.prepare(`
        UPDATE payment_batch_items SET
          creditor_name = ?, creditor_iban = ?, amount_minor = ?, currency_code = ?,
          remittance_information = ?, structured_creditor_reference = ?, requested_execution_date = ?, updated_at = ?
        WHERE batch_id = ? AND item_id = ?
      `).run(
        next.creditorName, next.creditorIban, next.amountMinor, next.currencyCode,
        next.remittanceInformation, next.structuredCreditorReference, next.requestedExecutionDate, now, batchId, itemId,
      );
      const totals = this.db.prepare(`
        SELECT COUNT(*) AS item_count, COALESCE(SUM(amount_minor), 0) AS control_sum_minor,
          CASE WHEN COUNT(DISTINCT requested_execution_date) = 1
                 AND COUNT(requested_execution_date) = COUNT(*)
            THEN MIN(requested_execution_date) ELSE NULL END AS requested_execution_date
        FROM payment_batch_items WHERE batch_id = ? AND active = 1
      `).get(batchId) as { item_count: number; control_sum_minor: number; requested_execution_date: string | null };
      assertSafeInteger(totals.item_count, 'PAYMENT_ITEM_COUNT_INVALID');
      assertSafeInteger(totals.control_sum_minor, 'PAYMENT_CONTROL_SUM_INVALID');
      const changed = this.db.prepare(`
        UPDATE payment_batches SET item_count = ?, control_sum_minor = ?, requested_execution_date = ?, updated_at = ?, revision = revision + 1
        WHERE batch_id = ? AND revision = ? AND status = 'draft'
      `).run(totals.item_count, totals.control_sum_minor, totals.requested_execution_date, now, batchId, expectedRevision);
      if (changed.changes !== 1) throw new Error('STALE_PAYMENT_REVISION');
      const sanitized = (value: PaymentBatchItem) => ({
        creditorName: value.creditorName,
        creditorIban: value.creditorIban,
        amountMinor: value.amountMinor,
        currencyCode: value.currencyCode,
        remittanceInformation: value.remittanceInformation,
        structuredCreditorReference: value.structuredCreditorReference,
        requestedExecutionDate: value.requestedExecutionDate,
      });
      this.insertEvent(
        batchId, 'draft', 'draft', actor, 'DRAFT_ITEM_EDIT', null, now,
        itemId, sanitized(item), sanitized(next),
      );
    });
    update();
    return this.requireBatch(batchId);
  }

  transitionBatch(
    batchId: string,
    nextStatus: PaymentBatchStatus,
    actor: string,
    expectedRevision: number,
    reason: string | null = null,
    georgeEvidence: Record<string, unknown> | null = null,
  ): PaymentBatch {
    const transition = this.db.transaction(() => {
      this.assertNoReleaseInProgress(batchId);
      const batch = this.requireBatch(batchId);
      if (batch.revision !== expectedRevision) throw new Error('STALE_PAYMENT_REVISION');
      if (!ALLOWED_TRANSITIONS[batch.status].has(nextStatus)
        || nextStatus === 'exported' || nextStatus === 'prepared' || nextStatus === 'released') {
        throw new Error(`INVALID_PAYMENT_TRANSITION: ${batch.status} -> ${nextStatus}`);
      }
      this.applyTransition(batch, nextStatus, actor, reason, georgeEvidence, expectedRevision);
    });
    transition();
    return this.requireBatch(batchId);
  }

  exportReviewedBatch(
    batchId: string,
    actor: string,
    expectedRevision: number,
    generate: AtomicExportArtifact | ((batch: PaymentBatch) => AtomicExportArtifact),
  ): AtomicExportResult {
    const exportBatch = this.db.transaction((): AtomicExportArtifact => {
      this.assertNoReleaseInProgress(batchId);
      const batch = this.requireBatch(batchId);
      if (batch.revision !== expectedRevision) throw new Error('STALE_PAYMENT_REVISION');
      if (batch.status !== 'reviewed') {
        throw new Error(`INVALID_PAYMENT_TRANSITION: ${batch.status} -> exported`);
      }
      const artifact = typeof generate === 'function' ? generate(batch) : generate;
      if (!Buffer.isBuffer(artifact.xml) || artifact.xml.length === 0
        || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(artifact.messageId)
        || !Number.isSafeInteger(artifact.transactionCount) || artifact.transactionCount < 1
        || !Number.isSafeInteger(artifact.controlSumMinor) || artifact.controlSumMinor < 1
        || artifact.transactionCount !== batch.itemCount
        || artifact.controlSumMinor !== batch.controlSumMinor) {
        throw new Error('SEPA_ARTIFACT_MISMATCH');
      }
      const now = this.clock().toISOString();
      const artifactPath = `sqlite://payment_batches/${batchId}/export_artifact_data`;
      const changed = this.db.prepare(`
        UPDATE payment_batches SET status = 'exported', exported_at = ?,
          export_artifact_path = ?, export_artifact_data = ?, xml_sha256 = ?, message_id = ?,
          updated_at = ?, revision = revision + 1
        WHERE batch_id = ? AND revision = ? AND status = 'reviewed'
      `).run(
        now, artifactPath, artifact.xml, artifact.sha256, artifact.messageId,
        now, batchId, expectedRevision,
      );
      if (changed.changes !== 1) throw new Error('STALE_PAYMENT_REVISION');
      this.db.prepare("UPDATE payment_batch_items SET item_status = 'exported', updated_at = ? WHERE batch_id = ?")
        .run(now, batchId);
      this.insertEvent(batchId, 'reviewed', 'exported', actor, 'SEPA_XML_EXPORTED', null, now);
      return artifact;
    });
    let artifact: AtomicExportArtifact;
    try {
      artifact = exportBatch();
    } catch (error) {
      if (String(error).includes('payment_batches.message_id')) {
        throw new Error('PAYMENT_MESSAGE_ID_CONFLICT');
      }
      throw error;
    }
    return { batch: this.requireBatch(batchId), artifact };
  }

  getExportArtifactData(batchId: string): Buffer | null {
    const row = this.db.prepare('SELECT export_artifact_data FROM payment_batches WHERE batch_id = ?')
      .get(batchId) as { export_artifact_data: Buffer | null } | undefined;
    if (!row) throw new Error('PAYMENT_BATCH_NOT_FOUND');
    return row.export_artifact_data == null ? null : Buffer.from(row.export_artifact_data);
  }

  createAutomationRun(batchId: string): PaymentAutomationRun {
    const create = this.db.transaction(() => {
      const batch = this.requireBatch(batchId);
      if (batch.status !== 'exported' || batch.xmlSha256 == null || batch.messageId == null) {
        throw new Error('PAYMENT_BATCH_NOT_EXPORTED');
      }
      const artifact = this.getExportArtifactData(batchId);
      if (!artifact || artifact.length === 0) throw new Error('PAYMENT_EXPORT_ARTIFACT_MISSING');
      const active = this.db.prepare(`
        SELECT 1 FROM payment_automation_runs
        WHERE batch_id = ? AND phase NOT IN ('released', 'failed') LIMIT 1
      `).get(batchId);
      if (active) throw new Error('PAYMENT_AUTOMATION_RUN_ACTIVE');
      const safeMessage = batch.messageId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'message';
      const safeBatch = batchId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 70);
      const importFilename = `sepa-${safeMessage}-${safeBatch}.xml`;
      const now = this.clock().toISOString();
      const runId = `PAYA-${this.idFactory()}`;
      const expected: PackageIdentity = {
        artifactSha256: batch.xmlSha256,
        messageId: batch.messageId,
        importFilename,
        expectedAccount: FIXED_DEBTOR,
        itemCount: batch.itemCount,
        controlSumMinor: batch.controlSumMinor,
      };
      this.db.prepare(`
        INSERT INTO payment_automation_runs (
          run_id, batch_id, phase, import_filename, expected_json, created_at, updated_at
        ) VALUES (?, ?, 'queued', ?, ?, ?, ?)
      `).run(runId, batchId, importFilename, JSON.stringify(expected), now, now);
      return runId;
    });
    try {
      return this.getAutomationRun(create())!;
    } catch (error) {
      if (String(error).includes('idx_payment_automation_one_nonfinal_batch')) {
        throw new Error('PAYMENT_AUTOMATION_RUN_ACTIVE');
      }
      throw error;
    }
  }

  getAutomationRun(runId: string): PaymentAutomationRun | null {
    const row = this.db.prepare('SELECT rowid AS _rowid, * FROM payment_automation_runs WHERE run_id = ?')
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    try { return automationRunFromRow(row); }
    catch { return automationRunFromRow(this.quarantineCorruptAutomationRow(row)); }
  }

  getLatestAutomationRun(batchId: string): PaymentAutomationRun | null {
    const rows = this.db.prepare(`
      SELECT rowid AS _rowid, * FROM payment_automation_runs WHERE batch_id = ?
      ORDER BY created_at DESC, rowid DESC
    `).all(batchId) as Array<Record<string, unknown>>;
    for (const row of rows) {
      try { return automationRunFromRow(row); }
      catch { return automationRunFromRow(this.quarantineCorruptAutomationRow(row)); }
    }
    return null;
  }

  getAutomationReleaseSafety(runId: string): PaymentAutomationReleaseSafety {
    const row = this.db.prepare(`SELECT release_confirmation_json,
      release_request_token IS NOT NULL AS has_request_token,
      release_click_claimed_at IS NOT NULL AS has_click_claim,
      release_clicked_at IS NOT NULL AS has_click
      FROM payment_automation_runs WHERE run_id=?`).get(runId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('PAYMENT_AUTOMATION_RUN_NOT_FOUND');
    const hasPersistedIntent = row.release_confirmation_json !== null;
    let confirmation: PaymentAutomationReleaseConfirmationSnapshot | null = null;
    if (hasPersistedIntent) {
      try {
        const parsed = parseJson<PaymentAutomationReleaseConfirmationSnapshot>(row.release_confirmation_json);
        if (exactKeys(parsed, ['revision', 'debtorIban', 'itemCount', 'controlSumMinor', 'xmlSha256', 'recovery'])
          && Number.isSafeInteger(parsed.revision) && parsed.revision > 0
          && parsed.debtorIban === FIXED_DEBTOR.iban
          && Number.isSafeInteger(parsed.itemCount) && parsed.itemCount > 0
          && Number.isSafeInteger(parsed.controlSumMinor) && parsed.controlSumMinor > 0
          && /^[a-f0-9]{64}$/.test(parsed.xmlSha256)
          && ['none', 'stable_prepared'].includes(parsed.recovery)) {
          confirmation = parsed;
        }
      } catch { /* malformed persisted intent stays fail-closed */ }
    }
    return {
      hasRequestToken: Number(row.has_request_token) === 1,
      hasClickClaim: Number(row.has_click_claim) === 1,
      hasClick: Number(row.has_click) === 1,
      hasPersistedIntent,
      confirmation,
    };
  }

  listNonFinalAutomationRuns(): PaymentAutomationRun[] {
    const rows = this.db.prepare(`
      SELECT rowid AS _rowid, * FROM payment_automation_runs
      WHERE phase NOT IN ('released', 'failed') ORDER BY created_at, rowid
    `).all() as Array<Record<string, unknown>>;
    const valid: PaymentAutomationRun[] = [];
    for (const row of rows) {
      try { valid.push(automationRunFromRow(row)); }
      catch {
        const quarantined = automationRunFromRow(this.quarantineCorruptAutomationRow(row));
        if (quarantined.phase !== 'failed' && quarantined.phase !== 'released') valid.push(quarantined);
      }
    }
    return valid;
  }

  recordAutomationBackgroundFailure(runId: string, errorCode: string): PaymentAutomationRun {
    const safeCode = /^[A-Z0-9_]{1,100}$/.test(errorCode) ? errorCode : 'PAYMENT_AUTOMATION_BACKGROUND_FAILED';
    const now = this.clock().toISOString();
    this.db.prepare(`UPDATE payment_automation_runs SET
      phase=CASE WHEN release_request_token IS NOT NULL OR release_click_claimed_at IS NOT NULL
        OR release_clicked_at IS NOT NULL OR phase IN ('requesting_release','release_click_claimed','waiting_release_2fa','verifying_release','unknown')
        THEN 'unknown' ELSE 'failed' END,
      error_code=?, error_message=NULL, updated_at=?
      WHERE run_id=? AND phase NOT IN ('released','failed')`).run(safeCode, now, runId);
    const run = this.getAutomationRun(runId);
    if (!run) throw new Error('PAYMENT_AUTOMATION_RUN_NOT_FOUND');
    return run;
  }

  private quarantineCorruptAutomationRow(row: Record<string, unknown>): Record<string, unknown> {
    const quarantine = this.db.transaction(() => {
      const rowid = Number(row._rowid);
      if (!Number.isSafeInteger(rowid) || rowid < 1) throw new Error('PAYMENT_AUTOMATION_STATE_CORRUPT');
      const now = this.clock().toISOString();
      const safeFilename = /^[-A-Za-z0-9_.]{6,200}\.xml$/.test(String(row.import_filename ?? ''))
        ? String(row.import_filename) : `corrupt-${rowid}.xml`;
      const quarantineExpected: PackageIdentity = {
        artifactSha256: '0'.repeat(64), messageId: 'corrupt', importFilename: safeFilename,
        expectedAccount: FIXED_DEBTOR, itemCount: 1, controlSumMinor: 1,
      };
      const releaseAuthority = row.release_request_token != null || row.release_click_claimed_at != null || row.release_clicked_at != null
        || ['requesting_release','release_click_claimed','waiting_release_2fa','verifying_release','unknown'].includes(String(row.phase));
      const changed = this.db.prepare(`UPDATE payment_automation_runs SET phase=?, import_filename=?, expected_json=?, observed_json=NULL,
        package_reference=NULL,
        release_request_token=CASE WHEN ? THEN release_request_token ELSE NULL END,
        release_click_claimed_at=CASE WHEN ? THEN release_click_claimed_at ELSE NULL END,
        release_clicked_at=CASE WHEN ? THEN release_clicked_at ELSE NULL END,
        error_code='CORRUPT_AUTOMATION_RUN', error_message=NULL, updated_at=?
        WHERE rowid=? AND phase=? AND updated_at=? AND expected_json=? AND observed_json IS ?
          AND release_request_token IS ? AND release_click_claimed_at IS ? AND release_clicked_at IS ?`)
        .run(releaseAuthority ? 'unknown' : 'failed', safeFilename, JSON.stringify(quarantineExpected),
          releaseAuthority ? 1 : 0, releaseAuthority ? 1 : 0, releaseAuthority ? 1 : 0,
          now, rowid, String(row.phase), String(row.updated_at), String(row.expected_json), row.observed_json ?? null,
          row.release_request_token ?? null, row.release_click_claimed_at ?? null, row.release_clicked_at ?? null);
      const current = this.db.prepare('SELECT rowid AS _rowid, * FROM payment_automation_runs WHERE rowid=?').get(rowid) as Record<string, unknown> | undefined;
      if (!current) throw new Error('PAYMENT_AUTOMATION_RUN_NOT_FOUND');
      if (changed.changes === 0) return current;
      return current;
    });
    return quarantine();
  }

  listEvents(batchId: string): PaymentStatusEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM payment_status_events WHERE batch_id = ? ORDER BY occurred_at, rowid
    `).all(batchId) as EventRow[];
    return rows.map(row => ({
      eventId: String(row.event_id),
      batchId: String(row.batch_id),
      actor: String(row.actor),
      occurredAt: String(row.occurred_at),
      previousStatus: row.previous_status == null ? null : String(row.previous_status) as PaymentBatchStatus,
      newStatus: String(row.new_status) as PaymentBatchStatus,
      reason: row.reason == null ? null : String(row.reason),
      georgeEvidence: row.george_evidence_json == null ? null : parseJson<Record<string, unknown>>(row.george_evidence_json),
      itemId: row.item_id == null ? null : String(row.item_id),
      before: row.before_json == null ? null : parseJson<Record<string, unknown>>(row.before_json),
      after: row.after_json == null ? null : parseJson<Record<string, unknown>>(row.after_json),
    }));
  }

  findActiveBatchStatus(documentId: string): PaymentBatchStatus | null {
    const row = this.db.prepare(`
      SELECT b.status FROM payment_batch_items i
      JOIN payment_batches b ON b.batch_id = i.batch_id
      WHERE i.document_id = ? AND i.active = 1
    `).get(documentId) as { status: PaymentBatchStatus } | undefined;
    return row?.status ?? null;
  }

  private requireBatch(batchId: string): PaymentBatch {
    const batch = this.getBatch(batchId);
    if (!batch) throw new Error('PAYMENT_BATCH_NOT_FOUND');
    return batch;
  }

  private assertNoReleaseInProgress(batchId: string): void {
    const active = this.db.prepare(`SELECT 1 FROM payment_automation_runs
      WHERE batch_id=? AND phase <> 'released' AND (
        release_request_token IS NOT NULL OR release_click_claimed_at IS NOT NULL OR release_clicked_at IS NOT NULL
        OR phase IN ('requesting_release','release_click_claimed','waiting_release_2fa','verifying_release','unknown')
      ) LIMIT 1`).get(batchId);
    if (active) throw new Error('PAYMENT_RELEASE_IN_PROGRESS');
  }

  private applyTransition(
    batch: PaymentBatch,
    nextStatus: PaymentBatchStatus,
    actor: string,
    reason: string | null,
    evidence: Record<string, unknown> | null,
    expectedRevision: number,
  ): void {
    const now = this.clock().toISOString();
    const reviewedAt = nextStatus === 'reviewed' ? now : batch.reviewedAt;
    const changed = this.db.prepare(`
      UPDATE payment_batches SET status = ?, reviewed_at = ?, updated_at = ?, revision = revision + 1
      WHERE batch_id = ? AND revision = ?
    `).run(nextStatus, reviewedAt, now, batch.batchId, expectedRevision);
    if (changed.changes !== 1) throw new Error('STALE_PAYMENT_REVISION');
    this.db.prepare(`
      UPDATE payment_batch_items SET item_status = ?, active = ?, updated_at = ? WHERE batch_id = ?
    `).run(nextStatus, nextStatus === 'cancelled' ? 0 : 1, now, batch.batchId);
    this.insertEvent(batch.batchId, batch.status, nextStatus, actor, reason, evidence, now);
  }

  private insertEvent(
    batchId: string,
    previousStatus: PaymentBatchStatus | null,
    newStatus: PaymentBatchStatus,
    actor: string,
    reason: string | null,
    evidence: Record<string, unknown> | null,
    occurredAt: string,
    itemId: string | null = null,
    before: Record<string, unknown> | null = null,
    after: Record<string, unknown> | null = null,
  ): void {
    this.db.prepare(`
      INSERT INTO payment_status_events (
        event_id, batch_id, actor, occurred_at, previous_status, new_status, reason,
        george_evidence_json, item_id, before_json, after_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `PAYE-${this.idFactory()}`, batchId, actor, occurredAt, previousStatus,
      newStatus, reason, evidence == null ? null : JSON.stringify(evidence), itemId,
      before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
    );
  }
}
