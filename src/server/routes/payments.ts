import { Router, type Request, type Response } from 'express';
import type { PaymentDraftInput } from '../../payments/types.js';
import type { ReleaseConfirmation } from '../../payments/browser/types.js';
import { getPaymentAutomationService } from '../../payments/automation-service.js';
import { PaymentDomainError, PaymentService } from '../../payments/service.js';

function invalid(field: string, message: string): never {
  throw new PaymentDomainError('PAYMENT_REQUEST_INVALID', 'Ungültige Zahlungsanfrage.', { field, message }, 400);
}

function bodyObject(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) invalid('body', 'Ein JSON-Objekt ist erforderlich.');
  return req.body as Record<string, unknown>;
}

function assertOnly(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  if (unknown.length > 0) invalid('body', `Unbekannte Felder: ${unknown.join(', ')}`);
}

function documentIds(body: Record<string, unknown>): string[] {
  const value = body.document_ids;
  if (!Array.isArray(value) || value.length === 0) invalid('document_ids', 'Mindestens eine Dokument-ID ist erforderlich.');
  if (value.length > 500) invalid('document_ids', 'Höchstens 500 Dokument-IDs sind erlaubt.');
  if (value.some(id => typeof id !== 'string' || id.length === 0 || id.trim() !== id)) {
    invalid('document_ids', 'Jede Dokument-ID muss eine nicht-leere Zeichenkette ohne Rand-Leerzeichen sein.');
  }
  return [...new Set(value as string[])];
}

function actor(body: Record<string, unknown>): string {
  if (body.actor === undefined) return 'payment-ui';
  if (typeof body.actor !== 'string' || !body.actor.trim()) invalid('actor', 'actor muss eine nicht-leere Zeichenkette sein.');
  return body.actor;
}

function expectedRevision(body: Record<string, unknown>): number {
  if (!Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 1) {
    invalid('expected_revision', 'expected_revision muss eine positive Ganzzahl sein.');
  }
  return body.expected_revision as number;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) invalid(field, `${field} muss eine nicht-leere Zeichenkette sein.`);
  return value;
}

function pathParam(req: Request, field: string): string {
  const value = req.params[field];
  if (typeof value !== 'string' || !value || value.length > 200 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    invalid(field, `${field} muss eine sichere Kennung mit höchstens 200 Zeichen sein.`);
  }
  return value;
}

function releaseConfirmation(body: Record<string, unknown>): ReleaseConfirmation {
  assertOnly(body, ['debtor_iban', 'item_count', 'control_sum_minor', 'xml_sha256']);
  if (typeof body.debtor_iban !== 'string' || !/^AT\d{18}$/.test(body.debtor_iban)) {
    invalid('debtor_iban', 'debtor_iban muss eine normalisierte österreichische IBAN sein.');
  }
  if (!Number.isSafeInteger(body.item_count) || Number(body.item_count) < 1) {
    invalid('item_count', 'item_count muss eine positive sichere Ganzzahl sein.');
  }
  if (!Number.isSafeInteger(body.control_sum_minor) || Number(body.control_sum_minor) < 1) {
    invalid('control_sum_minor', 'control_sum_minor muss eine positive sichere Ganzzahl in Cent sein.');
  }
  if (typeof body.xml_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.xml_sha256)) {
    invalid('xml_sha256', 'xml_sha256 muss ein kleingeschriebener SHA-256-Hash sein.');
  }
  return {
    debtorIban: body.debtor_iban,
    itemCount: body.item_count as number,
    controlSumMinor: body.control_sum_minor as number,
    xmlSha256: body.xml_sha256,
  };
}


const ITEM_FIELDS = [
  'creditor_name', 'creditor_iban', 'amount_minor', 'currency_code',
  'remittance_information', 'structured_creditor_reference',
  'requested_execution_date',
] as const;

function nullableString(body: Record<string, unknown>, field: typeof ITEM_FIELDS[number]): string | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') invalid(field, `${field} muss eine Zeichenkette oder null sein.`);
  return value;
}

