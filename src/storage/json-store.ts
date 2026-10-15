import {
  readFileSync, writeFileSync, existsSync, mkdirSync, openSync, fsyncSync,
  closeSync, renameSync, unlinkSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MatchingState, Transaction, Document, MatchGroup, ExclusionRule, AuditEvent, CommunityAccounting } from '../core/types.js';
import { validateAccountingState } from '../community/accounting/ledger.js';
import { resolveAccountingPaths } from './paths.js';

/**
 * All saved Community JSON states are versioned. Unknown/old versions need an
 * explicit offline, non-destructive migration; never silently reinterpret them.
 */
export const COMMUNITY_JSON_STATE_VERSION = 1;
export const COMMUNITY_JSON_STATE_FORMAT = 'matching-community-state-v1';
export const COMMUNITY_ACCOUNTING_JSON_STATE_VERSION = 2;
export const COMMUNITY_ACCOUNTING_JSON_STATE_FORMAT = 'matching-community-state-v2';
const MAX_STATE_BYTES = 256 * 1024 * 1024;

interface SerializedState {
  schema_version: number;
  format: string;
  run_id: string;
  transactions: Record<string, Transaction>;
  documents: Record<string, Document>;
  match_groups: Record<string, MatchGroup>;
  exclusion_rules: ExclusionRule[];
  audit_events: AuditEvent[];
  matched_transaction_ids: string[];
  matched_document_ids: string[];
  excluded_transaction_ids: string[];
  accounting?: CommunityAccounting;
}

const DATA_DIR = resolveAccountingPaths().stateRoot;
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function assertInteger(value: unknown, description: string): void {
  if (!Number.isSafeInteger(value)) throw new Error('Invalid Community financial field: ' + description);
}
function assertIdentifiers(container: unknown, key: string, field: string): Set<string> {
  if (!isObject(container)) throw new Error('Invalid Community persisted ' + key);
  const ids = new Set<string>();
  for (const [id, raw] of Object.entries(container)) {
    if (!id || !isObject(raw) || raw[field] !== id) {
      throw new Error('Mismatched Community persisted identifier: ' + key);
    }
    ids.add(id);
  }
  return ids;
}
function assertIdArray(value: unknown, ids: Set<string>, name: string): void {
  if (!Array.isArray(value) || !value.every(id => typeof id === 'string' && ids.has(id))) {
    throw new Error('Invalid Community persisted relationship: ' + name);
  }
}

