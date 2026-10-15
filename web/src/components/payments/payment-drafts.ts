import type { PaymentBatchItem } from '../../api';

export interface ItemDraft {
  creditorName: string;
  creditorIban: string;
  amount: string;
  currencyCode: string;
  reference: string;
  structuredReference: string;
  requestedExecutionDate: string;
}

function amountInput(value: number | null): string {
  if (value === null || !Number.isSafeInteger(value)) return '';
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 100)},${String(absolute % 100).padStart(2, '0')}`;
}

export function draftFromPaymentItem(item: PaymentBatchItem): ItemDraft {
  return {
    creditorName: item.creditorName ?? '',
    creditorIban: item.creditorIban ?? '',
    amount: amountInput(item.amountMinor),
    currencyCode: item.currencyCode ?? 'EUR',
    reference: item.remittanceInformation ?? '',
    structuredReference: item.structuredCreditorReference ?? '',
    requestedExecutionDate: item.requestedExecutionDate ?? '',
  };
}

export function mergePaymentDrafts(
  current: Record<string, ItemDraft>,
  items: PaymentBatchItem[],
  refreshedItemId?: string,
): Record<string, ItemDraft> {
  return Object.fromEntries(items.map(item => [
    item.itemId,
    item.itemId === refreshedItemId || !current[item.itemId]
      ? draftFromPaymentItem(item)
      : current[item.itemId],
  ]));
}
