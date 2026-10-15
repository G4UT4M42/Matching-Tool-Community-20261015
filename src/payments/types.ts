import type { ExtractedFields, InvoiceScan } from '../invoicerec/types.js';

export interface FixedDebtor {
  readonly accountLabel: string;
  readonly accountHolder: string;
  readonly iban: string;
  readonly currencyCode: 'EUR';
}

export const FIXED_DEBTOR: FixedDebtor = Object.freeze({
  accountLabel: 'Fictional Business Demo',
  accountHolder: 'Fictional Business Demo',
  iban: 'DEMO_INVALID_IBAN',
  currencyCode: 'EUR',
});

export type PaymentObligation = 'unpaid' | 'paid' | 'unclear';

export interface PaymentCandidateInput {
  documentId: string;
  scanId: InvoiceScan['scan_id'];
  creditorName: ExtractedFields['seller_name'];
  creditorIban: string | null;
  amountMinor: ExtractedFields['gross_amount_minor'];
  currencyCode: ExtractedFields['currency_code'];
  remittanceInformation: string | null;
  structuredCreditorReference?: string | null;
  requestedExecutionDate: string | null;
  invoiceNumber?: ExtractedFields['invoice_number'];
  dueDate?: string | null;
  classification: PaymentObligation;
  reasonCode: string | null;
  sourceMeta: Record<string, unknown>;
}

export interface PaymentDraftInput {
  creditorName: string | null;
  creditorIban: string | null;
  amountMinor: number | null;
  currencyCode: string | null;
  remittanceInformation?: string | null;
  structuredCreditorReference?: string | null;
  requestedExecutionDate?: string | null;
}

export interface PaymentValidationIssue {
  code: string;
  message: string;
  field: keyof PaymentDraftInput;
  severity: 'error' | 'warning';
}

export interface PaymentEligibilityInput {
  status: InvoiceScan['status'];
  currencyCode: string | null;
  amountMinor: number | null;
  rawText: string;
  meta: InvoiceScan['meta'];
}

export interface PaymentEligibility {
  classification: PaymentObligation;
  eligible: boolean;
  reasonCode: string | null;
}
