import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PaymentBatch } from './repository.js';
import { FIXED_DEBTOR } from './types.js';
import { normalizeIban } from './validation.js';
import {
  PSA_ASSERTION_COUNT,
  PSA_ASSERTION_MANIFEST,
  PSA_ASSERTION_MANIFEST_SHA256,
  parseSepaXmlSecure,
  validatePsaAssertions,
  verifyAssertionCoverage,
  type XmlNode,
} from './sepa-assertions.js';

export {
  PSA_ASSERTION_COUNT,
  PSA_ASSERTION_MANIFEST,
  PSA_ASSERTION_MANIFEST_SHA256,
  parseSepaXmlSecure,
  validatePsaAssertions,
} from './sepa-assertions.js';

export const PAIN_001_001_09_NAMESPACE = 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09';
export const PINNED_XSD_SHA256 = 'd0b5a15a17503cf0200b4857d535c7602aa217e0269a91bc66b72b54174e450d';
export const PINNED_XSD_PATH = join(dirname(fileURLToPath(import.meta.url)), 'xsd', 'ISO.pain.001.001.09.austrian.005.xsd');
const PINNED_XSD_FILES = Object.freeze({
  'ISO.pain.001.001.09.austrian.005.xsd': PINNED_XSD_SHA256,
  'pain.001.001.09.xsd': 'de038b373e47b0077b1832ddd81f4b2f1eb25d35721f62da1e38b7f5a09fda24',
  'pain.001.codelists.xsd': '9dac72dd26c1df4862845710631f5e8a5886f7f488687bee0f68737ac0d1720b',
});
const XSD_MAX_BYTES = 512 * 1024;

export interface SepaGenerationContext {
  clock(): Date;
  idFactory(): string;
}

export interface SepaArtifact {
  xml: Buffer;
  sha256: string;
  messageId: string;
  transactionCount: number;
  controlSumMinor: number;
}

export interface XsdValidationResult {
  valid: boolean;
  errors: string[];
}

interface XsdValidationRequest {
  readonly xml: Buffer;
  readonly schema: string;
  readonly generic: string;
  readonly codelists: string;
}

export interface XsdValidationProcess {
  readonly result: Promise<XsdValidationResult>;
  readonly closed?: Promise<void>;
  terminate(): Promise<void>;
}

export interface XsdValidationRunner {
  start(request: XsdValidationRequest): XsdValidationProcess;
}

export interface XsdValidationOptions {
  readonly runner?: XsdValidationRunner;
  readonly timeoutMs?: number;
  /** @internal Test-only fault injection; rejected outside NODE_ENV=test. */
  readonly testChildMode?: 'hang-with-nested-worker';
  /** @internal Test-only lifecycle observer. */
  readonly childObserver?: { spawned(pid: number): void; closed(pid: number): void };
}

const VALIDATION_TIMEOUT_MS = 15_000;
const VALIDATION_QUEUE_LIMIT = 8;
const VALIDATION_CLEANUP_TIMEOUT_MS = 2_000;
const CHILD_INPUT_MAX_BYTES = 6 * 1024 * 1024;
const CHILD_OUTPUT_MAX_BYTES = 256 * 1024;

