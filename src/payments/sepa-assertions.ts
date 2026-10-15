import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

export const PSA_ASSERTION_COUNT = 22;
export const PSA_ASSERTION_MANIFEST_SHA256 = '8d195a3e6086dda34de140d15044f7c16d3ab1757d06941e640e37936ddbf48e';

export interface PsaAssertionManifestEntry {
  readonly context: string;
  readonly test: string;
}

export const PSA_ASSERTION_MANIFEST: readonly PsaAssertionManifestEntry[] = Object.freeze([
  ['CustomerCreditTransferInitiationV09', 'xd:integer(_:GrpHdr/_:NbOfTxs) eq sum(_:PmtInf/xd:integer(_:NbOfTxs))'],
  ['CustomerCreditTransferInitiationV09', '_:GrpHdr/_:CtrlSum eq sum(_:PmtInf/_:CtrlSum)'],
  ['CustomerCreditTransferInitiationV09', 'count(_:PmtInf/_:PmtInfId) eq count(distinct-values(_:PmtInf/_:PmtInfId))'],
  ['CustomerCreditTransferInitiationV09', 'count(_:PmtInf) lt 10000'],
  ['PaymentInstruction30', 'if(count(_:PmtTpInf) eq 1) then (count(_:CdtTrfTxInf/_:PmtTpInf) eq 0) else (count(_:CdtTrfTxInf/_:PmtTpInf) eq count(_:CdtTrfTxInf))'],
  ['PaymentInstruction30', 'if(count(_:UltmtDbtr) eq 1) then (count(_:CdtTrfTxInf/_:UltmtDbtr) eq 0) else true()'],
  ['PaymentInstruction30', 'if(count(_:ChrgBr) eq 1) then (count(_:CdtTrfTxInf/_:ChrgBr) eq 0) else true()'],
  ['PaymentInstruction30', "if(count(_:ReqdExctnDt/_:DtTm) gt 0) then (_:PmtTpInf/_:LclInstrm/_:Cd eq 'INST') else true()"],
  ['PaymentInstruction30', 'if(count(_:PmtTpInf) eq 1) then true() else ( if(count(_:CdtTrfTxInf/_:PmtTpInf/_:LclInstrm) eq 0) then true() else ( if(count(_:CdtTrfTxInf/_:PmtTpInf/_:LclInstrm/_:Cd) eq 0) then true() else ( count(distinct-values(_:CdtTrfTxInf/_:PmtTpInf/_:LclInstrm/_:Cd)) eq 1)))'],
  ['PaymentInstruction30', 'xd:integer(_:NbOfTxs) eq count(_:CdtTrfTxInf)'],
  ['PaymentInstruction30', '_:CtrlSum eq sum(_:CdtTrfTxInf/_:Amt/_:InstdAmt)'],
  ['PaymentInstruction30', 'count(_:CdtTrfTxInf) lt 1000000'],
  ['RemittanceInformation16', 'count(*) eq 1'],
  ['FinancialInstitutionIdentification18_Dbtr', 'count(*) eq 1'],
  ['OrganisationIdentification29_Cdtr_Dbtr_Ultmt', 'count(*) eq 1'],
  ['OrganisationIdentification29_InitgPty', 'count(*) eq 1'],
  ['PartyIdentification135_InitgPty', 'count(*) eq 1'],
  ['PartyIdentification135_UltmtCdtr', 'count(*) gt 0'],
  ['PartyIdentification135_UltmtDbtr', 'count(*) gt 0'],
  ['PaymentTypeInformation26_Batch', 'count(*) gt 0'],
  ['PaymentTypeInformation26_Single', 'count(*) gt 0'],
  ['PersonIdentification13_Cdtr_Dbtr_Ultmt', 'count(*) eq 1'],
].map(([context, test]) => Object.freeze({ context, test })));

export type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  allowBooleanAttributes: false,
  isArray: (_name, _path, _leaf, isAttribute) => !isAttribute,
});

const XML_MAX_BYTES = 1024 * 1024;

