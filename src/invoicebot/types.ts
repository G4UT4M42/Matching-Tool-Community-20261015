/**
 * Domain types for the Invoice Bot module.
 */

export type PortalType = 'amazon' | 'alibaba' | 'generic' | 'custom' | 'browser_use' | 'openai' | 'chatgpt' | 'aliexpress' | 'google_cloud' | 'google_one' | 'bambulab' | 'post_at' | 'spotify' | 'fiverr';
export type AdapterType = 'amazon' | 'browser_use' | 'manual' | 'openai' | 'chatgpt' | 'aliexpress' | 'google_cloud' | 'google_one' | 'bambulab' | 'post_at' | 'spotify' | 'fiverr';
export type RunStrategy = 'agentic' | 'deterministic' | 'manual';
export type LoginStrategy = 'credentials' | 'manual' | 'sso' | 'existing_session';
export type PortalState = 'active' | 'needs_review' | 'broken' | 'manual_only' | 'disabled';
export type ReviewPolicy = 'auto_import' | 'review_if_uncertain' | 'always_review';
export type RunMode = 'check_session' | 'dry_run' | 'collect_invoices';
export type OpenclawProfile = 'openclaw' | 'user' | 'remote';
export type SessionMode = 'session-first' | 'http-basic';

export interface PortalConfig {
  id: string;
  name: string;
  baseUrl: string;
  portalType: PortalType;
  openclawProfile: OpenclawProfile;
  sessionMode: SessionMode;
  active: boolean;
  defaultDownloadPath?: string;
  invoicePageHints?: string[];
  dateFieldHints?: string[];
  // Browser-use extensions
  adapterType: AdapterType;
  runStrategy: RunStrategy;
  loginStrategy: LoginStrategy;
  credentialRef?: string;
  taskPrompt?: string;
  maxCostPerRun?: number;
  portalState: PortalState;
  requiresHumanLogin: boolean;
  reviewPolicy: ReviewPolicy;
  createdAt: string;
  updatedAt: string;
}

export type CollectionRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_login'
  | 'downloading'
  | 'importing'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface RunStats {
  found: number;
  downloaded: number;
  imported: number;
  duplicates: number;
  failed: number;
}

export interface CollectionRun {
  id: string;
  portalId: string;
  requestedStart: string;
  requestedEnd: string;
  status: CollectionRunStatus;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
  stats: RunStats;
  createdAt: string;
  updatedAt: string;
}

export type ImportStatus = 'pending' | 'imported' | 'duplicate' | 'failed';

export interface CollectedFile {
  id: string;
  runId: string;
  portalId: string;
  originalFilename: string;
  storedPath: string;
  sha256: string;
  invoiceDate?: string;
  supplierHint?: string;
  importStatus: ImportStatus;
  documentId?: string;
  createdAt: string;
  updatedAt: string;
}

export type EventLevel = 'info' | 'warn' | 'error';

export interface BotEvent {
  id: string;
  runId: string;
  level: EventLevel;
  code: string;
  message: string;
  payload?: unknown;
  createdAt: string;
}

/** Parameters for creating a new portal */
export interface CreatePortalParams {
  name: string;
  baseUrl: string;
  portalType?: PortalType;
  openclawProfile?: OpenclawProfile;
  sessionMode?: SessionMode;
  defaultDownloadPath?: string;
  invoicePageHints?: string[];
  dateFieldHints?: string[];
  // Browser-use extensions
  adapterType?: AdapterType;
  runStrategy?: RunStrategy;
  loginStrategy?: LoginStrategy;
  credentialRef?: string;
  taskPrompt?: string;
  maxCostPerRun?: number;
  requiresHumanLogin?: boolean;
  reviewPolicy?: ReviewPolicy;
}

/** Parameters for creating a new run */
export interface CreateRunParams {
  portalId: string;
  requestedStart: string;
  requestedEnd: string;
}

/** Result from OpenClaw adapter for a single collected file */
export interface OpenclawFileResult {
  filename: string;
  localPath: string;
  invoiceDate?: string;
  supplierHint?: string;
}

/** Result from OpenClaw adapter for a collection run */
export interface OpenclawRunResult {
  status: 'completed' | 'partial' | 'failed' | 'waiting_for_login';
  files: OpenclawFileResult[];
  errorMessage?: string;
}

// ==================== Session / Executor types ====================

/** Granular session check result */
export interface SessionCheckResult {
  /** Chrome/executor process responds on CDP port */
  browserReachable: boolean;
  /** Can navigate to the portal URL without network error */
  portalReachable: boolean;
  /** Logged in (portal-specific check, e.g. account menu visible) */
  loggedIn: boolean;
  /** Invoice/order area accessible (portal-specific) */
  invoiceAreaAccessible: boolean;
  /** Human-readable status */
  message: string;
  /** Detail messages per check step */
  details: string[];
}

// ==================== Portal adapter interface ====================

/** A portal adapter encodes portal-specific navigation and download logic */
export interface PortalAdapter {
  /** Portal type this adapter handles */
  readonly portalType: PortalType;

  /** Check session state for this portal */
  checkSession(portal: PortalConfig): Promise<SessionCheckResult>;

  /** Collect invoices for a date range. Downloads to a temp folder. */
  collectInvoices(
    portal: PortalConfig,
    dateRange: { start: string; end: string },
    downloadDir: string,
    onProgress?: (msg: string) => void,
  ): Promise<OpenclawRunResult>;
}

// ==================== Browser-Use specific types ====================

export interface BrowserProfile {
  id: string;
  portalId: string;
  profileDir: string;
  status: 'active' | 'stale' | 'broken';
  lastVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ArtifactType = 'screenshot' | 'download' | 'html_snapshot' | 'log_bundle';

export interface RunArtifact {
  id: string;
  runId: string;
  type: ArtifactType;
  localPath: string;
  mimeType?: string;
  sha256?: string;
  sourceUrl?: string;
  label?: string;
  sizeBytes?: number;
  createdAt: string;
}

export type ExtractedInvoiceImportStatus = 'pending' | 'skipped_duplicate' | 'ready_for_import' | 'imported' | 'failed';

export interface ExtractedInvoice {
  id: string;
  runId: string;
  portalId: string;
  supplierName?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  currency: string;
  grossTotalMinor?: number;
  portalReference?: string;
  downloadedFilename: string;
  artifactId?: string;
  sha256: string;
  extractionConfidence?: number;
  requiresReview: boolean;
  evidenceArtifactId?: string;
  sourceUrl?: string;
  importStatus: ExtractedInvoiceImportStatus;
  documentId?: string;
  createdAt: string;
  updatedAt: string;
}

// ==================== Worker event protocol ====================

export type WorkerEventType =
  | 'run.started' | 'run.progress' | 'auth.required'
  | 'browser.url' | 'browser.screenshot' | 'browser.message'
  | 'file.detected' | 'file.downloaded'
  | 'invoice.extracted' | 'cost.update'
  | 'run.warning' | 'run.error' | 'run.finished';

export interface WorkerEvent {
  type: WorkerEventType;
  runId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
