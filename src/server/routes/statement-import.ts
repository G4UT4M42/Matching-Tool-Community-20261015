import { Router } from 'express';
import multer from 'multer';
import { extname } from 'node:path';
import type { MatchingState } from '../../core/types.js';
import { MAX_STATEMENT_BYTES, parseStatementBuffer, StatementError } from '../../import/statement-parser.js';
import { commitStatementImport, statementRecoveryPending } from '../../storage/statement-transaction.js';

/** Memory-only staging behind authentication; filenames never become filesystem paths. */
export function createStatementImportRouter(getState: () => MatchingState, activate: (state: MatchingState) => void): Router {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_STATEMENT_BYTES, files: 1, fields: 2, parts: 3, fieldNameSize: 64, fieldSize: 256 },
  }).single('file');
  router.post('/import/upload', (request, response) => {
    const principal = response.locals.communityPrincipal as { subject?: string } | undefined;
    const subject = principal?.subject;
    if (!subject) { response.status(401).json({ code: 'AUTHENTICATION_REQUIRED', error: 'An authenticated local owner is required' }); return; }
    if (statementRecoveryPending()) { response.status(503).json({ code: 'RECOVERY_REQUIRED', error: 'Restart the local application to complete pending statement recovery' }); return; }
    upload(request, response, error => {
      if (error) {
        const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
        response.status(tooLarge ? 413 : 400).json({ code: tooLarge ? 'STATEMENT_LIMIT' : 'INVALID_UPLOAD', error: tooLarge ? 'The statement exceeds 10 MiB' : 'Upload exactly one statement and the required source and account fields' });
        return;
      }
      try {
        if (!request.file || !request.body || typeof request.body !== 'object' || Object.keys(request.body).some(key => !['source', 'account_id'].includes(key))) {
          throw new StatementError('INVALID_UPLOAD', 'Upload one statement with its source and account identifier');
        }
        const source = request.body.source;
        const account = request.body.account_id;
        if (source !== 'sparkasse' && source !== 'visa') throw new StatementError('INVALID_SOURCE', 'Select Sparkasse or Visa');
        if (typeof account !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(account)) throw new StatementError('INVALID_ACCOUNT', 'Use a local account identifier of 1 to 80 letters, digits, dots, colons, underscores or hyphens');
        const filename = request.file.originalname;
        if (!filename || filename.length > 200 || /[\u0000-\u001f\\/]/.test(filename)) throw new StatementError('INVALID_FILENAME', 'Use a regular statement filename');
        const rows = parseStatementBuffer(request.file.buffer, extname(filename).toLowerCase(), source, { accountId: account });
        const committed = commitStatementImport(getState(), rows, source, filename, subject);
        activate(committed.state);
        response.json({ ok: true, ...committed.result, account_id: account, payment_execution: false });
      } catch (error) {
        if (error instanceof StatementError) {
          const conflict = /CONFLICT|OVERLAP|STALE/.test(error.code);
          response.status(conflict ? 409 : 400).json({ code: error.code, error: error.message, row: error.row });
        } else {
          response.status(statementRecoveryPending() ? 503 : 500).json({ code: statementRecoveryPending() ? 'RECOVERY_REQUIRED' : 'STATEMENT_PERSISTENCE_FAILED', error: 'The import could not be completed. No unverified outcome is treated as a successful import.' });
        }
      } finally {
        // The buffer contains user-selected financial input, not durable attachments.
        request.file?.buffer.fill(0);
      }
    });
  });
  return router;
}
