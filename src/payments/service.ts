import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import * as invoiceStore from '../invoicerec/store.js';
import { buildPaymentCandidate } from './candidates.js';
import {
  PaymentRepository,
  type PaymentBatch,
  type PaymentCandidate,
  type PaymentCandidateWriteInput,
} from './repository.js';
import type { PaymentDraftInput, PaymentValidationIssue } from './types.js';
import { SepaGenerator, type SepaArtifact, validateAgainstPinnedXsd, verifySepaRoundTrip } from './sepa.js';
import { validatePaymentDraft } from './validation.js';

export class PaymentDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly status = 400,
  ) {
    super(message);
  }
}

export interface PaymentSelectionAccepted {
  document_id: string;
  candidate_id: string;
  classification: PaymentCandidate['classification'];
  validation_errors: PaymentValidationIssue[];
}

export interface PaymentSelectionRejected {
  document_id: string;
  reason_code: string;
  reason: string;
}

export interface PaymentSelectionResult {
  accepted: PaymentSelectionAccepted[];
  rejected: PaymentSelectionRejected[];
  candidates: PaymentCandidate[];
}

export interface PaymentBatchView {
  batch: PaymentBatch;
  revision: number;
  validations: Array<{ item_id: string; document_id: string; issues: PaymentValidationIssue[] }>;
  events: ReturnType<PaymentRepository['listEvents']>;
}

const REJECTION_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ALREADY_PAID: 'Die Rechnung ist bereits als bezahlt erkannt.',
  ALREADY_PAID_RECEIPT: 'Der Beleg ist bereits bezahlt und kann nicht überwiesen werden.',
  CREDIT_NOTE: 'Die Datei ist eine Gutschrift oder Rechnungskorrektur und darf nicht überwiesen werden.',
  SCAN_NOT_CONFIRMED: 'Der zugehörige Scan ist nicht bestätigt.',
  CURRENCY_NOT_EUR: 'Nur Zahlungen in EUR sind zulässig.',
  AMOUNT_NOT_POSITIVE: 'Der Zahlungsbetrag muss größer als null sein.',
  STALE_DOCUMENT_BINDING: 'Die Dokumentbindung ist nicht mehr aktuell.',
  PAYMENT_CANDIDATE_LOCKED: 'Der Zahlungskandidat ist durch einen exportierten Zahlungslauf gesperrt.',
  PAYMENT_DOCUMENT_NOT_FOUND: 'Für das Dokument wurde kein bestätigter Scan gefunden.',
  PAYMENT_SCAN_NOT_FOUND: 'Der zugehörige Scan wurde nicht gefunden.',
  PAYMENT_FIELDS_NOT_FOUND: 'Für den Scan fehlen erkannte Rechnungsfelder.',
  PAYMENT_ALREADY_ACTIVE: 'Für das Dokument existiert bereits eine aktive Zahlung.',
});

const HARD_REJECTION_CODES = new Set([
  'ALREADY_PAID',
  'ALREADY_PAID_RECEIPT',
  'CREDIT_NOTE',
  'SCAN_NOT_CONFIRMED',
  'CURRENCY_NOT_EUR',
  'AMOUNT_NOT_POSITIVE',
  'STALE_DOCUMENT_BINDING',
]);

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(':', 1)[0].trim() || 'PAYMENT_REFRESH_FAILED';
}

function rejection(documentId: string, code: string): PaymentSelectionRejected {
  return {
    document_id: documentId,
    reason_code: code,
    reason: REJECTION_MESSAGES[code] ?? 'Das Dokument konnte nicht für eine Zahlung vorbereitet werden.',
  };
}

