import {useLegacyText} from '../i18n/legacy';
import {legacyRecognitionEnglish} from '../i18n/legacy-recognition';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../api';
import { Card, Button, Badge, colors, usePageSize } from '../components/shared';
import { PaymentReview } from '../components/payments/PaymentReview';

type View = 'list' | 'review' | 'payment';
type StatusFilter = '' | 'extracted' | 'reviewed' | 'confirmed' | 'rejected' | 'error';

const STATUS_COLORS: Record<string, string> = {
  pending: colors.gray, extracted: colors.orange, reviewed: colors.blue,
  confirmed: colors.green, rejected: colors.red, error: colors.red,
};
const STATUS_LABELS: Record<string, string> = {
  pending: 'Ausstehend', extracted: 'Extrahiert', reviewed: 'Geprüft',
  confirmed: 'Bestätigt', rejected: 'Abgelehnt', error: 'Fehler',
};

export function InvoiceRecognition() {
  const [view, setView] = useState<View>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('payment') ? 'payment' : params.get('scan') ? 'review' : 'list';
  });
  const [selectedScanId, setSelectedScanId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('scan') || null;
  });
  const [paymentBatchId, setPaymentBatchId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('payment') || null;
  });
  const [, setPaymentChange] = useState(0);

  const openReview = (scanId: string) => { setSelectedScanId(scanId); setView('review'); };
  const openPayment = (batchId: string) => {
    setPaymentBatchId(batchId);
    setView('payment');
    window.history.replaceState({}, '', `/belegerkennung?payment=${encodeURIComponent(batchId)}`);
  };
  const backToList = () => {
    setView('list'); setSelectedScanId(null); setPaymentBatchId(null);
    window.history.replaceState({}, '', '/belegerkennung');
  };

  const initialHighlight = useState(() => new URLSearchParams(window.location.search).get('highlight') || null)[0];

  if (view === 'review' && selectedScanId) {
    return <ReviewView scanId={selectedScanId} onBack={backToList} />;
  }
  if (view === 'payment' && paymentBatchId) {
    return <PaymentReview key={paymentBatchId} batchId={paymentBatchId} onBack={backToList} onChanged={() => setPaymentChange(value => value + 1)} />;
  }
  return <ListView onOpenReview={openReview} onOpenPayment={openPayment} highlightScanId={initialHighlight} />;
}

// ==================== LIST VIEW ====================