export function parseSepaXmlSecure(xml: Buffer): XmlNode {
  if (xml.length > XML_MAX_BYTES) throw new Error('SEPA_XML_TOO_LARGE');
  const text = xml.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || /&(?!(?:amp|lt|gt|quot|apos);|#\d+;|#x[0-9a-f]+;)/i.test(text)) {
    throw new Error('SEPA_XML_UNSAFE');
  }
  let parsed: unknown;
  try { parsed = parser.parse(text); } catch { throw new Error('SEPA_XML_MALFORMED'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SEPA_XML_MALFORMED');
  return parsed as XmlNode;
}

function nodes(parent: unknown, name: string): XmlNode[] {
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return [];
  const value = (parent as XmlNode)[name];
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as XmlNode[] : [];
}

function values(parent: unknown, name: string): string[] {
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return [];
  const value = (parent as XmlNode)[name];
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : [];
}

function arrayLength(parent: XmlNode, name: string): number {
  const value = parent[name];
  return Array.isArray(value) ? value.length : value === undefined ? 0 : 1;
}

function childNames(node: XmlNode): string[] {
  return Object.keys(node).filter(key => !key.startsWith('@_') && !key.startsWith('?') && key !== '#text' && Array.isArray(node[key]) && (node[key] as unknown[]).length > 0);
}

function oneNode(parent: unknown, name: string): XmlNode {
  const found = nodes(parent, name);
  if (found.length !== 1) fail(`shape:${name}`);
  return found[0]!;
}

function oneValue(parent: unknown, name: string): string {
  const found = values(parent, name);
  if (found.length !== 1) fail(`shape:${name}`);
  return found[0]!;
}

function decimal(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) fail('decimal');
  return BigInt(match![1]!) * 100n + BigInt((match![2] ?? '').padEnd(2, '0'));
}

function integer(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) fail('integer');
  const result = Number(value);
  if (!Number.isSafeInteger(result)) fail('integer');
  return result;
}

function fail(coverage: string): never { throw new Error(`SEPA_PSA_ASSERTION_FAILED: ${coverage}`); }
function ensure(condition: boolean, coverage: string): void { if (!condition) fail(coverage); }

export type PsaAssertionHandler = (parsed: XmlNode) => void;
export interface PsaAssertionIdentity { readonly context: string; readonly test: string }

export function psaAssertionKey(assertion: PsaAssertionIdentity): string {
  return `${assertion.context}\u0000${assertion.test}`;
}

interface AssertionModel {
  readonly header: XmlNode;
  readonly paymentInfos: XmlNode[];
}

function assertionModel(parsed: XmlNode): AssertionModel {
  const document = oneNode(parsed, 'Document');
  ensure(childNames(parsed).length === 1, 'document-shape');
  const initiation = oneNode(document, 'CstmrCdtTrfInitn');
  ensure(childNames(document).length === 1, 'document-shape');
  const header = oneNode(initiation, 'GrpHdr');
  const paymentInfos = nodes(initiation, 'PmtInf');
  ensure(paymentInfos.length > 0 && childNames(initiation).every(name => name === 'GrpHdr' || name === 'PmtInf'), 'message-shape');
  return { header, paymentInfos };
}

function transactions(payment: XmlNode): XmlNode[] { return nodes(payment, 'CdtTrfTxInf'); }
function batchTypes(payment: XmlNode): XmlNode[] { return nodes(payment, 'PmtTpInf'); }
function transactionTypes(payment: XmlNode): XmlNode[] {
  return transactions(payment).flatMap(transaction => nodes(transaction, 'PmtTpInf'));
}

