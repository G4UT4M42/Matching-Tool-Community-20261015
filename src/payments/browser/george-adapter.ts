import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type Database from 'better-sqlite3';

import { ExecutorBusyError } from '../../invoicebot/errors.js';
import { acquireExecutorLock, releaseExecutorLock } from '../../invoicebot/openclaw-client.js';
import { getDb } from '../../storage/db.js';
import { resolveAccountingPaths, resolveRuntimePath } from '../../storage/paths.js';
import { FIXED_DEBTOR } from '../types.js';
import { PaymentRepository, type PaymentAutomationRun } from '../repository.js';
import { isSepaIban, isValidIban, normalizeIban } from '../validation.js';
import { createGeorgePageDriver } from './george-page-driver.js';
import {
  GEORGE_USER_NUMBER,
  GeorgeAutomationError,
  type AutomationPhase,
  type GeorgePageDriver,
  type ObservedAccount,
  type ObservedPackage,
  type PackageIdentity,
  type ReleaseConfirmation,
} from './types.js';

interface GeorgeRuntimeOptions {
  repository: PaymentRepository;
  database?: Database.Database;
  driverFactory?: () => Promise<GeorgePageDriver>;
  acquireLock?: (runId: string) => void;
  releaseLock?: (runId: string) => void;
  tempRoot?: string;
  releaseTimeoutMs?: number;

  delay?: (milliseconds: number) => Promise<void>;
  tokenFactory?: () => string;
  writeArtifact?: typeof writeFile;
  clock?: () => Date;
}

interface InternalRun {
  runId: string;
  batchId: string;
  phase: AutomationPhase;
  importFilename: string;
  uploadAttemptedAt: string | null;
  releaseConfirmation: PersistedReleaseConfirmation | null;
  releaseRequestToken: string | null;
  releaseClickClaimedAt: string | null;
  releaseClickedAt: string | null;
  releaseRetryClaimedAt: string | null;
  releaseRetryClickedAt: string | null;
  releaseRetryCount: number;
  packageReference: string | null;
  errorCode: string | null;
  expected: PackageIdentity;
  observed: ObservedPackage | null;
}

interface ConfirmedReleaseSnapshot {
  revision: number;
  debtorIban: string;
  itemCount: number;
  controlSumMinor: number;
  xmlSha256: string;
}

interface PersistedReleaseConfirmation extends ConfirmedReleaseSnapshot {
  recovery: 'none' | 'stable_prepared';
}

const INTERNAL_ID = /^[A-Za-z0-9_-]{1,200}$/;
const DEFAULT_RELEASE_TIMEOUT_MS = 5 * 60_000;
const UNKNOWN_RECOVERY_STEP_MS = 30_000;
const FINAL = new Set<AutomationPhase>(['released', 'failed']);
const AUTOMATION_PHASES: readonly AutomationPhase[] = [
  'queued', 'connecting_browser', 'waiting_login_2fa', 'uploading', 'upload_attempted',
  'verifying_import', 'prepared', 'requesting_release', 'release_click_claimed',
  'waiting_release_2fa', 'verifying_release', 'released', 'failed', 'unknown',
];
const URL_CLASSES = ['login', 'overview', 'data_import', 'package_list', 'package_detail', 'release_pending'] as const;

const TRANSITIONS: Record<AutomationPhase, ReadonlySet<AutomationPhase>> = {
  queued: new Set(['queued', 'connecting_browser', 'failed']),
  connecting_browser: new Set(['waiting_login_2fa', 'uploading', 'failed']),
  waiting_login_2fa: new Set(['connecting_browser', 'prepared', 'failed']),
  uploading: new Set(['upload_attempted', 'failed']),
  upload_attempted: new Set(['verifying_import', 'unknown', 'failed']),
  verifying_import: new Set(['prepared', 'failed']),
  prepared: new Set(['prepared', 'requesting_release', 'failed']),
  requesting_release: new Set(['release_click_claimed', 'prepared', 'unknown', 'failed']),
  release_click_claimed: new Set(['waiting_release_2fa', 'unknown', 'failed']),
  waiting_release_2fa: new Set(['verifying_release', 'unknown', 'failed']),
  verifying_release: new Set(['released', 'unknown', 'failed']),
  released: new Set(['released']),
  failed: new Set(['failed', 'requesting_release']),
  unknown: new Set(['connecting_browser', 'uploading', 'verifying_import', 'prepared', 'requesting_release', 'waiting_release_2fa', 'verifying_release', 'unknown', 'failed']),
};

function errorCode(error: unknown): string {
  if (error instanceof GeorgeAutomationError || error instanceof ExecutorBusyError) return error.code;
  const candidate = error as { code?: unknown };
  if (typeof candidate?.code === 'string') return candidate.code;
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(':', 1)[0].trim();
  return /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'GEORGE_AUTOMATION_FAILED';
}

function exactAccount(observed: ObservedAccount): boolean {
  return observed.accountLabel === FIXED_DEBTOR.accountLabel
    && observed.iban.replace(/\s/g, '').toUpperCase() === FIXED_DEBTOR.iban;
}

function exactPackage(expected: PackageIdentity, observed: ObservedPackage): boolean {
  return exactAccount(observed.account)
    && observed.itemCount === expected.itemCount
    && observed.controlSumMinor === expected.controlSumMinor
    && observed.messageId === expected.messageId
    && observed.importFilename === expected.importFilename;
}