function ListView({ onOpenReview, onOpenPayment, highlightScanId }: {
  onOpenReview: (id: string) => void;
  onOpenPayment: (batchId: string) => void;
  highlightScanId?: string | null;
}) {
  const lt=useLegacyText(legacyRecognitionEnglish);
  const [data, setData] = useState<any>(null);
  const [status, setStatus] = useState<StatusFilter>('');
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<any>(null);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(highlightScanId ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scanRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const { pageSize } = usePageSize();
  const sort = useScanSort();

  // Highlight scroll effect
  useEffect(() => {
    if (!highlightId || !data) return;
    const found = data.items?.find((s: any) => s.scan_id === highlightId);
    if (found) {
      setTimeout(() => {
        const row = scanRowRefs.current[highlightId];
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => { setHighlightId(null); window.history.replaceState({}, '', '/belegerkennung'); }, 3000);
      }, 150);
    }
  }, [highlightId, data]);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (!data) return;
    if (selected.size === data.items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(data.items.map((i: any) => i.scan_id)));
    }
  };
  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(lt('{count} Scan(s) wirklich löschen?',{count:selected.size}))) return;
    for (const id of selected) {
      try { await api.deleteScan(id); } catch {}
    }
    setSelected(new Set());
    load();
  };

  const preparePayments = async (documentIds: string[]) => {
    if (paymentBusy || documentIds.length === 0) return;
    setPaymentBusy(true);
    try {
      const requestedIds = [...new Set(documentIds)];
      const result = await api.createPaymentBatch(requestedIds);
      const returnedIds = new Set([
        ...result.accepted.map(entry => entry.document_id),
        ...result.rejected.map(entry => entry.document_id),
      ]);
      const missingIds = requestedIds.filter(id => !returnedIds.has(id));
      const unexpectedIds = [...returnedIds].filter(id => !requestedIds.includes(id));
      const lines = [
        lt("Ergebnis der manuellen Zahlungsauswahl:"),
        '',
        ...result.accepted.map(entry =>
          lt('AKZEPTIERT: {id} ({classification}{issues})',{id:entry.document_id,classification:entry.classification,issues:entry.validation_errors.length > 0 ? `; ${entry.validation_errors.map(issue => issue.message).join('; ')}` : ''})),
        ...result.rejected.map(entry =>
          lt('ABGELEHNT: {id} — {reason} ({code})',{id:entry.document_id,reason:entry.reason,code:entry.reason_code})),
        ...missingIds.map(id => lt('NICHT BEANTWORTET: {id} — Serverantwort unvollständig',{id})),
        ...unexpectedIds.map(id => lt('UNERWARTET: {id} — nicht angefragt',{id})),
      ];
      alert(lines.join('\n'));
      if (missingIds.length > 0 || unexpectedIds.length > 0) return;
      if (result.batch) {
        setSelected(new Set());
        onOpenPayment(result.batch.batchId);
      }
    } catch (paymentError) {
      alert(lt('Zahlungsauswahl fehlgeschlagen: {error}',{error:paymentError instanceof Error ? paymentError.message : lt('Unbekannter Fehler')}));
    } finally {
      setPaymentBusy(false);
    }
  };

  const load = () => {
    const params: Record<string, string> = { page: String(page), limit: String(pageSize) };
    if (status) params.status = status;
    api.getScans(params).then(setData);
  };
  useEffect(() => { load(); }, [page, pageSize, status]);

  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number; filename: string } | null>(null);
  const [uploadSummary, setUploadSummary] = useState<{
    count: number; failed: number; totalTokens: number; totalCost: number;
    files: Array<{ filename: string; ai_used: boolean; ai_tokens: number; ai_cost: number; seller: string | null; duplicate?: boolean }>;
  } | null>(null);
  const [importFolder, setImportFolder] = useState('Belege/Import');
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  /** SSE stream reader — shared between folder import and file upload */
  const readSSEStream = async (response: Response) => {
    const reader = response.body?.getReader();
    if (!reader) throw new Error(lt("Kein Stream verfügbar"));

    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
    const fileResults: Array<{ filename: string; ai_used: boolean; ai_tokens: number; ai_cost: number; seller: string | null; duplicate?: boolean }> = [];
    let summaryData = { count: 0, failed: 0, totalTokens: 0, totalCost: 0 };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx).trimEnd();
        buffer = buffer.slice(nlIdx + 1);

        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (eventType === 'start' || eventType === 'progress') {
              setProgress({ index: data.index ?? 0, total: data.total, filename: data.filename ?? '' });
            } else if (eventType === 'file_done') {
              fileResults.push({
                filename: data.filename, ai_used: data.ai_used,
                ai_tokens: data.ai_tokens ?? 0, ai_cost: data.ai_cost_usd ?? 0, seller: data.seller,
                duplicate: data.duplicate,
              });
              setProgress({ index: data.index + 1, total: data.total, filename: '' });
            } else if (eventType === 'file_error') {
              fileResults.push({ filename: data.filename, ai_used: false, ai_tokens: 0, ai_cost: 0, seller: null });
              setProgress({ index: (data.index ?? 0) + 1, total: data.total ?? 0, filename: '' });
            } else if (eventType === 'complete') {
              summaryData = { count: data.count, failed: data.failed ?? 0, totalTokens: data.total_tokens, totalCost: data.total_cost_usd };
            }
          } catch { /* ignore */ }
        } else if (line === '') {
          eventType = '';
        }
      }
    }
    return { summaryData, fileResults };
  };

  /** Import from local folder (primary method) */
  const startFolderImport = async () => {
    setUploading(true);
    setUploadResult(null);
    setProgress(null);
    setUploadSummary(null);

    const ctrl = new AbortController();
    setAbortController(ctrl);

    try {
      const res = await fetch(api.importFolderUrl(importFolder), { signal: ctrl.signal });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      const { summaryData, fileResults } = await readSSEStream(res);
      // Calculate totals from file results as fallback (in case complete event was missed)
      const calcTokens = fileResults.reduce((s, f) => s + f.ai_tokens, 0);
      const calcCost = fileResults.reduce((s, f) => s + f.ai_cost, 0);
      setUploadSummary({
        count: summaryData.count || fileResults.length,
        failed: summaryData.failed,
        totalTokens: summaryData.totalTokens || calcTokens,
        totalCost: summaryData.totalCost || calcCost,
        files: fileResults,
      });
      setUploadResult({ results: fileResults });
      load();
    } catch (err: any) {
      if (err.name !== 'AbortError') setUploadResult({ error: err.message });
    } finally {
      setUploading(false);
      setProgress(null);
      setAbortController(null);
    }
  };

  /** Upload individual files (drag & drop / file picker fallback) */
  const processFiles = async (fileList: File[]) => {
    if (fileList.length === 0) return;
    const accepted = fileList.filter(f => /\.(pdf|jpe?g|png)$/i.test(f.name));
    if (accepted.length === 0) { setUploadResult({ error: lt("Keine unterstützten Dateien (PDF, JPG, PNG)") }); return; }
    setUploading(true);
    setUploadResult(null);
    setProgress(null);
    setUploadSummary(null);

    const form = new FormData();
    for (const f of accepted) form.append('files', f);

    try {
      const res = await fetch('/api/invoicerec/upload', {
        method: 'POST', body: form,
        headers: { 'Accept': 'text/event-stream' },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      const { summaryData, fileResults } = await readSSEStream(res);
      setUploadSummary({ ...summaryData, files: fileResults });
      setUploadResult({ results: fileResults });
      load();
    } catch (err: any) {
      setUploadResult({ error: err.message });
    } finally {
      setUploading(false);
      setProgress(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleUpload = (e?: React.ChangeEvent<HTMLInputElement>) => {
    const files = e?.target?.files ?? fileRef.current?.files;
    if (files) processFiles(Array.from(files));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    processFiles(files);
  };

  const selectedPaymentDocumentIds: string[] = data
    ? (data.items as Array<{ scan_id: string; status: string; document_id?: string | null }>)
        .filter(item => selected.has(item.scan_id) && item.status === 'confirmed' && typeof item.document_id === 'string')
        .map(item => item.document_id as string)
    : [];

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>{lt("Belegerkennung")}</h1>

      {/* Folder import + file drop zone */}
      <div style={{ marginBottom: 16 }}>
        {uploading ? (
          <div style={{ padding: 24, borderRadius: 8, border: '2px solid #2980b9', background: '#f8f8f8', textAlign: 'center' }}>
            <div style={{ fontSize: 14, color: '#333', marginBottom: 8, fontWeight: 600 }}>
              {progress
                ? `Verarbeite ${progress.index + 1} von ${progress.total}${progress.filename ? `: ${progress.filename}` : ''}`
                : lt("Starte Import...")}
            </div>
            {progress && (
              <>
                <div style={{ width: '100%', height: 10, background: '#e0e0e0', borderRadius: 5, overflow: 'hidden', marginBottom: 6 }}>
                  <div style={{
                    width: `${((progress.index + (progress.filename ? 0.5 : 1)) / progress.total) * 100}%`,
                    height: '100%', background: '#2980b9', borderRadius: 5,
                    transition: 'width 0.3s ease',
                  }} />
                </div>
                <div style={{ fontSize: 11, color: '#888' }}>
                  {Math.round(((progress.index + (progress.filename ? 0.5 : 1)) / progress.total) * 100)}%
                </div>
              </>
            )}
            <button onClick={() => abortController?.abort()}
              style={{ marginTop: 8, padding: '4px 16px', borderRadius: 4, border: '1px solid #e74c3c', background: '#fee', color: '#e74c3c', cursor: 'pointer', fontSize: 12 }}>{" "}{lt("Abbrechen")}{" "}</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
            {/* Folder import (primary) */}
            <div style={{ flex: 1, padding: 16, borderRadius: 8, border: '2px solid #2980b9', background: '#f0f7ff' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#2c3e50' }}>{lt("Ordner-Import")}</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="text" value={importFolder} onChange={e => setImportFolder(e.target.value)}
                  placeholder="Belege/Import"
                  style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid #ccc', fontSize: 13 }} />
                <button onClick={startFolderImport}
                  style={{ padding: '6px 16px', borderRadius: 4, border: 'none', background: '#2980b9', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>{" "}{lt("Import starten")}{" "}</button>
              </div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{" "}{lt("Belege aus dem Ordner werden einzeln verarbeitet. Erfolgreiche → importiert/, Fehler → Fehlgeschlagen/")}{" "}</div>
            </div>

            {/* File drop/upload (secondary) */}
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
              style={{
                flex: '0 0 180px', padding: 16, borderRadius: 8, textAlign: 'center', cursor: 'pointer',
                border: dragging ? '2px solid #2980b9' : '2px dashed #ccc',
                background: dragging ? '#eaf4fd' : '#fafafa',
                display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
              }}
            >
              <input ref={fileRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png"
                style={{ display: 'none' }} onChange={handleUpload} />
              <div style={{ fontSize: 22, color: '#999' }}>+</div>
              <div style={{ fontSize: 11, color: '#999' }}>{lt("Einzelne Dateien")}</div>
            </div>
          </div>
        )}
        {uploadResult?.error && (
          <div style={{ color: colors.red, marginTop: 8, fontSize: 13 }}>{uploadResult.error}</div>
        )}
        {uploadResult?.results && !uploading && (
          <div style={{ marginTop: 8, fontSize: 13, color: colors.green }}>
            {uploadResult.results.length}{" "}{lt("Datei(en) verarbeitet")}{" "}</div>
        )}
      </div>

      {/* Upload summary with AI cost */}
      {uploadSummary && !uploading && (
        <Card style={{ marginBottom: 16, background: '#f0f7f0', border: '1px solid #c3e6cb' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#2c3e50' }}>{" "}{lt("Import abgeschlossen:")}{" "}{uploadSummary.count}{" "}{lt("Datei(en)")}{" "}{uploadSummary.failed > 0 && (
                <span style={{ color: colors.red, fontWeight: 600 }}>
                  {' '}({uploadSummary.failed}{" "}{lt("fehlgeschlagen)")}{" "}</span>
              )}
            </span>
            <button onClick={() => setUploadSummary(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: 16, lineHeight: 1 }}>x</button>
          </div>
          {/* Summenzeile — immer anzeigen */}
          <div style={{ display: 'flex', gap: 24, padding: '8px 0 4px', borderTop: '1px solid #c3e6cb', fontSize: 13 }}>
            <span>{lt("Gesamt:")}{" "}<b>{uploadSummary.count}</b>{" "}{lt("Belege")}</span>
            {uploadSummary.files.filter(f => f.ai_used).length > 0 && (
              <span>{lt("davon")}{" "}<b>{uploadSummary.files.filter(f => f.ai_used).length}</b>{" "}{lt("mit KI")}</span>
            )}
            {uploadSummary.files.filter(f => f.duplicate).length > 0 && (
              <span style={{ color: colors.orange }}>
                <b>{uploadSummary.files.filter(f => f.duplicate).length}</b>{" "}{lt("Duplikat(e) übersprungen")}{" "}</span>
            )}
            <span style={{ fontFamily: 'monospace' }}>
              Tokens: <b>{(uploadSummary.totalTokens ?? 0).toLocaleString('de-DE')}</b>
            </span>
            <span style={{ fontFamily: 'monospace' }}>{" "}{lt("Kosten:")}{" "}<b>${formatCost(uploadSummary.totalCost ?? 0)}</b>
            </span>
          </div>
          {/* Detail-Tabelle für KI-Dateien */}
          {uploadSummary.files.some(f => f.ai_used) && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ fontSize: 11, color: '#666', cursor: 'pointer' }}>{lt("KI-Details pro Datei")}</summary>
              <table style={{ width: '100%', fontSize: 11, marginTop: 4, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, fontSize: 10 }}>{lt("Datei")}</th>
                    <th style={{ ...th, fontSize: 10 }}>{lt("Verkäufer")}</th>
                    <th style={{ ...th, fontSize: 10, textAlign: 'right' }}>Tokens</th>
                    <th style={{ ...th, fontSize: 10, textAlign: 'right' }}>{lt("Kosten")}</th>
                  </tr>
                </thead>
                <tbody>
                  {uploadSummary.files.filter(f => f.ai_used).map((f, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: '2px 6px', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</td>
                      <td style={{ padding: '2px 6px' }}>{f.seller ?? '—'}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{f.ai_tokens.toLocaleString('de-DE')}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', fontFamily: 'monospace' }}>${formatCost(f.ai_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </Card>
      )}
      {/* KI-Kostenverlauf */}
      <AiCostPanel />

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -12, marginBottom: 12 }}>
        <button onClick={() => setShowAiSettings(!showAiSettings)}
          style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #ddd', cursor: 'pointer', fontSize: 12, background: showAiSettings ? '#2c3e50' : '#ecf0f1', color: showAiSettings ? '#fff' : '#333' }}>{" "}{lt("KI-Einstellungen")}{" "}</button>
      </div>

      {/* AI Settings panel */}
      {showAiSettings && <AiSettingsPanel />}

      {/* Status filter */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['', 'extracted', 'reviewed', 'confirmed', 'rejected', 'error'] as StatusFilter[]).map(s => (
          <button key={s} onClick={() => { setStatus(s); setPage(1); }}
            style={{
              padding: '4px 12px', borderRadius: 4, border: '1px solid #ddd', cursor: 'pointer',
              fontSize: 12, fontWeight: 600,
              background: status === s ? '#2c3e50' : '#ecf0f1',
              color: status === s ? '#fff' : '#333',
            }}>
            {s ? lt(STATUS_LABELS[s]) : lt("Alle")}
          </button>
        ))}
      </div>

      {/* Scans table */}
      {data && (
        <Card>
          {selected.size > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13 }}>{selected.size}{" "}{lt("ausgewählt")}</span>
              <button
                disabled={paymentBusy || selectedPaymentDocumentIds.length === 0}
                onClick={() => void preparePayments(selectedPaymentDocumentIds)}
                style={{
                  padding: '4px 12px', borderRadius: 4, border: '1px solid #2980b9',
                  background: selectedPaymentDocumentIds.length > 0 ? '#eaf4fd' : '#eee',
                  color: selectedPaymentDocumentIds.length > 0 ? '#2471a3' : '#999',
                  cursor: selectedPaymentDocumentIds.length > 0 ? 'pointer' : 'not-allowed', fontSize: 12, fontWeight: 700,
                }}
                title={lt("Nur ausgewählte, bestätigte Belege mit Dokument-ID werden angefragt")}
              >
                {paymentBusy ? lt("Bereite Zahlungen vor…") : lt('Zahlungen vorbereiten ({count})',{count:selectedPaymentDocumentIds.length})}
              </button>
              <button onClick={deleteSelected}
                style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #e74c3c', background: '#fee', color: '#e74c3c', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>{" "}{lt("Ausgewählte löschen")}{" "}</button>
              <button onClick={() => setSelected(new Set())}
                style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #ddd', background: '#ecf0f1', cursor: 'pointer', fontSize: 12 }}>{" "}{lt("Auswahl aufheben")}{" "}</button>
            </div>
          )}
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 30, textAlign: 'center' }}>
                  <input type="checkbox"
                    checked={data.items.length > 0 && selected.size === data.items.length}
                    onChange={toggleAll} />
                </th>
                <SortTh label={lt("Datei")} sortKey="filename" current={sort.sortKey} dir={sort.sortDir} onToggle={sort.toggleSort} />
                <SortTh label="Scan" sortKey="scan_date" current={sort.sortKey} dir={sort.sortDir} onToggle={sort.toggleSort} />
                <SortTh label={lt("Datum")} sortKey="date" current={sort.sortKey} dir={sort.sortDir} onToggle={sort.toggleSort} />
                <SortTh label={lt("Verkäufer")} sortKey="seller" current={sort.sortKey} dir={sort.sortDir} onToggle={sort.toggleSort} />
                <SortTh label={lt("Land")} sortKey="country" current={sort.sortKey} dir={sort.sortDir} onToggle={sort.toggleSort} />
                <SortTh label={lt("Brutto EUR")} sortKey="gross" current={sort.sortKey} dir={sort.sortDir} onToggle={sort.toggleSort} />
                <th style={th}>FX</th>
                <th style={th}>Status</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {sort.sortItems(data.items, sort.getSortValue).map((item: any) => (
                <tr key={item.scan_id}
                  ref={el => { scanRowRefs.current[item.scan_id] = el; }}
                  onClick={() => onOpenReview(item.scan_id)}
                  style={{
                    borderBottom: '1px solid #f0f0f0', cursor: 'pointer',
                    background: highlightId === item.scan_id ? '#fff9c4' : 'transparent',
                    transition: 'background 0.5s',
                  }}
                  onMouseOver={e => { if (highlightId !== item.scan_id) e.currentTarget.style.background = '#f8f9fa'; }}
                  onMouseOut={e => { if (highlightId !== item.scan_id) e.currentTarget.style.background = 'transparent'; }}>
                  <td style={{ ...td, textAlign: 'center', width: 30 }} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(item.scan_id)}
                      onChange={() => toggleSelect(item.scan_id)} />
                  </td>
                  <td style={{ ...td, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={item.original_filename}>{item.original_filename}</td>
                  <td style={{ ...td, fontSize: 11, color: '#888' }}>{fmtDate(item.created_at)}</td>
                  <td style={td}>{fmtDate(item.fields_summary?.invoice_date ?? item.created_at)}</td>
                  <td style={td}>{item.fields_summary?.seller_name ?? '—'}</td>
                  <td style={{ ...td, textAlign: 'center', fontSize: 11, color: '#666' }}>{item.fields_summary?.seller_country ?? '—'}</td>
                  <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right', color: item.fields_summary?.is_refund ? '#27ae60' : undefined }}>
                    {item.fields_summary?.currency_code === 'USD' || item.fields_summary?.original_currency === 'USD'
                      ? `$${((item.fields_summary?.original_amount_minor ?? item.fields_summary?.gross_amount_minor ?? 0) / 100).toFixed(2)}`
                      : item.fields_summary?.gross_amount_minor != null
                        ? (item.fields_summary.is_refund ? '+' : '') + fmtEur(item.fields_summary.gross_amount_minor) : '—'}
                  </td>
                  <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right', color: '#888' }}>
                    {item.fields_summary?.original_currency === 'USD' && item.fields_summary?.original_amount_minor != null
                      ? `$${(Math.abs(item.fields_summary.original_amount_minor) / 100).toFixed(2)}`
                      : ''}
                  </td>
                  <td style={td}>
                    <Badge text={lt(STATUS_LABELS[item.status] ?? item.status)} color={STATUS_COLORS[item.status] ?? colors.gray} />
                    {item.payment_summary && (
                      <div style={{ marginTop: 4, fontSize: 10, color: '#666' }}>{" "}{lt("Zahlung:")}{" "}{item.payment_summary.batch_status ?? item.payment_summary.classification}
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'center', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                    <button onClick={async () => {
                      if (!confirm(lt('"{filename}" wirklich löschen?',{filename:item.original_filename}))) return;
                      try { await api.deleteScan(item.scan_id); load(); } catch {}
                    }}
                      style={{
                        background: '#fee', border: '1px solid #e74c3c', borderRadius: 4,
                        cursor: 'pointer', color: '#e74c3c', fontSize: 13, fontWeight: 700,
                        padding: '2px 8px', lineHeight: '18px',
                      }}
                      title={lt("Löschen")}>
                      X
                    </button>
                    {item.status === 'confirmed' && item.document_id && (
                      <button
                        disabled={paymentBusy}
                        onClick={() => void preparePayments([item.document_id])}
                        style={{
                          marginLeft: 4, padding: '2px 8px', lineHeight: '18px', borderRadius: 4,
                          border: '1px solid #2980b9', background: '#eaf4fd', color: '#2471a3',
                          cursor: paymentBusy ? 'wait' : 'pointer', fontSize: 12, fontWeight: 700,
                        }}
                      >{" "}{lt("Jetzt bezahlen")}{" "}</button>
                    )}
                    {item.status === 'confirmed' && item.document_id && (
                      <a href={`/rechnungen?highlight=${encodeURIComponent(item.document_id)}`}
                        style={{
                          marginLeft: 4, background: '#f0f0f0', border: '1px solid #bbb', borderRadius: 4,
                          color: '#555', fontSize: 13, fontWeight: 700, padding: '2px 8px', lineHeight: '18px',
                          textDecoration: 'none', display: 'inline-block',
                        }}
                        title={lt("In Rechnungen anzeigen")}>...</a>
                    )}
                  </td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr><td colSpan={9} style={{ ...td, textAlign: 'center', color: '#999' }}>{lt("Keine Scans vorhanden")}</td></tr>
              )}
            </tbody>
          </table>
          {data.pages > 1 && (
            <div style={{ display: 'flex', gap: 4, justifyContent: 'center', marginTop: 12 }}>
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} style={btnS}>{lt("Zurück")}</button>
              <span style={{ padding: '6px 12px', fontSize: 13 }}>{lt("Seite")}{" "}{page}{" "}{lt("von")}{" "}{data.pages}</span>
              <button disabled={page >= data.pages} onClick={() => setPage(page + 1)} style={btnS}>{lt("Weiter")}</button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ==================== REVIEW VIEW ====================

function ReviewView({ scanId: initialScanId, onBack }: { scanId: string; onBack: () => void }) {
  const lt=useLegacyText(legacyRecognitionEnglish);
  const [scans, setScans] = useState<any[]>([]);
  const [previewScanId, setPreviewScanId] = useState<string>(initialScanId);
  const reviewRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const didScrollToInitial = useRef(false);
  const [editScanId, setEditScanId] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<any>(null);
  const [editRegions, setEditRegions] = useState<Record<string, any>>({});
  const [viewRegions, setViewRegions] = useState<Record<string, any>>({});
  const [activeField, setActiveField] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEditing, setBulkEditing] = useState(false);
  const [bulkFields, setBulkFields] = useState<Record<string, any>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const sort = useScanSort();

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAllSelect = () => {
    const allIds = scans.map(s => s.scan_id);
    if (selected.size === allIds.length) setSelected(new Set());
    else setSelected(new Set(allIds));
  };

  // Drag-select: hold mouse button and drag over rows to select/deselect multiple
  const dragMode = useRef<'add' | 'remove'>('add');
  const handleDragStart = (id: string) => {
    setIsDragging(true);
    // If starting on an already-selected item → drag to deselect, otherwise drag to select
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) { dragMode.current = 'remove'; next.delete(id); }
      else { dragMode.current = 'add'; next.add(id); }
      return next;
    });
  };
  const handleDragEnter = (id: string) => {
    if (!isDragging) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (dragMode.current === 'remove') next.delete(id); else next.add(id);
      return next;
    });
  };
  const handleDragEnd = () => { setIsDragging(false); };

  // Attach global mouseup to end drag-select even if mouse leaves the table
  useEffect(() => {
    const handler = () => setIsDragging(false);
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
  }, []);

  const loadAll = () => {
    api.getScans({ limit: '9999' }).then(res => setScans(res.items ?? []));
  };
  useEffect(() => { loadAll(); }, []);

  // Scroll to initial scan row after scans load
  useEffect(() => {
    if (didScrollToInitial.current || scans.length === 0) return;
    didScrollToInitial.current = true;
    setTimeout(() => {
      const row = reviewRowRefs.current[initialScanId];
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
  }, [scans]);

  const previewScan = scans.find(s => s.scan_id === previewScanId) ?? scans[0];

  // Load field_regions for preview when scan changes
  useEffect(() => {
    if (!previewScanId || editScanId === previewScanId) return;
    api.getScan(previewScanId).then(res => {
      setViewRegions(res.fields?.field_regions ?? {});
    }).catch(() => setViewRegions({}));
  }, [previewScanId, editScanId]);

  const confirmIfNeeded = (scanId: string, action: string): boolean => {
    const scan = scans.find((s: any) => s.scan_id === scanId);
    if (scan?.status === 'confirmed') {
      return confirm(lt('Dieser Beleg ist bereits bestätigt und importiert.\n\n"{action}" trotzdem ausführen?',{action}));
    }
    return true;
  };

  const handleOk = async (scanId: string) => {
    if (!confirmIfNeeded(scanId, lt("Erneut importieren"))) return;
    setBusyId(scanId);
    try {
      await api.confirmScan(scanId, true);
      setMessage({ text: lt("Importiert"), color: colors.green });
      loadAll();
    } catch (err: any) { setMessage({ text: err.message, color: colors.red }); }
    finally { setBusyId(null); }
  };

  const handleRescan = async (scanId: string) => {
    if (!confirmIfNeeded(scanId, lt("KI-Rescan"))) return;
    setBusyId(scanId);
    setMessage({ text: lt("KI-Rescan läuft..."), color: colors.blue });
    try {
      const proposal = await api.rescanScan(scanId, false);
      const changes = proposal.changes ?? [];
      if (changes.length === 0) {
        setMessage({ text: lt("KI-Rescan: keine Änderungen vorgeschlagen"), color: colors.green });
        return;
      }
      const summary = changes.slice(0, 8).map((c: any) => `${c.field}: ${String(c.old_value ?? '—')} → ${String(c.new_value ?? '—')}`).join('\n');
      if (!confirm(lt('KI-Vorschläge prüfen:\n\n{summary}\n\nDiese Änderungen übernehmen?',{summary}))) {
        setMessage({ text: lt("KI-Vorschläge verworfen"), color: colors.gray });
        return;
      }
      await api.updateScanFields(scanId, proposal.fields);
      setMessage({ text: lt('{count} KI-Vorschlag/Vorschläge übernommen',{count:changes.length}), color: colors.green });
      loadAll();
    } catch (err: any) { setMessage({ text: err.message, color: colors.red }); }
    finally { setBusyId(null); }
  };

  const handleRuleRescan = async (scanId: string) => {
    if (!confirmIfNeeded(scanId, lt("Regelbasiert neu erkennen"))) return;
    setBusyId(scanId);
    setMessage({ text: lt("Regelbasierte Erkennung läuft..."), color: colors.blue });
    try {
      await api.reparseScan(scanId);
      setMessage({ text: lt("Ohne KI neu erkannt"), color: colors.green });
      loadAll();
    } catch (err: any) { setMessage({ text: err.message, color: colors.red }); }
    finally { setBusyId(null); }
  };

  const handleDelete = async (scanId: string) => {
    if (!confirm(lt("Wirklich löschen?"))) return;
    try {
      await api.deleteScan(scanId);
      if (previewScanId === scanId) setPreviewScanId('');
      loadAll();
    } catch {}
  };

  const startEdit = async (scanId: string) => {
    const res = await api.getScan(scanId);
    setEditScanId(scanId);
    setEditFields(res.fields ? { ...res.fields } : null);
    setEditRegions(res.fields?.field_regions ?? {});
    setActiveField(null);
  };

  const saveEdit = async () => {
    if (!editScanId || !editFields) return;
    if (!confirmIfNeeded(editScanId, lt("Änderungen speichern"))) return;
    setBusyId(editScanId);
    try {
      await api.updateScanFields(editScanId, { ...editFields, field_regions: editRegions });
      setViewRegions({ ...editRegions }); // Keep regions visible after save
      setEditScanId(null);
      setEditFields(null);
      setEditRegions({});
      setActiveField(null);
      setMessage({ text: lt("Gespeichert"), color: colors.green });
      loadAll();
    } catch (err: any) { setMessage({ text: err.message, color: colors.red }); }
    finally { setBusyId(null); }
  };

  const handleLearnRescan = async (scanId: string) => {
    if (!confirmIfNeeded(scanId, lt("Vorlage lernen"))) return;
    setBusyId(scanId);
    setMessage({ text: lt("Vorlage wird gelernt..."), color: colors.blue });
    try {
      const res = await api.learnAndRescan(scanId);
      const msg = res.rescanned_count > 0
        ? lt('Vorlage "{vendor}" gelernt, {count} weitere Beleg(e) aktualisiert',{vendor:res.template.vendor_name,count:res.rescanned_count})
        : lt('Vorlage "{vendor}" gelernt (keine weiteren Belege gefunden)',{vendor:res.template.vendor_name});
      setMessage({ text: msg, color: colors.green });
      loadAll();
    } catch (err: any) { setMessage({ text: err.message, color: colors.red }); }
    finally { setBusyId(null); }
  };

  const cancelEdit = () => { setEditScanId(null); setEditFields(null); setEditRegions({}); setActiveField(null); };

  // ===== Bulk actions for multi-select =====
  const bulkOk = async () => {
    setBulkBusy(true);
    let ok = 0, fail = 0;
    for (const id of selected) {
      try { await api.confirmScan(id, true); ok++; } catch { fail++; }
    }
    setMessage({ text: lt('{count} importiert{failures}',{count:ok,failures:fail?lt(', {count} fehlgeschlagen',{count:fail}):''}), color: fail ? colors.orange : colors.green });
    setSelected(new Set());
    loadAll();
    setBulkBusy(false);
  };

  const bulkRescan = async () => {
    setBulkBusy(true);
    const ids = [...selected];
    let ok = 0, fail = 0;
    const errors: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const scan = scans.find(s => s.scan_id === ids[i]);
      const name = scan?.original_filename ?? ids[i].slice(0, 12);
      setMessage({ text: `Rescan ${i + 1}/${ids.length}: ${name}...`, color: colors.blue });
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90_000);
        const res = await fetch(`/api/invoicerec/scans/${encodeURIComponent(ids[i])}/rescan`, {
          method: 'POST', body: JSON.stringify({ apply: true }),
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          ok++;
        } else {
          const errData = await res.json().catch(() => ({ error: res.statusText }));
          errors.push(`${name}: ${errData.error}`);
          fail++;
        }
      } catch (err: any) {
        errors.push(`${name}: ${err.name === 'AbortError' ? 'Timeout' : err.message}`);
        fail++;
      }
    }
    const msg = `${ok} rescanned${fail ? lt(', {count} fehlgeschlagen',{count:fail}) : ''}`;
    setMessage({ text: errors.length > 0 ? `${msg} (${errors.join('; ')})` : msg, color: fail ? colors.orange : colors.green });
    setSelected(new Set());
    loadAll();
    setBulkBusy(false);
  };

  const bulkLearn = async () => {
    setBulkBusy(true);
    let totalRescanned = 0;
    for (const id of selected) {
      try {
        const res = await api.learnAndRescan(id);
        totalRescanned += res.rescanned_count ?? 0;
      } catch {}
    }
    setMessage({ text: lt('Vorlagen gelernt, {count} weitere Beleg(e) aktualisiert',{count:totalRescanned}), color: colors.green });
    setSelected(new Set());
    loadAll();
    setBulkBusy(false);
  };

  const startBulkEdit = () => {
    setBulkEditing(true);
    setBulkFields({ seller_name: '', seller_country: '', seller_vat_id: '', vat_rate: '', is_usd: false });
  };

  const saveBulkEdit = async () => {
    setBulkBusy(true);
    let ok = 0;
    for (const id of selected) {
      try {
        const scanData = await api.getScan(id);
        const existing = scanData.fields ?? {};
        const updates: Record<string, any> = {};

        if (bulkFields.seller_name) updates.seller_name = bulkFields.seller_name;
        if (bulkFields.seller_country) updates.seller_country = bulkFields.seller_country;
        if (bulkFields.seller_vat_id) updates.seller_vat_id = bulkFields.seller_vat_id;
        if (bulkFields.vat_rate !== '' && bulkFields.vat_rate !== null) {
          updates.vat_rate = parseFloat(String(bulkFields.vat_rate).replace(',', '.')) / 100;
        }

        // USD toggle
        if (bulkFields.is_usd && existing.currency_code !== 'USD') {
          updates.currency_code = 'USD';
          updates.meta = { ...(updates.meta ?? existing.meta), original_currency: 'USD', original_amount_minor: existing.gross_amount_minor };
          updates.gross_amount_minor = null;
          updates.net_amount_minor = null;
          updates.vat_amount_minor = null;
        }

        // EUSt toggle
        if (bulkFields.is_eust && !existing.meta?.carrier_eust_split) {
          updates.meta = { ...(updates.meta ?? existing.meta), carrier_eust_split: true, eust_amount_minor: 0 };
        }

        // Copy field_regions from bulk if set
        if (Object.keys(bulkFields.field_regions ?? {}).length > 0) {
          updates.field_regions = bulkFields.field_regions;
        }

        if (Object.keys(updates).length > 0) {
          await api.updateScanFields(id, updates);
          ok++;
        }
      } catch {}
    }
    setMessage({ text: lt('{count} Beleg(e) aktualisiert',{count:ok}), color: colors.green });
    setSelected(new Set());
    setBulkEditing(false);
    setBulkFields({});
    loadAll();
    setBulkBusy(false);
  };

  const cancelBulkEdit = () => { setBulkEditing(false); setBulkFields({}); };

  // Callback when user selects words on the annotated preview
  const handleRegionSelected = useCallback((field: string, region: any, text: string) => {
    if (!editFields) return;
    setEditRegions(prev => ({ ...prev, [field]: region }));
    // Auto-fill the field value from selected OCR words
    if (field.includes('amount') || field === 'gross_amount_minor' || field === 'net_amount_minor' || field === 'vat_amount_minor') {
      // Try to parse as number
      const val = parseMarkedNumber(text);
      if (!isNaN(val)) {
        setEditFields((prev: any) => ({ ...prev, [field]: Math.round(val * 100) }));
      }
    } else if (field === 'vat_rate') {
      const cleaned = text.replace(/[^\d.,]/g, '').replace(',', '.');
      const val = parseFloat(cleaned);
      if (!isNaN(val)) {
        setEditFields((prev: any) => ({ ...prev, vat_rate: val > 1 ? val / 100 : val }));
      }
    } else {
      setEditFields((prev: any) => ({ ...prev, [field]: text.trim() }));
    }
  }, [editFields]);

  const isEditing = !!editScanId;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Button onClick={onBack} color={colors.gray}>{lt("Zurück")}</Button>
        <h1 style={{ fontSize: 18, margin: 0 }}>{lt("Belegerkennung — Detailansicht")}</h1>
      </div>
      {message && <div style={{ color: message.color, marginBottom: 8, fontSize: 13 }}>{message.text}</div>}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* Left: Preview with annotation overlay */}
        <Card style={{ flex: '0 0 48%', minHeight: 600, position: 'sticky', top: 24 }}>
          {previewScan ? (
            <AnnotatedPreview
              scan={previewScan}
              activeField={activeField}
              fieldRegions={isEditing && editScanId === previewScanId ? editRegions : viewRegions}
              isAnnotating={isEditing && editScanId === previewScanId}
              onRegionSelected={handleRegionSelected}
            />
          ) : <span style={{ color: '#999' }}>{lt("Kein Beleg ausgewählt")}</span>}
        </Card>

        {/* Right: Scan table — scrollable independently */}
        <div style={{ flex: 1, overflow: 'auto', maxHeight: 'calc(100vh - 80px)' }}>
          {/* Bulk action toolbar */}
          {selected.size > 0 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, padding: '6px 8px', background: '#eef6ff', borderRadius: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{selected.size}{" "}{lt("ausgewählt:")}</span>
              <button onClick={bulkOk} disabled={bulkBusy}
                style={{ ...actionBtn, background: '#e8f5e9', color: colors.green, borderColor: colors.green, padding: '3px 10px' }}>{lt("OK alle")}</button>
              <button onClick={bulkRescan} disabled={bulkBusy}
                style={{ ...actionBtn, background: '#e3f2fd', color: colors.blue, borderColor: colors.blue, padding: '3px 10px' }}>{lt("Re alle")}</button>
              <button onClick={startBulkEdit} disabled={bulkBusy}
                style={{ ...actionBtn, background: '#fff3e0', color: colors.orange, borderColor: colors.orange, padding: '3px 10px' }}>{lt("Ed alle")}</button>
              <button onClick={bulkLearn} disabled={bulkBusy}
                style={{ ...actionBtn, background: '#f3e5f5', color: '#8e24aa', borderColor: '#8e24aa', padding: '3px 10px' }}>{lt("Lrn alle")}</button>
              <button onClick={() => setSelected(new Set())}
                style={{ ...actionBtn, padding: '3px 10px' }}>{lt("Auswahl aufheben")}</button>
            </div>
          )}

          {/* Bulk edit row */}
          {bulkEditing && selected.size > 0 && (
            <div style={{ marginBottom: 8, padding: 10, background: '#fffde7', borderRadius: 4, border: '1px solid #f0e68c' }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>{" "}{lt("Werte eingeben die auf alle")}{" "}{selected.size}{" "}{lt("ausgewählte(n) Beleg(e) übernommen werden. Leere Felder werden nicht geändert.")}{" "}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 12, alignItems: 'center' }}>
                <EditField label={lt("Verkäufer")} value={bulkFields.seller_name ?? ''} onChange={v => setBulkFields({ ...bulkFields, seller_name: v })} />
                <EditField label={lt("Land")} value={bulkFields.seller_country ?? ''} onChange={v => setBulkFields({ ...bulkFields, seller_country: v })} width={50} />
                <EditField label={lt("USt-ID")} value={bulkFields.seller_vat_id ?? ''} onChange={v => setBulkFields({ ...bulkFields, seller_vat_id: v })} />
                <EditField label={lt("USt%")} value={bulkFields.vat_rate ?? ''} onChange={v => setBulkFields({ ...bulkFields, vat_rate: v })} width={40} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!bulkFields.is_usd}
                    onChange={e => setBulkFields({ ...bulkFields, is_usd: e.target.checked })} />
                  <span style={{ fontWeight: 600, color: bulkFields.is_usd ? '#e67e22' : '#666' }}>USD</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!bulkFields.is_eust}
                    onChange={e => setBulkFields({ ...bulkFields, is_eust: e.target.checked })} />
                  <span style={{ fontWeight: 600, color: bulkFields.is_eust ? '#c0392b' : '#666' }}>{lt("EUSt")}</span>
                </label>
                <button onClick={saveBulkEdit} disabled={bulkBusy}
                  style={{ ...actionBtn, background: colors.green, color: '#fff', borderColor: colors.green, padding: '4px 12px' }}>{" "}{lt("Auf alle anwenden")}{" "}</button>
                <button onClick={cancelBulkEdit}
                  style={{ ...actionBtn, padding: '4px 12px' }}>{lt("Abbrechen")}</button>
              </div>
            </div>
          )}

          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 28, textAlign: 'center' }}>
                  <input type="checkbox"
                    checked={scans.length > 0 && selected.size === scans.length}
                    onChange={toggleAllSelect} />
                </th>
                <SortTh label={lt("Datei")} sortKey="filename" current={sort.sortKey} dir={sort.sortDir} onToggle={sort.toggleSort} />
                <SortTh label={lt("Datum")} sortKey="date" current={sort.sortKey} dir={sort.sortDir} onToggle={sort.toggleSort} />
                <SortTh label={lt("Verkäufer")} sortKey="seller" current={sort.sortKey} dir={sort.sortDir} onToggle={sort.toggleSort} />
                <SortTh label={lt("Land")} sortKey="country" current={sort.sortKey} dir={sort.sortDir} onToggle={sort.toggleSort} />
                <SortTh label={lt("Brutto EUR")} sortKey="gross" current={sort.sortKey} dir={sort.sortDir} onToggle={sort.toggleSort} />
                <th style={th}>FX</th>
                <th style={th}>{lt("USt%")}</th>
                <th style={th}>Status</th>
                <th style={th}>{lt("Aktionen")}</th>
              </tr>
            </thead>
            <tbody>
              {sort.sortItems(scans, sort.getSortValue).map(item => {
                const f = item.fields_summary;
                const isEditingThis = editScanId === item.scan_id;
                const isBusy = busyId === item.scan_id;
                const isConfirmed = item.status === 'confirmed';
                const isActive = previewScanId === item.scan_id;

                return (
                  <React.Fragment key={item.scan_id}>
                    <tr
                      ref={el => { reviewRowRefs.current[item.scan_id] = el; }}
                      style={{
                        borderBottom: '1px solid #f0f0f0', cursor: 'pointer',
                        background: selected.has(item.scan_id) ? '#e8f0fe' : isActive ? '#d4e6f9' : 'transparent',
                        fontWeight: isActive ? 600 : 'normal',
                        borderLeft: isActive ? '3px solid #2980b9' : '3px solid transparent',
                        userSelect: isDragging ? 'none' : 'auto',
                      }}
                      onClick={() => { if (!isDragging) setPreviewScanId(item.scan_id); }}
                      onMouseEnter={() => handleDragEnter(item.scan_id)}
                    >
                      <td style={{ ...td, textAlign: 'center', width: 28, userSelect: 'none' }}
                        onClick={e => e.stopPropagation()}
                        onMouseDown={e => { e.preventDefault(); handleDragStart(item.scan_id); }}
                        onMouseEnter={() => handleDragEnter(item.scan_id)}>
                        <input type="checkbox" checked={selected.has(item.scan_id)}
                          onChange={() => toggleSelect(item.scan_id)}
                          style={{ pointerEvents: isDragging ? 'none' : 'auto' }} />
                      </td>
                      <td style={{ ...td, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={item.original_filename}>
                        {item.original_filename}
                      </td>
                      <td style={td}>{fmtDate(f?.invoice_date)}</td>
                      <td style={{ ...td, maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {f?.seller_name ?? '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'center', fontSize: 11, color: '#666' }}>{f?.seller_country ?? '—'}</td>
                      <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right', color: f?.is_refund ? '#27ae60' : undefined }}>
                        {f?.currency_code === 'USD' || f?.original_currency === 'USD'
                          ? `$${((f?.original_amount_minor ?? f?.gross_amount_minor ?? 0) / 100).toFixed(2)}`
                          : f?.gross_amount_minor != null ? (f.is_refund ? '+' : '') + fmtEur(f.gross_amount_minor) : '—'}
                      </td>
                      <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right', color: '#888' }}>
                        {f?.original_currency === 'USD' && f?.original_amount_minor != null
                          ? `$${(Math.abs(f.original_amount_minor) / 100).toFixed(2)}`
                          : ''}
                      </td>
                      <td style={{ ...td, textAlign: 'center' }}>
                        {f?.vat_rate != null ? `${Math.round(f.vat_rate * 100)}%` : '—'}
                      </td>
                      <td style={td}>
                        <Badge text={lt(STATUS_LABELS[item.status] ?? item.status)}
                          color={STATUS_COLORS[item.status] ?? colors.gray} />
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                        {!isEditingThis && (
                          <div style={{ display: 'flex', gap: 3 }}>
                                <button onClick={() => handleOk(item.scan_id)} disabled={isBusy}
                                  style={{ ...actionBtn, background: '#e8f5e9', color: colors.green, borderColor: colors.green }}
                                  title={lt("Importieren")}>OK</button>
                                <button onClick={() => handleRuleRescan(item.scan_id)} disabled={isBusy}
                                  style={{ ...actionBtn, background: '#e3f2fd', color: colors.blue, borderColor: colors.blue }}
                                  title={lt("Ohne KI neu erkennen")}>Re</button>
                                <button onClick={() => handleRescan(item.scan_id)} disabled={isBusy}
                                  style={{ ...actionBtn, background: '#fff4e5', color: '#b45f06', borderColor: '#b45f06' }}
                                  title={lt("Optionaler KI-Rescan mit Vorschau")}>KI</button>
                                <button onClick={() => handleLearnRescan(item.scan_id)} disabled={isBusy}
                                  style={{ ...actionBtn, background: '#f3e5f5', color: '#8e24aa', borderColor: '#8e24aa' }}
                                  title={lt("Vorlage lernen & andere Belege aktualisieren")}>Lrn</button>
                            <button onClick={() => startEdit(item.scan_id)}
                              style={{ ...actionBtn, background: '#fff3e0', color: colors.orange, borderColor: colors.orange }}
                              title={lt("Bearbeiten")}>Ed</button>
                            <button onClick={() => {
                              if (item.document_id) {
                                // Check if document is linked to a match
                                const docId = item.document_id;
                                if (!confirm(lt('Dieser Beleg ist bereits importiert{confirmed}. Wenn er mit einer Buchung verknüpft ist, wird die Verknüpfung gelöst.\n\nWirklich löschen?',{confirmed:item.status==='confirmed'?lt(' und bestätigt'):''}))) return;
                              }
                              handleDelete(item.scan_id);
                            }}
                              style={{ ...actionBtn, background: '#fee', color: colors.red, borderColor: colors.red }}
                              title={lt("Löschen")}>X</button>
                            {isConfirmed && item.document_id && (
                              <a href={`/rechnungen?highlight=${encodeURIComponent(item.document_id)}`}
                                style={{ ...actionBtn, background: '#f0f0f0', color: '#555', borderColor: '#bbb', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                                title={lt("In Rechnungen anzeigen")}>...</a>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                    {/* Inline edit row with annotation support */}
                    {isEditingThis && editFields && (
                      <tr style={{ background: '#fffde7' }}>
                        <td colSpan={10} style={{ padding: 12 }}>
                          <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>{" "}{lt("Feld anklicken, dann im Beleg Bereich markieren (Klick + Ziehen)")}{" "}</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 12, alignItems: 'center' }}>
                            <AnnotatableField field="invoice_number" label={lt("Re-Nr.")} value={editFields.invoice_number ?? ''}
                              hasRegion={!!editRegions.invoice_number} active={activeField === 'invoice_number'}
                              onActivate={() => setActiveField(activeField === 'invoice_number' ? null : 'invoice_number')}
                              onChange={v => setEditFields({ ...editFields, invoice_number: v })} />
                            <AnnotatableField field="invoice_date" label={lt("Datum")} value={editFields.invoice_date ?? ''}
                              hasRegion={!!editRegions.invoice_date} active={activeField === 'invoice_date'}
                              onActivate={() => setActiveField(activeField === 'invoice_date' ? null : 'invoice_date')}
                              onChange={v => setEditFields({ ...editFields, invoice_date: v })} type="date" />
                            <AnnotatableField field="seller_name" label={lt("Verkäufer")} value={editFields.seller_name ?? ''}
                              hasRegion={!!editRegions.seller_name} active={activeField === 'seller_name'}
                              onActivate={() => setActiveField(activeField === 'seller_name' ? null : 'seller_name')}
                              onChange={v => setEditFields({ ...editFields, seller_name: v })} />
                            <EditField label={lt("Land")} value={editFields.seller_country ?? ''} onChange={v => setEditFields({ ...editFields, seller_country: v })} width={50} />
                            <EditField label={lt("USt-ID")} value={editFields.seller_vat_id ?? ''} onChange={v => setEditFields({ ...editFields, seller_vat_id: v })} />
                            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}
                              title={lt("USD-Rechnung: Betrag in FX-Spalte, EUR bleibt leer bis Bank-Abgleich")}>
                              <input type="checkbox"
                                checked={editFields.currency_code === 'USD' || editFields.meta?.original_currency === 'USD'}
                                onChange={e => {
                                  if (e.target.checked) {
                                    // Move gross to USD meta, clear EUR
                                    const gross = editFields.gross_amount_minor;
                                    setEditFields({
                                      ...editFields,
                                      currency_code: 'USD',
                                      meta: { ...editFields.meta, original_currency: 'USD', original_amount_minor: gross },
                                      gross_amount_minor: null, net_amount_minor: null, vat_amount_minor: null,
                                    });
                                  } else {
                                    // Restore from USD meta
                                    const origAmount = editFields.meta?.original_amount_minor ?? null;
                                    const { original_currency, original_amount_minor, original_net_minor, original_vat_minor, ...cleanMeta } = editFields.meta ?? {};
                                    setEditFields({
                                      ...editFields,
                                      currency_code: 'EUR',
                                      meta: cleanMeta,
                                      gross_amount_minor: origAmount ?? editFields.gross_amount_minor,
                                    });
                                  }
                                }} />
                              <span style={{ fontWeight: 600, color: editFields.currency_code === 'USD' ? '#e67e22' : '#666' }}>USD</span>
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}
                              title={lt("Gutschrift/Erstattung: Betrag wird positiv (Einnahme)")}>
                              <input type="checkbox"
                                checked={!!editFields.meta?.is_refund}
                                onChange={e => {
                                  const meta = { ...editFields.meta };
                                  if (e.target.checked) {
                                    meta.is_refund = true;
                                  } else {
                                    delete meta.is_refund;
                                  }
                                  setEditFields({ ...editFields, meta });
                                }} />
                              <span style={{ fontWeight: 600, color: editFields.meta?.is_refund ? '#27ae60' : '#666' }}>{lt("Gutschrift")}</span>
                            </label>
                            <AnnotatableAmount field="gross_amount_minor" label={lt("Brutto")} value={editFields.gross_amount_minor}
                              hasRegion={!!editRegions.gross_amount_minor} active={activeField === 'gross_amount_minor'}
                              onActivate={() => setActiveField(activeField === 'gross_amount_minor' ? null : 'gross_amount_minor')}
                              onChange={v => setEditFields({ ...editFields, gross_amount_minor: v })} />
                            <AnnotatableAmount field="net_amount_minor" label={lt("Netto")} value={editFields.net_amount_minor}
                              hasRegion={!!editRegions.net_amount_minor} active={activeField === 'net_amount_minor'}
                              onActivate={() => setActiveField(activeField === 'net_amount_minor' ? null : 'net_amount_minor')}
                              onChange={v => setEditFields({ ...editFields, net_amount_minor: v })} />
                            <EditAmount label={lt("USt")} value={editFields.vat_amount_minor} onChange={v => setEditFields({ ...editFields, vat_amount_minor: v })} />
                            <EditField label={lt("USt%")} value={editFields.vat_rate != null ? String(Math.round(editFields.vat_rate * 100)) : ''}
                              onChange={v => setEditFields({ ...editFields, vat_rate: v ? parseFloat(v) / 100 : null })} width={40} />
                            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}
                              title={lt("EUSt-Split: Rechnung mit Einfuhrumsatzsteuer (z.B. UPS, DHL, Zoll)")}>
                              <input type="checkbox"
                                checked={!!editFields.meta?.carrier_eust_split}
                                onChange={e => {
                                  const meta = { ...editFields.meta };
                                  if (e.target.checked) {
                                    meta.carrier_eust_split = true;
                                    meta.eust_amount_minor = meta.eust_amount_minor ?? 0;
                                  } else {
                                    delete meta.carrier_eust_split;
                                    delete meta.eust_amount_minor;
                                  }
                                  setEditFields({ ...editFields, meta });
                                }} />
                              <span style={{ fontWeight: 600, color: editFields.meta?.carrier_eust_split ? '#c0392b' : '#666' }}>{lt("EUSt")}</span>
                            </label>
                            {editFields.meta?.carrier_eust_split && (
                              <AnnotatableAmount field="eust_amount" label={lt("EUSt-Betrag")}
                                value={editFields.meta?.eust_amount_minor ?? null}
                                hasRegion={!!editRegions.eust_amount} active={activeField === 'eust_amount'}
                                onActivate={() => setActiveField(activeField === 'eust_amount' ? null : 'eust_amount')}
                                onChange={v => setEditFields({ ...editFields, meta: { ...editFields.meta, eust_amount_minor: v } })} />
                            )}
                            <EditField label={lt("E-Mail")} value={editFields.meta?.seller_email ?? ''}
                              onChange={v => setEditFields({ ...editFields, meta: { ...editFields.meta, seller_email: v || undefined } })} width={160} />
                            <button onClick={saveEdit} disabled={isBusy}
                              style={{ ...actionBtn, background: colors.green, color: '#fff', borderColor: colors.green, padding: '4px 12px' }}>{" "}{lt("Speichern")}{" "}</button>
                            <button onClick={cancelEdit}
                              style={{ ...actionBtn, padding: '4px 12px' }}>{" "}{lt("Abbrechen")}{" "}</button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {scans.length === 0 && (
                <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: '#999' }}>{lt("Keine Scans")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function parseMarkedNumber(text: string): number {
  const match = text.match(/-?\d{1,3}(?:[. ]\d{3})*,\d{2}|-?\d{1,3}(?:,\d{3})*\.\d{2}|-?\d+(?:[.,]\d+)?/);
  if (!match) return Number.NaN;
  const token = match[0].replace(/\s/g, '');
  const lastComma = token.lastIndexOf(',');
  const lastDot = token.lastIndexOf('.');
  const decimalIndex = Math.max(lastComma, lastDot);
  const normalized = decimalIndex >= 0
    ? token.slice(0, decimalIndex).replace(/[.,]/g, '') + '.' + token.slice(decimalIndex + 1)
    : token;
  return Number(normalized);
}

// ==================== SORTING ====================

type SortKey = 'date' | 'scan_date' | 'seller' | 'country' | 'gross' | 'filename' | '';
type SortDir = 'asc' | 'desc';

function useScanSort() {
  const [sortKey, setSortKey] = useState<SortKey>('');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const sortItems = <T extends any>(items: T[], getField: (item: T) => any): T[] => {
    if (!sortKey) return items;
    const sorted = [...items].sort((a, b) => {
      const fa = getField(a);
      const fb = getField(b);
      if (fa == null && fb == null) return 0;
      if (fa == null) return 1;
      if (fb == null) return -1;
      if (typeof fa === 'string') return fa.localeCompare(fb, 'de');
      return fa - fb;
    });
    return sortDir === 'desc' ? sorted.reverse() : sorted;
  };

  const getSortValue = (item: any) => {
    const f = item.fields_summary ?? {};
    switch (sortKey) {
      case 'date': return f.invoice_date ?? item.created_at ?? '';
      case 'scan_date': return item.created_at ?? '';
      case 'seller': return f.seller_name ?? '';
      case 'country': return f.seller_country ?? '';
      case 'gross': return f.gross_amount_minor ?? -Infinity;
      case 'filename': return item.original_filename ?? '';
      default: return null;
    }
  };

  return { sortKey, sortDir, toggleSort, sortItems, getSortValue };
}

function SortTh({ label, sortKey: myKey, current, dir, onToggle, style }: {
  label: string; sortKey: SortKey; current: SortKey; dir: SortDir;
  onToggle: (k: SortKey) => void; style?: React.CSSProperties;
}) {
  const active = current === myKey;
  const arrow = active ? (dir === 'asc' ? ' ^' : ' v') : '';
  return (
    <th style={{ ...th, cursor: 'pointer', userSelect: 'none', ...style }}
      onClick={() => onToggle(myKey)}>
      {label}{arrow && <span style={{ fontSize: 9, color: '#2980b9' }}>{arrow}</span>}
    </th>
  );
}

// ==================== SUB-COMPONENTS ====================

// Field colors for annotation highlighting
const FIELD_COLORS: Record<string, string> = {
  invoice_number: '#2196f3', invoice_date: '#4caf50', seller_name: '#ff9800',
  gross_amount_minor: '#e91e63', net_amount_minor: '#9c27b0', vat_amount_minor: '#00bcd4',
  eust_amount: '#c0392b',
};

function AnnotatedPreview({ scan, activeField, fieldRegions, isAnnotating, onRegionSelected }: {
  scan: any;
  activeField: string | null;
  fieldRegions: Record<string, any>;
  isAnnotating: boolean;
  onRegionSelected: (field: string, region: any, text: string) => void;
}) {
  const lt=useLegacyText(legacyRecognitionEnglish);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [words, setWords] = useState<any[]>([]);
  // Local copy of regions that updates immediately (before parent re-renders)
  const [localRegions, setLocalRegions] = useState<Record<string, any>>({});
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragEnd, setDragEnd] = useState<{ x: number; y: number } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const pageUrl = api.getScanPageUrl(scan.scan_id, currentPage);
  const isPdf = scan.file_type === 'pdf_text' || scan.file_type === 'pdf_image';

  // Sync local regions with parent prop
  useEffect(() => { setLocalRegions(fieldRegions); }, [fieldRegions]);

  // Load OCR words
  useEffect(() => {
    api.getScanWords(scan.scan_id).then(res => setWords(res.words ?? [])).catch(() => setWords([]));
    setCurrentPage(1);
    setImgLoaded(false);
    setImgError(false);
  }, [scan.scan_id]);

  // Draw canvas overlay
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !imgLoaded) return;

    const w = img.clientWidth;
    const h = img.clientHeight;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    // Draw existing field regions (use localRegions for immediate updates)
    for (const [field, region] of Object.entries(localRegions)) {
      if (!region || (region.page ?? 1) !== currentPage) continue;
      const color = FIELD_COLORS[field] ?? '#666';
      ctx.fillStyle = color + '20';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.fillRect(region.x * w, region.y * h, region.w * w, region.h * h);
      ctx.strokeRect(region.x * w, region.y * h, region.w * w, region.h * h);
      // Label
      ctx.fillStyle = color;
      ctx.font = '10px sans-serif';
      ctx.fillText(field.replace(/_minor$/, '').replace(/_/g, ' '), region.x * w + 2, region.y * h - 3);
    }

    // Draw OCR word boundaries (subtle, only in annotation mode with active field)
    if (isAnnotating && activeField && words.length > 0) {
      ctx.strokeStyle = '#ccc';
      ctx.lineWidth = 0.5;
      for (const word of words.filter(word => word.page === currentPage)) {
        ctx.strokeRect(word.x * w, word.y * h, word.w * w, word.h * h);
      }
    }

    // Highlight active field region
    if (activeField && localRegions[activeField] && (localRegions[activeField].page ?? 1) === currentPage) {
      const r = localRegions[activeField];
      const color = FIELD_COLORS[activeField] ?? '#2196f3';
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(r.x * w, r.y * h, r.w * w, r.h * h);
      ctx.setLineDash([]);
    }

    // Draw current drag selection
    if (dragStart && dragEnd) {
      const color = FIELD_COLORS[activeField ?? ''] ?? '#2196f3';
      const sx = Math.min(dragStart.x, dragEnd.x);
      const sy = Math.min(dragStart.y, dragEnd.y);
      const sw = Math.abs(dragEnd.x - dragStart.x);
      const sh = Math.abs(dragEnd.y - dragStart.y);
      ctx.fillStyle = color + '30';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.fillRect(sx * w, sy * h, sw * w, sh * h);
      ctx.strokeRect(sx * w, sy * h, sw * w, sh * h);
      ctx.setLineDash([]);

      // Highlight words inside selection
      for (const word of words.filter(word => word.page === currentPage)) {
        const cx = word.x + word.w / 2;
        const cy = word.y + word.h / 2;
        if (cx >= sx && cx <= sx + sw && cy >= sy && cy <= sy + sh) {
          ctx.fillStyle = color + '50';
          ctx.fillRect(word.x * w, word.y * h, word.w * w, word.h * h);
        }
      }
    }
  }, [words, localRegions, activeField, isAnnotating, imgLoaded, dragStart, dragEnd, currentPage]);

  useEffect(() => { draw(); }, [draw]);

  // Resize observer
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(img);
    return () => ro.disconnect();
  }, [draw]);

  // Mouse handlers for lasso selection
  const getRelPos = (e: React.MouseEvent): { x: number; y: number } | null => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!isAnnotating || !activeField) return;
    const pos = getRelPos(e);
    if (pos) { setDragStart(pos); setDragEnd(pos); }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragStart) return;
    const pos = getRelPos(e);
    if (pos) setDragEnd(pos);
  };

  const onMouseUp = () => {
    if (!dragStart || !dragEnd || !activeField) { setDragStart(null); setDragEnd(null); return; }

    const sx = Math.min(dragStart.x, dragEnd.x);
    const sy = Math.min(dragStart.y, dragEnd.y);
    const sw = Math.abs(dragEnd.x - dragStart.x);
    const sh = Math.abs(dragEnd.y - dragStart.y);

    // Minimum drag size threshold
    if (sw < 0.01 && sh < 0.01) { setDragStart(null); setDragEnd(null); return; }

    // Find words inside selection
    const selectedWords = words.filter(w => {
      if (w.page !== currentPage) return false;
      const cx = w.x + w.w / 2;
      const cy = w.y + w.h / 2;
      return cx >= sx && cx <= sx + sw && cy >= sy && cy <= sy + sh;
    });

    if (selectedWords.length > 0) {
      // Sort by y then x for reading order
      selectedWords.sort((a: any, b: any) => Math.abs(a.y - b.y) > 0.01 ? a.y - b.y : a.x - b.x);
      const text = selectedWords.map((w: any) => w.text).join(' ');
      // Compute bounding box of all selected words
      const minX = Math.min(...selectedWords.map((w: any) => w.x));
      const minY = Math.min(...selectedWords.map((w: any) => w.y));
      const maxX = Math.max(...selectedWords.map((w: any) => w.x + w.w));
      const maxY = Math.max(...selectedWords.map((w: any) => w.y + w.h));
      const region = { page: currentPage, x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      setLocalRegions(prev => ({ ...prev, [activeField]: region }));
      onRegionSelected(activeField, region, text);
    } else {
      // No OCR words found — still save the raw drawn region
      const region = { page: currentPage, x: sx, y: sy, w: sw, h: sh };
      setLocalRegions(prev => ({ ...prev, [activeField]: region }));
      onRegionSelected(activeField, region, '');
    }

    setDragStart(null);
    setDragEnd(null);
  };

  // For PDFs without OCR data and NOT in edit mode, use native PDF embed
  if (isPdf && words.length === 0 && !isAnnotating) {
    const url = api.getScanPreviewUrl(scan.scan_id);
    return <embed src={url} type="application/pdf" style={{ width: '100%', height: 700, borderRadius: 4, border: 'none' }} />;
  }

  // If page image failed to load in edit mode, show embed fallback
  if (imgError && isPdf) {
    const url = api.getScanPreviewUrl(scan.scan_id);
    return <embed src={url} type="application/pdf" style={{ width: '100%', height: 700, borderRadius: 4, border: 'none' }} />;
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', userSelect: 'none' }}>
      <img
        ref={imgRef}
        src={pageUrl}
        alt={scan.original_filename}
        style={{ width: '100%', borderRadius: 4, display: 'block' }}
        onLoad={() => { setImgLoaded(true); setImgError(false); }}
        onError={() => setImgError(true)}
        draggable={false}
      />
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute', top: 0, left: 0,
          cursor: isAnnotating && activeField ? 'crosshair' : 'default',
          pointerEvents: isAnnotating && activeField ? 'auto' : 'none',
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => { if (dragStart) { setDragStart(null); setDragEnd(null); } }}
      />
      {scan.page_count > 1 && (
        <div style={{ position: 'absolute', top: 4, right: 4, zIndex: 3, display: 'flex', gap: 4, background: '#fffffff0', padding: 3, borderRadius: 4 }}>
          <button disabled={currentPage <= 1} onClick={() => { setImgLoaded(false); setCurrentPage(p => p - 1); }}>‹</button>
          <span style={{ fontSize: 11, padding: '3px 5px' }}>{currentPage}/{scan.page_count}</span>
          <button disabled={currentPage >= scan.page_count} onClick={() => { setImgLoaded(false); setCurrentPage(p => p + 1); }}>›</button>
        </div>
      )}
      {isAnnotating && activeField && (
        <div style={{
          position: 'absolute', top: 4, left: 4, background: (FIELD_COLORS[activeField] ?? '#2196f3') + 'dd',
          color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
        }}>
          {activeField.replace(/_minor$/, '').replace(/_/g, ' ')}{" "}{lt("markieren — ziehen Sie ein Rechteck")}{" "}</div>
      )}
    </div>
  );
}

/** Field input with annotation button */
function AnnotatableField({ field, label, value, hasRegion, active, onActivate, onChange, type }: {
  field: string; label: string; value: string; hasRegion: boolean; active: boolean;
  onActivate: () => void; onChange: (v: string) => void; type?: string;
}) {
  const lt=useLegacyText(legacyRecognitionEnglish);
  const color = FIELD_COLORS[field] ?? '#666';
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11 }}>
      <button onClick={onActivate} title={active ? lt("Markierung beenden") : lt("Auf Beleg markieren")}
        style={{
          width: 16, height: 16, borderRadius: 3, border: `2px solid ${color}`,
          background: active ? color : hasRegion ? color + '40' : 'transparent',
          cursor: 'pointer', padding: 0, fontSize: 8, color: active ? '#fff' : color,
          lineHeight: '12px', textAlign: 'center', flexShrink: 0,
        }}>
        {hasRegion ? (active ? 'X' : '+') : (active ? 'X' : ' ')}
      </button>
      <span style={{ fontWeight: 600, color: active ? color : '#666' }}>{label}:</span>
      <input type={type ?? 'text'} value={value} onChange={e => onChange(e.target.value)}
        style={{
          padding: '2px 6px', borderRadius: 3, fontSize: 12, width: 110,
          border: active ? `2px solid ${color}` : '1px solid #ddd',
        }} />
    </label>
  );
}

/** Amount input with annotation button */
function AnnotatableAmount({ field, label, value, hasRegion, active, onActivate, onChange }: {
  field: string; label: string; value: number | null; hasRegion: boolean; active: boolean;
  onActivate: () => void; onChange: (v: number | null) => void;
}) {
  const lt=useLegacyText(legacyRecognitionEnglish);
  const color = FIELD_COLORS[field] ?? '#666';
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11 }}>
      <button onClick={onActivate} title={active ? lt("Markierung beenden") : lt("Auf Beleg markieren")}
        style={{
          width: 16, height: 16, borderRadius: 3, border: `2px solid ${color}`,
          background: active ? color : hasRegion ? color + '40' : 'transparent',
          cursor: 'pointer', padding: 0, fontSize: 8, color: active ? '#fff' : color,
          lineHeight: '12px', textAlign: 'center', flexShrink: 0,
        }}>
        {hasRegion ? (active ? 'X' : '+') : (active ? 'X' : ' ')}
      </button>
      <span style={{ fontWeight: 600, color: active ? color : '#666' }}>{label}:</span>
      <input type="text" value={value != null ? (value / 100).toFixed(2) : ''}
        onChange={e => {
          const v = parseFloat(e.target.value.replace(',', '.'));
          onChange(isNaN(v) ? null : Math.round(v * 100));
        }}
        style={{
          padding: '2px 6px', borderRadius: 3, fontSize: 12, width: 70,
          textAlign: 'right', fontFamily: 'monospace',
          border: active ? `2px solid ${color}` : '1px solid #ddd',
        }} />
    </label>
  );
}