/** Reject structural corruption and unknown financial statuses before activation. */
export function validateCommunityJsonState(input: unknown): SerializedState {
  if (!isObject(input) || !(
    (input.schema_version === COMMUNITY_JSON_STATE_VERSION && input.format === COMMUNITY_JSON_STATE_FORMAT && input.accounting === undefined) ||
    (input.schema_version === COMMUNITY_ACCOUNTING_JSON_STATE_VERSION && input.format === COMMUNITY_ACCOUNTING_JSON_STATE_FORMAT && input.accounting !== undefined)
  )) {
    throw new Error('Unsupported Community JSON schema version; offline migration required');
  }
  if (typeof input.run_id !== 'string' || !input.run_id.trim() ||
      !Array.isArray(input.exclusion_rules) || !Array.isArray(input.audit_events)) {
    throw new Error('Invalid Community JSON state header or audit data');
  }
  const txIds = assertIdentifiers(input.transactions, 'transactions', 'transaction_id');
  const docIds = assertIdentifiers(input.documents, 'documents', 'document_id');
  assertIdentifiers(input.match_groups, 'match_groups', 'match_group_id');
  for (const transaction of Object.values(input.transactions as Record<string, Transaction>)) {
    assertInteger(transaction.amount_minor, 'transaction amount');
    if (typeof transaction.currency_code !== 'string' || !/^[A-Z]{3}$/.test(transaction.currency_code)) {
      throw new Error('Invalid persisted transaction currency');
    }
  }
  for (const document of Object.values(input.documents as Record<string, Document>)) {
    assertInteger(document.total_amount_minor, 'document total');
  }
  const statuses = new Set(['proposed', 'accepted', 'rejected', 'manual', 'confirmed']);
  for (const match of Object.values(input.match_groups as Record<string, MatchGroup>)) {
    if (!statuses.has(match.status)) throw new Error('Unsupported persisted match approval status');
    assertInteger(match.amount_total_minor, 'matching allocation');
    assertIdArray(match.transaction_ids, txIds, 'match transactions');
    assertIdArray(match.document_ids, docIds, 'match documents');
  }
  assertIdArray(input.matched_transaction_ids, txIds, 'matched transaction reservations');
  assertIdArray(input.matched_document_ids, docIds, 'matched document reservations');
  assertIdArray(input.excluded_transaction_ids, txIds, 'excluded transactions');
  const candidate: MatchingState = {
    run_id: input.run_id as string,
    transactions: new Map(Object.entries(input.transactions as Record<string, Transaction>)),
    documents: new Map(Object.entries(input.documents as Record<string, Document>)),
    match_groups: new Map(Object.entries(input.match_groups as Record<string, MatchGroup>)),
    exclusion_rules: input.exclusion_rules as ExclusionRule[], audit_events: input.audit_events as AuditEvent[],
    matched_transaction_ids: new Set(input.matched_transaction_ids as string[]),
    matched_document_ids: new Set(input.matched_document_ids as string[]),
    excluded_transaction_ids: new Set(input.excluded_transaction_ids as string[]),
    accounting: input.accounting as CommunityAccounting | undefined,
  };
  validateAccountingState(candidate);
  return input as unknown as SerializedState;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
function stateFilePath(filename: string): string {
  if (!/^[A-Za-z0-9_.-]+\.json$/.test(filename) || filename === '..') {
    throw new Error('Invalid accounting state filename');
  }
  return join(DATA_DIR, filename);
}

/** Replace a snapshot only after all bytes have been written and flushed. */
export function writeStateFileAtomically(
  target: string,
  content: string,
  options: { beforeRename?: () => void } = {},
): void {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    options.beforeRename?.();
    renameSync(temporary, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function serializeCommunityState(state: MatchingState): string {
  const serialized: SerializedState = {
    schema_version: state.accounting ? COMMUNITY_ACCOUNTING_JSON_STATE_VERSION : COMMUNITY_JSON_STATE_VERSION,
    format: state.accounting ? COMMUNITY_ACCOUNTING_JSON_STATE_FORMAT : COMMUNITY_JSON_STATE_FORMAT,
    run_id: state.run_id,
    transactions: Object.fromEntries(state.transactions),
    documents: Object.fromEntries(state.documents),
    match_groups: Object.fromEntries(state.match_groups),
    exclusion_rules: state.exclusion_rules,
    audit_events: state.audit_events,
    matched_transaction_ids: [...state.matched_transaction_ids],
    matched_document_ids: [...state.matched_document_ids],
    excluded_transaction_ids: [...state.excluded_transaction_ids],
    ...(state.accounting ? { accounting: state.accounting } : {}),
  };
  validateCommunityJsonState(serialized);
  return JSON.stringify(serialized, null, 2);
}

export function saveState(state: MatchingState, filename = 'state.json'): void {
  if (existsSync(join(DATA_DIR, 'statement-journal-v1.json'))) {
    throw new Error('Pending statement recovery must finish before another state write');
  }
  const content = serializeCommunityState(state);
  ensureDir(DATA_DIR);
  writeStateFileAtomically(stateFilePath(filename), content);
}

export function loadState(filename = 'state.json'): MatchingState | null {
  const path = stateFilePath(filename);
  if (!existsSync(path)) return null;
  if (statSync(path).size > MAX_STATE_BYTES) {
    throw new Error('Community persisted state exceeds the supported local file-size limit');
  }
  return deserializeCommunityState(JSON.parse(readFileSync(path, 'utf8')));
}

export function deserializeCommunityState(input: unknown): MatchingState {
  const raw = validateCommunityJsonState(input);
  return {
    run_id: raw.run_id,
    transactions: new Map(Object.entries(raw.transactions)),
    documents: new Map(Object.entries(raw.documents)),
    match_groups: new Map(Object.entries(raw.match_groups)),
    exclusion_rules: raw.exclusion_rules,
    audit_events: raw.audit_events,
    matched_transaction_ids: new Set(raw.matched_transaction_ids),
    matched_document_ids: new Set(raw.matched_document_ids),
    excluded_transaction_ids: new Set(raw.excluded_transaction_ids),
    accounting: raw.accounting,
  };
}

export function createEmptyState(run_id: string): MatchingState {
  return {
    run_id,
    transactions: new Map(),
    documents: new Map(),
    match_groups: new Map(),
    exclusion_rules: [],
    audit_events: [],
    matched_transaction_ids: new Set(),
    matched_document_ids: new Set(),
    excluded_transaction_ids: new Set(),
  };
}