const handlers: PsaAssertionHandler[] = [
  parsed => {
    const { header, paymentInfos } = assertionModel(parsed);
    ensure(integer(oneValue(header, 'NbOfTxs')) === paymentInfos.reduce((sum, payment) => sum + integer(oneValue(payment, 'NbOfTxs')), 0), 'message-count');
  },
  parsed => {
    const { header, paymentInfos } = assertionModel(parsed);
    ensure(decimal(oneValue(header, 'CtrlSum')) === paymentInfos.reduce((sum, payment) => sum + decimal(oneValue(payment, 'CtrlSum')), 0n), 'message-sum');
  },
  parsed => {
    const ids = assertionModel(parsed).paymentInfos.map(payment => oneValue(payment, 'PmtInfId'));
    ensure(new Set(ids).size === ids.length, 'unique-payment-info-id');
  },
  parsed => ensure(assertionModel(parsed).paymentInfos.length < 10_000, 'payment-info-limit'),
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) {
      const txs = transactions(payment);
      const txTypes = transactionTypes(payment);
      ensure(batchTypes(payment).length === 1 ? txTypes.length === 0 : txTypes.length === txs.length, 'payment-type-exclusivity');
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) {
      ensure(nodes(payment, 'UltmtDbtr').length !== 1
        || transactions(payment).flatMap(transaction => nodes(transaction, 'UltmtDbtr')).length === 0, 'ultimate-debtor-exclusivity');
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) {
      ensure(values(payment, 'ChrgBr').length !== 1
        || transactions(payment).flatMap(transaction => values(transaction, 'ChrgBr')).length === 0, 'charge-bearer-exclusivity');
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) {
      const requested = oneNode(payment, 'ReqdExctnDt');
      ensure(childNames(requested).length === 1 && values(requested, 'Dt').length + values(requested, 'DtTm').length === 1, 'instant-datetime');
      if (values(requested, 'DtTm').length > 0) {
        const codes = batchTypes(payment).flatMap(type => nodes(type, 'LclInstrm')).flatMap(local => values(local, 'Cd'));
        ensure(codes.length === 1 && codes[0] === 'INST', 'instant-datetime');
      }
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) {
      const txs = transactions(payment);
      const codes = transactionTypes(payment).flatMap(type => nodes(type, 'LclInstrm')).flatMap(local => values(local, 'Cd'));
      ensure(batchTypes(payment).length === 1 || codes.length === 0
        || (codes.length === txs.length && new Set(codes).size === 1), 'single-local-instrument');
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) {
      ensure(integer(oneValue(payment, 'NbOfTxs')) === transactions(payment).length, 'payment-count');
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) {
      const sum = transactions(payment).reduce((total, transaction) => total + decimal(oneValue(oneNode(oneNode(transaction, 'Amt'), 'InstdAmt'), '#text')), 0n);
      ensure(decimal(oneValue(payment, 'CtrlSum')) === sum, 'payment-sum');
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) ensure(transactions(payment).length < 1_000_000, 'transaction-limit');
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) for (const transaction of transactions(payment)) {
      const remittance = oneNode(transaction, 'RmtInf');
      ensure(childNames(remittance).length === 1 && values(remittance, 'Ustrd').length + nodes(remittance, 'Strd').length === 1, 'remittance-choice');
      for (const structured of nodes(remittance, 'Strd')) {
        ensure(childNames(structured).length === 1, 'remittance-choice');
        const reference = oneNode(structured, 'CdtrRefInf');
        ensure(arrayLength(reference, 'Tp') <= 1 && values(reference, 'Ref').length === 1, 'remittance-choice');
      }
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) {
      const agentId = oneNode(oneNode(payment, 'DbtrAgt'), 'FinInstnId');
      ensure(childNames(agentId).length === 1 && values(agentId, 'BICFI').length + nodes(agentId, 'Othr').length === 1, 'debtor-agent-choice');
      for (const other of nodes(agentId, 'Othr')) ensure(childNames(other).length === 1 && oneValue(other, 'Id') === 'NOTPROVIDED', 'debtor-agent-choice');
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) {
      const parties = [oneNode(payment, 'Dbtr'), ...transactions(payment).map(transaction => oneNode(transaction, 'Cdtr'))];
      for (const party of parties) ensure(nodes(party, 'Id').length === 0, 'organisation-id-choice');
      const accountIds = [oneNode(oneNode(payment, 'DbtrAcct'), 'Id'), ...transactions(payment).map(transaction => oneNode(oneNode(transaction, 'CdtrAcct'), 'Id'))];
      for (const id of accountIds) ensure(childNames(id).length === 1 && values(id, 'IBAN').length === 1, 'organisation-id-choice');
    }
  },
  parsed => {
    const initiating = oneNode(assertionModel(parsed).header, 'InitgPty');
    ensure(nodes(initiating, 'Id').length === 0, 'initiating-organisation-id-choice');
  },
  parsed => {
    const initiating = oneNode(assertionModel(parsed).header, 'InitgPty');
    ensure(childNames(initiating).length === 1 && values(initiating, 'Nm').length === 1 && nodes(initiating, 'Id').length === 0, 'initiating-party-shape');
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) for (const transaction of transactions(payment)) {
      ensure(nodes(transaction, 'UltmtCdtr').length === 0, 'ultimate-creditor-shape');
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) {
      ensure(nodes(payment, 'UltmtDbtr').length === 0
        && transactions(payment).flatMap(transaction => nodes(transaction, 'UltmtDbtr')).length === 0, 'ultimate-debtor-shape');
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) for (const type of batchTypes(payment)) {
      ensure(childNames(type).length > 0, 'batch-payment-type-shape');
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) for (const type of transactionTypes(payment)) {
      ensure(childNames(type).length > 0, 'transaction-payment-type-shape');
    }
  },
  parsed => {
    for (const payment of assertionModel(parsed).paymentInfos) {
      const parties = [oneNode(payment, 'Dbtr'), ...transactions(payment).map(transaction => oneNode(transaction, 'Cdtr'))];
      for (const party of parties) {
        const privateIdentifications = nodes(party, 'Id').flatMap(id => nodes(id, 'PrvtId'));
        ensure(nodes(party, 'Id').length === 0 && privateIdentifications.length === 0, 'person-id-choice');
      }
    }
  },
];

