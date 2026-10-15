/**
 * SQLite repository for Invoice Bot entities.
 * All DB access for portals, runs, files, and events goes through here.
 */
import { randomUUID } from 'crypto';
import { getDb } from '../storage/db.js';
import type {
  PortalConfig, CollectionRun, CollectedFile, BotEvent,
  CreatePortalParams, CreateRunParams, CollectionRunStatus,
  ImportStatus, RunStats, EventLevel,
  BrowserProfile, RunArtifact, ArtifactType, ExtractedInvoice, ExtractedInvoiceImportStatus,
} from './types.js';

// ==================== ID generation ====================
// All IDs use crypto.randomUUID() for uniqueness guarantees.
// Prefixes are kept for human readability and log grep-ability.

function genId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// ==================== Serialization helpers ====================

function deserializePortal(row: any): PortalConfig {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    portalType: row.portal_type,
    openclawProfile: row.openclaw_profile,
    sessionMode: row.session_mode,
    active: !!row.active,
    defaultDownloadPath: row.default_download_path ?? undefined,
    invoicePageHints: row.invoice_page_hints_json ? JSON.parse(row.invoice_page_hints_json) : undefined,
    dateFieldHints: row.date_field_hints_json ? JSON.parse(row.date_field_hints_json) : undefined,
    adapterType: row.adapter_type ?? 'amazon',
    runStrategy: row.run_strategy ?? 'agentic',
    loginStrategy: row.login_strategy ?? 'existing_session',
    credentialRef: row.credential_ref ?? undefined,
    taskPrompt: row.task_prompt ?? undefined,
    maxCostPerRun: row.max_cost_per_run ?? undefined,
    portalState: row.portal_state ?? 'active',
    requiresHumanLogin: !!row.requires_human_login,
    reviewPolicy: row.review_policy ?? 'review_if_uncertain',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeRun(row: any): CollectionRun {
  return {
    id: row.id,
    portalId: row.portal_id,
    requestedStart: row.requested_start,
    requestedEnd: row.requested_end,
    status: row.status,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    errorMessage: row.error_message ?? undefined,
    stats: JSON.parse(row.stats_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeFile(row: any): CollectedFile {
  return {
    id: row.id,
    runId: row.run_id,
    portalId: row.portal_id,
    originalFilename: row.original_filename,
    storedPath: row.stored_path,
    sha256: row.sha256,
    invoiceDate: row.invoice_date ?? undefined,
    supplierHint: row.supplier_hint ?? undefined,
    importStatus: row.import_status,
    documentId: row.document_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeEvent(row: any): BotEvent {
  return {
    id: row.id,
    runId: row.run_id,
    level: row.level,
    code: row.code,
    message: row.message,
    payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
    createdAt: row.created_at,
  };
}

// ==================== Portals ====================

export function createPortal(params: CreatePortalParams): PortalConfig {
  const now = new Date().toISOString();
  const id = genId('PRT');
  const db = getDb();

  db.prepare(`
    INSERT INTO invoice_bot_portals (
      id, name, base_url, portal_type, openclaw_profile, session_mode,
      active, default_download_path, invoice_page_hints_json, date_field_hints_json,
      adapter_type, run_strategy, login_strategy, credential_ref, task_prompt,
      max_cost_per_run, requires_human_login, review_policy,
      created_at, updated_at
    ) VALUES (
      @id, @name, @base_url, @portal_type, @openclaw_profile, @session_mode,
      @active, @default_download_path, @invoice_page_hints_json, @date_field_hints_json,
      @adapter_type, @run_strategy, @login_strategy, @credential_ref, @task_prompt,
      @max_cost_per_run, @requires_human_login, @review_policy,
      @created_at, @updated_at
    )
  `).run({
    id,
    name: params.name,
    base_url: params.baseUrl,
    portal_type: params.portalType ?? 'generic',
    openclaw_profile: params.openclawProfile ?? 'user',
    session_mode: params.sessionMode ?? 'session-first',
    active: 1,
    default_download_path: params.defaultDownloadPath ?? null,
    invoice_page_hints_json: params.invoicePageHints ? JSON.stringify(params.invoicePageHints) : null,
    date_field_hints_json: params.dateFieldHints ? JSON.stringify(params.dateFieldHints) : null,
    adapter_type: params.adapterType ?? 'amazon',
    run_strategy: params.runStrategy ?? 'agentic',
    login_strategy: params.loginStrategy ?? 'existing_session',
    credential_ref: params.credentialRef ?? null,
    task_prompt: params.taskPrompt ?? null,
    max_cost_per_run: params.maxCostPerRun ?? null,
    requires_human_login: params.requiresHumanLogin ? 1 : 0,
    review_policy: params.reviewPolicy ?? 'review_if_uncertain',
    created_at: now,
    updated_at: now,
  });

  return getPortal(id)!;
}

export function getPortal(id: string): PortalConfig | null {
  const row = getDb().prepare('SELECT * FROM invoice_bot_portals WHERE id = ?').get(id) as any;
  return row ? deserializePortal(row) : null;
}

export function listPortals(): PortalConfig[] {
  const rows = getDb().prepare('SELECT * FROM invoice_bot_portals ORDER BY name').all() as any[];
  return rows.map(deserializePortal);
}

export function updatePortal(id: string, updates: Partial<CreatePortalParams> & { active?: boolean }): PortalConfig | null {
  const existing = getPortal(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const db = getDb();

  db.prepare(`
    UPDATE invoice_bot_portals SET
      name = @name, base_url = @base_url, portal_type = @portal_type,
      openclaw_profile = @openclaw_profile, session_mode = @session_mode,
      active = @active, default_download_path = @default_download_path,
      invoice_page_hints_json = @invoice_page_hints_json,
      date_field_hints_json = @date_field_hints_json,
      adapter_type = @adapter_type, run_strategy = @run_strategy,
      login_strategy = @login_strategy, credential_ref = @credential_ref,
      task_prompt = @task_prompt, max_cost_per_run = @max_cost_per_run,
      requires_human_login = @requires_human_login, review_policy = @review_policy,
      updated_at = @updated_at
    WHERE id = @id
  `).run({
    id,
    name: updates.name ?? existing.name,
    base_url: updates.baseUrl ?? existing.baseUrl,
    portal_type: updates.portalType ?? existing.portalType,
    openclaw_profile: updates.openclawProfile ?? existing.openclawProfile,
    session_mode: updates.sessionMode ?? existing.sessionMode,
    active: updates.active !== undefined ? (updates.active ? 1 : 0) : (existing.active ? 1 : 0),
    default_download_path: updates.defaultDownloadPath ?? existing.defaultDownloadPath ?? null,
    invoice_page_hints_json: updates.invoicePageHints
      ? JSON.stringify(updates.invoicePageHints)
      : (existing.invoicePageHints ? JSON.stringify(existing.invoicePageHints) : null),
    date_field_hints_json: updates.dateFieldHints
      ? JSON.stringify(updates.dateFieldHints)
      : (existing.dateFieldHints ? JSON.stringify(existing.dateFieldHints) : null),
    adapter_type: updates.adapterType ?? existing.adapterType,
    run_strategy: updates.runStrategy ?? existing.runStrategy,
    login_strategy: updates.loginStrategy ?? existing.loginStrategy,
    credential_ref: updates.credentialRef ?? existing.credentialRef ?? null,
    task_prompt: updates.taskPrompt ?? existing.taskPrompt ?? null,
    max_cost_per_run: updates.maxCostPerRun ?? existing.maxCostPerRun ?? null,
    requires_human_login: updates.requiresHumanLogin !== undefined
      ? (updates.requiresHumanLogin ? 1 : 0)
      : (existing.requiresHumanLogin ? 1 : 0),
    review_policy: updates.reviewPolicy ?? existing.reviewPolicy,
    updated_at: now,
  });

  return getPortal(id);
}

// ==================== Runs ====================

export function createRun(params: CreateRunParams): CollectionRun {
  const now = new Date().toISOString();
  const id = genId('RUN');
  const db = getDb();

  const emptyStats: RunStats = { found: 0, downloaded: 0, imported: 0, duplicates: 0, failed: 0 };

  db.prepare(`
    INSERT INTO invoice_bot_runs (
      id, portal_id, requested_start, requested_end, status, stats_json, created_at, updated_at
    ) VALUES (@id, @portal_id, @requested_start, @requested_end, @status, @stats_json, @created_at, @updated_at)
  `).run({
    id,
    portal_id: params.portalId,
    requested_start: params.requestedStart,
    requested_end: params.requestedEnd,
    status: 'queued' as CollectionRunStatus,
    stats_json: JSON.stringify(emptyStats),
    created_at: now,
    updated_at: now,
  });

  return getRun(id)!;
}

export function getRun(id: string): CollectionRun | null {
  const row = getDb().prepare('SELECT * FROM invoice_bot_runs WHERE id = ?').get(id) as any;
  return row ? deserializeRun(row) : null;
}

export function listRuns(portalId?: string, limit = 50, offset = 0): { items: CollectionRun[]; total: number } {
  const db = getDb();
  const where = portalId ? 'WHERE portal_id = ?' : '';
  const params = portalId ? [portalId] : [];

  const total = (db.prepare(`SELECT COUNT(*) as c FROM invoice_bot_runs ${where}`).get(...params) as any).c;
  const rows = db.prepare(
    `SELECT * FROM invoice_bot_runs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as any[];

  return { items: rows.map(deserializeRun), total };
}

/** Valid status transitions. A transition not in this map is rejected. */
const VALID_TRANSITIONS: Record<CollectionRunStatus, CollectionRunStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['downloading', 'waiting_for_login', 'importing', 'completed', 'partial', 'failed', 'cancelled'],
  waiting_for_login: ['queued', 'cancelled', 'failed'],
  downloading: ['importing', 'completed', 'partial', 'failed', 'cancelled'],
  importing: ['completed', 'partial', 'failed', 'cancelled'],
  completed: [],
  partial: [],
  failed: ['queued'], // retry resets to queued
  cancelled: [],
};

export function isValidTransition(from: CollectionRunStatus, to: CollectionRunStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function updateRunStatus(
  id: string,
  status: CollectionRunStatus,
  extra?: { errorMessage?: string; stats?: RunStats },
): void {
  // Validate transition
  const current = getRun(id);
  if (current && !isValidTransition(current.status, status)) {
    throw new Error(`Ungültiger Statuswechsel: ${current.status} → ${status} (Run ${id})`);
  }

  const now = new Date().toISOString();
  const db = getDb();

  const sets = ['status = @status', 'updated_at = @updated_at'];
  const binds: Record<string, any> = { id, status, updated_at: now };

  if (status === 'running' || status === 'downloading') {
    sets.push('started_at = COALESCE(started_at, @started_at)');
    binds.started_at = now;
  }
  if (['completed', 'partial', 'failed', 'cancelled'].includes(status)) {
    sets.push('finished_at = @finished_at');
    binds.finished_at = now;
  }
  if (extra?.errorMessage !== undefined) {
    sets.push('error_message = @error_message');
    binds.error_message = extra.errorMessage;
  }
  if (extra?.stats) {
    sets.push('stats_json = @stats_json');
    binds.stats_json = JSON.stringify(extra.stats);
  }

  db.prepare(`UPDATE invoice_bot_runs SET ${sets.join(', ')} WHERE id = @id`).run(binds);
}

// ==================== Files ====================

export function createFile(params: {
  runId: string;
  portalId: string;
  originalFilename: string;
  storedPath: string;
  sha256: string;
  invoiceDate?: string;
  supplierHint?: string;
}): CollectedFile {
  const now = new Date().toISOString();
  const id = genId('IBF');
  const db = getDb();

  db.prepare(`
    INSERT INTO invoice_bot_files (
      id, run_id, portal_id, original_filename, stored_path, sha256,
      invoice_date, supplier_hint, import_status, created_at, updated_at
    ) VALUES (@id, @run_id, @portal_id, @original_filename, @stored_path, @sha256,
      @invoice_date, @supplier_hint, @import_status, @created_at, @updated_at)
  `).run({
    id,
    run_id: params.runId,
    portal_id: params.portalId,
    original_filename: params.originalFilename,
    stored_path: params.storedPath,
    sha256: params.sha256,
    invoice_date: params.invoiceDate ?? null,
    supplier_hint: params.supplierHint ?? null,
    import_status: 'pending' as ImportStatus,
    created_at: now,
    updated_at: now,
  });

  return getFile(id)!;
}

export function getFile(id: string): CollectedFile | null {
  const row = getDb().prepare('SELECT * FROM invoice_bot_files WHERE id = ?').get(id) as any;
  return row ? deserializeFile(row) : null;
}

export function getFilesBySha256(sha256: string): CollectedFile[] {
  const rows = getDb().prepare('SELECT * FROM invoice_bot_files WHERE sha256 = ?').all(sha256) as any[];
  return rows.map(deserializeFile);
}

export function listFilesByRun(runId: string): CollectedFile[] {
  const rows = getDb().prepare(
    'SELECT * FROM invoice_bot_files WHERE run_id = ? ORDER BY created_at'
  ).all(runId) as any[];
  return rows.map(deserializeFile);
}

export function updateFileImportStatus(id: string, status: ImportStatus, documentId?: string): void {
  const now = new Date().toISOString();
  getDb().prepare(
    'UPDATE invoice_bot_files SET import_status = ?, document_id = ?, updated_at = ? WHERE id = ?'
  ).run(status, documentId ?? null, now, id);
}

// ==================== Events ====================

export function createEvent(
  runId: string,
  level: EventLevel,
  code: string,
  message: string,
  payload?: unknown,
): BotEvent {
  const now = new Date().toISOString();
  const id = genId('EVT');

  getDb().prepare(`
    INSERT INTO invoice_bot_events (id, run_id, level, code, message, payload_json, created_at)
    VALUES (@id, @run_id, @level, @code, @message, @payload_json, @created_at)
  `).run({
    id,
    run_id: runId,
    level,
    code,
    message,
    payload_json: payload != null ? JSON.stringify(payload) : null,
    created_at: now,
  });

  return { id, runId, level, code, message, payload, createdAt: now };
}

export function listEventsByRun(runId: string): BotEvent[] {
  const rows = getDb().prepare(
    'SELECT * FROM invoice_bot_events WHERE run_id = ? ORDER BY created_at'
  ).all(runId) as any[];
  return rows.map(deserializeEvent);
}

// ==================== Browser Profiles ====================

export function createProfile(portalId: string, profileDir: string): BrowserProfile {
  const now = new Date().toISOString();
  const id = genId('BPR');
  getDb().prepare(`
    INSERT INTO invoice_bot_profiles (id, portal_id, profile_dir, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(id, portalId, profileDir, now, now);
  return { id, portalId, profileDir, status: 'active', createdAt: now, updatedAt: now };
}

export function getProfileForPortal(portalId: string): BrowserProfile | null {
  const row = getDb().prepare(
    "SELECT * FROM invoice_bot_profiles WHERE portal_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get(portalId) as any;
  if (!row) return null;
  return {
    id: row.id, portalId: row.portal_id, profileDir: row.profile_dir,
    status: row.status, lastVerifiedAt: row.last_verified_at ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function updateProfileStatus(id: string, status: 'active' | 'stale' | 'broken'): void {
  getDb().prepare('UPDATE invoice_bot_profiles SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
}

export function updateProfileVerified(id: string): void {
  const now = new Date().toISOString();
  getDb().prepare('UPDATE invoice_bot_profiles SET last_verified_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, id);
}

// ==================== Artifacts ====================

export function createArtifact(params: {
  runId: string; type: ArtifactType; localPath: string;
  mimeType?: string; sha256?: string; sourceUrl?: string; label?: string; sizeBytes?: number;
}): RunArtifact {
  const now = new Date().toISOString();
  const id = genId('ART');
  getDb().prepare(`
    INSERT INTO invoice_bot_artifacts (id, run_id, type, local_path, mime_type, sha256, source_url, label, size_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.runId, params.type, params.localPath, params.mimeType ?? null,
    params.sha256 ?? null, params.sourceUrl ?? null, params.label ?? null, params.sizeBytes ?? null, now);
  return { id, runId: params.runId, type: params.type, localPath: params.localPath,
    mimeType: params.mimeType, sha256: params.sha256, sourceUrl: params.sourceUrl,
    label: params.label, sizeBytes: params.sizeBytes, createdAt: now };
}

export function listArtifactsByRun(runId: string): RunArtifact[] {
  const rows = getDb().prepare('SELECT * FROM invoice_bot_artifacts WHERE run_id = ? ORDER BY created_at').all(runId) as any[];
  return rows.map(r => ({
    id: r.id, runId: r.run_id, type: r.type, localPath: r.local_path,
    mimeType: r.mime_type ?? undefined, sha256: r.sha256 ?? undefined,
    sourceUrl: r.source_url ?? undefined, label: r.label ?? undefined,
    sizeBytes: r.size_bytes ?? undefined, createdAt: r.created_at,
  }));
}

// ==================== Extracted Invoices ====================

export function createExtractedInvoice(params: {
  runId: string; portalId: string; downloadedFilename: string; sha256: string;
  artifactId?: string; supplierName?: string; invoiceNumber?: string; invoiceDate?: string;
  currency?: string; grossTotalMinor?: number; portalReference?: string;
  extractionConfidence?: number; requiresReview?: boolean; evidenceArtifactId?: string; sourceUrl?: string;
}): ExtractedInvoice {
  const now = new Date().toISOString();
  const id = genId('EXI');
  getDb().prepare(`
    INSERT INTO invoice_bot_extracted_invoices (
      id, run_id, portal_id, supplier_name, invoice_number, invoice_date, currency,
      gross_total_minor, portal_reference, downloaded_filename, artifact_id, sha256,
      extraction_confidence, requires_review, evidence_artifact_id, source_url,
      import_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, params.runId, params.portalId, params.supplierName ?? null,
    params.invoiceNumber ?? null, params.invoiceDate ?? null, params.currency ?? 'EUR',
    params.grossTotalMinor ?? null, params.portalReference ?? null, params.downloadedFilename,
    params.artifactId ?? null, params.sha256, params.extractionConfidence ?? null,
    params.requiresReview !== false ? 1 : 0, params.evidenceArtifactId ?? null,
    params.sourceUrl ?? null, now, now);
  return {
    id, runId: params.runId, portalId: params.portalId,
    supplierName: params.supplierName, invoiceNumber: params.invoiceNumber,
    invoiceDate: params.invoiceDate, currency: params.currency ?? 'EUR',
    grossTotalMinor: params.grossTotalMinor, portalReference: params.portalReference,
    downloadedFilename: params.downloadedFilename, artifactId: params.artifactId,
    sha256: params.sha256, extractionConfidence: params.extractionConfidence,
    requiresReview: params.requiresReview !== false, evidenceArtifactId: params.evidenceArtifactId,
    sourceUrl: params.sourceUrl, importStatus: 'pending', documentId: undefined,
    createdAt: now, updatedAt: now,
  };
}

export function updateExtractedInvoiceStatus(id: string, status: ExtractedInvoiceImportStatus, documentId?: string): void {
  getDb().prepare('UPDATE invoice_bot_extracted_invoices SET import_status = ?, document_id = ?, updated_at = ? WHERE id = ?')
    .run(status, documentId ?? null, new Date().toISOString(), id);
}

export function listExtractedInvoicesByRun(runId: string): ExtractedInvoice[] {
  const rows = getDb().prepare('SELECT * FROM invoice_bot_extracted_invoices WHERE run_id = ? ORDER BY created_at').all(runId) as any[];
  return rows.map(r => ({
    id: r.id, runId: r.run_id, portalId: r.portal_id,
    supplierName: r.supplier_name ?? undefined, invoiceNumber: r.invoice_number ?? undefined,
    invoiceDate: r.invoice_date ?? undefined, currency: r.currency ?? 'EUR',
    grossTotalMinor: r.gross_total_minor ?? undefined, portalReference: r.portal_reference ?? undefined,
    downloadedFilename: r.downloaded_filename, artifactId: r.artifact_id ?? undefined,
    sha256: r.sha256, extractionConfidence: r.extraction_confidence ?? undefined,
    requiresReview: !!r.requires_review, evidenceArtifactId: r.evidence_artifact_id ?? undefined,
    sourceUrl: r.source_url ?? undefined, importStatus: r.import_status,
    documentId: r.document_id ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

export function findExtractedInvoiceBySha256(portalId: string, sha256: string): ExtractedInvoice | null {
  const row = getDb().prepare(
    'SELECT * FROM invoice_bot_extracted_invoices WHERE portal_id = ? AND sha256 = ? LIMIT 1'
  ).get(portalId, sha256) as any;
  if (!row) return null;
  return listExtractedInvoicesByRun(row.run_id).find(i => i.id === row.id) ?? null;
}

// ==================== Run cost/counter updates ====================

export function updateRunCost(runId: string, cost: number, tokens: number): void {
  getDb().prepare('UPDATE invoice_bot_runs SET total_cost = ?, total_tokens = ?, updated_at = ? WHERE id = ?')
    .run(cost, tokens, new Date().toISOString(), runId);
}

export function incrementRunCounters(runId: string, field: 'warnings_count' | 'invoices_found_count' | 'files_downloaded_count'): void {
  getDb().prepare(`UPDATE invoice_bot_runs SET ${field} = ${field} + 1, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), runId);
}
