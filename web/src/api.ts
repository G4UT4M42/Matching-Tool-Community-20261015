const BASE = '/api';
const ACCESS_KEY = 'matching-community-owner-token';

export function setCommunityAccessToken(token: string): void {
  if (token.trim()) window.sessionStorage.setItem(ACCESS_KEY, token.trim());
  else window.sessionStorage.removeItem(ACCESS_KEY);
}

export function getCommunityAccessToken(): string {
  return window.sessionStorage.getItem(ACCESS_KEY) ?? '';
}

// Account session cookies remain HttpOnly. This request-confirmation value is
// volatile and never persisted into sessionStorage, localStorage, logs or URLs.
let communityCsrfToken = '';
export function setCommunityCsrfToken(token: string): void {
  if (token && !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid session confirmation token');
  communityCsrfToken = token;
}
export async function communityFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const target = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
  const localApi = target.origin === window.location.origin && (target.pathname === '/api' || target.pathname.startsWith('/api/'));
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (localApi) {
    const previewToken = getCommunityAccessToken();
    if (previewToken) headers.set('X-Community-Access-Token', previewToken);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && communityCsrfToken) headers.set('X-CSRF-Token', communityCsrfToken);
  } else {
    // Never forward local authentication headers to imported or external links.
    headers.delete('X-Community-Access-Token'); headers.delete('X-CSRF-Token');
  }
  const response = await window.fetch(input, { ...init, headers, credentials: 'same-origin', ...(localApi ? {redirect: 'error' as const} : {}) });
  if (localApi && response.status === 401 && !target.pathname.startsWith('/api/auth/')) {
    communityCsrfToken = '';
    window.dispatchEvent(new Event('community-session-expired'));
  }
  return response;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await communityFetch(BASE + url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export type PaymentBatchStatus = 'draft' | 'reviewed' | 'exported' | 'prepared' | 'released' | 'cancelled' | 'failed';

export interface PaymentValidationIssue {
  code: string;
  message: string;
  field: 'creditorName' | 'creditorIban' | 'amountMinor' | 'currencyCode' | 'remittanceInformation' | 'structuredCreditorReference' | 'requestedExecutionDate';
  severity: 'error' | 'warning';
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

export interface PaymentBatchView {
  batch: PaymentBatch;
  revision: number;
  validations: Array<{ item_id: string; document_id: string; issues: PaymentValidationIssue[] }>;
  events: Array<{
    eventId: string;
    batchId: string;
    actor: string;
    occurredAt: string;
    previousStatus: PaymentBatchStatus | null;
    newStatus: PaymentBatchStatus;
    reason: string | null;
  }>;
}

export interface PaymentSelectionEntry {
  document_id: string;
  candidate_id: string;
  classification: 'unpaid' | 'paid' | 'unclear';
  validation_errors: PaymentValidationIssue[];
}

export interface PaymentSelectionRejection {
  document_id: string;
  reason_code: string;
  reason: string;
}

export interface PaymentBatchCreation {
  batch: PaymentBatch | null;
  revision: number | null;
  accepted: PaymentSelectionEntry[];
  rejected: PaymentSelectionRejection[];
}

export interface PaymentItemPatch {
  creditor_name?: string | null;
  creditor_iban?: string | null;
  amount_minor?: number | null;
  currency_code?: string | null;
  remittance_information?: string | null;
  structured_creditor_reference?: string | null;
  requested_execution_date?: string | null;
}

export interface PaymentXmlDownload {
  blob: Blob;
  filename: string;
  batchId: string;
  controlSumMinor: number;
}

export type PaymentAutomationPhase =
  | 'queued' | 'connecting_browser' | 'waiting_login_2fa' | 'uploading' | 'upload_attempted'
  | 'verifying_import' | 'prepared' | 'requesting_release' | 'release_click_claimed'
  | 'waiting_release_2fa' | 'verifying_release' | 'released' | 'failed' | 'unknown';

export interface PaymentAutomationStatus {
  run_id: string;
  batch_id: string;
  phase: PaymentAutomationPhase;
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

export interface PaymentReleaseConfirmation {
  debtor_iban: string;
  item_count: number;
  control_sum_minor: number;
  xml_sha256: string;
}

interface PaymentErrorPayload {
  code?: string;
  error?: string;
  details?: unknown;
}

export class PaymentApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details: unknown,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'PaymentApiError';
  }
}

function detailValue(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return '[nicht darstellbar]'; }
}