function FieldRow({ label, field, fields, confidence, onChange, disabled, type, displayValue }: {
  label: string; field: string; fields: any; confidence: any;
  onChange: (v: string) => void; disabled: boolean; type?: string; displayValue?: string;
}) {
  const value = displayValue ?? (fields[field] ?? '');
  const conf = confidence?.[field]?.value;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label style={{ width: 100, fontSize: 12, fontWeight: 600, textAlign: 'right', flexShrink: 0 }}>{label}</label>
      <input type={type ?? 'text'} value={value} onChange={e => onChange(e.target.value)}
        disabled={disabled}
        style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13 }} />
      <ConfidenceDot value={conf} />
    </div>
  );
}

function AmountRow({ label, field, fields, confidence, onChange, disabled }: {
  label: string; field: string; fields: any; confidence: any;
  onChange: (v: number | null) => void; disabled: boolean;
}) {
  const minor = fields[field] as number | null;
  const display = minor != null ? (minor / 100).toFixed(2) : '';
  const conf = confidence?.[field]?.value ?? confidence?.[field.replace('_minor', '')]?.value;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label style={{ width: 100, fontSize: 12, fontWeight: 600, textAlign: 'right', flexShrink: 0 }}>{label}</label>
      <input type="text" value={display}
        onChange={e => {
          const v = parseFloat(e.target.value.replace(',', '.'));
          onChange(isNaN(v) ? null : Math.round(v * 100));
        }}
        disabled={disabled}
        style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13, textAlign: 'right', fontFamily: 'monospace' }} />
      <span style={{ fontSize: 11, color: '#999', width: 24 }}>EUR</span>
      <ConfidenceDot value={conf} />
    </div>
  );
}

