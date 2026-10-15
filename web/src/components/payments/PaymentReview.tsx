import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  cancelPaymentBatch,
  downloadPaymentBatchXml,
  getPaymentAutomationStatus,
  getPaymentBatch,
  importPaymentBatchToGeorge,
  requestPaymentBatchRelease,
  reviewPaymentBatch,
  paymentApiErrorMessage,
  updatePaymentItem,
  type PaymentAutomationStatus,
  type PaymentBatchItem,
  type PaymentBatchView,
  type PaymentItemPatch,
} from '../../api';
import { Badge, Button, Card, colors } from '../shared';
import { draftFromPaymentItem, mergePaymentDrafts, type ItemDraft } from './payment-drafts';
import {
  exactPaymentReleaseConfirmation,
  paymentAutomationManualGuidance,
  paymentAutomationReleaseDecision,
} from './payment-automation-release';
import {
  PaymentOperationGuard,
  isPaymentOperationPreconditionSatisfied,
  type PaymentOperationToken,
} from './payment-operation-guard';

export interface PaymentReviewProps {
  batchId: string;
  onBack: () => void;
  onChanged: () => void;
}


interface CandidateEvidence {
  strategy?: string;
  confidence?: Record<string, number | null>;
  sources?: Record<string, string>;
}

interface ScanDetail {
  payment_candidate?: {
    candidateId?: string;
    sourceMeta?: CandidateEvidence;
  } | null;
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Entwurf',
  reviewed: 'Geprüft',
  exported: 'SEPA exportiert',
  prepared: 'In Bank vorbereitet',
  released: 'Freigegeben',
  cancelled: 'Storniert',
  failed: 'Fehler',
};

const AUTOMATION_PHASE_COPY: Record<PaymentAutomationStatus['phase'], string> = {
  queued: 'Automation eingereiht.',
  connecting_browser: 'Verbindung zu George wird hergestellt.',
  waiting_login_2fa: 'Anmeldung in der Banking-App freigeben. Passwort und 2FA bleiben vollständig bei Ihnen.',
  uploading: 'SEPA-Paket wird hochgeladen.',
  upload_attempted: 'Upload wurde angestoßen; das vorhandene Paket wird sicher gesucht und geprüft.',
  verifying_import: 'Import wird geprüft.',
  prepared: 'Paket in George vorbereitet und gegen den exportierten Stapel geprüft.',
  requesting_release: 'Sammelfreigabe wird sicher vorbereitet.',
  release_click_claimed: 'Freigabe wurde genau einmal angefordert; Bankstatus wird geprüft.',
  waiting_release_2fa: 'Freigabe in der Banking-App bestätigen. Erst George-Nachweis bedeutet Freigabe.',
  verifying_release: 'Endgültiger Freigabestatus wird in George geprüft.',
  released: 'Freigabe durch George verifiziert.',
  failed: 'Automation fehlgeschlagen. Keine Freigabe wird angenommen.',
  unknown: 'Status unbekannt. Nicht als bezahlt oder freigegeben behandeln.',
};

const POLLED_PHASES = new Set<PaymentAutomationStatus['phase']>([
  'queued', 'connecting_browser', 'waiting_login_2fa', 'uploading', 'upload_attempted',
  'verifying_import', 'requesting_release', 'release_click_claimed', 'waiting_release_2fa', 'verifying_release',
]);

const fieldStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: 12,
};

const thStyle: React.CSSProperties = {
  padding: '7px 8px', textAlign: 'left', fontSize: 11, color: '#666', borderBottom: '1px solid #ddd', verticalAlign: 'bottom',
};

const tdStyle: React.CSSProperties = {
  padding: '8px', borderBottom: '1px solid #eee', verticalAlign: 'top',
};

function formatMinor(value: number | null, currency = 'EUR'): string {
  if (value === null || !Number.isSafeInteger(value)) return '—';
  return new Intl.NumberFormat('de-AT', { style: 'currency', currency }).format(value / 100);
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('de-AT');
}


function parseMinor(value: string): number | null {
  const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const euros = Number(match[1]);
  const cents = Number((match[2] ?? '').padEnd(2, '0'));
  const result = euros * 100 + cents;
  return Number.isSafeInteger(result) ? result : null;
}


function errorMessage(error: unknown): string {
  return paymentApiErrorMessage(error);
}

function startDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function Evidence({ evidence }: { evidence?: CandidateEvidence }) {
  const fields: Array<[string, string]> = [
    ['creditorName', 'Gläubigername'],
    ['creditorIban', 'Gläubiger-IBAN'],
    ['amountMinor', 'Betrag'],
    ['currencyCode', 'Währung'],
    ['remittanceInformation', 'Verwendungszweck'],
    ['structuredCreditorReference', 'Strukturierte Referenz'],
    ['requestedExecutionDate', 'Ausführungsdatum'],
    ['invoiceNumber', 'Rechnungsnummer'],
    ['dueDate', 'Fälligkeitsdatum'],
  ];
  return (
    <div style={{ minWidth: 150, fontSize: 10, color: '#666', lineHeight: 1.5 }}>
      <div><b>Quelle:</b> {evidence?.strategy ?? 'bestätigter Beleg'}</div>
      {fields.map(([field, label]) => {
        const source = evidence?.sources?.[field];
        const confidence = evidence?.confidence?.[field];
        if (!source && confidence == null) return null;
        return (
          <div key={field}>
            {label}: {source ?? '—'}{confidence == null ? '' : ` · ${Math.round(confidence * 100)} %`}
          </div>
        );
      })}
    </div>
  );
}

export function PaymentReview({ batchId, onBack, onChanged }: PaymentReviewProps) {
  const [view, setView] = useState<PaymentBatchView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});
  const [evidence, setEvidence] = useState<Record<string, CandidateEvidence>>({});
  const [confirmedUnpaid, setConfirmedUnpaid] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [automation, setAutomation] = useState<PaymentAutomationStatus | null>(null);
  const [releaseDialogOpen, setReleaseDialogOpen] = useState(false);
  const [operationGuard] = useState(() => new PaymentOperationGuard(batchId));
  const loadAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const isLoadCurrent = useCallback((token: PaymentOperationToken): boolean => (
    operationGuard.isCurrent(token) && token.batchId === batchId
  ), [batchId, operationGuard]);

  const isMutationCurrent = useCallback((operationView: PaymentBatchView, token: PaymentOperationToken): boolean => (
    operationGuard.isCurrent(token)
      && isPaymentOperationPreconditionSatisfied(operationView.batch.batchId, batchId, token)
  ), [batchId, operationGuard]);

  const load = useCallback(async (clearError = true) => {
    loadAbortRef.current?.abort();
    const token = operationGuard.capture(batchId);
    if (!token) return;
    loadAbortRef.current = token.controller;
    if (clearError && isLoadCurrent(token)) setError('');
    try {
      const next = await getPaymentBatch(token.batchId, token.controller.signal);
      if (!isLoadCurrent(token) || !isPaymentOperationPreconditionSatisfied(next.batch.batchId, batchId, token)) return;
      setView(next);
      if (!isLoadCurrent(token)) return;
      setDrafts(previous => mergePaymentDrafts(previous, next.batch.items));
      const details = await Promise.all(next.batch.items.map(async item => {
        try {
          const response = await fetch(`/api/invoicerec/scans/${encodeURIComponent(item.scanId)}`, { signal: token.controller.signal });
          if (!isLoadCurrent(token)) return [item.itemId, {}] as const;
          if (!response.ok) throw new Error(response.statusText);
          const detail = await response.json() as ScanDetail;
          if (!isLoadCurrent(token)) return [item.itemId, {}] as const;
          return [
            item.itemId,
            detail.payment_candidate?.candidateId === item.candidateId
              ? detail.payment_candidate.sourceMeta ?? {}
              : {},
          ] as const;
        } catch {
          return [item.itemId, {}] as const;
        }
      }));
      if (!isLoadCurrent(token)) return;
      setEvidence(Object.fromEntries(details));
    } catch (loadError) {
      if (!isLoadCurrent(token)) return;
      if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) setError(errorMessage(loadError));
    } finally {
      if (loadAbortRef.current === token.controller) loadAbortRef.current = null;
      operationGuard.release(token);
    }
  }, [batchId, isLoadCurrent, operationGuard]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
  }, []);

  const pollAutomation = useCallback(async function poll(attempt = 0): Promise<void> {
    pollAbortRef.current?.abort();
    const token = operationGuard.capture(batchId);
    if (!token) return;
    pollAbortRef.current = token.controller;
    try {
      const next = await getPaymentAutomationStatus(token.batchId, token.controller.signal);
      if (!operationGuard.isCurrent(token) || next.batch_id !== batchId) return;
      setAutomation(next);
      if (next.phase === 'prepared' || next.phase === 'released') void load(false);
      if (POLLED_PHASES.has(next.phase) && operationGuard.isCurrent(token)) {
        const delay = Math.min(1_000 * (2 ** Math.min(attempt, 4)), 15_000);
        pollTimerRef.current = window.setTimeout(() => void poll(attempt + 1), delay);
      }
    } catch (pollError) {
      if (!operationGuard.isCurrent(token)) return;
      const code = (pollError as { code?: unknown })?.code;
      if (code !== 'PAYMENT_AUTOMATION_RUN_NOT_FOUND') setError(errorMessage(pollError));
    } finally {
      if (pollAbortRef.current === token.controller) pollAbortRef.current = null;
      operationGuard.release(token);
    }
  }, [batchId, load, operationGuard]);

  const beginMutation = (operationView: PaymentBatchView): PaymentOperationToken | null => {
    if (operationView.batch.batchId !== batchId) return null;
    stopPolling();
    mutationAbortRef.current?.abort();
    loadAbortRef.current?.abort();
    const token = operationGuard.capture(batchId);
    if (!token || !isMutationCurrent(operationView, token)) {
      token?.controller.abort();
      if (token) operationGuard.release(token);
      return null;
    }
    mutationAbortRef.current = token.controller;
    return token;
  };

  const finishMutation = (token: PaymentOperationToken): void => {
    if (mutationAbortRef.current === token.controller) mutationAbortRef.current = null;
    operationGuard.release(token);
  };

  useLayoutEffect(() => {
    operationGuard.mount();
    return () => {
      stopPolling();
      operationGuard.dispose();
      loadAbortRef.current = null;
      mutationAbortRef.current = null;
      pollAbortRef.current = null;
    };
  }, [operationGuard, stopPolling]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (view?.batch.batchId === batchId && ['exported', 'prepared', 'released'].includes(view.batch.status)) {
      void pollAutomation(0);
    }
    return stopPolling;
  }, [batchId, pollAutomation, stopPolling, view?.batch.batchId, view?.batch.status]);

  const saveItem = async (item: PaymentBatchItem) => {
    const operationView = view;
    if (!operationView || operationView.batch.batchId !== batchId) return;
    const draft = drafts[item.itemId];
    if (!draft) return;
    const token = beginMutation(operationView);
    if (!token) return;
    const amountMinor = parseMinor(draft.amount);
    if (amountMinor === null || amountMinor <= 0) {
      if (isMutationCurrent(operationView, token)) setError('Betrag muss als positiver EUR-Betrag mit höchstens zwei Nachkommastellen eingegeben werden.');
      finishMutation(token);
      return;
    }
    const patch: PaymentItemPatch = {
      creditor_name: draft.creditorName || null,
      creditor_iban: draft.creditorIban || null,
      amount_minor: amountMinor,
      currency_code: draft.currencyCode || null,
      remittance_information: draft.reference || null,
      structured_creditor_reference: draft.structuredReference || null,
      requested_execution_date: draft.requestedExecutionDate || null,
    };
    if (!isMutationCurrent(operationView, token)) return;
    setBusy(item.itemId);
    if (!isMutationCurrent(operationView, token)) return;
    setError('');
    if (!isMutationCurrent(operationView, token)) return;
    setNotice('');
    try {
      const next = await updatePaymentItem(token.batchId, item.itemId, operationView.revision, patch, token.controller.signal);
      if (!isMutationCurrent(operationView, token)
        || !isPaymentOperationPreconditionSatisfied(next.batch.batchId, batchId, token)) return;
      setView(next);
      if (!isMutationCurrent(operationView, token)) return;
      setDrafts(current => mergePaymentDrafts(current, next.batch.items, item.itemId));
      if (!isMutationCurrent(operationView, token)) return;
      setConfirmedUnpaid(false);
      if (!isMutationCurrent(operationView, token)) return;
      setNotice('Zahlungsposition gespeichert und serverseitig neu geprüft.');
      if (!isMutationCurrent(operationView, token)) return;
      onChanged();
    } catch (saveError) {
      if (!isMutationCurrent(operationView, token)) return;
      const message = errorMessage(saveError);
      if (!isMutationCurrent(operationView, token)) return;
      await load(false);
      if (!isMutationCurrent(operationView, token)) return;
      setError(message);
    } finally {
      if (isMutationCurrent(operationView, token)) setBusy(null);
      finishMutation(token);
    }
  };

  const review = async () => {
    const operationView = view;
    if (!operationView || operationView.batch.batchId !== batchId || !confirmedUnpaid) return;
    const token = beginMutation(operationView);
    if (!token) return;
    if (!isMutationCurrent(operationView, token)) return;
    setBusy('review');
    if (!isMutationCurrent(operationView, token)) return;
    setError('');
    if (!isMutationCurrent(operationView, token)) return;
    setNotice('');
    try {
      const next = await reviewPaymentBatch(token.batchId, operationView.revision, true, token.controller.signal);
      if (!isMutationCurrent(operationView, token)
        || !isPaymentOperationPreconditionSatisfied(next.batch.batchId, batchId, token)) return;
      setView(next);
      if (!isMutationCurrent(operationView, token)) return;
      setNotice('Zahlungsstapel geprüft. Die Daten sind jetzt unveränderlich und für den SEPA-Export bereit.');
      if (!isMutationCurrent(operationView, token)) return;
      onChanged();
    } catch (reviewError) {
      if (!isMutationCurrent(operationView, token)) return;
      const message = errorMessage(reviewError);
      if (!isMutationCurrent(operationView, token)) return;
      await load(false);
      if (!isMutationCurrent(operationView, token)) return;
      setError(message);
    } finally {
      if (isMutationCurrent(operationView, token)) setBusy(null);
      finishMutation(token);
    }
  };

  const exportXml = async () => {
    const operationView = view;
    if (!operationView || operationView.batch.batchId !== batchId || operationView.batch.status !== 'reviewed') return;
    const batch = operationView.batch;
    const confirmation = [
      'SEPA-Datei wirklich erzeugen und herunterladen?',
      '',
      `Schuldner-IBAN: ${batch.debtorIban}`,
      `Transaktionen: ${batch.itemCount}`,
      `Kontrollsumme: ${formatMinor(batch.controlSumMinor, batch.currencyCode)}`,
      '',
      'Dies exportiert nur eine Datei und führt keine Bankaktion aus.',
    ].join('\n');
    if (!confirm(confirmation)) return;
    const token = beginMutation(operationView);
    if (!token) return;
    if (!isMutationCurrent(operationView, token)) return;
    setBusy('export');
    if (!isMutationCurrent(operationView, token)) return;
    setError('');
    if (!isMutationCurrent(operationView, token)) return;
    setNotice('');
    try {
      const result = await downloadPaymentBatchXml(token.batchId, batch.controlSumMinor, operationView.revision, token.controller.signal);
      if (!isMutationCurrent(operationView, token) || result.batchId !== batchId) return;
      startDownload(result.blob, result.filename);
      if (!isMutationCurrent(operationView, token)) return;
      setNotice(`SEPA-Datei exportiert: ${result.filename} · Stapel ${result.batchId} · Kontrollsumme ${formatMinor(result.controlSumMinor, batch.currencyCode)}.`);
      if (!isMutationCurrent(operationView, token)) return;
      await load();
      if (!isMutationCurrent(operationView, token)) return;
      onChanged();
    } catch (exportError) {
      if (!isMutationCurrent(operationView, token)) return;
      const message = `${errorMessage(exportError)} Falls der Export bereits serverseitig gespeichert wurde, kann der Download nach dem Aktualisieren erneut versucht werden.`;
      if (!isMutationCurrent(operationView, token)) return;
      await load(false);
      if (!isMutationCurrent(operationView, token)) return;
      setError(message);
    } finally {
      if (isMutationCurrent(operationView, token)) setBusy(null);
      finishMutation(token);
    }
  };

  const retryDownload = async () => {
    const operationView = view;
    if (!operationView || operationView.batch.batchId !== batchId || operationView.batch.status !== 'exported') return;
    const token = beginMutation(operationView);
    if (!token) return;
    if (!isMutationCurrent(operationView, token)) return;
    setBusy('retry');
    if (!isMutationCurrent(operationView, token)) return;
    setError('');
    try {
      const result = await downloadPaymentBatchXml(token.batchId, operationView.batch.controlSumMinor, undefined, token.controller.signal);
      if (!isMutationCurrent(operationView, token) || result.batchId !== batchId) return;
      startDownload(result.blob, result.filename);
      if (!isMutationCurrent(operationView, token)) return;
      setNotice(`SEPA-Datei exportiert: ${result.filename} · Stapel ${result.batchId} · Kontrollsumme ${formatMinor(result.controlSumMinor, operationView.batch.currencyCode)}.`);
    } catch (retryError) {
      if (!isMutationCurrent(operationView, token)) return;
      setError(errorMessage(retryError));
    } finally {
      if (isMutationCurrent(operationView, token)) setBusy(null);
      finishMutation(token);
    }
  };

  const prepareInGeorge = async () => {
    const operationView = view;
    if (!operationView || operationView.batch.batchId !== batchId || operationView.batch.status !== 'exported') return;
    const token = beginMutation(operationView);
    if (!token) return;
    setBusy('george-import');
    setError('');
    setNotice('');
    try {
      const next = await importPaymentBatchToGeorge(token.batchId, token.controller.signal);
      if (!isMutationCurrent(operationView, token) || next.batch_id !== batchId) return;
      setAutomation(next);
      setNotice('George-Import wurde eingereiht. Die Seite zeigt ausschließlich den serverseitig verifizierten Fortschritt.');
      window.setTimeout(() => void pollAutomation(0), 0);
    } catch (importError) {
      if (isMutationCurrent(operationView, token)) setError(errorMessage(importError));
    } finally {
      if (isMutationCurrent(operationView, token)) setBusy(null);
      finishMutation(token);
    }
  };

  const submitReleaseAction = async (
    expectedAction: 'request_release' | 'reconcile_release_status',
  ) => {
    const operationView = view;
    const current = automation;
    if (!operationView || operationView.batch.batchId !== batchId || !current
      || current.batch_id !== batchId || current.available_action !== expectedAction) return;
    const confirmation = exactPaymentReleaseConfirmation(current, operationView.batch);
    if (!confirmation) {
      setError('Die verifizierten George-Daten stimmen nicht exakt mit dem unveränderlichen Zahlungsstapel überein.');
      return;
    }
    const token = beginMutation(operationView);
    if (!token) return;
    setBusy(expectedAction === 'request_release' ? 'release' : 'release-reconcile');
    setError('');
    try {
      const next = await requestPaymentBatchRelease(
        token.batchId,
        confirmation,
        token.controller.signal,
      );
      if (!isMutationCurrent(operationView, token) || next.batch_id !== batchId) return;
      setAutomation(next);
      setReleaseDialogOpen(false);
      setNotice(expectedAction === 'request_release'
        ? 'Sammelfreigabe wurde angefordert. Dies ist noch kein Zahlungs- oder Freigabenachweis.'
        : 'Der Freigabestatus wird ausschließlich lesend mit George abgeglichen. Es wurde keine zweite Freigabe angefordert.');
      window.setTimeout(() => void pollAutomation(0), 0);
    } catch (releaseError) {
      if (isMutationCurrent(operationView, token)) setError(errorMessage(releaseError));
    } finally {
      if (isMutationCurrent(operationView, token)) setBusy(null);
      finishMutation(token);
    }
  };

  const requestRelease = async () => submitReleaseAction('request_release');
  const reconcileReleaseStatus = async () => submitReleaseAction('reconcile_release_status');

  const cancelBatch = async () => {
    const operationView = view;
    if (!operationView || operationView.batch.batchId !== batchId
      || !['draft', 'reviewed', 'exported'].includes(operationView.batch.status)) return;
    if (operationView.batch.status === 'exported' && !confirm(
      'Diesen exportierten Zahlungsstapel wirklich stornieren?\n\nDie bereits exportierte XML-Datei wird dadurch obsolet und darf nicht mehr in der Bank verwendet werden. Diese Stornierung führt keine Bankaktion aus.',
    )) return;
    const reason = prompt('Grund für das Stornieren dieses Zahlungsstapels:');
    if (!reason?.trim()) return;
    const token = beginMutation(operationView);
    if (!token) return;
    if (!isMutationCurrent(operationView, token)) return;
    setBusy('cancel');
    if (!isMutationCurrent(operationView, token)) return;
    setError('');
    try {
      const next = await cancelPaymentBatch(token.batchId, operationView.revision, reason.trim(), token.controller.signal);
      if (!isMutationCurrent(operationView, token)
        || !isPaymentOperationPreconditionSatisfied(next.batch.batchId, batchId, token)) return;
      setView(next);
      if (!isMutationCurrent(operationView, token)) return;
      setNotice(operationView.batch.status === 'exported'
        ? 'Exportierter Zahlungsstapel storniert. Die exportierte XML-Datei ist obsolet und darf nicht mehr verwendet werden. Es wurde keine Bankaktion ausgeführt.'
        : 'Zahlungsstapel storniert. Es wurde keine Bankaktion ausgeführt.');
      if (!isMutationCurrent(operationView, token)) return;
      onChanged();
    } catch (cancelError) {
      if (!isMutationCurrent(operationView, token)) return;
      const message = errorMessage(cancelError);
      if (!isMutationCurrent(operationView, token)) return;
      await load(false);
      if (!isMutationCurrent(operationView, token)) return;
      setError(message);
    } finally {
      if (isMutationCurrent(operationView, token)) setBusy(null);
      finishMutation(token);
    }
  };

  if (!view) {
    return (
      <div>
        <Button onClick={onBack}>Zurück</Button>
        <Card style={{ marginTop: 12 }}>{error || 'Zahlungsstapel wird geladen…'}</Card>
      </div>
    );
  }

  if (view.batch.batchId !== batchId) {
    return (
      <div>
        <Button onClick={onBack}>Zurück</Button>
        <Card style={{ marginTop: 12 }}>Zahlungsstapel wird geladen…</Card>
      </div>
    );
  }

  const { batch } = view;
  const hasIssues = view.validations.some(validation => validation.issues.length > 0);
  const editable = batch.status === 'draft';
  const releaseConfirmation = automation
    ? exactPaymentReleaseConfirmation(automation, batch)
    : null;
  const releaseDecision = automation
    ? paymentAutomationReleaseDecision(automation, batch)
    : { kind: 'none' as const, label: '' as const };
  const automationManualGuidance = automation ? paymentAutomationManualGuidance(automation) : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Button onClick={onBack}>Zurück zur Belegerkennung</Button>
        <h1 style={{ fontSize: 22, margin: 0 }}>Zahlungsprüfung</h1>
        <Badge text={STATUS_LABELS[batch.status] ?? batch.status} color={batch.status === 'draft' ? colors.orange : batch.status === 'cancelled' || batch.status === 'failed' ? colors.red : colors.green} />
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#777' }}>Stapel {batch.batchId} · Revision {view.revision}</span>
      </div>

      {error && <div style={{ marginBottom: 12, padding: 10, background: '#fee', border: '1px solid #e74c3c', borderRadius: 5, color: colors.red }}>{error}</div>}
      {notice && <div style={{ marginBottom: 12, padding: 10, background: '#eef8ee', border: '1px solid #7dbb7d', borderRadius: 5, color: '#236b23' }}>{notice}</div>}

      <Card style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>Schuldnerkonto (fest, schreibgeschützt)</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr 0.5fr', gap: 14, fontSize: 13 }}>
          <div><b>Konto:</b><br />{batch.debtorAccountLabel}</div>
          <div><b>Kontoinhaber:</b><br />{batch.debtorAccountHolder}</div>
          <div><b>IBAN:</b><br /><code>{batch.debtorIban}</code></div>
          <div><b>Währung:</b><br />{batch.currencyCode}</div>
        </div>
      </Card>

      <Card style={{ overflowX: 'auto', marginBottom: 14 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1180 }}>
          <thead>
            <tr>
              <th style={thStyle}>Gläubiger</th>
              <th style={thStyle}>IBAN</th>
              <th style={thStyle}>Betrag</th>
              <th style={thStyle}>Referenz</th>
              <th style={thStyle}>Datum</th>
              <th style={thStyle}>Quelle / Konfidenz</th>
              <th style={thStyle}>Rechnung / Prüfung</th>
              {editable && <th style={thStyle}>Aktion</th>}
            </tr>
          </thead>
          <tbody>
            {batch.items.map(item => {
              const draft = drafts[item.itemId] ?? draftFromPaymentItem(item);
              const validation = view.validations.find(value => value.item_id === item.itemId)?.issues ?? [];
              const setDraft = (change: Partial<ItemDraft>) => setDrafts(current => ({
                ...current,
                [item.itemId]: { ...draft, ...change },
              }));
              return (
                <tr key={item.itemId}>
                  <td style={{ ...tdStyle, minWidth: 160 }}>
                    {editable ? <input aria-label="Gläubigername" value={draft.creditorName} onChange={event => setDraft({ creditorName: event.target.value })} style={fieldStyle} /> : item.creditorName || '—'}
                  </td>
                  <td style={{ ...tdStyle, minWidth: 190 }}>
                    {editable ? <input aria-label="Gläubiger-IBAN" value={draft.creditorIban} onChange={event => setDraft({ creditorIban: event.target.value })} style={{ ...fieldStyle, fontFamily: 'monospace' }} /> : <code>{item.creditorIban || '—'}</code>}
                  </td>
                  <td style={{ ...tdStyle, minWidth: 105 }}>
                    {editable ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input aria-label="Betrag in Euro" value={draft.amount} onChange={event => setDraft({ amount: event.target.value })} style={{ ...fieldStyle, width: 80, textAlign: 'right' }} />
                        <input aria-label="Währung" value={draft.currencyCode} onChange={event => setDraft({ currencyCode: event.target.value.toUpperCase() })} style={{ ...fieldStyle, width: 50 }} maxLength={3} />
                      </div>
                    ) : formatMinor(item.amountMinor, item.currencyCode ?? batch.currencyCode)}
                  </td>
                  <td style={{ ...tdStyle, minWidth: 210 }}>
                    {editable ? (
                      <>
                        <input aria-label="Verwendungszweck" value={draft.reference} onChange={event => setDraft({ reference: event.target.value })} placeholder="Verwendungszweck" style={{ ...fieldStyle, marginBottom: 4 }} />
                        <input aria-label="Strukturierte Referenz" value={draft.structuredReference} onChange={event => setDraft({ structuredReference: event.target.value })} placeholder="RF-Referenz (optional)" style={fieldStyle} />
                      </>
                    ) : item.structuredCreditorReference || item.remittanceInformation || '—'}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap', fontSize: 11 }}>
                    <div><b>Ausführung:</b> {editable ? (
                      <input
                        aria-label="Ausführungsdatum"
                        type="date"
                        value={draft.requestedExecutionDate}
                        onChange={event => setDraft({ requestedExecutionDate: event.target.value })}
                        style={{ ...fieldStyle, width: 132, marginTop: 4 }}
                      />
                    ) : formatDate(item.requestedExecutionDate)}</div>
                    <div><b>Fällig:</b> {formatDate(item.dueDate)}</div>
                  </td>
                  <td style={tdStyle}><Evidence evidence={evidence[item.itemId]} /></td>
                  <td style={{ ...tdStyle, minWidth: 180, fontSize: 11 }}>
                    <a href={`/rechnungen?highlight=${encodeURIComponent(item.documentId)}`} target="_blank" rel="noreferrer">Rechnung {item.invoiceNumber || item.documentId}</a>
                    {validation.length === 0 ? (
                      <div style={{ color: colors.green, marginTop: 5 }}>Serverprüfung: gültig</div>
                    ) : validation.map(issue => (
                      <div key={`${issue.code}-${issue.field}`} style={{ color: issue.severity === 'error' ? colors.red : colors.orange, marginTop: 5 }}>
                        {issue.message} <code>{issue.code}</code>
                      </div>
                    ))}
                  </td>
                  {editable && (
                    <td style={tdStyle}>
                      <button disabled={busy !== null} onClick={() => void saveItem(item)} style={{ padding: '5px 9px', cursor: 'pointer' }}>
                        {busy === item.itemId ? 'Speichere…' : 'Speichern'}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {(automation || ['exported', 'prepared', 'released'].includes(batch.status)) && (
        <Card style={{ marginBottom: 14, border: automation?.phase === 'unknown' || automation?.phase === 'failed' ? '1px solid #d98c00' : undefined }}>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>George-Automation (deterministisch, ohne Agent)</h2>
          {automation ? (
            <>
              <div style={{ fontWeight: 700 }}>{AUTOMATION_PHASE_COPY[automation.phase]}</div>
              <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>
                Fortschritt {automation.progress.current}/{automation.progress.total} · Phase <code>{automation.phase}</code>
              </div>
              {automation.error && <div style={{ marginTop: 8, color: colors.red }}>{automation.error.message} <code>{automation.error.code}</code></div>}
              {automationManualGuidance && <div style={{ marginTop: 8, padding: 10, border: '2px solid #d98c00', background: '#fff7e6', color: '#6b3a00', fontWeight: 700 }}>{automationManualGuidance}</div>}
              {automation.evidence.package_status === 'rejected' && <div style={{ marginTop: 8, color: colors.red, fontWeight: 700 }}>Freigabe abgelehnt. Der Stapel ist nicht freigegeben.</div>}
              {automation.phase === 'unknown' && <div style={{ marginTop: 8, color: colors.red, fontWeight: 700 }}>Status unbekannt — keinesfalls als bezahlt behandeln.</div>}
              {automation.evidence.package_reference && (
                <div style={{ display: 'grid', gridTemplateColumns: '1.2fr .7fr 1fr 1.5fr', gap: 12, marginTop: 12, fontSize: 12 }}>
                  <div><b>Schuldner-IBAN</b><br /><code>{automation.evidence.debtor_iban}</code></div>
                  <div><b>Anzahl</b><br />{automation.evidence.item_count}</div>
                  <div><b>Kontrollsumme</b><br />{formatMinor(automation.evidence.control_sum_minor ?? null, batch.currencyCode)}</div>
                  <div><b>George-Paketreferenz</b><br /><code>{automation.evidence.package_reference}</code></div>
                  <div style={{ gridColumn: '1 / -1' }}><b>XML-SHA-256</b><br /><code style={{ overflowWrap: 'anywhere' }}>{automation.evidence.xml_sha256}</code></div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                {releaseDecision.kind !== 'none' && (
                  <button
                    disabled={busy !== null}
                    onClick={releaseDecision.kind === 'confirm_release'
                      ? () => setReleaseDialogOpen(true)
                      : () => void reconcileReleaseStatus()}
                    style={{
                      padding: '8px 16px',
                      background: releaseDecision.kind === 'confirm_release' ? '#a14d00' : '#245a9b',
                      color: '#fff', border: 0, borderRadius: 4, fontWeight: 700,
                    }}
                  >
                    {releaseDecision.label}
                  </button>
                )}
                {automation.phase !== 'released' && (
                  <button disabled={busy !== null} onClick={() => void pollAutomation(0)} style={{ padding: '8px 12px' }}>
                    Status erneut prüfen
                  </button>
                )}
                {automation.phase === 'failed' && batch.status === 'exported' && (
                  <button disabled={busy !== null} onClick={() => void prepareInGeorge()} style={{ padding: '8px 12px' }}>
                    Neuen sicheren Importversuch starten
                  </button>
                )}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: '#666' }}>Noch kein George-Import gestartet. Das Öffnen dieser Ansicht löst keine Bankaktion aus.</div>
          )}
        </Card>
      )}

      {releaseDialogOpen && automation?.available_action === 'request_release' && releaseConfirmation && (
        <Card style={{ marginBottom: 14, border: '2px solid #a14d00', background: '#fffaf2' }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Sammelfreigabe ausdrücklich bestätigen</h2>
          <p>Diese separate Bestätigung erlaubt genau eine Freigabeanforderung in George. Die Banking-App-2FA führen ausschließlich Sie aus.</p>
          <ul style={{ lineHeight: 1.7 }}>
            <li>Schuldner-IBAN: <code>{automation.evidence.debtor_iban}</code></li>
            <li>Transaktionen: <b>{automation.evidence.item_count}</b></li>
            <li>Kontrollsumme: <b>{formatMinor(automation.evidence.control_sum_minor ?? null, batch.currencyCode)}</b></li>
            <li>George-Paketreferenz: <code>{automation.evidence.package_reference}</code></li>
            <li>XML-SHA-256: <code style={{ overflowWrap: 'anywhere' }}>{automation.evidence.xml_sha256}</code></li>
          </ul>
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={busy !== null} onClick={() => void requestRelease()} style={{ padding: '8px 16px', background: '#a14d00', color: '#fff', border: 0, borderRadius: 4, fontWeight: 700 }}>
              {busy === 'release' ? 'Fordere an…' : 'Sammelfreigabe anfordern'}
            </button>
            <button disabled={busy !== null} onClick={() => setReleaseDialogOpen(false)} style={{ padding: '8px 12px' }}>Abbrechen</button>
          </div>
        </Card>
      )}

      <Card>
        <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
          <div><b>Anzahl:</b> {batch.itemCount}</div>
          <div><b>Kontrollsumme:</b> {formatMinor(batch.controlSumMinor, batch.currencyCode)}</div>
          <div><b>Ausführungsdatum:</b> {formatDate(batch.requestedExecutionDate)}</div>
          <div><b>Status:</b> {STATUS_LABELS[batch.status] ?? batch.status}</div>
        </div>

        {editable && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #ddd' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontWeight: 600, cursor: 'pointer' }}>
              <input type="checkbox" checked={confirmedUnpaid} onChange={event => setConfirmedUnpaid(event.target.checked)} />
              Ich bestätige, dass alle angezeigten Rechnungen offen und unbezahlt sind.
            </label>
            {hasIssues && <div style={{ color: colors.red, fontSize: 12, marginTop: 8 }}>Die Serverprüfung enthält Fehler oder Warnungen. Bitte korrigieren und jede betroffene Position speichern.</div>}
            <button
              disabled={!confirmedUnpaid || hasIssues || busy !== null}
              onClick={() => void review()}
              style={{ marginTop: 12, padding: '8px 16px', background: confirmedUnpaid && !hasIssues ? '#2980b9' : '#bbb', color: '#fff', border: 0, borderRadius: 4, cursor: confirmedUnpaid && !hasIssues ? 'pointer' : 'not-allowed', fontWeight: 700 }}
            >
              {busy === 'review' ? 'Prüfe…' : 'Zahlungsstapel verbindlich prüfen'}
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          {batch.status === 'reviewed' && (
            <button disabled={busy !== null} onClick={() => void exportXml()} style={{ padding: '8px 16px', background: '#237a3b', color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontWeight: 700 }}>
              {busy === 'export' ? 'Erzeuge SEPA-Datei…' : 'SEPA-Datei exportieren'}
            </button>
          )}
          {batch.status === 'exported' && (
            <button disabled={busy !== null} onClick={() => void retryDownload()} style={{ padding: '8px 16px', background: '#237a3b', color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontWeight: 700 }}>
              {busy === 'retry' ? 'Lade…' : 'SEPA-Datei erneut herunterladen'}
            </button>
          )}
          {batch.status === 'exported' && (!automation || automation.phase === 'failed') && (
            <button disabled={busy !== null} onClick={() => void prepareInGeorge()} style={{ padding: '8px 16px', background: '#245a9b', color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontWeight: 700 }}>
              {busy === 'george-import' ? 'Reihe ein…' : 'In George vorbereiten'}
            </button>
          )}
          {['draft', 'reviewed', 'exported'].includes(batch.status) && (
            <button disabled={busy !== null} onClick={() => void cancelBatch()} style={{ padding: '8px 16px', background: '#fff', color: colors.red, border: `1px solid ${colors.red}`, borderRadius: 4, cursor: 'pointer' }}>
              {batch.status === 'exported' ? 'Exportierten Stapel stornieren (XML wird obsolet)' : 'Zahlungsstapel stornieren'}
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}