function exactValue(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validExpected(value: unknown, importFilename: string): value is PackageIdentity {
  if (!value || typeof value !== 'object'
    || !exactKeys(value, ['artifactSha256','messageId','importFilename','expectedAccount','itemCount','controlSumMinor'])) return false;
  const expected = value as Record<string, unknown>;
  const account = expected.expectedAccount;
  return /^[a-f0-9]{64}$/.test(String(expected.artifactSha256))
    && typeof expected.messageId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(expected.messageId)
    && expected.importFilename === importFilename
    && Number.isSafeInteger(expected.itemCount) && Number(expected.itemCount) > 0
    && Number.isSafeInteger(expected.controlSumMinor) && Number(expected.controlSumMinor) > 0
    && !!account && typeof account === 'object'
    && exactKeys(account, ['accountLabel','accountHolder','iban','currencyCode'])
    && (account as Record<string, unknown>).accountLabel === FIXED_DEBTOR.accountLabel
    && (account as Record<string, unknown>).accountHolder === FIXED_DEBTOR.accountHolder
    && (account as Record<string, unknown>).iban === FIXED_DEBTOR.iban
    && (account as Record<string, unknown>).currencyCode === FIXED_DEBTOR.currencyCode;
}

function validReleaseConfirmation(value: unknown): value is PersistedReleaseConfirmation {
  if (!value || typeof value !== 'object'
    || !exactKeys(value, ['revision','debtorIban','itemCount','controlSumMinor','xmlSha256','recovery'])) return false;
  const confirmation = value as Record<string, unknown>;
  return Number.isSafeInteger(confirmation.revision) && Number(confirmation.revision) > 0
    && confirmation.debtorIban === FIXED_DEBTOR.iban
    && Number.isSafeInteger(confirmation.itemCount) && Number(confirmation.itemCount) > 0
    && Number.isSafeInteger(confirmation.controlSumMinor) && Number(confirmation.controlSumMinor) > 0
    && typeof confirmation.xmlSha256 === 'string' && /^[a-f0-9]{64}$/.test(confirmation.xmlSha256)
    && ['none', 'stable_prepared'].includes(String(confirmation.recovery));
}

function assertUrlClass(value: string | null): void {
  if (value !== null && !URL_CLASSES.includes(value as typeof URL_CLASSES[number])) {
    throw new GeorgeAutomationError('PORTAL_LAYOUT_CHANGED');
  }
}

function assertReleaseConfirmation(
  run: InternalRun,
  batch: ReturnType<PaymentRepository['getBatch']>,
  confirmation: ReleaseConfirmation,
): void {
  if (!batch || batch.batchId !== run.batchId || batch.status !== 'prepared'
    || typeof confirmation !== 'object' || confirmation === null
    || typeof confirmation.debtorIban !== 'string' || !Number.isSafeInteger(confirmation.itemCount)
    || !Number.isSafeInteger(confirmation.controlSumMinor) || typeof confirmation.xmlSha256 !== 'string'
    || !/^[a-f0-9]{64}$/i.test(confirmation.xmlSha256)
    || !exactValue(confirmation.debtorIban.replace(/\s/g, '').toUpperCase(), batch.debtorIban)
    || confirmation.itemCount !== batch.itemCount || confirmation.itemCount !== run.expected.itemCount
    || confirmation.controlSumMinor !== batch.controlSumMinor || confirmation.controlSumMinor !== run.expected.controlSumMinor
    || !batch.xmlSha256 || !exactValue(confirmation.xmlSha256.toLowerCase(), batch.xmlSha256.toLowerCase())
    || !exactValue(confirmation.xmlSha256.toLowerCase(), run.expected.artifactSha256.toLowerCase())) {
    throw new GeorgeAutomationError('RELEASE_CONFIRMATION_MISMATCH');
  }
}

function sanitizeObserved(observed: ObservedPackage): ObservedPackage {
  const normalizedIban = typeof observed?.account?.iban === 'string' ? normalizeIban(observed.account.iban) : '';
  if (!observed || typeof observed !== 'object'
    || !exactKeys(observed, ['reference','importFilename','account','itemCount','controlSumMinor','messageId','warnings','status'])
    || typeof observed.account !== 'object' || observed.account === null
    || !exactKeys(observed.account, ['accountLabel','iban'])
    || !Array.isArray(observed.warnings)
    || !['prepared', 'waiting_release_2fa', 'released', 'rejected', 'unknown'].includes(observed.status)
    || typeof observed.reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(observed.reference)
    || typeof observed.importFilename !== 'string' || !/^(?=.{6,200}$)[-A-Za-z0-9_.]+\.xml$/.test(observed.importFilename)
    || observed.account.accountLabel !== FIXED_DEBTOR.accountLabel
    || !isValidIban(normalizedIban) || !isSepaIban(normalizedIban) || normalizedIban.length > 34
    || typeof observed.messageId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(observed.messageId)
    || observed.warnings.length > 20 || observed.warnings.some(value => typeof value !== 'string' || value.length < 1 || value.length > 200 || value.trim() !== value)
    || !Number.isSafeInteger(observed.itemCount) || observed.itemCount < 1
    || !Number.isSafeInteger(observed.controlSumMinor) || observed.controlSumMinor < 1) {
    throw new GeorgeAutomationError('GEORGE_PACKAGE_MISMATCH');
  }
  return {
    reference: observed.reference,
    importFilename: observed.importFilename,
    account: { accountLabel: observed.account.accountLabel, iban: normalizedIban },
    itemCount: observed.itemCount,
    controlSumMinor: observed.controlSumMinor,
    messageId: observed.messageId,
    warnings: [...observed.warnings],
    status: observed.status,
  };
}

/** Module-private status authority. No instance or mutation capability is exported. */
class AutomationStore {
  constructor(private readonly db: Database.Database, private readonly clock: () => Date) {}

  get(runId: string): InternalRun {
    const row = this.db.prepare('SELECT * FROM payment_automation_runs WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
    if (!row) throw new GeorgeAutomationError('PAYMENT_AUTOMATION_RUN_NOT_FOUND');
    try {
      const expected = JSON.parse(String(row.expected_json)) as PackageIdentity;
      const observed = row.observed_json == null ? null : JSON.parse(String(row.observed_json)) as ObservedPackage;
      const releaseConfirmation = row.release_confirmation_json == null
        ? null : JSON.parse(String(row.release_confirmation_json)) as PersistedReleaseConfirmation;
      const packageReference = row.package_reference == null ? null : String(row.package_reference);
      if (!AUTOMATION_PHASES.includes(String(row.phase) as AutomationPhase)
        || !validExpected(expected, String(row.import_filename))
        || (releaseConfirmation !== null && !validReleaseConfirmation(releaseConfirmation))
        || (packageReference !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(packageReference))) throw new Error('shape');
      if (observed !== null) {
        const safeObserved = sanitizeObserved(observed);
        if (packageReference !== null && safeObserved.reference !== packageReference) throw new Error('shape');
      }
      assertUrlClass(row.last_verified_url_class == null ? null : String(row.last_verified_url_class));
      return {
        runId: String(row.run_id), batchId: String(row.batch_id), phase: String(row.phase) as AutomationPhase,
        importFilename: String(row.import_filename), uploadAttemptedAt: row.upload_attempted_at == null ? null : String(row.upload_attempted_at),
        releaseRequestToken: row.release_request_token == null ? null : String(row.release_request_token),
        releaseClickClaimedAt: row.release_click_claimed_at == null ? null : String(row.release_click_claimed_at),
        releaseClickedAt: row.release_clicked_at == null ? null : String(row.release_clicked_at),
        releaseRetryClaimedAt: row.release_retry_claimed_at == null ? null : String(row.release_retry_claimed_at),
        releaseRetryClickedAt: row.release_retry_clicked_at == null ? null : String(row.release_retry_clicked_at),
        releaseRetryCount: Number(row.release_retry_count ?? 0),
        packageReference, errorCode: row.error_code == null ? null : String(row.error_code),
        expected, observed, releaseConfirmation,
      };
    } catch {
      throw new GeorgeAutomationError('PAYMENT_AUTOMATION_STATE_CORRUPT');
    }
  }

  phase(runId: string, next: AutomationPhase, code: string | null = null, urlClass: string | null = null): InternalRun {
    assertUrlClass(urlClass);
    const current = this.get(runId);
    if (!TRANSITIONS[current.phase]?.has(next)) throw new GeorgeAutomationError('INVALID_AUTOMATION_PHASE_TRANSITION');
    const now = this.clock().toISOString();
    const safeUrl = urlClass;
    const changed = this.db.prepare(`UPDATE payment_automation_runs SET phase=?, error_code=?, error_message=NULL,
      last_verified_url_class=COALESCE(?,last_verified_url_class), updated_at=? WHERE run_id=? AND phase=?`)
      .run(next, code, safeUrl, now, runId, current.phase);
    if (changed.changes !== 1) throw new GeorgeAutomationError('AUTOMATION_STATE_CHANGED');
    return this.get(runId);
  }

  observe(runId: string, observed: ObservedPackage, urlClass: string): InternalRun {
    assertUrlClass(urlClass);
    const safe = sanitizeObserved(observed);
    const now = this.clock().toISOString();
    const changed = this.db.prepare(`UPDATE payment_automation_runs SET observed_json=?, package_reference=?,
      last_verified_url_class=?, updated_at=? WHERE run_id=?`).run(JSON.stringify(safe), safe.reference, urlClass, now, runId);
    if (changed.changes !== 1) throw new GeorgeAutomationError('PAYMENT_AUTOMATION_RUN_NOT_FOUND');
    return this.get(runId);
  }

  attempted(runId: string): InternalRun {
    const current = this.get(runId);
    if (current.uploadAttemptedAt) return current;
    if (!TRANSITIONS[current.phase]?.has('upload_attempted')) throw new GeorgeAutomationError('INVALID_AUTOMATION_PHASE_TRANSITION');
    const now = this.clock().toISOString();
    const changed = this.db.prepare(`UPDATE payment_automation_runs SET phase='upload_attempted', upload_attempted_at=?,
      error_code=NULL, updated_at=? WHERE run_id=? AND phase='uploading' AND upload_attempted_at IS NULL`).run(now, now, runId);
    if (changed.changes !== 1) throw new GeorgeAutomationError('AUTOMATION_STATE_CHANGED');
    return this.get(runId);
  }

  releaseIntent(
    runId: string,
    snapshot: ConfirmedReleaseSnapshot,
    recovery: PersistedReleaseConfirmation['recovery'],
  ): InternalRun {
    const current = this.get(runId);
    if (!['prepared', 'unknown', 'failed'].includes(current.phase)
      || current.releaseRequestToken || current.releaseClickClaimedAt || current.releaseClickedAt
      || !TRANSITIONS[current.phase]?.has('requesting_release')) {
      throw new GeorgeAutomationError('PAYMENT_RELEASE_IN_PROGRESS');
    }
    const persisted: PersistedReleaseConfirmation = { ...snapshot, recovery };
    const now = this.clock().toISOString();
    const changed = this.db.prepare(`UPDATE payment_automation_runs SET phase='requesting_release',
      release_confirmation_json=?, error_code=NULL, error_message=NULL, updated_at=?
      WHERE run_id=? AND phase=? AND release_request_token IS NULL
      AND release_click_claimed_at IS NULL AND release_clicked_at IS NULL`)
      .run(JSON.stringify(persisted), now, runId, current.phase);
    if (changed.changes !== 1) throw new GeorgeAutomationError('AUTOMATION_STATE_CHANGED');
    return this.get(runId);
  }

  releaseLoginState(runId: string, waiting: boolean, urlClass: string): InternalRun {
    assertUrlClass(urlClass);
    const now = this.clock().toISOString();
    const changed = this.db.prepare(`UPDATE payment_automation_runs SET error_code=?, error_message=NULL,
      last_verified_url_class=?, updated_at=? WHERE run_id=? AND phase='requesting_release'
      AND release_request_token IS NULL AND release_click_claimed_at IS NULL AND release_clicked_at IS NULL`)
      .run(waiting ? 'WAITING_LOGIN_2FA' : null, urlClass, now, runId);
    if (changed.changes !== 1) throw new GeorgeAutomationError('AUTOMATION_STATE_CHANGED');
    return this.get(runId);
  }

  claimReleaseForVerifiedBatch(runId: string, token: string, snapshot: ConfirmedReleaseSnapshot): InternalRun {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new GeorgeAutomationError('INVALID_RELEASE_REQUEST_TOKEN');
    const claim = this.db.transaction(() => {
      const run = this.get(runId);
      const batch = this.db.prepare(`SELECT revision,status,debtor_iban,item_count,control_sum_minor,xml_sha256,export_artifact_data
        FROM payment_batches WHERE batch_id=?`).get(run.batchId) as Record<string, unknown> | undefined;
      const artifact = batch?.export_artifact_data;
      const artifactHash = Buffer.isBuffer(artifact) && artifact.length > 0
        ? createHash('sha256').update(artifact).digest('hex') : '';
      if (run.phase !== 'requesting_release' || !run.releaseConfirmation
        || run.releaseRequestToken || run.releaseClickClaimedAt || run.releaseClickedAt
        || !batch || batch.status !== 'prepared' || Number(batch.revision) !== snapshot.revision
        || String(batch.debtor_iban) !== snapshot.debtorIban || Number(batch.item_count) !== snapshot.itemCount
        || Number(batch.control_sum_minor) !== snapshot.controlSumMinor
        || String(batch.xml_sha256).toLowerCase() !== snapshot.xmlSha256 || artifactHash !== snapshot.xmlSha256
        || run.expected.artifactSha256.toLowerCase() !== snapshot.xmlSha256
        || run.expected.itemCount !== snapshot.itemCount || run.expected.controlSumMinor !== snapshot.controlSumMinor
        || run.releaseConfirmation.revision !== snapshot.revision
        || run.releaseConfirmation.debtorIban !== snapshot.debtorIban
        || run.releaseConfirmation.itemCount !== snapshot.itemCount
        || run.releaseConfirmation.controlSumMinor !== snapshot.controlSumMinor
        || run.releaseConfirmation.xmlSha256 !== snapshot.xmlSha256) {
        throw new GeorgeAutomationError('RELEASE_CONFIRMATION_MISMATCH');
      }
      const now = this.clock().toISOString();
      const changed = this.db.prepare(`UPDATE payment_automation_runs SET phase='release_click_claimed',
        release_request_token=?, release_click_claimed_at=?, error_code=NULL, updated_at=?
        WHERE run_id=? AND phase='requesting_release' AND release_request_token IS NULL
        AND release_click_claimed_at IS NULL AND release_clicked_at IS NULL`).run(token, now, now, runId);
      if (changed.changes !== 1) throw new GeorgeAutomationError('AUTOMATION_STATE_CHANGED');
    });
    claim();
    return this.get(runId);
  }

  clicked(runId: string, urlClass: string): InternalRun {
    const now = this.clock().toISOString();
    const changed = this.db.prepare(`UPDATE payment_automation_runs SET phase='waiting_release_2fa', release_clicked_at=?,
      last_verified_url_class=?, updated_at=? WHERE run_id=? AND phase IN ('release_click_claimed','unknown')
      AND release_click_claimed_at IS NOT NULL AND release_clicked_at IS NULL`).run(now, urlClass, now, runId);
    if (changed.changes !== 1) throw new GeorgeAutomationError('AUTOMATION_STATE_CHANGED');
    return this.get(runId);
  }

  claimReleaseRetry(runId: string): InternalRun {
    const current = this.get(runId);
    if (current.phase !== 'unknown' || current.errorCode !== 'RELEASE_STATUS_UNKNOWN'
      || !current.releaseClickedAt || current.releaseRetryClaimedAt || current.releaseRetryClickedAt
      || current.releaseRetryCount !== 0) {
      throw new GeorgeAutomationError('PAYMENT_RELEASE_IN_PROGRESS');
    }
    const now = this.clock().toISOString();
    const changed = this.db.prepare(`UPDATE payment_automation_runs SET release_retry_claimed_at=?,
      release_retry_count=1, updated_at=? WHERE run_id=? AND phase='unknown'
      AND error_code='RELEASE_STATUS_UNKNOWN' AND release_clicked_at IS NOT NULL
      AND release_retry_claimed_at IS NULL AND release_retry_clicked_at IS NULL
      AND release_retry_count=0`).run(now, now, runId);
    if (changed.changes !== 1) throw new GeorgeAutomationError('AUTOMATION_STATE_CHANGED');
    return this.get(runId);
  }

  clickedReleaseRetry(runId: string, urlClass: string): InternalRun {
    assertUrlClass(urlClass);
    const now = this.clock().toISOString();
    const changed = this.db.prepare(`UPDATE payment_automation_runs SET phase='waiting_release_2fa',
      release_retry_clicked_at=?, last_verified_url_class=?, error_code=NULL, updated_at=?
      WHERE run_id=? AND phase='unknown' AND release_retry_claimed_at IS NOT NULL
      AND release_retry_clicked_at IS NULL AND release_retry_count=1`).run(now, urlClass, now, runId);
    if (changed.changes !== 1) throw new GeorgeAutomationError('AUTOMATION_STATE_CHANGED');
    return this.get(runId);
  }

  abandonClaim(runId: string, code: string): InternalRun {
    const now = this.clock().toISOString();
    this.db.prepare(`UPDATE payment_automation_runs SET phase='unknown', release_request_token=NULL,
      release_click_claimed_at=NULL, error_code=?, updated_at=? WHERE run_id=? AND release_clicked_at IS NULL`).run(code, now, runId);
    return this.get(runId);
  }

  recoverUnknownPrepared(runId: string, urlClass: string): InternalRun {
    const now = this.clock().toISOString();
    const changed = this.db.prepare(`UPDATE payment_automation_runs SET phase='prepared', release_request_token=NULL,
      release_click_claimed_at=NULL, release_clicked_at=NULL, error_code=NULL, last_verified_url_class=?, updated_at=?
      WHERE run_id=? AND phase='unknown' AND release_clicked_at IS NULL`).run(urlClass, now, runId);
    if (changed.changes !== 1) throw new GeorgeAutomationError('AUTOMATION_STATE_CHANGED');
    return this.get(runId);
  }

  markPrepared(runId: string, observed: ObservedPackage, urlClass: string): InternalRun {
    const safe = sanitizeObserved(observed);
    const mark = this.db.transaction(() => {
      const run = this.get(runId);
      const batch = this.db.prepare('SELECT * FROM payment_batches WHERE batch_id=?').get(run.batchId) as Record<string, unknown> | undefined;
      if (!batch || batch.status !== 'exported' || !exactPackage(run.expected, safe) || safe.warnings.length || safe.status !== 'prepared') {
        throw new GeorgeAutomationError(safe.warnings.length ? 'GEORGE_IMPORT_WARNING' : 'GEORGE_PACKAGE_MISMATCH');
      }
      const now = this.clock().toISOString();
      const changed = this.db.prepare(`UPDATE payment_batches SET status='prepared', george_package_reference=?, updated_at=?, revision=revision+1
        WHERE batch_id=? AND revision=? AND status='exported'`).run(safe.reference, now, run.batchId, batch.revision);
      if (changed.changes !== 1) throw new GeorgeAutomationError('STALE_PAYMENT_REVISION');
      this.db.prepare("UPDATE payment_batch_items SET item_status='prepared', updated_at=? WHERE batch_id=?").run(now, run.batchId);
      this.insertEvent(run.batchId, 'exported', 'prepared', 'GEORGE_IMPORT_VERIFIED', safe, now);
      this.db.prepare(`UPDATE payment_automation_runs SET phase='prepared', observed_json=?, package_reference=?, error_code=NULL,
        last_verified_url_class=?, updated_at=? WHERE run_id=?`).run(JSON.stringify(safe), safe.reference, urlClass, now, runId);
    });
    mark();
    return this.get(runId);
  }

  markReleased(runId: string, observed: ObservedPackage, urlClass: string): InternalRun {
    const safe = sanitizeObserved(observed);
    const mark = this.db.transaction(() => {
      const run = this.get(runId);
      const batch = this.db.prepare('SELECT * FROM payment_batches WHERE batch_id=?').get(run.batchId) as Record<string, unknown> | undefined;
      if (!batch || batch.status !== 'prepared' || !run.releaseClickedAt || !run.releaseRequestToken
        || !exactPackage(run.expected, safe) || safe.reference !== run.packageReference || safe.status !== 'released') {
        throw new GeorgeAutomationError('PAYMENT_RELEASE_NOT_AUTHORIZED');
      }
      const now = this.clock().toISOString();
      const changed = this.db.prepare(`UPDATE payment_batches SET status='released', updated_at=?, revision=revision+1
        WHERE batch_id=? AND revision=? AND status='prepared'`).run(now, run.batchId, batch.revision);
      if (changed.changes !== 1) throw new GeorgeAutomationError('STALE_PAYMENT_REVISION');
      this.db.prepare("UPDATE payment_batch_items SET item_status='released', updated_at=? WHERE batch_id=?").run(now, run.batchId);
      this.insertEvent(run.batchId, 'prepared', 'released', 'GEORGE_RELEASE_VERIFIED', safe, now);
      this.db.prepare(`UPDATE payment_automation_runs SET phase='released', observed_json=?, error_code=NULL,
        last_verified_url_class=?, updated_at=? WHERE run_id=?`).run(JSON.stringify(safe), urlClass, now, runId);
    });
    mark();
    return this.get(runId);
  }

  markRejected(runId: string, observed: ObservedPackage, urlClass: string): InternalRun {
    const safe = sanitizeObserved(observed);
    const run = this.get(runId);
    if (!run.releaseClickClaimedAt || !run.releaseRequestToken || !exactPackage(run.expected, safe)
      || safe.reference !== run.packageReference || safe.status !== 'rejected') {
      throw new GeorgeAutomationError('GEORGE_PACKAGE_MISMATCH');
    }
    const now = this.clock().toISOString();
    const changed = this.db.prepare(`UPDATE payment_automation_runs SET phase='failed', observed_json=?,
      release_request_token=NULL, release_click_claimed_at=NULL, release_clicked_at=NULL,
      error_code='GEORGE_RELEASE_REJECTED', last_verified_url_class=?, updated_at=?
      WHERE run_id=? AND phase IN ('release_click_claimed','waiting_release_2fa','verifying_release','unknown')
      AND release_request_token IS NOT NULL AND release_click_claimed_at IS NOT NULL`)
      .run(JSON.stringify(safe), urlClass, now, runId);
    if (changed.changes !== 1) throw new GeorgeAutomationError('AUTOMATION_STATE_CHANGED');
    return this.get(runId);
  }

  private insertEvent(batchId: string, previous: string, next: string, reason: string, observed: ObservedPackage, now: string): void {
    const evidence = { packageReference: observed.reference, importFilename: observed.importFilename,
      accountLabel: observed.account.accountLabel, debtorIban: observed.account.iban, itemCount: observed.itemCount,
      controlSumMinor: observed.controlSumMinor, messageId: observed.messageId, status: observed.status, warnings: observed.warnings };
    this.db.prepare(`INSERT INTO payment_status_events(event_id,batch_id,actor,occurred_at,previous_status,new_status,reason,george_evidence_json)
      VALUES(?,?,?,?,?,?,?,?)`).run(`PAYE-${crypto.randomUUID()}`, batchId, 'george-adapter', now, previous, next, reason, JSON.stringify(evidence));
  }
}

class GeorgePaymentAdapter {
  readonly #store: AutomationStore;
  private readonly driverFactory: () => Promise<GeorgePageDriver>;
  private readonly acquireLock: (runId: string) => void;
  private readonly releaseLock: (runId: string) => void;
  private readonly tempRoot: string;
  private readonly releaseTimeoutMs: number;

  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly tokenFactory: () => string;
  private readonly writeArtifact: typeof writeFile;

  constructor(private readonly options: GeorgeRuntimeOptions) {
    this.#store = new AutomationStore(options.database ?? getDb(), options.clock ?? (() => new Date()));
    this.driverFactory = options.driverFactory ?? createGeorgePageDriver;
    this.acquireLock = options.acquireLock ?? (runId => acquireExecutorLock(runId, 'george-payments'));
    this.releaseLock = options.releaseLock ?? releaseExecutorLock;
    const paths = resolveAccountingPaths();
    const defaultTempRoot = paths.mode === 'external-runtime-root'
      ? resolveRuntimePath(paths, 'temp', 'payments', 'automation')
      : resolveRuntimePath(paths, 'state', 'payments', 'automation-tmp');
    this.tempRoot = resolve(options.tempRoot ?? defaultTempRoot);
    this.releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;

    this.delay = options.delay ?? (milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds)));
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('hex'));
    this.writeArtifact = options.writeArtifact ?? writeFile;
  }

  async importBatch(runId: string): Promise<PaymentAutomationRun> {
    let run: InternalRun;
    try { run = this.#store.get(runId); } catch (error) { throw error; }
    if (run.phase === 'prepared' || run.phase === 'released') return this.publicRun(runId);
    let artifact: Buffer;
    try { artifact = this.verifyLocalArtifact(run); } catch (error) { return this.fail(runId, error); }
    let locked = false; let driver: GeorgePageDriver | null = null; let tempDir: string | null = null;
    try {
      try { this.acquireLock(runId); locked = true; } catch (error) {
        if (errorCode(error) === 'EXECUTOR_BUSY') return this.retryable(runId, run.phase, 'EXECUTOR_BUSY');
        throw error;
      }
      run = this.#store.get(runId);
      const batch = this.options.repository.getBatch(run.batchId);
      if (!batch || (!['exported', 'prepared'].includes(batch.status)) || batch.messageId !== run.expected.messageId) {
        throw new GeorgeAutomationError('AUTOMATION_STATE_CHANGED');
      }
      if (batch.status === 'prepared') return this.publicRun(runId);
      if (run.phase !== 'unknown' && run.phase !== 'upload_attempted') this.#store.phase(runId, 'connecting_browser');
      driver = await this.driverFactory();
      const auth = await driver.ensureAuthenticated(GEORGE_USER_NUMBER);
      if (auth === 'waiting_login_2fa') {
        const urlClass = await driver.getVerifiedUrlClass();
        if (this.#store.get(runId).phase === 'connecting_browser') this.#store.phase(runId, 'waiting_login_2fa', 'WAITING_LOGIN_2FA', urlClass);
        return this.publicRun(runId);
      }
      const overviewClass = await driver.getVerifiedUrlClass();
      if (this.#store.get(runId).phase === 'waiting_login_2fa') this.#store.phase(runId, 'connecting_browser', null, overviewClass);
      const account = await driver.verifySourceAccount(FIXED_DEBTOR);
      if (!exactAccount(account)) throw new GeorgeAutomationError('SOURCE_ACCOUNT_MISMATCH');
      if (await driver.ensureDataImportAvailable() === 'activation_required') throw new GeorgeAutomationError('DATA_IMPORT_ACTIVATION_REQUIRED');
      run = this.#store.get(runId);
      if (run.phase !== 'upload_attempted' && run.phase !== 'unknown') this.#store.phase(runId, 'uploading', null, await driver.getVerifiedUrlClass());
      run = this.#store.get(runId);
      const materialized = await this.materializeArtifact(run, artifact); tempDir = materialized.tempDir;
      let observed = await driver.findPackage(run.expected, materialized.xmlPath);
      if (!observed) {
        if (run.uploadAttemptedAt) throw new GeorgeAutomationError('PACKAGE_RECOVERY_UNVERIFIABLE');
        this.#store.attempted(runId); // durable before browser upload
        try { observed = await driver.uploadPackage(materialized.xmlPath, 'single_package', run.expected); }
        catch { return this.unknown(runId, 'PACKAGE_UPLOAD_OUTCOME_UNKNOWN'); }
      }
      this.#store.observe(runId, observed, await driver.getVerifiedUrlClass());
      const current = this.#store.get(runId);
      if (current.phase !== 'verifying_import') this.#store.phase(runId, 'verifying_import', null, await driver.getVerifiedUrlClass());
      const readback = await driver.openPackage(observed.reference, run.expected);
      const verifiedUrlClass = await driver.getVerifiedUrlClass();
      const verified = this.#store.observe(runId, readback, verifiedUrlClass).observed!;
      if (verified.warnings.length) throw new GeorgeAutomationError('GEORGE_IMPORT_WARNING');
      if (!exactPackage(current.expected, verified) || verified.reference !== observed.reference || verified.status !== 'prepared') {
        throw new GeorgeAutomationError('GEORGE_PACKAGE_MISMATCH');
      }
      this.#store.markPrepared(runId, verified, verifiedUrlClass);
      return this.publicRun(runId);
    } catch (error) { return this.fail(runId, error); }
    finally { if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined); if (driver) await driver.close().catch(() => undefined); if (locked) this.releaseLock(runId); }
  }

  async requestRelease(runId: string, confirmation: ReleaseConfirmation): Promise<PaymentAutomationRun> {
    const current = this.#store.get(runId);
    const snapshot = this.verifyCurrentConfirmation(current, confirmation);
    const recovery: PersistedReleaseConfirmation['recovery'] = current.phase === 'unknown'
      ? 'stable_prepared' : 'none';
    this.#store.releaseIntent(runId, snapshot, recovery);
    return this.releaseFlow(runId, confirmation, false, snapshot);
  }

  async continueRelease(runId: string, confirmation: ReleaseConfirmation): Promise<PaymentAutomationRun> {
    const current = this.#store.get(runId);
    if (current.phase !== 'requesting_release' || current.releaseRequestToken
      || current.releaseClickClaimedAt || current.releaseClickedAt) {
      throw new GeorgeAutomationError('PAYMENT_RELEASE_IN_PROGRESS');
    }
    const snapshot = this.verifyCurrentConfirmation(current, confirmation);
    const persisted = current.releaseConfirmation;
    if (!persisted || persisted.revision !== snapshot.revision
      || persisted.debtorIban !== snapshot.debtorIban
      || persisted.itemCount !== snapshot.itemCount
      || persisted.controlSumMinor !== snapshot.controlSumMinor
      || persisted.xmlSha256 !== snapshot.xmlSha256) {
      throw new GeorgeAutomationError('RELEASE_CONFIRMATION_MISMATCH');
    }
    return this.releaseFlow(runId, confirmation, false, snapshot);
  }

  async retryExpiredRelease(runId: string, confirmation: ReleaseConfirmation): Promise<PaymentAutomationRun> {
    let locked = false; let driver: GeorgePageDriver | null = null;
    try {
      let run = this.#store.get(runId);
      const snapshot = this.verifyCurrentConfirmation(run, confirmation);
      if (run.phase !== 'unknown' || run.errorCode !== 'RELEASE_STATUS_UNKNOWN'
        || !run.releaseClickedAt || run.releaseRetryClaimedAt || run.releaseRetryClickedAt
        || run.releaseRetryCount !== 0 || !run.packageReference) {
        throw new GeorgeAutomationError('PAYMENT_RELEASE_IN_PROGRESS');
      }
      this.acquireLock(runId); locked = true;
      driver = await this.driverFactory();
      const auth = await driver.ensureAuthenticated(GEORGE_USER_NUMBER);
      if (auth === 'waiting_login_2fa') return this.publicRun(runId);
      const before = await driver.openPackage(run.packageReference, run.expected);
      const beforeUrlClass = await driver.getVerifiedUrlClass();
      const verified = this.#store.observe(runId, before, beforeUrlClass).observed!;
      this.assertExactPreparedOrPending(run, verified);
      if (!['prepared', 'waiting_release_2fa'].includes(verified.status)) {
        throw new GeorgeAutomationError('RELEASE_RECOVERY_NOT_STABLE');
      }
      this.verifyCurrentConfirmation(this.#store.get(runId), confirmation);
      if (snapshot.xmlSha256 !== run.expected.artifactSha256) throw new GeorgeAutomationError('RELEASE_CONFIRMATION_MISMATCH');
      run = this.#store.claimReleaseRetry(runId);
      try { await driver.clickReleaseOnce(run.packageReference!); }
      catch { return this.unknown(runId, 'RELEASE_RETRY_CLICK_OUTCOME_UNKNOWN'); }
      run = this.#store.clickedReleaseRetry(runId, await driver.getVerifiedUrlClass());
      return await this.waitAndFinalizeRelease(driver, runId, run);
    } catch (error) {
      if (errorCode(error) === 'EXECUTOR_BUSY') return this.publicRun(runId);
      const current = this.#store.get(runId);
      if (!current.releaseRetryClaimedAt) throw error;
      return this.fail(runId, error);
    } finally {
      if (driver) await driver.close().catch(() => undefined);
      if (locked) this.releaseLock(runId);
    }
  }

  async resumeRelease(runId: string): Promise<PaymentAutomationRun> {
    const run = this.#store.get(runId);
    if (run.phase === 'requesting_release' && !run.releaseClickClaimedAt) {
      this.unknown(runId, 'RELEASE_INTENT_ORPHANED');
      return this.publicRun(runId);
    }
    return this.releaseFlow(runId, null, true, null);
  }

  private async releaseFlow(
    runId: string,
    confirmation: ReleaseConfirmation | null,
    resume: boolean,
    snapshot: ConfirmedReleaseSnapshot | null,
  ): Promise<PaymentAutomationRun> {
    let locked = false; let driver: GeorgePageDriver | null = null;
    try {
      let run = this.#store.get(runId);
      if (run.phase === 'released') return this.publicRun(runId);
      this.acquireLock(runId); locked = true;
      run = this.#store.get(runId);
      if (resume && run.phase === 'requesting_release' && !run.releaseClickClaimedAt) {
        this.unknown(runId, 'RELEASE_INTENT_ORPHANED');
        return this.publicRun(runId);
      }
      driver = await this.driverFactory();
      const auth = await driver.ensureAuthenticated(GEORGE_USER_NUMBER);
      if (auth === 'waiting_login_2fa') {
        this.#store.releaseLoginState(runId, true, await driver.getVerifiedUrlClass());
        return this.publicRun(runId);
      }
      if (run.phase === 'requesting_release' && !run.releaseRequestToken
        && !run.releaseClickClaimedAt && !run.releaseClickedAt) {
        this.#store.releaseLoginState(runId, false, await driver.getVerifiedUrlClass());
      }
      run = this.#store.get(runId);
      if (resume && run.releaseClickClaimedAt && !run.releaseClickedAt
        && await driver.getVerifiedUrlClass() === 'release_pending') {
        try { await driver.clickReleaseOnce(run.packageReference!); }
        catch { return this.unknown(runId, 'RELEASE_CLICK_OUTCOME_UNKNOWN'); }
        this.#store.clicked(runId, await driver.getVerifiedUrlClass());
        return await this.waitAndFinalizeRelease(driver, runId, this.#store.get(runId));
      }
      const account = await driver.verifySourceAccount(FIXED_DEBTOR);
      if (!exactAccount(account)) throw new GeorgeAutomationError('SOURCE_ACCOUNT_MISMATCH');
      run = this.#store.get(runId);
      if (!run.packageReference) throw new GeorgeAutomationError('GEORGE_PACKAGE_MISMATCH');
      let before = await driver.openPackage(run.packageReference, run.expected);
      let beforeUrlClass = await driver.getVerifiedUrlClass();
      before = this.#store.observe(runId, before, beforeUrlClass).observed!;
      this.assertExactPreparedOrPending(run, before);
      run = this.#store.get(runId);
      if (resume && run.releaseClickClaimedAt && !run.releaseClickedAt) {
        if (before.status === 'prepared') return this.unknown(runId, 'RELEASE_CLAIM_NOT_EFFECTIVE');
        if (!['waiting_release_2fa', 'released'].includes(before.status)) return this.unknown(runId, 'RELEASE_CLICK_OUTCOME_UNKNOWN');
        this.#store.clicked(runId, beforeUrlClass); run = this.#store.get(runId);
      }
      if (before.status === 'released' && run.releaseClickedAt) {
        if (run.phase !== 'verifying_release') this.#store.phase(runId, 'verifying_release', null, beforeUrlClass);
        this.#store.markReleased(runId, before, beforeUrlClass); return this.publicRun(runId);
      }
      if (!resume) {
        if (!confirmation) throw new GeorgeAutomationError('RELEASE_CONFIRMATION_MISMATCH');
        this.verifyCurrentConfirmation(run, confirmation);
        if (run.releaseConfirmation?.recovery === 'stable_prepared' && !run.releaseClickedAt) {
          if (before.status !== 'prepared') throw new GeorgeAutomationError('RELEASE_RECOVERY_NOT_STABLE');
          let stable = before;
          let stableUrlClass = beforeUrlClass;
          for (let check = 0; check < 2; check += 1) {
            await this.delay(UNKNOWN_RECOVERY_STEP_MS);
            const fresh = await driver.openPackage(run.packageReference!, run.expected);
            stableUrlClass = await driver.getVerifiedUrlClass();
            stable = this.#store.observe(runId, fresh, stableUrlClass).observed!;
            this.assertExactPreparedOrPending(run, stable);
            if (stable.status !== 'prepared' || stable.reference !== before.reference) {
              throw new GeorgeAutomationError('RELEASE_RECOVERY_NOT_STABLE');
            }
          }
          before = stable; beforeUrlClass = stableUrlClass;
        }
        if (run.phase !== 'requesting_release' || before.status !== 'prepared') throw new GeorgeAutomationError('PAYMENT_BATCH_NOT_PREPARED');
        if (!snapshot) throw new GeorgeAutomationError('RELEASE_CONFIRMATION_MISMATCH');
        const token = this.tokenFactory();
        run = this.#store.claimReleaseForVerifiedBatch(runId, token, snapshot);
        try { await driver.clickReleaseOnce(run.packageReference!); } catch { return this.unknown(runId, 'RELEASE_CLICK_OUTCOME_UNKNOWN'); }
        this.#store.clicked(runId, await driver.getVerifiedUrlClass()); run = this.#store.get(runId);
      } else if (!run.releaseClickedAt) {
        return this.publicRun(runId);
      }
      return await this.waitAndFinalizeRelease(driver, runId, run);
    } catch (error) {
      if (errorCode(error) === 'EXECUTOR_BUSY') return this.publicRun(runId);
      return this.fail(runId, error);
    } finally { if (driver) await driver.close().catch(() => undefined); if (locked) this.releaseLock(runId); }
  }

  private async waitAndFinalizeRelease(
    driver: GeorgePageDriver,
    runId: string,
    run: InternalRun,
  ): Promise<PaymentAutomationRun> {
      const release = await driver.waitForRelease(run.packageReference!, this.releaseTimeoutMs);
      if (release === 'timeout') return this.unknown(runId, 'RELEASE_STATUS_UNKNOWN');
      if (release === 'rejected') {
        const rejectedReadback = await driver.openPackage(run.packageReference!, run.expected);
        const rejectedUrlClass = await driver.getVerifiedUrlClass();
        this.#store.markRejected(runId, rejectedReadback, rejectedUrlClass);
        return this.publicRun(runId);
      }
      const finalReadback = await driver.openPackage(run.packageReference!, run.expected);
      const finalUrlClass = await driver.getVerifiedUrlClass();
      this.#store.phase(runId, 'verifying_release', null, finalUrlClass);
      const final = this.#store.observe(runId, finalReadback, finalUrlClass).observed!;
      if (!exactPackage(run.expected, final) || final.reference !== run.packageReference || final.status !== 'released' || final.warnings.length) throw new GeorgeAutomationError('GEORGE_PACKAGE_MISMATCH');
      this.#store.markReleased(runId, final, finalUrlClass); return this.publicRun(runId);
  }

  private verifyCurrentConfirmation(run: InternalRun, confirmation: ReleaseConfirmation): ConfirmedReleaseSnapshot {
    const batch = this.options.repository.getBatch(run.batchId);
    assertReleaseConfirmation(run, batch, confirmation);
    const artifact = this.options.repository.getExportArtifactData(run.batchId);
    if (!artifact?.length || !exactValue(createHash('sha256').update(artifact).digest('hex'), confirmation.xmlSha256.toLowerCase())) {
      throw new GeorgeAutomationError('RELEASE_CONFIRMATION_MISMATCH');
    }
    return {
      revision: batch!.revision,
      debtorIban: batch!.debtorIban,
      itemCount: batch!.itemCount,
      controlSumMinor: batch!.controlSumMinor,
      xmlSha256: confirmation.xmlSha256.toLowerCase(),
    };
  }

  private assertExactPreparedOrPending(run: InternalRun, observed: ObservedPackage): void {
    if (!exactPackage(run.expected, observed) || observed.reference !== run.packageReference || observed.warnings.length) {
      throw new GeorgeAutomationError(observed.warnings.length ? 'GEORGE_IMPORT_WARNING' : 'GEORGE_PACKAGE_MISMATCH');
    }
  }

  private verifyLocalArtifact(run: InternalRun): Buffer {
    if (!INTERNAL_ID.test(run.runId) || !INTERNAL_ID.test(run.batchId) || !/^[a-f0-9]{64}$/i.test(run.expected.artifactSha256)) throw new GeorgeAutomationError('UNSAFE_AUTOMATION_IDENTIFIER');
    const batch = this.options.repository.getBatch(run.batchId);
    if (!batch || !['exported', 'prepared'].includes(batch.status)) throw new GeorgeAutomationError('PAYMENT_BATCH_NOT_EXPORTED');
    const artifact = this.options.repository.getExportArtifactData(run.batchId);
    if (!artifact?.length) throw new GeorgeAutomationError('PAYMENT_EXPORT_ARTIFACT_MISSING');
    const hash = createHash('sha256').update(artifact).digest('hex');
    if (hash !== run.expected.artifactSha256.toLowerCase() || hash !== batch.xmlSha256?.toLowerCase()) throw new GeorgeAutomationError('PAYMENT_EXPORT_ARTIFACT_HASH_MISMATCH');
    return artifact;
  }

  private async materializeArtifact(run: InternalRun, artifact: Buffer): Promise<{ tempDir: string; xmlPath: string }> {
    const tempDir = resolve(this.tempRoot, run.runId); const xmlPath = resolve(tempDir, run.importFilename);
    const rel = relative(this.tempRoot, xmlPath); if (rel.startsWith('..') || isAbsolute(rel)) throw new GeorgeAutomationError('UNSAFE_AUTOMATION_IDENTIFIER');
    try {
      await mkdir(tempDir, { recursive: true });
      await this.writeArtifact(xmlPath, artifact, { flag: 'w', mode: 0o600 });
      return { tempDir, xmlPath };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private publicRun(runId: string): PaymentAutomationRun { const run = this.options.repository.getAutomationRun(runId); if (!run) throw new GeorgeAutomationError('PAYMENT_AUTOMATION_RUN_NOT_FOUND'); return run; }
  private fail(runId: string, error: unknown): PaymentAutomationRun {
    const run = this.#store.get(runId);
    const releaseLocked = run.releaseRequestToken !== null || run.releaseClickClaimedAt !== null || run.releaseClickedAt !== null
      || ['requesting_release','release_click_claimed','waiting_release_2fa','verifying_release','unknown'].includes(run.phase);
    if (releaseLocked) {
      if (run.phase !== 'unknown') this.#store.phase(runId, 'unknown', errorCode(error));
    } else if (!FINAL.has(run.phase)) {
      this.#store.phase(runId, 'failed', errorCode(error));
    }
    return this.publicRun(runId);
  }
  private unknown(runId: string, code: string): PaymentAutomationRun { const run = this.#store.get(runId); if (run.phase !== 'unknown') this.#store.phase(runId, 'unknown', code); return this.publicRun(runId); }
  private retryable(runId: string, phase: AutomationPhase, code: string): PaymentAutomationRun { if (phase === 'queued') this.#store.phase(runId, 'queued', code); return this.publicRun(runId); }
}

export interface GeorgePaymentController {
  queueImport(batchId: string): Promise<PaymentAutomationRun>;
  requestRelease(batchId: string, confirmation: ReleaseConfirmation): Promise<PaymentAutomationRun>;
  /** Explicit operator-only retry after a timed-out bank authorization. */
  retryExpiredRelease(batchId: string, confirmation: ReleaseConfirmation): Promise<PaymentAutomationRun>;
  resumeNonFinalRuns(): Promise<void>;
  status(runId: string): PaymentAutomationRun | null;
}

/** Production capability: authority-bearing dependencies are fixed in this module. */
export function createGeorgePaymentController(): GeorgePaymentController {
  const database = getDb();
  const repository = new PaymentRepository(database);
  const authority = new GeorgePaymentAdapter({ repository, database });
  const activeReleaseRuns = new Set<string>();
  const controller = {
    queueImport: async (batchId: string) => {
      const run = repository.createAutomationRun(batchId);
      return authority.importBatch(run.runId);
    },
    requestRelease: async (batchId: string, confirmation: ReleaseConfirmation) => {
      if (activeReleaseRuns.has(batchId)) throw new GeorgeAutomationError('PAYMENT_RELEASE_IN_PROGRESS');
      activeReleaseRuns.add(batchId);
      try {
        const run = repository.getLatestAutomationRun(batchId);
        if (!run) {
          throw new GeorgeAutomationError('PAYMENT_BATCH_NOT_PREPARED');
        }
        const safety = repository.getAutomationReleaseSafety(run.runId);
        const releaseAuthority = safety.hasRequestToken || safety.hasClickClaim || safety.hasClick;
        const failedReleaseAuthority = releaseAuthority
          || (safety.hasPersistedIntent && run.errorCode !== 'GEORGE_RELEASE_REJECTED');
        if (run.phase === 'unknown' && releaseAuthority) {
          return await authority.resumeRelease(run.runId);
        }
        if (run.phase === 'failed' && failedReleaseAuthority) {
          throw new GeorgeAutomationError('PAYMENT_RELEASE_IN_PROGRESS');
        }
        if (run.phase === 'requesting_release') {
          if (releaseAuthority) throw new GeorgeAutomationError('PAYMENT_RELEASE_IN_PROGRESS');
          return await authority.continueRelease(run.runId, confirmation);
        }
        if (!['prepared', 'unknown', 'failed'].includes(run.phase)) {
          throw new GeorgeAutomationError('PAYMENT_BATCH_NOT_PREPARED');
        }
        return await authority.requestRelease(run.runId, confirmation);
      } finally {
        activeReleaseRuns.delete(batchId);
      }
    },
    resumeNonFinalRuns: async () => {
      for (const run of repository.listNonFinalAutomationRuns()) {
        if (run.phase === 'prepared') continue;
        if (run.releaseClickClaimedAt !== null || run.releaseClickedAt !== null
          || ['requesting_release','release_click_claimed','waiting_release_2fa','verifying_release'].includes(run.phase)) {
          await authority.resumeRelease(run.runId);
        } else {
          await authority.importBatch(run.runId);
        }
      }
    },
    status: (runId: string) => repository.getAutomationRun(runId),
  } as Omit<GeorgePaymentController, 'retryExpiredRelease'>;
  Object.defineProperty(controller, 'retryExpiredRelease', {
    enumerable: false,
    configurable: false,
    writable: false,
    value: async (batchId: string, confirmation: ReleaseConfirmation) => {
      const run = repository.getLatestAutomationRun(batchId);
      if (!run) throw new GeorgeAutomationError('PAYMENT_AUTOMATION_RUN_NOT_FOUND');
      return authority.retryExpiredRelease(run.runId, confirmation);
    },
  });
  return Object.freeze(controller) as GeorgePaymentController;
}
