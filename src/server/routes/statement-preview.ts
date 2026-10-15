import { createHash, randomBytes } from 'node:crypto';
import { extname } from 'node:path';
import { Router, type Response } from 'express';
import multer from 'multer';
import type { MatchingState, Transaction } from '../../core/types.js';
import { MAX_STATEMENT_BYTES, parseStatementBuffer, StatementError } from '../../import/statement-parser.js';
import { commitStatementImport, statementRecoveryPending } from '../../storage/statement-transaction.js';
import { serializeCommunityState } from '../../storage/json-store.js';

interface ReviewPrincipal { subject: string; workspace_id: string; session_id: string }
interface PendingReview {
  principal: ReviewPrincipal; source: 'sparkasse' | 'visa'; filename: string;
  account: string; digest: string; stateDigest: string;
  rows: Transaction[]; created: number;
}
const MAX_PENDING = 8, MAX_AGE_MS = 10 * 60 * 1000;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const pending = new Map<string, PendingReview>();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_STATEMENT_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 256 },
}).single('file');

function identify(response: Response): ReviewPrincipal {
  const value: unknown = response.locals.communityPrincipal;
  if (!value || typeof value !== 'object') throw new StatementError('AUTHENTICATION_REQUIRED', 'An authenticated accounting user is required');
  const principal = value as Partial<ReviewPrincipal>;
  if (![principal.subject, principal.workspace_id, principal.session_id].every(v => typeof v === 'string' && v.length > 0 && v.length <= 200)) {
    throw new StatementError('AUTHENTICATION_REQUIRED', 'A valid account session is required');
  }
  return principal as ReviewPrincipal;
}
function prune(now = Date.now()): void {
  for (const [key, value] of pending) if (value.created + MAX_AGE_MS <= now) pending.delete(key);
}
function samePrincipal(left: ReviewPrincipal, right: ReviewPrincipal): boolean {
  return left.subject === right.subject && left.workspace_id === right.workspace_id && left.session_id === right.session_id;
}
function report(error: unknown, response: Response): void {
  if (error instanceof multer.MulterError) {
    response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ code: 'STATEMENT_LIMIT', error: 'The statement exceeds the supported upload limits' });
  } else if (error instanceof StatementError) {
    const status = error.code === 'AUTHENTICATION_REQUIRED' ? 401 : /CONFLICT|OVERLAP|STALE/.test(error.code) ? 409 : 400;
    response.status(status).json({ code: error.code, error: error.message, row: error.row });
  } else {
    response.status(statementRecoveryPending() ? 503 : 500).json({ code: statementRecoveryPending() ? 'RECOVERY_REQUIRED' : 'STATEMENT_REVIEW_FAILED', error: 'The statement review could not be completed' });
  }
}

export function createStatementPreviewRouter(getState: () => MatchingState, activate: (state: MatchingState) => void): Router {
  const router = Router();
  router.post('/import/preview', (request, response) => {
    let principal: ReviewPrincipal;
    try { principal = identify(response); }
    catch (error) { report(error, response); return; }
    if (statementRecoveryPending()) { response.status(503).json({ code: 'RECOVERY_REQUIRED' }); return; }
    upload(request, response, error => {
      if (error) { report(error, response); return; }
      try {
        if (!request.file || !request.body || Object.keys(request.body).sort().join(',') !== 'account_id,source') {
          throw new StatementError('INVALID_UPLOAD', 'Select a source, account and statement file');
        }
        const source = request.body.source;
        const account = request.body.account_id;
        const filename = request.file.originalname;
        if (source !== 'sparkasse' && source !== 'visa') throw new StatementError('INVALID_SOURCE', 'Choose a supported statement source');
        if (typeof account !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(account)) throw new StatementError('INVALID_ACCOUNT', 'Choose a local account identifier');
        if (!filename || filename.length > 200 || /[\\/\u0000-\u001f]/.test(filename)) throw new StatementError('INVALID_FILENAME', 'Choose a regular statement filename');
        const rows = parseStatementBuffer(request.file.buffer, extname(filename).toLowerCase(), source, { accountId: account });
        const totals = new Map<string, bigint>();
        for (const row of rows) totals.set(row.currency_code, (totals.get(row.currency_code) ?? 0n) + BigInt(row.amount_minor));
        const totalsMinor: Record<string, number> = Object.create(null);
        for (const [currency, total] of totals) {
          if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) throw new StatementError('TOTAL_OVERFLOW', 'The combined amount exceeds exact supported range');
          totalsMinor[currency] = Number(total);
        }
        prune();
        if (pending.size >= MAX_PENDING) throw new StatementError('REVIEW_CAPACITY', 'Too many statement previews are awaiting confirmation');
        const token = randomBytes(32).toString('base64url');
        const digest = sha(request.file.buffer);
        pending.set(sha(token), { principal, source, filename, account, digest, stateDigest: sha(serializeCommunityState(getState())), rows, created: Date.now() });
        response.json({ token, filename, source, account_id: account, file_sha256: digest, fetched: rows.length,
          totals_minor_by_currency: totalsMinor, expires_in_seconds: MAX_AGE_MS / 1000,
          preview: rows.slice(0, 100).map((row, index) => ({
            row: index + 1, date: row.posting_at, description: row.description_raw,
            counterparty: row.counterparty_name ?? '', amount_minor: row.amount_minor,
            currency: row.currency_code, reference: row.booking_reference ?? null,
          })),
          remaining_rows: Math.max(0, rows.length - 100), payment_execution: false });
      } catch (reason) { report(reason, response); }
      finally { request.file?.buffer.fill(0); }
    });
  });
  router.post('/import/discard', (request, response) => {
    try {
      const principal = identify(response);
      if (!request.is('application/json') || !request.body ||
          Object.keys(request.body).sort().join(',') !== 'token' ||
          typeof request.body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(request.body.token)) {
        throw new StatementError('INVALID_REVIEW', 'A valid preview token is required');
      }
      prune();
      const id = sha(request.body.token);
      const review = pending.get(id);
      if (!review || !samePrincipal(review.principal, principal)) {
        throw new StatementError('REVIEW_EXPIRED', 'The preview has expired or belongs to a different session');
      }
      pending.delete(id);
      response.json({ discarded: true, financial_records_changed: false });
    } catch (error) { report(error, response); }
  });
  router.post('/import/commit', (request, response) => {
    try {
      const principal = identify(response);
      if (!request.is('application/json') || !request.body || Object.keys(request.body).sort().join(',') !== 'token' ||
          typeof request.body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(request.body.token)) {
        throw new StatementError('INVALID_REVIEW', 'A valid preview confirmation token is required');
      }
      prune();
      const id = sha(request.body.token);
      const review = pending.get(id);
      if (!review || !samePrincipal(review.principal, principal)) throw new StatementError('REVIEW_EXPIRED', 'The preview has expired or belongs to a different session');
      if (sha(serializeCommunityState(getState())) !== review.stateDigest) throw new StatementError('STALE_ACCOUNTING_STATE', 'Financial records changed; preview again before importing');
      if (statementRecoveryPending()) { response.status(503).json({ code: 'RECOVERY_REQUIRED' }); return; }
      const result = commitStatementImport(getState(), review.rows, review.source, review.filename, principal.subject);
      pending.delete(id);
      activate(result.state);
      response.json({ ok: true, ...result.result, account_id: review.account, file_sha256: review.digest, payment_execution: false });
    } catch (error) { report(error, response); }
  });
  return router;
}