ensure(handlers.length === PSA_ASSERTION_COUNT, 'registry-count');
const assertionRegistry = new Map<string, PsaAssertionHandler>(
  PSA_ASSERTION_MANIFEST.map((entry, index) => [psaAssertionKey(entry), handlers[index]!] as const),
);

export function createPsaAssertionRegistryForTest(): Map<string, PsaAssertionHandler> {
  return new Map(assertionRegistry);
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

export function verifyAssertionCoverage(
  parsed: XmlNode,
  extracted: readonly PsaAssertionIdentity[] = PSA_ASSERTION_MANIFEST,
  registry: ReadonlyMap<string, PsaAssertionHandler> = assertionRegistry,
): Set<string> {
  ensure(PSA_ASSERTION_MANIFEST.length === PSA_ASSERTION_COUNT, 'manifest-count');
  const manifestIdentities = PSA_ASSERTION_MANIFEST.map(({ context, test }) => ({ context, test }));
  ensure(createHash('sha256').update(JSON.stringify(manifestIdentities)).digest('hex') === PSA_ASSERTION_MANIFEST_SHA256, 'manifest-hash');
  const extractedIdentities = extracted.map(({ context, test }) => ({ context, test }));
  ensure(extracted.length === PSA_ASSERTION_COUNT, 'manifest-count');
  const extractedKeys = new Set(extractedIdentities.map(psaAssertionKey));
  const registryKeys = new Set(registry.keys());
  ensure(extractedKeys.size === PSA_ASSERTION_COUNT && sameSet(extractedKeys, registryKeys), 'registry-set');
  ensure(createHash('sha256').update(JSON.stringify(extractedIdentities)).digest('hex') === PSA_ASSERTION_MANIFEST_SHA256, 'manifest-hash');

  const executed = new Set<string>();
  for (const assertion of extracted) {
    const key = psaAssertionKey(assertion);
    const handler = registry.get(key);
    ensure(Boolean(handler), 'registry-set');
    handler!(parsed);
    executed.add(key);
  }
  ensure(sameSet(executed, extractedKeys), 'registry-execution');
  return executed;
}

export function validatePsaAssertions(
  parsed: XmlNode,
  extracted: readonly PsaAssertionIdentity[] = PSA_ASSERTION_MANIFEST,
): void {
  void verifyAssertionCoverage(parsed, extracted);
}
