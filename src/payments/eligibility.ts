import type {
  PaymentEligibility,
  PaymentEligibilityInput,
} from './types.js';

const PAID_TEXT = /^[ \t]*(?:bezahlt|paid|(?:bereits|schon)[ \t]+bezahlt|(?:bereits[ \t]+)?mit[ \t]+(?:visa|mastercard|maestro|karte)[ \t]+bezahlt|(?:bar|karten)zahlung|kartenzahlung|paid[ \t]+(?:by|with)(?:[ \t]+.+)?|payment[ \t]+received|zahlung[ \t]+erhalten)[ \t]*[.!]?[ \t]*$/im;
const RECEIPT_TEXT = /kassenbon|kassenbeleg|kartenbeleg|receipt/i;
const CREDIT_NOTE_TEXT = /\b(?:rechnungskorrektur|gutschrift|kredit(?:nummer|betrag|datum)|credit\s+note)\b/i;
const INVOICE_OR_DUE_TEXT = /\brechnung\b|\binvoice\b|zahlbar(?:\s+bis|\s+sofort)?|f[aä]llig(?:keit)?|payment\s+due|due\s+date/i;

function result(
  classification: PaymentEligibility['classification'],
  reasonCode: string | null,
): PaymentEligibility {
  return {
    classification,
    eligible: classification === 'unpaid',
    reasonCode,
  };
}

function metaSaysPaid(meta: Record<string, unknown>): boolean {
  return meta.paid === true
    || meta.alreadyPaid === true
    || meta.paymentStatus === 'paid'
    || meta.payment_status === 'paid';
}

export function classifyPaymentEligibility(input: PaymentEligibilityInput): PaymentEligibility {
  const rawText = String(input.rawText ?? '');

  if (input.meta.is_refund === true || input.meta.is_credit_note === true || CREDIT_NOTE_TEXT.test(rawText)) {
    return result('unclear', 'CREDIT_NOTE');
  }

  if (metaSaysPaid(input.meta) || PAID_TEXT.test(rawText)) {
    return result('paid', RECEIPT_TEXT.test(rawText) ? 'ALREADY_PAID_RECEIPT' : 'ALREADY_PAID');
  }

  if (input.status !== 'confirmed') {
    return result('unclear', 'SCAN_NOT_CONFIRMED');
  }

  if (input.currencyCode !== 'EUR') {
    return result('unclear', 'CURRENCY_NOT_EUR');
  }

  if (!Number.isInteger(input.amountMinor) || (input.amountMinor ?? 0) <= 0) {
    return result('unclear', 'AMOUNT_NOT_POSITIVE');
  }

  if (INVOICE_OR_DUE_TEXT.test(rawText)) {
    return result('unpaid', null);
  }

  return result('unclear', 'PAYMENT_OBLIGATION_UNCLEAR');
}
