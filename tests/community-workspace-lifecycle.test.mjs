import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const applicationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const evidenceRoot = process.env.MATCHING_LIFECYCLE_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'community-lifecycle-synthetic-'));
mkdirSync(evidenceRoot, { recursive: true });

async function scenario(mode) {
  const output = join(evidenceRoot, mode);
  let stdout = '', stderr = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/workspace-lifecycle-server.mjs', mode, output], {
    cwd: applicationRoot, env: { ...process.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  writeFileSync(join(evidenceRoot, mode + '.stdout.txt'), stdout || '(no stdout)\n');
  writeFileSync(join(evidenceRoot, mode + '.stderr.txt'), stderr || '(no stderr)\n');
  assert.equal(code, 0, stderr + stdout);
  return JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'));
}

test('a surviving restore cutover exception rolls back state and rebuilds ordinary payment services', { timeout: 30000 }, async () => {
  const result = await scenario('rollback');
  assert.equal(result.ordinaryThrowAfterCutover, true);
  assert.equal(result.canonicalStateRolledBackExactly, true);
  assert.equal(result.paymentListStatusAfterRollback, 200, 'Payment services must use the reopened database after rollback');
  assert.equal(result.bankStatusAfterRollback, 200, 'Bank services must use the reopened database after rollback');
  assert.equal(result.closedHandleSuspected, false);
});

test('a disconnected provider operation cannot commit into the restored accounting generation', { timeout: 30000 }, async () => {
  const result = await scenario('aborted');
  assert.equal(result.clientDisconnectedBeforeRestore, true);
  assert.equal(result.activationStatus, 200);
  assert.equal(result.transactionsImmediatelyAfterRestore, 0);
  assert.equal(result.transactionsAfterReleasingRetiredProviderOperation, 0, 'A response-close event must not authorize old work against restored data');
  assert.equal(result.staleOperationCrossedRestoreGeneration, false);
  assert.equal(result.canonicalStateUnchangedAfterRetiredOperation, true);
  assert.equal(result.encryptedCheckpointUnchangedAfterRetiredOperation, true);
});

test('an exclusive real SQLite backup excludes writes from an earlier disconnected provider request', { timeout: 30000 }, async () => {
  const result = await scenario('exclusive');
  assert.equal(result.clientDisconnectedBeforeBackup, true);
  assert.equal(result.providerReleasedWhileRealBackupHeld, true);
  assert.equal(result.canonicalStateUnchangedWhileBackupHeld, true);
  assert.equal(result.encryptedCheckpointUnchangedWhileBackupHeld, true);
  assert.equal(result.transactionsWhileBackupHeld, 0);
  assert.equal(result.backupStatus, 201);
  assert.equal(result.backupCrossStoreVerificationPassed, true);
  assert.equal(result.backupTransactions, 0);
  assert.equal(result.backupSqlTransactions, 0);
});
