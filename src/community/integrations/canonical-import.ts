import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { MatchingState, Transaction } from '../../core/types.js';
import { recordAudit } from '../../observability/audit.js';
import type { CanonicalTransaction, CommitBatch } from './types.js';

type Batch = Parameters<CommitBatch>[0];
export interface ProviderImportResult { state: MatchingState; added: number; duplicates: number; events: number; importedEvents: number }
const digest = (values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const identity = (event: CanonicalTransaction, kind: 'source' | 'fee') =>
  'PROV-' + digest([event.provider, event.environment, event.account, event.reference, event.classification, event.currency, kind]).slice(0, 40);

function checkedEvent(event: CanonicalTransaction, batch: Batch): void {
  if (!event || event.provider !== batch.provider || event.environment !== batch.environment ||
      event.account !== batch.principal.subject ||
      !/^[A-Za-z0-9:_-]{1,160}$/.test(event.reference) ||
      !/^[A-Z]{3}$/.test(event.currency) ||
      !['payment','refund','dispute','fee','payout','other'].includes(event.classification) ||
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      !Number.isSafeInteger(event.amountMinor) || !Number.isSafeInteger(event.feeMinor) ||
      !Number.isSafeInteger(event.netMinor) ||
      !Number.isSafeInteger(event.amountMinor + event.feeMinor) ||
      event.amountMinor + event.feeMinor !== event.netMinor ||
      typeof event.revenue !== 'boolean' ||
      (event.relatedReference !== undefined && (typeof event.relatedReference !== 'string' || event.relatedReference.length > 256))) {
    throw new Error('INVALID_PROVIDER_EVENT');
  }
}

function row(event: CanonicalTransaction, kind: 'source' | 'fee', amount: number): Transaction {
  const fee = kind === 'fee';
  const sourceRef = [event.reference, event.classification, event.currency, ...(fee ? ['fee'] : [])].join(':');
  return {
    transaction_id: identity(event,kind),
    source_system: event.provider,
    source_account_id: event.account + ':' + event.environment,
    source_row_ref: sourceRef,
    posting_at: event.occurredAt,
    amount_minor: amount === 0 ? 0 : amount,
    currency_code: event.currency,
    description_raw: fee ? event.provider + ' provider fee for ' + event.reference : event.provider + ' ' + event.classification + ' ' + event.reference,
    booking_reference: event.reference,
    ...(event.relatedReference ? {payment_reference:event.relatedReference} : {}),
    tags: fee ? ['provider-import','provider-fee'] : ['provider-import'],
    meta: {
      provider_environment: event.environment,
      provider_classification: fee ? 'fee' : event.classification,
      provider_source_event_key: event.sourceEventKey ?? null,
      provider_gross_minor: event.amountMinor === 0 ? 0 : event.amountMinor,
      provider_fee_minor: event.feeMinor === 0 ? 0 : event.feeMinor,
      provider_net_minor: event.netMinor === 0 ? 0 : event.netMinor,
      provider_revenue_evidence: event.revenue,
      accounting_event_kind: fee ? 'provider_fee' : event.classification === 'payout' ? 'provider_payout' : 'provider_' + event.classification,
    },
  };
}

/**
 * Convert provider events to immutable canonical accounting evidence. A repeated
 * reference with changed amount or provenance MUST fail, never create revenue
 * twice or silently replace the original source. Provider fees are separate
 * signed cashflow legs, so payout and gross records cannot disguise net fees.
 * This is pure preparation; the caller durably commits through the shared
 * SQLite/JSON journal before a provider checkpoint can advance.
 */
export function prepareProviderImport(input: MatchingState, batch: Batch): ProviderImportResult {
  if (!batch || !batch.principal || typeof batch.principal.subject !== 'string' ||
      !['paypal','stripe'].includes(batch.provider) || !['sandbox','test','live'].includes(batch.environment) ||
      !Array.isArray(batch.transactions) || batch.transactions.length > 10000) {
    throw new Error('INVALID_PROVIDER_BATCH');
  }
  const state = structuredClone(input);
  let added = 0, duplicates = 0, importedEvents = 0;
  const knownRefs = new Map<string,string>();
  for (const existing of state.transactions.values()) {
    const ref = [existing.source_system,existing.source_account_id,existing.source_row_ref].join('\u0000');
    const found = knownRefs.get(ref);
    if (found && found !== existing.transaction_id) throw new Error('PROVIDER_SOURCE_COLLISION');
    knownRefs.set(ref,existing.transaction_id);
  }
  for (const event of batch.transactions) {
    checkedEvent(event,batch);
    const precedingAdded = added;
    const candidates: Transaction[] = [row(event,'source',event.amountMinor)];
    if (event.feeMinor !== 0) candidates.push(row(event,'fee',event.feeMinor));
    for (const next of candidates) {
      const sourceKey = [next.source_system,next.source_account_id,next.source_row_ref].join('\u0000');
      const priorId = knownRefs.get(sourceKey);
      if (priorId !== undefined && priorId !== next.transaction_id) throw new Error('PROVIDER_SOURCE_COLLISION');
      const previous = state.transactions.get(next.transaction_id);
      if (previous) {
        if (!isDeepStrictEqual(previous,next)) throw new Error('PROVIDER_SOURCE_CONFLICT');
        duplicates++;
        continue;
      }
      state.transactions.set(next.transaction_id,next);
      knownRefs.set(sourceKey,next.transaction_id);
      added++;
    }
    if(added > precedingAdded)importedEvents++;
  }
  if (added) {
    recordAudit(state,'TRANSACTIONS_IMPORTED','Run',
      'PROVIDER-' + randomUUID(),
      {actor_type:'user',actor_id:batch.principal.subject,reason:'Durable user-requested provider synchronization',
       after:{provider:batch.provider,environment:batch.environment,source_events:batch.transactions.length,created_ledger_rows:added,duplicate_ledger_rows:duplicates}});
  }
  return {state,added,duplicates,events:batch.transactions.length,importedEvents};
}