// Called by the repository while its selection transaction is active. All source
// reads and the resulting candidate writes therefore share the same SQLite transaction.
function defaultRefreshByDocumentId(documentId: string): PaymentCandidateWriteInput {
  const row = getDb().prepare(`
    SELECT scan_id, status FROM invoice_scans
    WHERE document_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(documentId) as { scan_id: string; status: string } | undefined;
  if (!row) throw new Error('PAYMENT_DOCUMENT_NOT_FOUND');
  if (row.status !== 'confirmed') throw new Error('SCAN_NOT_CONFIRMED');
  const scan = invoiceStore.getScan(row.scan_id);
  if (!scan) throw new Error('PAYMENT_SCAN_NOT_FOUND');
  const fields = invoiceStore.getFields(row.scan_id);
  if (!fields) throw new Error('PAYMENT_FIELDS_NOT_FOUND');
  return buildPaymentCandidate(scan, fields);
}

function itemValidation(batch: PaymentBatch) {
  return batch.items.map(item => ({
    item_id: item.itemId,
    document_id: item.documentId,
    issues: validatePaymentDraft({
      creditorName: item.creditorName,
      creditorIban: item.creditorIban,
      amountMinor: item.amountMinor,
      currencyCode: item.currencyCode,
      remittanceInformation: item.remittanceInformation,
      structuredCreditorReference: item.structuredCreditorReference,
    }),
  }));
}

export class PaymentService {
  constructor(
    private readonly repository = new PaymentRepository(),
    private readonly refreshByDocumentId: (documentId: string) => PaymentCandidateWriteInput = defaultRefreshByDocumentId,
    private readonly sepaGenerator = new SepaGenerator(),
    private readonly clock: () => Date = () => new Date(),
    private readonly idFactory: () => string = () => randomUUID(),
    private readonly exportValidator: (xml: Buffer) => Promise<{ valid: boolean; errors: string[] }> = validateAgainstPinnedXsd,
  ) {}

  refreshCandidates(documentIds: string[]): PaymentSelectionResult {
    const accepted: PaymentSelectionAccepted[] = [];
    const rejected: PaymentSelectionRejected[] = [];
    const candidates: PaymentCandidate[] = [];

    for (const documentId of [...new Set(documentIds)]) {
      try {
        const candidate = this.repository.replaceCandidateForScan(this.refreshByDocumentId(documentId));
        if (candidate.documentId !== documentId) {
          rejected.push(rejection(documentId, 'PAYMENT_CANDIDATE_MISMATCH'));
          continue;
        }
        if (candidate.classification === 'paid' || (candidate.reasonCode && HARD_REJECTION_CODES.has(candidate.reasonCode))) {
          rejected.push(rejection(documentId, candidate.reasonCode ?? 'ALREADY_PAID'));
          continue;
        }
        candidates.push(candidate);
        accepted.push({
          document_id: documentId,
          candidate_id: candidate.candidateId,
          classification: candidate.classification,
          validation_errors: candidate.validationErrors,
        });
      } catch (error) {
        rejected.push(rejection(documentId, errorCode(error)));
      }
    }
    return { accepted, rejected, candidates };
  }

  createBatch(documentIds: string[], actor: string): PaymentSelectionResult & { batch: PaymentBatch | null } {
    const result = this.repository.createDraftFromSelection(documentIds, actor, this.refreshByDocumentId);
    return {
      accepted: result.accepted.map(candidate => ({
        document_id: candidate.documentId,
        candidate_id: candidate.candidateId,
        classification: candidate.classification,
        validation_errors: candidate.validationErrors,
      })),
      rejected: result.rejected.map(value => rejection(value.document_id, value.reason_code)),
      candidates: result.accepted,
      batch: result.batch,
    };
  }

  getBatch(batchId: string): PaymentBatchView {
    const batch = this.repository.getBatch(batchId);
    if (!batch) throw new PaymentDomainError('PAYMENT_BATCH_NOT_FOUND', 'Zahlungsstapel nicht gefunden.', { batch_id: batchId }, 404);
    return {
      batch,
      revision: batch.revision,
      validations: itemValidation(batch),
      events: this.repository.listEvents(batchId),
    };
  }

  updateItem(
    batchId: string,
    itemId: string,
    expectedRevision: number,
    patch: Partial<PaymentDraftInput>,
    actor: string,
  ): PaymentBatchView {
    try {
      this.repository.updateDraftItem(batchId, itemId, patch, actor, expectedRevision);
      return this.getBatch(batchId);
    } catch (error) {
      throw this.mapRepositoryError(error, { batch_id: batchId, item_id: itemId });
    }
  }

  review(batchId: string, expectedRevision: number, actor: string, confirmUnpaid: boolean): PaymentBatchView {
    const view = this.getBatch(batchId);
    if (view.revision !== expectedRevision) {
      throw new PaymentDomainError('STALE_PAYMENT_REVISION', 'Der Zahlungsstapel wurde zwischenzeitlich geändert.', {
        expected_revision: expectedRevision,
        current_revision: view.revision,
      }, 409);
    }
    if (view.batch.status !== 'draft') {
      throw new PaymentDomainError('INVALID_PAYMENT_TRANSITION', 'Der Zahlungsstapel kann in diesem Status nicht geprüft werden.', {
        current_status: view.batch.status, requested_status: 'reviewed',
      }, 409);
    }
    const executionDates = new Set(view.batch.items.map(item => item.requestedExecutionDate));
    if (executionDates.size !== 1 || executionDates.has(null)) {
      throw new PaymentDomainError(
        'PAYMENT_EXECUTION_DATE_MIXED',
        'Alle Positionen eines Zahlungsstapels müssen dasselbe Ausführungsdatum besitzen.',
        { requested_execution_dates: [...executionDates] },
        422,
      );
    }
    const issues = view.validations.filter(value => value.issues.length > 0);
    if (!confirmUnpaid || issues.length > 0) {
      throw new PaymentDomainError('PAYMENT_REVIEW_INVALID', 'Der Zahlungsstapel ist noch nicht vollständig und ausdrücklich bestätigt.', {
        confirm_unpaid: confirmUnpaid, issues,
      }, 422);
    }
    try {
      this.repository.transitionBatch(batchId, 'reviewed', actor, expectedRevision, 'PAYMENT_REVIEW_CONFIRMED');
      return this.getBatch(batchId);
    } catch (error) {
      throw this.mapRepositoryError(error, { batch_id: batchId });
    }
  }

  async export(batchId: string, expectedRevision: number, actor: string): Promise<{ batch: PaymentBatch; artifact: SepaArtifact }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const batch = this.repository.getBatch(batchId);
        if (!batch) throw new Error('PAYMENT_BATCH_NOT_FOUND');
        if (batch.revision !== expectedRevision) throw new Error('STALE_PAYMENT_REVISION');
        const artifact = await this.sepaGenerator.generate(batch, { clock: this.clock, idFactory: this.idFactory });
        return this.repository.exportReviewedBatch(
          batchId,
          actor,
          expectedRevision,
          artifact,
        );
      } catch (error) {
        if (errorCode(error) === 'PAYMENT_MESSAGE_ID_CONFLICT' && attempt < 2) continue;
        throw this.mapRepositoryError(error, { batch_id: batchId });
      }
    }
    throw new PaymentDomainError('PAYMENT_MESSAGE_ID_CONFLICT', 'Es konnte keine eindeutige MsgID erzeugt werden.', { batch_id: batchId }, 409);
  }

  async getExport(batchId: string): Promise<{ batch: PaymentBatch; artifact: SepaArtifact }> {
    const batch = this.repository.getBatch(batchId);
    if (!batch) throw new PaymentDomainError('PAYMENT_BATCH_NOT_FOUND', 'Zahlungsstapel nicht gefunden.', { batch_id: batchId }, 404);
    const xml = this.repository.getExportArtifactData(batchId);
    const sha256 = xml == null ? null : createHash('sha256').update(xml).digest('hex');
    try {
      if (batch.status !== 'exported' || !xml || !batch.xmlSha256 || sha256 !== batch.xmlSha256 || !batch.messageId) {
        throw new Error('SEPA_PERSISTED_ARTIFACT_INVALID');
      }
      const validation = await this.exportValidator(xml);
      if (!validation.valid) throw new Error('SEPA_PERSISTED_ARTIFACT_INVALID');
      verifySepaRoundTrip(xml, batch);
      const currentBatch = this.repository.getBatch(batchId);
      const currentXml = this.repository.getExportArtifactData(batchId);
      if (!currentBatch || !currentXml
        || currentBatch.status !== 'exported'
        || currentBatch.revision !== batch.revision
        || currentBatch.xmlSha256 !== batch.xmlSha256
        || currentBatch.messageId !== batch.messageId
        || !currentXml.equals(xml)
        || createHash('sha256').update(currentXml).digest('hex') !== sha256
        || currentBatch.itemCount !== batch.itemCount
        || currentBatch.controlSumMinor !== batch.controlSumMinor
        || currentBatch.debtorAccountLabel !== batch.debtorAccountLabel
        || currentBatch.debtorAccountHolder !== batch.debtorAccountHolder
        || currentBatch.debtorIban !== batch.debtorIban
        || currentBatch.currencyCode !== batch.currencyCode) {
        throw new Error('PAYMENT_EXPORT_CHANGED');
      }
      return { batch, artifact: {
        xml, sha256, messageId: batch.messageId,
        transactionCount: batch.itemCount, controlSumMinor: batch.controlSumMinor,
      } };
    } catch (error) {
      if (errorCode(error) === 'PAYMENT_EXPORT_CHANGED') {
        throw new PaymentDomainError(
          'PAYMENT_EXPORT_CHANGED',
          'Der Zahlungsstapel wurde während der Exportprüfung geändert.',
          { batch_id: batchId },
          409,
        );
      }
      throw new PaymentDomainError(
        'SEPA_PERSISTED_ARTIFACT_INVALID',
        'Das persistierte SEPA-Artefakt hat die Integritätsprüfung nicht bestanden.',
        { batch_id: batchId },
        409,
      );
    }
  }

  cancel(batchId: string, expectedRevision: number, actor: string, reason: string): PaymentBatchView {
    try {
      this.repository.transitionBatch(batchId, 'cancelled', actor, expectedRevision, reason);
      return this.getBatch(batchId);
    } catch (error) {
      throw this.mapRepositoryError(error, { batch_id: batchId, requested_status: 'cancelled' });
    }
  }

  private mapRepositoryError(error: unknown, details: Record<string, unknown>): PaymentDomainError {
    const code = errorCode(error);
    if (code === 'PAYMENT_BATCH_NOT_FOUND' || code === 'PAYMENT_ITEM_NOT_FOUND') {
      return new PaymentDomainError(code, 'Zahlungsstapel oder Position nicht gefunden.', details, 404);
    }
    if (code === 'INVALID_PAYMENT_TRANSITION' || code === 'PAYMENT_ITEMS_IMMUTABLE'
      || code === 'PAYMENT_MESSAGE_ID_CONFLICT') {
      return new PaymentDomainError(code, 'Diese Änderung ist im aktuellen Zahlungsstatus nicht zulässig.', details, 409);
    }
    if (code === 'STALE_PAYMENT_REVISION') {
      return new PaymentDomainError(code, 'Der Zahlungsstapel wurde zwischenzeitlich geändert.', {
        ...details,
        current_revision: this.repository.getBatch(String(details.batch_id))?.revision ?? null,
      }, 409);
    }
    return new PaymentDomainError(code, 'Die Zahlungsänderung konnte nicht durchgeführt werden.', details, 400);
  }
}