export function paymentApiErrorMessage(error: unknown): string {
  if (!(error instanceof PaymentApiError)) return error instanceof Error ? error.message : 'Unbekannter Fehler';
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? Object.entries(error.details as Record<string, unknown>)
        .map(([key, value]) => `${key}: ${detailValue(value)}`)
        .join('; ')
    : detailValue(error.details);
  return `${error.message} (${error.code})${details ? ` · Details: ${details}` : ''}`;
}

async function paymentError(response: Response): Promise<PaymentApiError> {
  const raw: unknown = await response.json().catch(() => ({ error: response.statusText }));
  const payload: PaymentErrorPayload = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as PaymentErrorPayload
    : { error: response.statusText };
  return new PaymentApiError(
    typeof payload.error === 'string' && payload.error ? payload.error : response.statusText,
    typeof payload.code === 'string' && payload.code ? payload.code : 'PAYMENT_REQUEST_FAILED',
    payload.details,
    response.status,
  );
}

async function fetchPaymentJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await communityFetch(BASE + url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) throw await paymentError(response);
  return response.json() as Promise<T>;
}

export async function createPaymentBatch(documentIds: string[]): Promise<PaymentBatchCreation> {
  const response = await communityFetch(BASE + '/payments/batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document_ids: documentIds, actor: 'payment-ui' }),
  });
  if (response.status !== 201 && response.status !== 422) throw await paymentError(response);
  return response.json() as Promise<PaymentBatchCreation>;
}

export const getPaymentBatch = (batchId: string, signal?: AbortSignal) =>
  fetchPaymentJson<PaymentBatchView>(`/payments/batches/${encodeURIComponent(batchId)}`, { signal });

export const updatePaymentItem = (
  batchId: string,
  itemId: string,
  expectedRevision: number,
  changes: PaymentItemPatch,
  signal?: AbortSignal,
) => fetchPaymentJson<PaymentBatchView>(
  `/payments/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}`,
  { method: 'PUT', body: JSON.stringify({ expected_revision: expectedRevision, actor: 'payment-ui', ...changes }), signal },
);

export const reviewPaymentBatch = (batchId: string, expectedRevision: number, confirmUnpaid: boolean, signal?: AbortSignal) =>
  fetchPaymentJson<PaymentBatchView>(`/payments/batches/${encodeURIComponent(batchId)}/review`, {
    method: 'POST',
    body: JSON.stringify({ expected_revision: expectedRevision, actor: 'payment-ui', confirm_unpaid: confirmUnpaid }),
    signal,
  });

