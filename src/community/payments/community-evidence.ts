import type { MatchingState } from '../../core/types.js';
import { documentSettlementConvention } from '../accounting/document-settlement.js';
import { accountingOf, remainingBalances } from '../accounting/ledger.js';
import type { InvoiceEvidence, PaymentBatch } from './types.js';

/**
 * Only reviewed, workspace-owned positive supplier invoices are candidates.
 * No inferred IBAN, due date, tax status, document owner or payment authority.
 * Historical signed cashflow or receivable documents cannot become payables.
 */
export function currentPaymentInvoices(state:MatchingState,workspaceId:string):InvoiceEvidence[]{
  const balances=remainingBalances(state), accounting=accountingOf(state);
  const accepted=[...state.match_groups.values()].filter(group=>['accepted','confirmed','manual'].includes(group.status));
  return [...state.documents.values()].filter(doc=>doc.meta?.workspace_id===workspaceId)
    .filter(doc=>documentSettlementConvention(doc)==='payable-face-v1')
    .map(doc=>{
      const remaining=balances.document.get(doc.document_id);
      if(remaining===undefined||!Number.isSafeInteger(doc.total_amount_minor)||doc.total_amount_minor<=0)throw new Error('PAYMENT_EVIDENCE_INVALID');
      if(remaining<0n||remaining>BigInt(doc.total_amount_minor))throw new Error('PAYMENT_BALANCE_INVALID');
      const allocated=doc.total_amount_minor-Number(remaining);
      const links=accepted.filter(g=>g.document_ids.includes(doc.document_id)).map(g=>g.match_group_id)
        .concat(accounting.allocations.filter(a=>a.status==='accepted'&&a.document_id===doc.document_id).map(a=>a.allocation_id)).sort();
      const m=doc.meta, string=(key:string):string|null=>typeof m[key]==='string'&&m[key]?m[key] as string:null;
      return {
        documentId:doc.document_id,
        invoiceId:string('invoice_number')??doc.source_document_ref,
        sourceHash:doc.file_hash??'',
        confirmed:m.document_review_status==='confirmed',
        archived:m.document_review_status==='archived'||m.accounting_status==='cancelled',
        rejected:m.document_review_status==='rejected',
        totalMinor:doc.total_amount_minor,
        allocatedMinor:allocated,
        currency:doc.currency_code,
        creditorName:doc.supplier_name??null,
        creditorIban:string('iban'),
        reference:string('payment_reference'),
        dueDate:string('due_date'),
        matchIds:links,
      };
    });
}

/** A payment cannot be marked reconciled by an arbitrary user-supplied ID. */
export function provedPaymentReconciliation(state:MatchingState,workspaceId:string,batch:PaymentBatch,matchId:string):boolean{
  if(batch.workspaceId!==workspaceId||batch.status!=='acknowledged')return false;
  const match=state.match_groups.get(matchId);
  if(!match||!['accepted','confirmed','manual'].includes(match.status)||match.document_ids.length===0)return false;
  const all=new Set(match.document_ids);
  if(!batch.items.every(item=>all.has(item.documentId)))return false;
  if(batch.items.some(item=>state.documents.get(item.documentId)?.meta.workspace_id!==workspaceId))return false;
  const evidence=currentPaymentInvoices(state,workspaceId);
  return batch.items.every(item=>evidence.some(e=>e.documentId===item.documentId&&e.allocatedMinor===e.totalMinor));
}
