export type PaymentStatus = 'draft'|'validated'|'reviewed'|'approved'|'submission_claimed'|'acknowledged'|'unknown'|'failed'|'reconciled'|'cancelled';
export type PaymentPermission = 'finance:read'|'payments:prepare'|'payments:approve'|'payments:submit'|'integrations:read'|'integrations:configure'|'integrations:sync';
export interface Principal { subject: string; workspace_id: string; role: string; session_id: string; authenticated_at: string; reauthenticated_at?: string; permissions: string[] }
export interface InvoiceEvidence {
  /** Canonical original workspace for explicitly adopted evidence only. */
  originalWorkspaceId?: string;
  /** Exact original/prior adopted namespaces, for read-only history and dedup. */
  paymentWorkspaceIds?: string[];
  documentId: string; invoiceId: string; sourceHash: string; confirmed: boolean;
  archived: boolean; rejected: boolean; totalMinor: number; allocatedMinor: number;
  currency: string; creditorName: string|null; creditorIban: string|null;
  reference: string|null; dueDate: string|null; matchIds: string[];
}
export interface PaymentItem { id: string; documentId: string; invoiceId: string; sourceHash: string; creditorName: string; creditorIban: string; amountMinor: number; currency: 'EUR'; reference: string; dueDate: string; matchIds: string[] }
export interface Candidate { evidence: InvoiceEvidence; outstandingMinor: number; issues: string[]; eligible: boolean }
export interface PaymentBatch { id: string; workspaceId: string; debtorIban: string; debtorName: string; provider: string; environment: 'mock'|'live'; status: PaymentStatus; revision: number; detailDigest: string; items: PaymentItem[]; createdAt:string; reviewer?: string; approver?: string; approvalRevision?: number; approvalDigest?: string; claimId?: string; providerReference?: string }
export interface PaymentAdapter { provider: string; environment: 'mock'|'live'; submit(input: { claimId: string; batch: PaymentBatch; credential: unknown }): Promise<{ outcome: 'acknowledged'|'failed'|'unknown'; reference?: string }>; readStatus(input: { claimId: string; reference?: string; credential: unknown }): Promise<{ outcome: 'acknowledged'|'failed'|'unknown'; reference?: string }> }
export interface CredentialResolver { resolve(input: { subject: string; workspaceId: string; provider: string; environment: 'mock'|'live'; vaultRef: string }): Promise<unknown> }
export interface AccountingCallbacks<State> { loadState(): State; persistAndActivate(expectedState: State, nextState: State, actor: string): void; invoiceEvidence(state: State, workspaceId: string): InvoiceEvidence[]; confirmedReconciliation(state:State, workspaceId:string, batch:PaymentBatch, matchId:string):boolean }