export const cancelPaymentBatch = (batchId: string, expectedRevision: number, reason: string, signal?: AbortSignal) =>
  fetchPaymentJson<PaymentBatchView>(`/payments/batches/${encodeURIComponent(batchId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ expected_revision: expectedRevision, actor: 'payment-ui', reason }),
    signal,
  });

export const importPaymentBatchToGeorge = (batchId: string, signal?: AbortSignal) =>
  fetchPaymentJson<PaymentAutomationStatus>(`/payments/batches/${encodeURIComponent(batchId)}/import-to-george`, {
    method: 'POST', body: '{}', signal,
  });

export const getPaymentAutomationStatus = (batchId: string, signal?: AbortSignal) =>
  fetchPaymentJson<PaymentAutomationStatus>(`/payments/batches/${encodeURIComponent(batchId)}/automation`, { signal });

export const requestPaymentBatchRelease = (
  batchId: string,
  confirmation: PaymentReleaseConfirmation,
  signal?: AbortSignal,
) => fetchPaymentJson<PaymentAutomationStatus>(`/payments/batches/${encodeURIComponent(batchId)}/request-release`, {
  method: 'POST', body: JSON.stringify(confirmation), signal,
});

function downloadFilename(disposition: string | null, fallback: string): string {
  const utf8 = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try { return decodeURIComponent(utf8); } catch { return utf8; }
  }
  return disposition?.match(/filename="([^"]+)"/i)?.[1]
    ?? disposition?.match(/filename=([^;]+)/i)?.[1]?.trim()
    ?? fallback;
}

async function paymentXmlResponse(response: Response, batchId: string, expectedControlSumMinor: number): Promise<PaymentXmlDownload> {
  if (!response.ok) throw await paymentError(response);
  const responseBatchId = response.headers.get('X-Payment-Batch-Id');
  const rawControlSum = response.headers.get('X-Payment-Control-Sum-Minor');
  const controlSumMinor = rawControlSum === null ? Number.NaN : Number(rawControlSum);
  if (!responseBatchId || !Number.isSafeInteger(controlSumMinor)) {
    throw new PaymentApiError('Der SEPA-Download enthält unvollständige Bestätigungsdaten.', 'PAYMENT_EXPORT_HEADERS_INVALID', {}, 502);
  }
  if (responseBatchId !== batchId || controlSumMinor !== expectedControlSumMinor) {
    throw new PaymentApiError(
      'Die Bestätigungsdaten des SEPA-Downloads stimmen nicht exakt mit dem geprüften Stapel überein.',
      'PAYMENT_EXPORT_HEADERS_MISMATCH',
      { expected_batch_id: batchId, actual_batch_id: responseBatchId, expected_control_sum_minor: expectedControlSumMinor, actual_control_sum_minor: controlSumMinor },
      502,
    );
  }
  return {
    blob: await response.blob(),
    filename: downloadFilename(response.headers.get('Content-Disposition'), `sepa-${batchId}.xml`),
    batchId: responseBatchId,
    controlSumMinor,
  };
}

export async function downloadPaymentBatchXml(
  batchId: string,
  expectedControlSumMinor: number,
  expectedRevision?: number,
  signal?: AbortSignal,
): Promise<PaymentXmlDownload> {
  const url = `${BASE}/payments/batches/${encodeURIComponent(batchId)}/export`;
  const response = expectedRevision === undefined
    ? signal ? await communityFetch(url, { signal }) : await communityFetch(url)
    : await communityFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_revision: expectedRevision, actor: 'payment-ui' }),
        signal,
      });
  return paymentXmlResponse(response, batchId, expectedControlSumMinor);
}

export const api = {
  getSummary: (year?: number, quarter?: number | null) => {
    const params = new URLSearchParams();
    if (year) params.set('year', String(year));
    if (quarter) params.set('quarter', String(quarter));
    const qs = params.toString();
    return fetchJson<any>(qs ? `/summary?${qs}` : '/summary');
  },
  runPipeline: () => fetchJson<any>('/run', { method: 'POST' }),
  getMatchStatus: (year?: number, quarter?: number | null) => {
    const params = new URLSearchParams();
    if (year) params.set('year', String(year));
    if (quarter) params.set('quarter', String(quarter));
    const qs = params.toString();
    return fetchJson<any>(qs ? `/match?${qs}` : '/match');
  },
  runMatching: () => fetchJson<any>('/match', { method: 'POST' }),

  getTransactions: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchJson<any>(`/transactions?${qs}`);
  },
  getTransaction: (id: string) => fetchJson<any>(`/transactions/${encodeURIComponent(id)}`),
  enrichPayPalTransaction: (id: string) =>
    fetchJson<any>(`/transactions/${encodeURIComponent(id)}/enrich-paypal`, { method: 'POST' }),

  getDocument: (id: string) => fetchJson<any>(`/documents/${encodeURIComponent(id)}`),
  getDocuments: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchJson<any>(`/documents?${qs}`);
  },

  deleteDocuments: (ids: string[]) =>
    fetchJson<any>('/documents/delete', { method: 'POST', body: JSON.stringify({ ids }) }),

  getMatches: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchJson<any>(`/matches?${qs}`);
  },
  getMatch: (id: string) => fetchJson<any>(`/matches/${encodeURIComponent(id)}`),
  acceptMatch: (id: string, reason?: string) =>
    fetchJson<any>(`/matches/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'accepted', reason }),
    }),
  createMatch: (txnIds: string[], docIds: string[], reason?: string) =>
    fetchJson<any>('/matches', {
      method: 'POST',
      body: JSON.stringify({ transaction_ids: txnIds, document_ids: docIds, reason }),
    }),
  deleteMatch: (id: string, reason?: string) =>
    fetchJson<any>(`/matches/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    }),

  getReviewQueue: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchJson<any>(`/review-queue?${qs}`);
  },

  getExclusions: () => fetchJson<any[]>('/exclusions'),
  createExclusion: (field: string, operator: string, value: string, description?: string) =>
    fetchJson<any>('/exclusions', {
      method: 'POST',
      body: JSON.stringify({ field, operator, value, description }),
    }),
  deleteExclusion: (id: string) =>
    fetchJson<any>(`/exclusions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getAudit: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchJson<any>(`/audit?${qs}`);
  },

  importStripe: (startDate: string, endDate: string, apiKey?: string) =>
    fetchJson<any>('/import/stripe', {
      method: 'POST',
      body: JSON.stringify({ start_date: startDate, end_date: endDate, api_key: apiKey }),
    }),

  // PayPal Import
  importPayPal: (startDate: string, endDate: string, clientId?: string, clientSecret?: string, sandbox?: boolean) =>
    fetchJson<any>('/import/paypal', {
      method: 'POST',
      body: JSON.stringify({ start_date: startDate, end_date: endDate, client_id: clientId, client_secret: clientSecret, sandbox }),
    }),

  // Enable Banking (Bank Import)
  searchBanks: (query: string, country?: string) => {
    const qs = new URLSearchParams({ q: query });
    if (country) qs.set('country', country);
    return fetchJson<any>(`/import/bank/aspsps?${qs}`);
  },
  connectBank: (aspspName: string, aspspCountry?: string) =>
    fetchJson<any>('/import/bank/connect', {
      method: 'POST',
      body: JSON.stringify({ aspsp_name: aspspName, aspsp_country: aspspCountry ?? 'AT' }),
    }),
  getBankStatus: () => fetchJson<any>('/import/bank/status'),
  importBank: (accountUids: string[], startDate: string, endDate: string) =>
    fetchJson<any>('/import/bank/transactions', {
      method: 'POST',
      body: JSON.stringify({ account_uids: accountUids, start_date: startDate, end_date: endDate }),
    }),

  // Document Import (Income / Invoice XLS/CSV)
  importDocuments: async (file: File, type: 'income' | 'invoice') => {
    const form = new FormData();
    form.append('file', file);
    form.append('type', type);
    const res = await communityFetch(BASE + '/import/documents', { method: 'POST', body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  // Belege folder management
  getBelegeInfo: () => fetchJson<any>('/belege/info'),
  openBelegeFolder: (folder: 'einkuenfte' | 'rechnungen' | 'base', year?: string) =>
    fetchJson<any>('/belege/open', {
      method: 'POST',
      body: JSON.stringify({ folder, year }),
    }),

  // Amazon Import (3 CSV files)
  importAmazon: async (sendungen: File, erstattungen: File | null, abgleich: File) => {
    const form = new FormData();
    form.append('sendungen', sendungen);
    if (erstattungen) form.append('erstattungen', erstattungen);
    form.append('abgleich', abgleich);
    const res = await communityFetch(BASE + '/import/amazon', { method: 'POST', body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  // Amazon Invoice Organization
  organizeAmazonInvoices: (sourceDir: string) =>
    fetchJson<any>('/import/amazon/organize-invoices', {
      method: 'POST',
      body: JSON.stringify({ source_dir: sourceDir }),
    }),

  // File Upload Import (Sparkasse / Visa)
  importFile: async (file: File, source: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('source', source);
    const res = await communityFetch(BASE + '/import/upload', { method: 'POST', body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  // Reports / Exports
  getReportSummary: () => fetchJson<any>('/report/summary'),
  downloadReportJson: () => BASE + '/report/json',
  downloadReportCsv: () => BASE + '/report/csv',
  getVatReport: (start: string, end: string) =>
    fetchJson<any>(`/report/vat?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  getIncomeTaxReport: (start: string, end: string) =>
    fetchJson<any>(`/report/income-tax?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  createEigenbeleg: (transactionId: string, vendor: string, country: string, description?: string, provisional?: boolean) =>
    fetchJson<any>('/documents/eigenbeleg', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_id: transactionId, vendor, country, description, provisional }),
    }),
  updateDocumentVat: (docId: string, changes: Record<string, any>) =>
    fetchJson<{ ok: boolean }>(`/documents/${encodeURIComponent(docId)}/vat-edit`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
    }),

  // Invoice Recognition
  uploadInvoices: async (files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    const res = await communityFetch(BASE + '/invoicerec/upload', { method: 'POST', body: form });
    if (!res.ok) { const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }; throw new Error(err.error || res.statusText); }
    return res.json();
  },
  uploadAndMatch: async (files: File[], transactionId: string) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    form.append('transaction_id', transactionId);
    const res = await communityFetch(BASE + '/invoicerec/upload-and-match', { method: 'POST', body: form });
    if (!res.ok) { const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }; throw new Error(err.error || res.statusText); }
    return res.json() as Promise<{ ok: boolean; results: Array<{ filename: string; scanId?: string; documentId?: string; matchGroupId?: string; error?: string }> }>;
  },
  getScans: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchJson<any>(`/invoicerec/scans?${qs}`);
  },
  getScan: (id: string) => fetchJson<any>(`/invoicerec/scans/${encodeURIComponent(id)}`),
  updateScanFields: (id: string, fields: Record<string, any>) =>
    fetchJson<any>(`/invoicerec/scans/${encodeURIComponent(id)}/fields`, {
      method: 'PUT', body: JSON.stringify(fields),
      }),
  reparseScan: (id: string) =>
    fetchJson<any>(`/invoicerec/scans/${encodeURIComponent(id)}/reparse`, { method: 'POST', body: '{}' }),
  confirmScan: (id: string, learnTemplate?: boolean) =>
    fetchJson<any>(`/invoicerec/scans/${encodeURIComponent(id)}/confirm`, {
      method: 'POST', body: JSON.stringify({ learn_template: learnTemplate }),
    }),
  rejectScan: (id: string) =>
    fetchJson<any>(`/invoicerec/scans/${encodeURIComponent(id)}/reject`, { method: 'POST', body: '{}' }),
  rescanScan: (id: string, apply = false) =>
    fetchJson<any>(`/invoicerec/scans/${encodeURIComponent(id)}/rescan`, {
      method: 'POST', body: JSON.stringify({ apply }),
    }),
  deleteScan: (id: string) =>
    fetchJson<any>(`/invoicerec/scans/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  importFolderUrl: (folderPath?: string) => {
    const params = folderPath ? `?path=${encodeURIComponent(folderPath)}` : '';
    return `${BASE}/invoicerec/import-folder${params}`;
  },
  getScanPreviewUrl: (id: string) => `${BASE}/invoicerec/scans/${encodeURIComponent(id)}/preview`,
  getScanPageUrl: (id: string, page: number) =>
    `${BASE}/invoicerec/scans/${encodeURIComponent(id)}/page/${page}`,
  getScanWords: (id: string) =>
    fetchJson<{ words: any[]; source: string }>(`/invoicerec/scans/${encodeURIComponent(id)}/words`),
  learnAndRescan: (id: string) =>
    fetchJson<any>(`/invoicerec/scans/${encodeURIComponent(id)}/learn-and-rescan`, {
      method: 'POST', body: '{}',
    }),
  getInvoiceTemplates: () => fetchJson<any[]>('/invoicerec/templates'),
  deleteInvoiceTemplate: (id: string) =>
    fetchJson<any>(`/invoicerec/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Manually initiated invoice payments
  createPaymentBatch,
  getPaymentBatch,
  updatePaymentItem,
  reviewPaymentBatch,
  downloadPaymentBatchXml,
  cancelPaymentBatch,
  importPaymentBatchToGeorge,
  getPaymentAutomationStatus,
  requestPaymentBatchRelease,

  // AI / OpenRouter
  getAiStatus: () => fetchJson<any>('/invoicerec/ai/status'),
  getAiModels: () => fetchJson<any>('/invoicerec/ai/models'),
  saveAiConfig: (apiKey?: string, model?: string, fallbackModel?: string) =>
    fetchJson<any>('/invoicerec/ai/config', {
      method: 'PUT', body: JSON.stringify({ api_key: apiKey, model, fallback_model: fallbackModel }),
    }),
  deleteAiConfig: () =>
    fetchJson<any>('/invoicerec/ai/config', { method: 'DELETE' }),

  // Backup
  getBackups: () => fetchJson<any[]>('/backups'),
  createBackup: (label?: string) =>
    fetchJson<any>('/backups', { method: 'POST', body: JSON.stringify({ label }) }),
  restoreBackup: (name: string) =>
    fetchJson<any>(`/backups/${encodeURIComponent(name)}/restore`, { method: 'POST', body: '{}' }),
  deleteBackup: (name: string) =>
    fetchJson<any>(`/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Papierkorb / Trash
  getTrash: (type?: string) => {
    const qs = type ? `?type=${type}` : '';
    return fetchJson<any[]>(`/trash${qs}`);
  },
  restoreTrash: (trashId: string) =>
    fetchJson<any>(`/trash/${encodeURIComponent(trashId)}/restore`, { method: 'POST', body: '{}' }),
  deleteTrashItem: (trashId: string) =>
    fetchJson<any>(`/trash/${encodeURIComponent(trashId)}`, { method: 'DELETE' }),
  emptyTrash: (type?: string) =>
    fetchJson<any>(`/trash${type ? `?type=${type}` : ''}`, { method: 'DELETE' }),

  getSetting: (key: string) => fetchJson<any>(`/settings/${key}`),
  saveSetting: (key: string, value: string) =>
    fetchJson<any>(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  deleteSetting: (key: string) =>
    fetchJson<any>(`/settings/${key}`, { method: 'DELETE' }),

  // Dispositions
  setDisposition: (transactionId: string, disposition: string, note?: string) =>
    fetchJson<any>(`/transactions/${encodeURIComponent(transactionId)}/disposition`, {
      method: 'POST',
      body: JSON.stringify({ disposition, note }),
    }),

  // Email compose via Betterbird
  composeEmail: (to: string, subject: string, body: string) =>
    fetchJson<any>('/compose-email', { method: 'POST', body: JSON.stringify({ to, subject, body }) }),

  // Vendor directory & email lookup
  getVendors: () => fetchJson<any[]>('/vendors'),
  updateVendor: (name: string, data: Record<string, any>) =>
    fetchJson<any>(`/vendors/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(data) }),
  getVendorEmail: (vendor: string) => fetchJson<{ email: string | null }>(`/vendor-email?vendor=${encodeURIComponent(vendor)}`),

  // Private vendors
  getPrivateVendors: () => fetchJson<any[]>('/private-vendors'),
  addPrivateVendor: (vendorName: string) =>
    fetchJson<any>('/private-vendors', {
      method: 'POST',
      body: JSON.stringify({ vendor_name: vendorName }),
    }),
  removePrivateVendor: (vendorName: string) =>
    fetchJson<any>(`/private-vendors/${encodeURIComponent(vendorName)}`, { method: 'DELETE' }),

  // Invoice Bot
  botGetPortals: () => fetchJson<any[]>('/invoice-bot/portals'),
  botFindPortalByVendor: (vendor: string) => fetchJson<{ portal: any }>(`/invoice-bot/portals/by-vendor?vendor=${encodeURIComponent(vendor)}`),
  botAutoCreatePortal: (data: { vendorName: string; baseUrl?: string; dateFrom?: string; dateTo?: string; amountHint?: string; currencyHint?: string }) =>
    fetchJson<any>('/invoice-bot/portals/auto-create', { method: 'POST', body: JSON.stringify(data) }),
  botCreatePortal: (data: any) =>
    fetchJson<any>('/invoice-bot/portals', { method: 'POST', body: JSON.stringify(data) }),
  botUpdatePortal: (id: string, data: any) =>
    fetchJson<any>(`/invoice-bot/portals/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  botDeletePortal: (id: string) =>
    fetchJson<any>(`/invoice-bot/portals/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  botCheckSession: (portalId: string) =>
    fetchJson<any>(`/invoice-bot/portals/${encodeURIComponent(portalId)}/connect-session`, { method: 'POST', body: '{}' }),
  botGetExecutorStatus: () => fetchJson<any>('/invoice-bot/executor/status'),
  botGetBrowserStatus: () => fetchJson<any>('/invoice-bot/browser/status'),
  botLaunchBrowser: () => fetchJson<any>('/invoice-bot/browser/launch', { method: 'POST', body: '{}' }),
  botLaunchProfile: (portalId?: string) =>
    fetchJson<any>('/invoice-bot/browser/launch-profile', { method: 'POST', body: JSON.stringify({ portalId }) }),
  botStartRun: (portalId: string, start: string, end: string) =>
    fetchJson<any>(`/invoice-bot/portals/${encodeURIComponent(portalId)}/runs`, {
      method: 'POST', body: JSON.stringify({ start, end }),
    }),
  botGetRuns: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return fetchJson<any>(`/invoice-bot/runs${qs}`);
  },
  botGetRun: (id: string) => fetchJson<any>(`/invoice-bot/runs/${encodeURIComponent(id)}`),
  botGetRunFiles: (id: string) => fetchJson<any[]>(`/invoice-bot/runs/${encodeURIComponent(id)}/files`),
  botGetRunEvents: (id: string) => fetchJson<any[]>(`/invoice-bot/runs/${encodeURIComponent(id)}/events`),
  botGetRunArtifacts: (id: string) => fetchJson<any[]>(`/invoice-bot/runs/${encodeURIComponent(id)}/artifacts`),
  botGetRunInvoices: (id: string) => fetchJson<any[]>(`/invoice-bot/runs/${encodeURIComponent(id)}/invoices`),
  botGetBrowserUseStatus: () => fetchJson<any>('/invoice-bot/browser-use/status'),
  botRetryRun: (id: string) =>
    fetchJson<any>(`/invoice-bot/runs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' }),
  botCancelRun: (id: string) =>
    fetchJson<any>(`/invoice-bot/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  botGetAiConfig: () => fetchJson<any>('/invoice-bot/ai/config'),
  botSaveAiConfig: (data: any) =>
    fetchJson<any>('/invoice-bot/ai/config', { method: 'PUT', body: JSON.stringify(data) }),
  botDeleteAiKey: () =>
    fetchJson<any>('/invoice-bot/ai/config', { method: 'DELETE' }),

  // Cost Monitor
  botGetCostSnapshot: () => fetchJson<any>('/invoice-bot/costs/snapshot'),
  botGetCostHistory: (limit?: number) =>
    fetchJson<any[]>(`/invoice-bot/costs/history${limit ? `?limit=${limit}` : ''}`),
  botGetSessionEntries: (id: string) =>
    fetchJson<any[]>(`/invoice-bot/costs/sessions/${encodeURIComponent(id)}/entries`),
  botSetCostLimit: (limitUsd: number | null) =>
    fetchJson<any>('/invoice-bot/costs/limit', { method: 'PUT', body: JSON.stringify({ limit_usd: limitUsd }) }),
  botApproveContinuation: () =>
    fetchJson<any>('/invoice-bot/costs/continue', { method: 'POST', body: '{}' }),
};