function ConfidenceDot({ value }: { value?: number }) {
  const lt=useLegacyText(legacyRecognitionEnglish);
  if (value == null) return <span style={{ width: 12 }} />;
  const color = value >= 0.8 ? colors.green : value >= 0.5 ? colors.orange : colors.red;
  return (
    <span title={lt('Konfidenz: {value}%',{value:Math.round(value*100)})}
      style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
  );
}

function EditField({ label, value, onChange, type, width }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; width?: number;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
      <span style={{ fontWeight: 600, color: '#666' }}>{label}:</span>
      <input type={type ?? 'text'} value={value} onChange={e => onChange(e.target.value)}
        style={{ padding: '2px 6px', borderRadius: 3, border: '1px solid #ddd', fontSize: 12, width: width ?? 110 }} />
    </label>
  );
}

function EditAmount({ label, value, onChange }: {
  label: string; value: number | null; onChange: (v: number | null) => void;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
      <span style={{ fontWeight: 600, color: '#666' }}>{label}:</span>
      <input type="text" value={value != null ? (value / 100).toFixed(2) : ''}
        onChange={e => {
          const v = parseFloat(e.target.value.replace(',', '.'));
          onChange(isNaN(v) ? null : Math.round(v * 100));
        }}
        style={{ padding: '2px 6px', borderRadius: 3, border: '1px solid #ddd', fontSize: 12, width: 70, textAlign: 'right', fontFamily: 'monospace' }} />
    </label>
  );
}