const CHILD_SOURCE = String.raw`
const MAX_INPUT = 6 * 1024 * 1024;
let input = Buffer.alloc(0);
let replying = false;
const reply = value => {
  if (replying) return;
  replying = true;
  process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(0));
};
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  if (input.length > MAX_INPUT) {
    process.stdin.pause();
    reply({ ok: false, error: 'child input too large' });
  }
});
process.stdin.on('error', error => reply({ ok: false, error: error.message }));
process.stdin.on('end', () => {
(async () => {
  try {
    const request = JSON.parse(input.toString('utf8'));
    if (request.mode === 'hang-with-nested-worker') {
      const { Worker } = require('node:worker_threads');
      new Worker('setInterval(() => {}, 1000)', { eval: true });
      return;
    }
    const { validateXML } = await import('xmllint-wasm');
    const result = await validateXML({
      xml: { fileName: 'payment.xml', contents: Buffer.from(request.xmlBase64, 'base64') },
      schema: { fileName: 'ISO.pain.001.001.09.austrian.005.xsd', contents: request.schema },
      preload: [
        { fileName: 'pain.001.001.09.xsd', contents: request.generic },
        { fileName: 'pain.001.codelists.xsd', contents: request.codelists },
      ],
      initialMemoryPages: 256,
      maxMemoryPages: 512,
      modifyArguments: args => ['--nonet', ...args],
    });
    reply({ ok: true, value: {
      valid: result.valid,
      errors: result.errors.map(error => error.message.trim()),
    } });
  } catch (error) {
    reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
})();
});`;

function isValidationResult(value: unknown): value is XsdValidationResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { valid?: unknown; errors?: unknown };
  return typeof candidate.valid === 'boolean'
    && Array.isArray(candidate.errors)
    && candidate.errors.every(error => typeof error === 'string');
}

function createChildRunner(
  mode: 'validate' | 'hang-with-nested-worker',
  observer?: { spawned(pid: number): void; closed(pid: number): void },
): XsdValidationRunner {
  return Object.freeze({
  start(request: XsdValidationRequest): XsdValidationProcess {
    const payload = Buffer.from(JSON.stringify({
      mode,
      xmlBase64: request.xml.toString('base64'),
      schema: request.schema,
      generic: request.generic,
      codelists: request.codelists,
    }), 'utf8');
    if (payload.length > CHILD_INPUT_MAX_BYTES) throw new Error('WASM child input too large');
    const child = spawn(process.execPath, ['-e', CHILD_SOURCE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error('WASM child PID unavailable');
    try { observer?.spawned(pid); } catch { /* test telemetry must not own the child lifecycle */ }
    let stopped: Promise<void> | undefined;
    const terminate = (): Promise<void> => {
      if (!stopped) {
        stopped = Promise.resolve().then(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        });
      }
      return stopped;
    };
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let streamFailure: Error | undefined;
    const appendBounded = (
      current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, label: string,
    ): Buffer<ArrayBufferLike> => {
      if (current.length + chunk.length > CHILD_OUTPUT_MAX_BYTES) {
        streamFailure ??= new Error(`WASM child ${label} too large`);
        void terminate();
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk, 'stdout'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk, 'stderr'); });
    const closed = new Promise<void>(resolve => {
      child.once('close', () => {
        try { observer?.closed(pid); } catch { /* test telemetry must not block cleanup */ }
        resolve();
      });
    });
    const result = new Promise<XsdValidationResult>((resolve, reject) => {
      let spawnError: Error | undefined;
      child.once('error', error => { spawnError = error; });
      child.stdin.once('error', error => { streamFailure ??= error; void terminate(); });
      child.once('close', (code, signal) => {
        if (spawnError) return reject(spawnError);
        if (streamFailure) return reject(streamFailure);
        if (code !== 0) {
          const detail = stderr.toString('utf8').trim();
          return reject(new Error(`WASM child exited before result (${code ?? signal})${detail ? `: ${detail}` : ''}`));
        }
        const text = stdout.toString('utf8').trim();
        let message: unknown;
        try { message = JSON.parse(text); } catch { return reject(new Error('WASM child output malformed')); }
        if (!message || typeof message !== 'object') return reject(new Error('WASM child output malformed'));
        const response = message as { ok?: unknown; value?: unknown; error?: unknown };
        if (response.ok === true && isValidationResult(response.value)) return resolve(response.value);
        if (response.ok === false && typeof response.error === 'string') return reject(new Error(response.error));
        return reject(new Error('WASM child output malformed'));
      });
      child.stdin.end(payload);
    });
    return { result, closed, terminate };
  },
});
}

const childRunner = createChildRunner('validate');

