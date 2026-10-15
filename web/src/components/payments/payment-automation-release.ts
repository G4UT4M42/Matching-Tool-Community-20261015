import type {
  PaymentAutomationStatus,
  PaymentReleaseConfirmation,
} from '../../api';

export interface PaymentReleaseBatchSnapshot {
  batchId: string;
  status: string;
  debtorIban: string;
  itemCount: number;
  controlSumMinor: number;
  xmlSha256: string | null;
}

export type PaymentAutomationReleaseDecision =
  | { kind: 'none'; label: '' }
  | { kind: 'confirm_release'; label: string }
  | { kind: 'reconcile_status'; label: 'Freigabestatus sicher abgleichen' };

export function paymentAutomationManualGuidance(
  automation: PaymentAutomationStatus,
): string | null {
  if (automation.phase === 'waiting_login_2fa'
    || (automation.phase === 'requesting_release' && automation.error?.code === 'WAITING_LOGIN_2FA')) {
    return 'Bitte geben Sie jetzt die George-Anmeldung manuell in Ihrer Banking-App frei. Danach wird derselbe sichere Vorgang automatisch fortgesetzt.';
  }
  if (automation.phase === 'waiting_release_2fa') {
    return 'Bitte bestätigen oder verwerfen Sie jetzt die Sammelfreigabe in Ihrer Banking-App. Erst der anschließende George-Readback gilt als Freigabenachweis.';
  }
  return null;
}

export function exactPaymentReleaseConfirmation(
  automation: PaymentAutomationStatus,
  batch: PaymentReleaseBatchSnapshot,
): PaymentReleaseConfirmation | null {
  if (batch.status !== 'prepared'
    || automation.batch_id !== batch.batchId
    || automation.available_action === 'none'
    || automation.evidence.debtor_iban !== batch.debtorIban
    || automation.evidence.item_count !== batch.itemCount
    || automation.evidence.control_sum_minor !== batch.controlSumMinor
    || !batch.xmlSha256
    || automation.evidence.xml_sha256 !== batch.xmlSha256
    || !automation.evidence.package_reference) {
    return null;
  }
  return {
    debtor_iban: automation.evidence.debtor_iban,
    item_count: automation.evidence.item_count,
    control_sum_minor: automation.evidence.control_sum_minor,
    xml_sha256: automation.evidence.xml_sha256,
  };
}

export function paymentAutomationReleaseDecision(
  automation: PaymentAutomationStatus,
  batch: PaymentReleaseBatchSnapshot,
): PaymentAutomationReleaseDecision {
  if (!exactPaymentReleaseConfirmation(automation, batch)) return { kind: 'none', label: '' };
  if (automation.available_action === 'reconcile_release_status') {
    return { kind: 'reconcile_status', label: 'Freigabestatus sicher abgleichen' };
  }
  if (automation.available_action === 'request_release') {
    return {
      kind: 'confirm_release',
      label: automation.phase === 'prepared'
        ? 'Sammelfreigabe anfordern'
        : 'Sammelfreigabe sicher erneut anfordern',
    };
  }
  return { kind: 'none', label: '' };
}