// ==================== HELPERS ====================

// ==================== KI-KOSTENVERLAUF ====================

function AiCostPanel() {
  const lt=useLegacyText(legacyRecognitionEnglish);
  const [snapshot, setSnapshot] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [entries, setEntries] = useState<any[]>([]);

  const load = () => {
    api.botGetCostSnapshot().then(setSnapshot).catch(() => {});
    api.botGetCostHistory(20).then(setHistory).catch(() => {});
  };
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const toggleSession = async (id: string) => {
    if (expandedSession === id) { setExpandedSession(null); return; }
    try {
      const data = await api.botGetSessionEntries(id);
      setEntries(data);
      setExpandedSession(id);
    } catch { setEntries([]); }
  };

  if (!snapshot) return null;

  const s = snapshot.session;
  const totalCost = history.reduce((sum: number, h: any) => sum + (h.totalCostUsd ?? 0), 0);
  const totalTokens = history.reduce((sum: number, h: any) => sum + (h.totalTokens ?? 0), 0);
  const totalCalls = history.reduce((sum: number, h: any) => sum + (h.callCount ?? 0), 0);

  return (
    <Card style={{ marginBottom: 16, background: '#f8f9fa' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>{" "}{lt("KI-Kostenverlauf")}{" "}{s && (
            <span style={{ fontSize: 11, color: colors.green, marginLeft: 8, fontWeight: 400 }}>{" "}{lt("Aktive Session:")}{" "}{s.callCount}{" "}{lt("Aufrufe,")}{" "}{s.totalTokens.toLocaleString('de-DE')} Tokens, ${formatCost(s.totalCostUsd)}
            </span>
          )}
        </h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>{" "}{lt("Heute: $")}{formatCost(snapshot.todayTotalUsd)} ({snapshot.todayTotalTokens.toLocaleString('de-DE')} Tok)
          </span>
          <button onClick={() => setExpanded(!expanded)}
            style={{ padding: '2px 8px', borderRadius: 4, border: '1px solid #ddd', cursor: 'pointer', fontSize: 10, background: expanded ? '#2c3e50' : '#ecf0f1', color: expanded ? '#fff' : '#333' }}>
            {expanded ? lt("Einklappen") : lt("Verlauf")}
          </button>
        </div>
      </div>

      {expanded && history.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {/* Totals */}
          <div style={{ display: 'flex', gap: 16, fontSize: 11, padding: '6px 8px', background: '#eee', borderRadius: 4, marginBottom: 6 }}>
            <span><b>{history.length}</b> Sessions</span>
            <span><b>{totalCalls}</b>{" "}{lt("Aufrufe")}</span>
            <span style={{ fontFamily: 'monospace' }}><b>{totalTokens.toLocaleString('de-DE')}</b> Tokens</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{lt("Gesamt: $")}{formatCost(totalCost)}</span>
          </div>

          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 16 }}></th>
                <th style={th}>Start</th>
                <th style={th}>{lt("Aufrufe")}</th>
                <th style={{ ...th, textAlign: 'right' }}>Prompt</th>
                <th style={{ ...th, textAlign: 'right' }}>Completion</th>
                <th style={{ ...th, textAlign: 'right' }}>Tokens</th>
                <th style={{ ...th, textAlign: 'right' }}>{lt("Kosten")}</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h: any) => (
                <React.Fragment key={h.id}>
                  <tr style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer', background: expandedSession === h.id ? '#f0f7ff' : 'transparent' }}
                    onClick={() => toggleSession(h.id)}>
                    <td style={td}>{expandedSession === h.id ? 'v' : '>'}</td>
                    <td style={td}>{h.startedAt?.slice(0, 16).replace('T', ' ')}</td>
                    <td style={{ ...td, textAlign: 'center' }}>{h.callCount}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{(h.promptTokens ?? 0).toLocaleString('de-DE')}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{(h.completionTokens ?? 0).toLocaleString('de-DE')}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{h.totalTokens.toLocaleString('de-DE')}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>${formatCost(h.totalCostUsd)}</td>
                    <td style={td}>
                      <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3,
                        background: h.status === 'active' ? '#e8f5e9' : h.status === 'limit_reached' ? '#fee' : '#f0f0f0',
                        color: h.status === 'active' ? colors.green : h.status === 'limit_reached' ? colors.red : '#666',
                      }}>{h.status === 'active' ? lt("Aktiv") : h.status === 'completed' ? lt("Beendet") : h.status}</span>
                    </td>
                  </tr>
                  {expandedSession === h.id && (
                    <tr>
                      <td colSpan={8} style={{ padding: 0 }}>
                        <div style={{ background: '#fafafa', padding: '4px 12px 4px 24px', borderBottom: '2px solid #ddd' }}>
                          {entries.length === 0 ? (
                            <div style={{ fontSize: 10, color: '#999' }}>{lt("Keine Einträge")}</div>
                          ) : (
                            <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse' }}>
                              <thead>
                                <tr>
                                  <th style={{ ...th, fontSize: 9 }}>{lt("Zeit")}</th>
                                  <th style={{ ...th, fontSize: 9 }}>{lt("Modell")}</th>
                                  <th style={{ ...th, fontSize: 9, textAlign: 'right' }}>Prompt</th>
                                  <th style={{ ...th, fontSize: 9, textAlign: 'right' }}>Completion</th>
                                  <th style={{ ...th, fontSize: 9, textAlign: 'right' }}>Tokens</th>
                                  <th style={{ ...th, fontSize: 9, textAlign: 'right' }}>{lt("Kosten")}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {entries.map((e: any, i: number) => (
                                  <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
                                    <td style={td}>{e.createdAt?.slice(11, 19)}</td>
                                    <td style={{ ...td, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                      title={e.model}>{e.model?.split('/')[1] ?? e.model}</td>
                                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{e.promptTokens?.toLocaleString('de-DE')}</td>
                                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{e.completionTokens?.toLocaleString('de-DE')}</td>
                                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{e.totalTokens?.toLocaleString('de-DE')}</td>
                                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>${formatCost(e.costUsd ?? 0)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {expanded && history.length === 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>{lt("Noch keine KI-Aufrufe. Nach dem nächsten Import erscheinen hier die Kosten.")}</div>
      )}
    </Card>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '4px 6px', borderBottom: '2px solid #ddd', color: '#666', fontSize: 11 };
const td: React.CSSProperties = { padding: '4px 6px' };
const btnS: React.CSSProperties = { padding: '6px 12px', borderRadius: 4, border: '1px solid #ddd', background: '#fff', cursor: 'pointer', fontSize: 12 };
const actionBtn: React.CSSProperties = {
  padding: '2px 6px', borderRadius: 3, border: '1px solid #ddd', cursor: 'pointer',
  fontSize: 11, fontWeight: 700, background: '#f8f8f8',
};

function formatCost(usd: number): string {
  if (usd === 0) return '0.00';
  if (usd < 0.001) return usd.toFixed(6);
  if (usd < 0.01) return usd.toFixed(4);
  return usd.toFixed(2);
}

function fmtEur(minor: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(minor / 100);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

// ==================== AI SETTINGS PANEL ====================

function AiSettingsPanel() {
  const lt=useLegacyText(legacyRecognitionEnglish);
  const [aiStatus, setAiStatus] = useState<any>(null);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<any[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedFallback, setSelectedFallback] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    api.getAiStatus().then(s => {
      setAiStatus(s);
      setSelectedModel(s.model ?? 'google/gemini-2.0-flash-001');
      setSelectedFallback(s.fallback_model ?? 'anthropic/claude-sonnet-4');
    }).catch(() => {});
  }, []);

  const loadModels = async () => {
    setLoadingModels(true);
    try {
      const res = await api.getAiModels();
      setModels(res.models ?? []);
      if (res.current_model) setSelectedModel(res.current_model);
    } catch (err: any) {
      setMessage({ text: lt("Modelle laden fehlgeschlagen: ") + err.message, color: colors.red });
    } finally { setLoadingModels(false); }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await api.saveAiConfig(apiKey || undefined, selectedModel || undefined, selectedFallback || undefined);
      if (apiKey) setApiKey('');
      const s = await api.getAiStatus();
      setAiStatus(s);
      setMessage({ text: lt("Gespeichert"), color: colors.green });
    } catch (err: any) {
      setMessage({ text: err.message, color: colors.red });
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    await api.deleteAiConfig();
    setAiStatus({ enabled: false, model: null, fallback_model: null, masked_key: null });
    setModels([]);
    setMessage({ text: lt("API-Key entfernt"), color: colors.orange });
  };

  const modelSelect = (value: string, onChange: (v: string) => void, placeholder: string) => {
    if (models.length > 0) {
      return (
        <select value={value} onChange={e => onChange(e.target.value)}
          style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13 }}>
          {models.map((m: any) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      );
    }
    return (
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13 }} />
    );
  };

  return (
    <Card style={{ marginBottom: 16, background: '#f8f9fa' }}>
      <h3 style={{ fontSize: 14, margin: '0 0 12px' }}>{" "}{lt("KI-Erkennung (OpenRouter)")}{" "}{aiStatus?.enabled ? (
          <Badge text={lt("Aktiv")} color={colors.green} />
        ) : (
          <span style={{ color: '#999', fontSize: 12, marginLeft: 8 }}>{lt("Nicht konfiguriert")}</span>
        )}
      </h3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* API Key */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={aiLabel}>API-Key:</label>
          {aiStatus?.masked_key && !apiKey && (
            <span style={{ fontSize: 12, color: '#666' }}>{" "}{lt("Gespeichert:")}{" "}<code>{aiStatus.masked_key}</code>
              <button onClick={handleDelete}
                style={{ marginLeft: 8, fontSize: 11, color: colors.red, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>{" "}{lt("entfernen")}{" "}</button>
            </span>
          )}
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
            placeholder={aiStatus?.masked_key ? lt("Neuen Key eingeben (optional)") : 'sk-or-v1-...'}
            style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13 }} />
        </div>

        {/* Standard model */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={aiLabel}>Standard:</label>
          {modelSelect(selectedModel, setSelectedModel, 'google/gemini-2.0-flash-001')}
          <button onClick={loadModels} disabled={loadingModels || !aiStatus?.enabled}
            style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #ddd', cursor: 'pointer', fontSize: 11, background: '#ecf0f1' }}>
            {loadingModels ? '...' : lt("Modelle laden")}
          </button>
        </div>

        {/* Fallback model */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={aiLabel}>Fallback:</label>
          {modelSelect(selectedFallback, setSelectedFallback, 'anthropic/claude-sonnet-4')}
          <span style={{ fontSize: 11, color: '#999', width: 90, flexShrink: 0 }}>{lt("bei Problemen")}</span>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button onClick={handleSave} disabled={saving} color="#2c3e50">
            {saving ? '...' : lt("Speichern")}
          </Button>
          {message && <span style={{ fontSize: 12, color: message.color }}>{message.text}</span>}
        </div>

        <div style={{ fontSize: 11, color: '#999', lineHeight: 1.5 }}>
          <b>{lt("Standard-Modell")}</b>{" "}{lt("(schnell + günstig) wird zuerst versucht. Wenn weniger als 3 von 4 Pflichtfeldern erkannt werden, wird automatisch das")}{" "}<b>{lt("Fallback-Modell")}</b>{" "}{lt("(stärker) eingesetzt. KI nur aktiv wenn Regex/Vorlage nicht ausreichen.")}{" "}</div>
      </div>
    </Card>
  );
}

const aiLabel: React.CSSProperties = { width: 90, fontSize: 12, fontWeight: 600, flexShrink: 0 };