interface ValidationExecution {
  readonly result: Promise<XsdValidationResult>;
  readonly closed: Promise<void>;
}

class ValidationGate {
  private active = false;
  private cleanupBlocked = false;
  private readonly queue: Array<{
    run: () => ValidationExecution;
    resolve: (value: XsdValidationResult) => void;
    reject: (reason: unknown) => void;
  }> = [];

  schedule(run: () => ValidationExecution): Promise<XsdValidationResult> {
    if (this.cleanupBlocked || (this.active && this.queue.length >= VALIDATION_QUEUE_LIMIT)) {
      return Promise.reject(new Error('SEPA_VALIDATION_BUSY'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ run, resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = true;
    let execution: ValidationExecution;
    try { execution = job.run(); } catch (error) {
      job.reject(error);
      this.active = false;
      this.drain();
      return;
    }
    void execution.result.then(job.resolve, job.reject);
    let closed = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const startCleanupWatchdog = (): void => {
      if (closed || watchdog) return;
      watchdog = setTimeout(() => {
        this.cleanupBlocked = true;
        for (const queued of this.queue.splice(0)) queued.reject(new Error('SEPA_VALIDATION_BUSY'));
      }, VALIDATION_CLEANUP_TIMEOUT_MS);
    };
    void execution.result.then(startCleanupWatchdog, startCleanupWatchdog);
    const releaseSlot = (): void => {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      this.cleanupBlocked = false;
      this.active = false;
      this.drain();
    };
    void execution.closed.then(releaseSlot, startCleanupWatchdog);
  }
}

const validationGate = new ValidationGate();

function executeValidation(
  request: XsdValidationRequest,
  runner: XsdValidationRunner,
  timeoutMs: number,
): ValidationExecution {
  const process = runner.start(request);
  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => {
    termination ??= process.terminate().catch(() => undefined);
    return termination;
  };
  let timer: ReturnType<typeof setTimeout>;
  const result = new Promise<XsdValidationResult>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    timer = setTimeout(() => {
      void terminate();
      settle(() => reject(new Error('SEPA_XSD_VALIDATION_TIMEOUT')));
    }, timeoutMs);
    void process.result.then(
      value => { void terminate(); settle(() => resolve(value)); },
      error => { void terminate(); settle(() => reject(error)); },
    );
  });
  const closed = process.closed ?? result.then(terminate, terminate);
  return { result, closed };
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}


function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function schemaSafeId(prefix: string, raw: string): string {
  const safe = raw.normalize('NFKD').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${prefix}-${safe || 'id'}`.slice(0, 35);
}

function formatMinor(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('SEPA_AMOUNT_INVALID');
  return `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, '0')}`;
}

function decimalToMinor(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error('SEPA_ROUND_TRIP_MISMATCH');
  const result = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw new Error('SEPA_ROUND_TRIP_MISMATCH');
  return result;
}

function canonicalizeAssertion(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractAssertions(xsd: string): Array<{ context: string; test: string }> {
  const tokenPattern = /<\/?xd:complexType\b[^>]*>|<xd:assert\b[^>]*\btest="([^"]*)"[^>]*>/gs;
  const contexts: string[] = [];
  const assertions: Array<{ context: string; test: string }> = [];
  for (const match of xsd.matchAll(tokenPattern)) {
    const token = match[0];
    if (token.startsWith('</xd:complexType')) contexts.pop();
    else if (token.startsWith('<xd:complexType')) {
      const name = /\bname="([^"]+)"/.exec(token)?.[1];
      if (!name) throw new Error('SEPA_XSD_MANIFEST_MISMATCH');
      contexts.push(name);
    } else {
      const context = contexts.at(-1);
      if (!context || match[1] === undefined) throw new Error('SEPA_XSD_MANIFEST_MISMATCH');
      assertions.push({ context, test: canonicalizeAssertion(match[1]) });
    }
  }
  return assertions;
}

export function verifyPinnedPsaSchemas(xsdPath = PINNED_XSD_PATH): {
  root: string; generic: string; codelists: string;
  assertions: Array<{ context: string; test: string }>;
} {
  const schemaDirectory = dirname(xsdPath);
  const contents = new Map<string, Buffer>();
  for (const [name, expectedHash] of Object.entries(PINNED_XSD_FILES)) {
    const path = name === 'ISO.pain.001.001.09.austrian.005.xsd' ? xsdPath : join(schemaDirectory, name);
    const raw = readFileSync(path);
    if (raw.length > XSD_MAX_BYTES || sha256(raw) !== expectedHash) throw new Error('SEPA_XSD_PIN_MISMATCH');
    contents.set(name, raw);
  }
  const root = contents.get('ISO.pain.001.001.09.austrian.005.xsd')!.toString('utf8');
  const assertions = extractAssertions(root);
  const expected = PSA_ASSERTION_MANIFEST.map(({ context, test }) => ({ context, test }));
  if (assertions.length !== PSA_ASSERTION_COUNT
    || createHash('sha256').update(JSON.stringify(assertions)).digest('hex') !== PSA_ASSERTION_MANIFEST_SHA256
    || JSON.stringify(assertions) !== JSON.stringify(expected)) throw new Error('SEPA_XSD_MANIFEST_MISMATCH');
  return {
    root,
    generic: contents.get('pain.001.001.09.xsd')!.toString('utf8'),
    codelists: contents.get('pain.001.codelists.xsd')!.toString('utf8'),
    assertions,
  };
}

export async function validateAgainstPinnedXsd(
  xml: Buffer,
  xsdPath = PINNED_XSD_PATH,
  options: XsdValidationOptions = {},
): Promise<XsdValidationResult> {
  const schemas = verifyPinnedPsaSchemas(xsdPath);
  const parsed = parseSepaXmlSecure(xml);
  verifyAssertionCoverage(parsed, schemas.assertions);
  try {
    const compatibilitySchema = schemas.root
      .replace(/\s*<xd:assert\b[\s\S]*?<\/xd:assert>/g, '')
      .replace('vc:minVersion="1.1"', 'vc:minVersion="1.0"');
    if (extractAssertions(compatibilitySchema).length !== 0 || compatibilitySchema.includes('vc:minVersion="1.1"')) {
      throw new Error('SEPA_XSD_COMPATIBILITY_FAILED');
    }
    if ((options.testChildMode || options.childObserver) && process.env.NODE_ENV !== 'test') {
      throw new Error('SEPA_TEST_CHILD_MODE_FORBIDDEN');
    }
    if (options.runner && (options.testChildMode || options.childObserver)) {
      throw new Error('SEPA_VALIDATION_RUNNER_CONFLICT');
    }
    const runner = options.runner ?? (options.testChildMode || options.childObserver
      ? createChildRunner(options.testChildMode ?? 'validate', options.childObserver)
      : childRunner);
    return await validationGate.schedule(() => executeValidation({
      xml,
      schema: compatibilitySchema,
      generic: schemas.generic,
      codelists: schemas.codelists,
    }, runner, options.timeoutMs ?? VALIDATION_TIMEOUT_MS));
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === 'SEPA_VALIDATION_BUSY' || code === 'SEPA_XSD_VALIDATION_TIMEOUT') throw error;
    throw new Error(`SEPA_XSD_VALIDATION_UNAVAILABLE: ${code}`);
  }
}

function assertReviewedFixedBatch(batch: PaymentBatch): void {
  if (batch.status !== 'reviewed') throw new Error('SEPA_BATCH_NOT_REVIEWED');
  if (batch.debtorAccountLabel !== FIXED_DEBTOR.accountLabel
    || batch.debtorAccountHolder !== FIXED_DEBTOR.accountHolder
    || batch.debtorIban !== FIXED_DEBTOR.iban) {
    throw new Error('SEPA_DEBTOR_NOT_ALLOWED');
  }
  if (batch.currencyCode !== FIXED_DEBTOR.currencyCode
    || batch.items.some(item => item.currencyCode !== FIXED_DEBTOR.currencyCode)) {
    throw new Error('SEPA_CURRENCY_NOT_ALLOWED');
  }
  if (!batch.requestedExecutionDate || !/^\d{4}-\d{2}-\d{2}$/.test(batch.requestedExecutionDate)) {
    throw new Error('SEPA_EXECUTION_DATE_INVALID');
  }
  if (batch.items.length === 0 || batch.items.some(item => item.status !== 'reviewed' || !item.active)) {
    throw new Error('SEPA_BATCH_NOT_IMMUTABLE');
  }
  const controlSum = batch.items.reduce((sum, item) => {
    if (!Number.isSafeInteger(item.amountMinor) || (item.amountMinor ?? 0) <= 0) throw new Error('SEPA_AMOUNT_INVALID');
    const next = sum + item.amountMinor!;
    if (!Number.isSafeInteger(next)) throw new Error('SEPA_CONTROL_SUM_INVALID');
    return next;
  }, 0);
  if (batch.itemCount !== batch.items.length || batch.controlSumMinor !== controlSum) {
    throw new Error('SEPA_BATCH_TOTALS_MISMATCH');
  }
}

function transactionXml(item: PaymentBatch['items'][number], endToEndId: string): string {
  if (!item.creditorName || !item.creditorIban
    || Boolean(item.remittanceInformation) === Boolean(item.structuredCreditorReference)) throw new Error('SEPA_ITEM_INVALID');
  const remittance = item.structuredCreditorReference
    ? `<Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>${escapeXml(item.structuredCreditorReference)}</Ref></CdtrRefInf></Strd>`
    : `<Ustrd>${escapeXml(item.remittanceInformation!)}</Ustrd>`;
  return `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${escapeXml(endToEndId)}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">${formatMinor(item.amountMinor!)}</InstdAmt></Amt>
        <Cdtr><Nm>${escapeXml(item.creditorName)}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${escapeXml(normalizeIban(item.creditorIban))}</IBAN></Id></CdtrAcct>
        <RmtInf>${remittance}</RmtInf>
      </CdtTrfTxInf>`;
}

function array(parent: XmlNode, name: string): unknown[] {
  const value = parent[name];
  return Array.isArray(value) ? value : [];
}

function object(parent: XmlNode, name: string): XmlNode {
  const found = array(parent, name);
  if (found.length !== 1 || !found[0] || typeof found[0] !== 'object' || Array.isArray(found[0])) {
    throw new Error('SEPA_ROUND_TRIP_MISMATCH');
  }
  return found[0] as XmlNode;
}

function text(parent: XmlNode, name: string): string {
  if (typeof parent[name] === 'string') return parent[name] as string;
  const found = array(parent, name);
  if (found.length !== 1 || typeof found[0] !== 'string') throw new Error('SEPA_ROUND_TRIP_MISMATCH');
  return found[0];
}

export function verifySepaRoundTrip(xml: Buffer, batch: PaymentBatch): void {
  const parsed = parseSepaXmlSecure(xml);
  validatePsaAssertions(parsed);
  const initiation = object(object(parsed, 'Document'), 'CstmrCdtTrfInitn');
  const header = object(initiation, 'GrpHdr');
  const payments = array(initiation, 'PmtInf') as XmlNode[];
  if (payments.length !== 1) throw new Error('SEPA_ROUND_TRIP_MISMATCH');
  const payment = payments[0]!;
  const transactions = array(payment, 'CdtTrfTxInf') as XmlNode[];
  const amountNodes = transactions.map(transaction => object(object(transaction, 'Amt'), 'InstdAmt'));
  const amounts = amountNodes.map(amount => decimalToMinor(text(amount, '#text')));
  const controlSum = amounts.reduce((sum, amount) => sum + amount, 0);
  const declaredCounts = [text(header, 'NbOfTxs'), text(payment, 'NbOfTxs')].map(Number);
  const declaredControlSums = [text(header, 'CtrlSum'), text(payment, 'CtrlSum')].map(decimalToMinor);
  const initiatorName = text(object(header, 'InitgPty'), 'Nm');
  const messageId = text(header, 'MsgId');
  const paymentInfoId = text(payment, 'PmtInfId');
  const endToEndIds = transactions.map(transaction => text(object(transaction, 'PmtId'), 'EndToEndId'));
  const debtorName = text(object(payment, 'Dbtr'), 'Nm');
  const debtorAccount = object(payment, 'DbtrAcct');
  const debtorIban = text(object(debtorAccount, 'Id'), 'IBAN');
  const debtorCurrency = text(debtorAccount, 'Ccy');
  const currencies = amountNodes.map(amount => amount['@_Ccy']);
  if (transactions.length !== batch.itemCount
    || controlSum !== batch.controlSumMinor
    || declaredCounts.some(count => count !== transactions.length)
    || declaredControlSums.some(sum => sum !== controlSum)
    || (batch.messageId !== null && messageId !== batch.messageId)
    || paymentInfoId !== schemaSafeId('PMT', batch.batchId)
    || new Set(endToEndIds).size !== endToEndIds.length
    || initiatorName !== FIXED_DEBTOR.accountLabel
    || debtorName !== FIXED_DEBTOR.accountHolder
    || debtorIban !== FIXED_DEBTOR.iban
    || debtorCurrency !== FIXED_DEBTOR.currencyCode
    || currencies.some(currency => currency !== FIXED_DEBTOR.currencyCode)) {
    throw new Error('SEPA_ROUND_TRIP_MISMATCH');
  }
}

export class SepaGenerator {
  async generate(batch: PaymentBatch, context: SepaGenerationContext): Promise<SepaArtifact> {
    assertReviewedFixedBatch(batch);
    const messageId = schemaSafeId('MSG', context.idFactory());
    const endToEndIds = new Set<string>();
    const transactions = batch.items.map((item, index) => {
      let id = schemaSafeId('E2E', context.idFactory());
      if (endToEndIds.has(id)) id = `${id.slice(0, 31)}-${index + 1}`;
      if (endToEndIds.has(id)) throw new Error('SEPA_IDENTIFIER_COLLISION');
      endToEndIds.add(id);
      return transactionXml(item, id);
    }).join('\n');
    const count = batch.items.length;
    const controlSum = formatMinor(batch.controlSumMinor);
    const xml = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="${PAIN_001_001_09_NAMESPACE}">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${escapeXml(messageId)}</MsgId>
      <CreDtTm>${escapeXml(context.clock().toISOString().replace('.000Z', 'Z'))}</CreDtTm>
      <NbOfTxs>${count}</NbOfTxs>
      <CtrlSum>${controlSum}</CtrlSum>
      <InitgPty><Nm>${escapeXml(FIXED_DEBTOR.accountLabel)}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${escapeXml(schemaSafeId('PMT', batch.batchId))}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>false</BtchBookg>
      <NbOfTxs>${count}</NbOfTxs>
      <CtrlSum>${controlSum}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
      <ReqdExctnDt><Dt>${batch.requestedExecutionDate}</Dt></ReqdExctnDt>
      <Dbtr><Nm>${escapeXml(FIXED_DEBTOR.accountHolder)}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${FIXED_DEBTOR.iban}</IBAN></Id><Ccy>EUR</Ccy></DbtrAcct>
      <DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
${transactions}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`, 'utf8');
    const validation = await validateAgainstPinnedXsd(xml);
    if (!validation.valid) throw new Error(`SEPA_XSD_INVALID: ${validation.errors.join('; ')}`);
    verifySepaRoundTrip(xml, batch);
    return {
      xml,
      sha256: sha256(xml),
      messageId,
      transactionCount: count,
      controlSumMinor: batch.controlSumMinor,
    };
  }
}