function itemPatch(body: Record<string, unknown>): Partial<PaymentDraftInput> {
  const supplied = ITEM_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(body, field));
  if (supplied.length === 0) invalid('body', 'Mindestens ein editierbares Positionsfeld ist erforderlich.');
  if (body.amount_minor !== undefined && body.amount_minor !== null && !Number.isSafeInteger(body.amount_minor)) {
    invalid('amount_minor', 'amount_minor muss eine sichere Ganzzahl in Cent oder null sein.');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'requested_execution_date')) {
    const value = body.requested_execution_date;
    if (value !== null) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        invalid('requested_execution_date', 'requested_execution_date muss YYYY-MM-DD oder null sein.');
      }
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
        invalid('requested_execution_date', 'requested_execution_date muss ein gültiges Kalenderdatum sein.');
      }
    }
  }
  return {
    ...(Object.prototype.hasOwnProperty.call(body, 'creditor_name') ? { creditorName: nullableString(body, 'creditor_name') } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'creditor_iban') ? { creditorIban: nullableString(body, 'creditor_iban') } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'amount_minor') ? { amountMinor: body.amount_minor as number | null } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'currency_code') ? { currencyCode: nullableString(body, 'currency_code') } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'remittance_information') ? { remittanceInformation: nullableString(body, 'remittance_information') } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'structured_creditor_reference') ? { structuredCreditorReference: nullableString(body, 'structured_creditor_reference') } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'requested_execution_date') ? { requestedExecutionDate: body.requested_execution_date as string | null } : {}),
  };
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof PaymentDomainError) {
    res.status(error.status).json({ code: error.code, error: error.message, details: error.details });
    return;
  }
  const automationError = error as { code?: unknown; status?: unknown; message?: unknown };
  if (typeof automationError.code === 'string' && Number.isInteger(automationError.status)
    && Number(automationError.status) >= 400 && Number(automationError.status) <= 599) {
    res.status(Number(automationError.status)).json({
      code: automationError.code,
      error: typeof automationError.message === 'string' ? automationError.message : 'Die Zahlungsautomation wurde sicher angehalten.',
      details: {},
    });
    return;
  }
  const code = typeof automationError.code === 'string'
    ? automationError.code
    : error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : null;
  if (code) {
    const status = ['PAYMENT_BATCH_NOT_FOUND', 'PAYMENT_AUTOMATION_RUN_NOT_FOUND'].includes(code) ? 404
      : ['PAYMENT_RELEASE_IN_PROGRESS', 'EXECUTOR_BUSY'].includes(code) ? 423
        : ['BROWSER_CONNECTION', 'DATA_IMPORT_ACTIVATION_REQUIRED'].includes(code) ? 503
          : 409;
    res.status(status).json({ code, error: 'Die Zahlungsautomation wurde sicher angehalten.', details: {} });
    return;
  }
  res.status(500).json({
    code: 'PAYMENT_INTERNAL_ERROR',
    error: 'Die Zahlungsanfrage konnte nicht verarbeitet werden.',
    details: {},
  });
}

function route(handler: (req: Request, res: Response) => void | Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

function sendExport(res: Response, batchId: string, result: Awaited<ReturnType<PaymentService['getExport']>>): void {
  res.status(200);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sepa-${batchId}.xml"`);
  res.setHeader('X-Payment-Batch-Id', batchId);
  res.setHeader('X-Payment-Control-Sum-Minor', String(result.artifact.controlSumMinor));
  res.send(result.artifact.xml);
}

export function createPaymentsRouter(service: PaymentService): Router {
  const router = Router();
  const automation = getPaymentAutomationService();

  router.post('/candidates/refresh', route((req, res) => {
    const body = bodyObject(req);
    assertOnly(body, ['document_ids', 'actor']);
    void actor(body);
    const result = service.refreshCandidates(documentIds(body));
    res.json({ accepted: result.accepted, rejected: result.rejected });
  }));

  router.post('/batches', route((req, res) => {
    const body = bodyObject(req);
    assertOnly(body, ['document_ids', 'actor']);
    const result = service.createBatch(documentIds(body), actor(body));
    const payload = {
      batch: result.batch,
      revision: result.batch?.revision ?? null,
      accepted: result.accepted,
      rejected: result.rejected,
    };
    res.status(result.batch ? 201 : 422).json(payload);
  }));

  router.get('/batches/:id', route((req, res) => {
    res.json(service.getBatch(pathParam(req, 'id')));
  }));

  router.put('/batches/:id/items/:itemId', route((req, res) => {
    const body = bodyObject(req);
    assertOnly(body, ['expected_revision', 'actor', ...ITEM_FIELDS]);
    res.json(service.updateItem(
      pathParam(req, 'id'),
      pathParam(req, 'itemId'),
      expectedRevision(body),
      itemPatch(body),
      actor(body),
    ));
  }));

  router.post('/batches/:id/review', route((req, res) => {
    const body = bodyObject(req);
    assertOnly(body, ['expected_revision', 'actor', 'confirm_unpaid']);
    if (typeof body.confirm_unpaid !== 'boolean') invalid('confirm_unpaid', 'confirm_unpaid muss explizit true oder false sein.');
    res.json(service.review(pathParam(req, 'id'), expectedRevision(body), actor(body), body.confirm_unpaid));
  }));

  router.post('/batches/:id/export', route(async (req, res) => {
    const body = bodyObject(req);
    assertOnly(body, ['expected_revision', 'actor']);
    const batchId = pathParam(req, 'id');
    const result = await service.export(batchId, expectedRevision(body), actor(body));
    sendExport(res, batchId, result);
  }));

  router.get('/batches/:id/export', route(async (req, res) => {
    const batchId = pathParam(req, 'id');
    sendExport(res, batchId, await service.getExport(batchId));
  }));

  router.post('/batches/:id/import-to-george', route((req, res) => {
    const body = bodyObject(req);
    assertOnly(body, []);
    res.status(202).json(automation.queueImport(pathParam(req, 'id')));
  }));

  router.get('/batches/:id/automation', route((req, res) => {
    const batchId = pathParam(req, 'id');
    const status = automation.getStatus(batchId);
    if (!status) {
      throw Object.assign(new Error('Für diesen Zahlungsstapel existiert noch kein Automationslauf.'), {
        code: 'PAYMENT_AUTOMATION_RUN_NOT_FOUND', status: 404,
      });
    }
    res.json(status);
  }));

  router.post('/batches/:id/request-release', route((req, res) => {
    const confirmation = releaseConfirmation(bodyObject(req));
    res.status(202).json(automation.requestRelease(pathParam(req, 'id'), confirmation));
  }));

  router.post('/batches/:id/cancel', route((req, res) => {
    const body = bodyObject(req);
    assertOnly(body, ['expected_revision', 'actor', 'reason']);
    res.json(service.cancel(
      pathParam(req, 'id'), expectedRevision(body), actor(body), requiredString(body, 'reason'),
    ));
  }));

  return router;
}
