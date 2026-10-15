import React, { useEffect, useState, useMemo, useRef } from 'react';
import { api } from '../api';
import { Card, Pagination, SearchInput, Select, Amount, Badge, FileLink, SourceBadge, colors, formatDate, usePageSize, useWorkingYear, Tip } from '../components/shared';

type ImportStatus = 'idle' | 'loading' | 'success' | 'error';

export function Rechnungen() {
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get('highlight') || '';
  });
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sortField, setSortField] = useState('document_date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const { pageSize } = usePageSize();
  const { workingYear, quarter } = useWorkingYear();
  const [periodFilter, setPeriodFilter] = useState(() => localStorage.getItem('doc_periodFilter') !== 'false');
  const [highlightId, setHighlightId] = useState<string | null>(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get('highlight') || null;
  });
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  // Import state
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus>('idle');
  const [importResult, setImportResult] = useState<any>(null);
  const [importError, setImportError] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [belegeInfo, setBelegeInfo] = useState<any>(null);
  const [summary, setSummary] = useState<any>(null);
  const [editMode, setEditMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [dismissedDups, setDismissedDups] = useState<Set<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // Inline editing
  const [edits, setEdits] = useState<Record<string, Record<string, any>>>({});
  const [editingCell, setEditingCell] = useState<string | null>(null); // "docId:field"
  const [saving, setSaving] = useState<string | null>(null);

  // Amazon import state
  const [amazonSendungen, setAmazonSendungen] = useState<File | null>(null);
  const [amazonErstattungen, setAmazonErstattungen] = useState<File | null>(null);
  const [amazonAbgleich, setAmazonAbgleich] = useState<File | null>(null);
  const [amazonStatus, setAmazonStatus] = useState<ImportStatus>('idle');
  const [amazonResult, setAmazonResult] = useState<any>(null);
  const [amazonError, setAmazonError] = useState('');
  // (organize removed — linking is automatic)

  const load = () => {
    const params: Record<string, string> = { page: String(page), limit: String(pageSize), type: 'expense', sort: sortField, order: sortOrder };
    if (search) params.search = search;
    if (status) params.status = status;
    if (source) params.source = source;
    if (periodFilter) {
      params.year = String(workingYear);
      if (quarter) params.quarter = String(quarter);
    }
    api.getDocuments(params).then(setData);
  };

  useEffect(() => { load(); }, [page, pageSize, status, source, sortField, sortOrder, search, periodFilter, workingYear, quarter]);
  useEffect(() => {
    api.getBelegeInfo().then(setBelegeInfo).catch(() => {});
    api.getSummary().then(setSummary).catch(() => {});
  }, [importResult]);

  // Inline edit helpers
  const setField = (docId: string, field: string, value: any) => {
    setEdits(prev => ({ ...prev, [docId]: { ...prev[docId], [field]: value } }));
  };
  const editKey = (docId: string, field: string) => `${docId}:${field}`;
  const handleSave = async (docId: string) => {
    const changes = edits[docId];
    if (!changes || Object.keys(changes).length === 0) return;

    // Auto-compute missing values: if net/gross/vat/rate changed, derive the rest
    const doc = data?.items?.find((d: any) => d.document_id === docId);
    if (doc) {
      const gross = changes.gross_minor ?? doc.total_amount_minor;
      const vat = changes.vat_minor ?? (doc.ust != null ? Math.round(doc.ust * 100) : 0);
      const rate = changes.vat_rate ?? doc.vat_rate ?? doc.tax_rate ?? null;
      const net = changes.net_minor;

      if (net !== undefined && gross === doc.total_amount_minor && rate != null && rate > 0) {
        // Net changed → compute gross and vat from net + rate
        const computedVat = Math.round(Math.abs(net) * (rate / 100));
        changes.vat_minor = net < 0 ? -computedVat : computedVat;
        changes.gross_minor = net + changes.vat_minor;
      } else if (net !== undefined && changes.vat_minor === undefined) {
        // Net changed, no rate → compute vat = gross - net
        changes.vat_minor = gross - net;
      } else if (changes.gross_minor !== undefined && changes.vat_minor === undefined && rate != null && rate > 0) {
        // Gross changed + rate → compute net and vat
        const computedNet = Math.round(changes.gross_minor / (1 + rate / 100));
        changes.vat_minor = changes.gross_minor - computedNet;
      }
      // Clean up net_minor — it's not a DB field, computed from gross - vat
      delete changes.net_minor;
    }

    // If supplier_name changed, ask whether to apply to all vendor docs
    let skipPropagation = true; // default: only this doc
    if (changes.supplier_name !== undefined) {
      const doc = data?.items?.find((d: any) => d.document_id === docId);
      const oldName = doc?.supplier_name ?? '';
      const applyAll = confirm(
        `Lieferant geändert: "${oldName}" → "${changes.supplier_name}"\n\nFür ALLE Rechnungen von "${oldName}" übernehmen?\n\n• OK = Alle Rechnungen\n• Abbrechen = Nur diese Rechnung`
      );
      if (applyAll) skipPropagation = false;
    }

    setSaving(docId);
    try {
      await api.updateDocumentVat(docId, { ...changes, skip_propagation: skipPropagation });
      setEdits(prev => { const n = { ...prev }; delete n[docId]; return n; });
      setEditingCell(null);
      load();
    } catch (e: any) {
      alert('Fehler: ' + e.message);
    } finally {
      setSaving(null);
    }
  };

  // Highlight scroll effect
  useEffect(() => {
    if (!highlightId || !data) return;
    const found = data.items?.find((d: any) => d.document_id === highlightId);
    if (found) {
      setTimeout(() => {
        const row = rowRefs.current[highlightId];
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => setHighlightId(null), 3000);
      }, 150);
    }
  }, [highlightId, data]);

  const doSearch = () => { setPage(1); load(); };

  const handleImport = async () => {
    if (!importFile) return;
    setImportStatus('loading');
    setImportError('');
    setImportResult(null);
    try {
      const res = await api.importDocuments(importFile, 'invoice');
      setImportResult(res);
      setImportStatus('success');
      load(); // refresh list
    } catch (err: any) {
      setImportError(err.message);
      setImportStatus('error');
    }
  };

  const handleAmazonImport = async () => {
    if (!amazonSendungen || !amazonAbgleich) return;
    setAmazonStatus('loading');
    setAmazonError('');
    setAmazonResult(null);
    try {
      const res = await api.importAmazon(amazonSendungen, amazonErstattungen, amazonAbgleich);
      setAmazonResult(res);
      setAmazonStatus('success');
      load();
    } catch (err: any) {
      setAmazonError(err.message);
      setAmazonStatus('error');
    }
  };



  // Only flag documents as duplicates when their linked booking lines also match.
  const dupSet = useMemo(() => {
    if (!data?.items) return new Set<string>();
    const seen = new Map<string, string>(); // key → first document_id
    const dups = new Set<string>();
    for (const d of data.items) {
      const bookingLines = (d.linked_transactions ?? [])
        .map((t: any) => (t.description_raw ?? '').trim().replace(/\s+/g, ' ').toLowerCase())
        .filter(Boolean)
        .sort()
        .join('|') || 'unlinked';
      const key = `${d.total_amount_minor}|${(d.document_date ?? '').slice(0, 10)}|${(d.supplier_name ?? '').toLowerCase()}|${bookingLines}`;
      const existing = seen.get(key);
      if (existing && existing !== d.document_id) {
        dups.add(d.document_id);
        dups.add(existing);
      } else {
        seen.set(key, d.document_id);
      }
    }
    return dups;
  }, [data]);

  if (!data) return <p>Loading...</p>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Rechnungen (Ausgaben)</h1>
        {(() => {
          const docs = summary?.documents;
          if (!docs) return null;
          const rSources = ['invoice_file', 'extracted_invoice', 'amazon', 'invoice_scan'];
          let total = 0, matched = 0;
          for (const src of rSources) {
            const s = docs.by_source?.[src];
            if (s) { total += s.total; matched += s.matched; }
          }
          if (total === 0) return null;
          const pct = Math.round(matched / total * 100);
          return (
            <span style={{
              fontSize: 14, fontWeight: 700, padding: '4px 12px', borderRadius: 12,
              background: pct > 80 ? '#e8f5e9' : pct > 50 ? '#fff8e1' : '#fce4ec',
              color: pct > 80 ? '#27ae60' : pct > 50 ? '#f39c12' : '#e74c3c',
            }}>
              {pct}% gematcht ({matched}/{total})
            </span>
          );
        })()}
        <button
          onClick={() => setShowImport(!showImport)}
          style={{
            padding: '6px 14px', background: showImport ? '#eee' : '#e67e22', color: showImport ? '#333' : '#fff',
            border: 'none', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {showImport ? 'Import ausblenden' : 'Import'}
        </button>
        {belegeInfo?.years && Object.keys(belegeInfo.years).sort().reverse().map(year => (
          <button
            key={year}
            onClick={() => api.openBelegeFolder('rechnungen', year)}
            style={{
              padding: '6px 14px', background: '#f0f0f0', color: '#333',
              border: '1px solid #ddd', borderRadius: 4, fontSize: 13, cursor: 'pointer',
            }}
          >
            {year} ({belegeInfo.years[year].rechnungen} Dateien)
          </button>
        ))}
      </div>

      {showImport && (<>
        <Card style={{ marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Rechnungen importieren (XLS / CSV)</h3>
          <p style={{ color: '#666', fontSize: 13, margin: '0 0 12px' }}>
            Importiert Ausgaben-Rechnungen aus einer Excel- oder CSV-Datei.
            Erwartet die Spalten: filename, invoice_date, vendor, invoice_number, sum_value, vat_%, vat_value, etc.
          </p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={e => setImportFile(e.target.files?.[0] ?? null)}
              style={{ fontSize: 13 }}
            />
            <button
              onClick={handleImport}
              disabled={importStatus === 'loading' || !importFile}
              style={{
                padding: '8px 20px', background: '#e67e22', color: '#fff',
                border: 'none', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                opacity: (importStatus === 'loading' || !importFile) ? 0.6 : 1,
              }}
            >
              {importStatus === 'loading' ? 'Importiere...' : 'Importieren'}
            </button>
          </div>

          {importStatus === 'error' && (
            <div style={{ marginTop: 8, padding: 10, background: '#fdecea', color: '#c0392b', borderRadius: 4, fontSize: 13 }}>
              {importError}
            </div>
          )}

          {importResult && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', gap: 20, marginBottom: 12 }}>
                <StatBox label="Gelesen" value={importResult.fetched} />
                <StatBox label="Neu" value={importResult.imported} color={colors.green} />
                <StatBox label="Aktualisiert" value={importResult.skipped} color={colors.darkGray} />
              </div>
              {importResult.documents?.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
                      <th style={thStyle}>Status</th>
                      <th style={thStyle}>Datum</th>
                      <th style={thStyle}>Rechnungsnr.</th>
                      <th style={thStyle}>Lieferant</th>
                      <th style={thStyle}>Datei</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Betrag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importResult.documents.slice(0, 50).map((d: any, i: number) => (
                      <tr key={i} style={{
                        borderBottom: '1px solid #f0f0f0',
                        background: d.is_new ? '#f0fff0' : 'transparent',
                      }}>
                        <td style={tdStyle}>
                          {d.is_new
                            ? <Badge text="NEU" color={colors.green} />
                            : <Badge text="aktualisiert" color={colors.blue} />
                          }
                        </td>
                        <td style={tdStyle}>{formatDate(d.date)}</td>
                        <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{d.ref}</td>
                        <td style={tdStyle}>{d.name || '—'}</td>
                        <td style={tdStyle}>
                          {d.filename ? <FileLink filename={d.filename} /> : '—'}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>
                          <Amount value={d.amount_minor / 100} currency={d.currency} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </Card>

        {/* Amazon Import */}
        <Card style={{ marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Amazon Bestellungen importieren</h3>
          <p style={{ color: '#666', fontSize: 13, margin: '0 0 12px' }}>
            Drei CSV-Berichte von Amazon hochladen. Alle werden über die Bestellnummer verknüpft.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
            <div>
              <label style={labelStyle}>Sendungen (Pflicht)</label>
              <input type="file" accept=".csv,.xlsx,.xls" onChange={e => setAmazonSendungen(e.target.files?.[0] ?? null)} style={{ fontSize: 13 }} />
            </div>
            <div>
              <label style={labelStyle}>Abgleich (Pflicht — enthält Zahldatum)</label>
              <input type="file" accept=".csv,.xlsx,.xls" onChange={e => setAmazonAbgleich(e.target.files?.[0] ?? null)} style={{ fontSize: 13 }} />
            </div>
            <div>
              <label style={labelStyle}>Erstattungen (optional)</label>
              <input type="file" accept=".csv,.xlsx,.xls" onChange={e => setAmazonErstattungen(e.target.files?.[0] ?? null)} style={{ fontSize: 13 }} />
            </div>
          </div>

          <button
            onClick={handleAmazonImport}
            disabled={amazonStatus === 'loading' || !amazonSendungen || !amazonAbgleich}
            style={{
              padding: '8px 20px', background: '#f39c12', color: '#fff',
              border: 'none', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              opacity: (amazonStatus === 'loading' || !amazonSendungen || !amazonAbgleich) ? 0.6 : 1,
            }}
          >
            {amazonStatus === 'loading' ? 'Importiere...' : 'Amazon Import starten'}
          </button>

          {amazonStatus === 'error' && (
            <div style={{ marginTop: 8, padding: 10, background: '#fdecea', color: '#c0392b', borderRadius: 4, fontSize: 13 }}>
              {amazonError}
            </div>
          )}

          {amazonResult && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', gap: 20, marginBottom: 12 }}>
                <StatBox label="Bestellungen" value={amazonResult.orders} />
                <StatBox label="Erstattungen" value={amazonResult.refunds} color={colors.orange} />
                <StatBox label="Neu" value={amazonResult.imported} color={colors.green} />
                <StatBox label="Aktualisiert" value={amazonResult.skipped} color={colors.darkGray} />
              </div>
              {amazonResult.auto_linked && amazonResult.auto_linked.matched > 0 && (
                <div style={{ marginBottom: 12, padding: 8, background: '#e8f5e9', borderRadius: 4, fontSize: 12 }}>
                  <b>{amazonResult.auto_linked.matched}</b> PDFs automatisch den Rechnungen zugeordnet
                  {amazonResult.auto_linked.unmatched > 0 && (
                    <span style={{ color: colors.orange }}> ({amazonResult.auto_linked.unmatched} nicht zugeordnet)</span>
                  )}
                </div>
              )}
              {amazonResult.debug && (
                <details open style={{ marginBottom: 12, fontSize: 11, color: '#888', border: '1px solid #ddd', borderRadius: 4, padding: 8 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Spalten-Erkennung (Debug)</summary>
                  <div style={{ marginTop: 6, padding: 8, background: '#f8f8f8', borderRadius: 4, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                    <div><b>Abgleich Spalten:</b> {amazonResult.debug.abgleich_columns?.join(', ') || '—'}</div>
                    <div><b>Transaktionstyp-Spalte:</b> {amazonResult.debug.abgleich_txn_type_col || 'NICHT GEFUNDEN'}</div>
                    <div><b>Transaktionstyp-Werte:</b> {amazonResult.debug.abgleich_txn_type_values?.join(', ') || '—'}</div>
                    <div><b>Erstattungen im Abgleich:</b> {amazonResult.debug.abgleich_refund_count}</div>
                    <div><b>Abgleich Zeilen gesamt:</b> {amazonResult.debug.abgleich_total_rows ?? '—'}</div>
                    <div><b>Orders gesamt:</b> {amazonResult.debug.orders_total ?? '—'} (davon Erstattungen: {amazonResult.debug.orders_refund_count ?? '—'})</div>
                    {amazonResult.debug.abgleich_samples && (
                      <div style={{ marginTop: 4 }}>
                        <b>Erste 5 Abgleich-Zeilen:</b>
                        {amazonResult.debug.abgleich_samples.map((s: any, i: number) => (
                          <div key={i} style={{ paddingLeft: 12 }}>
                            {s.order} | Typ: "{s.txnType}" | Betrag: {s.amount}
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ marginTop: 4 }}><b>Sendungen Spalten:</b> {amazonResult.debug.sendungen_columns?.join(', ') || '—'}</div>
                    <div><b>USt-Land-Spalte:</b> {amazonResult.debug.sendungen_vat_country_col || 'NICHT GEFUNDEN'}</div>
                    <div><b>Versand-MwSt-Spalte:</b> {amazonResult.debug.sendungen_shipping_vat_col || 'NICHT GEFUNDEN'}</div>
                  </div>
                </details>
              )}
              {amazonResult.documents?.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
                      <th style={thStyle}>Status</th>
                      <th style={thStyle}>Typ</th>
                      <th style={thStyle}>Datum</th>
                      <th style={thStyle}>Bestellnummer</th>
                      <th style={thStyle}>Artikel</th>
                      <th style={thStyle}>Land</th>
                      <th style={thStyle}>Ust.</th>
                      <th style={thStyle}>Steuer%</th>
                      <th style={thStyle}>Kat.</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Betrag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {amazonResult.documents.map((d: any, i: number) => (
                      <tr key={i} style={{
                        borderBottom: '1px solid #f0f0f0',
                        background: d.is_new ? '#f0fff0' : 'transparent',
                      }}>
                        <td style={tdStyle}>
                          {d.is_new
                            ? <Badge text="NEU" color={colors.green} />
                            : <Badge text="aktualisiert" color={colors.blue} />
                          }
                        </td>
                        <td style={tdStyle}>
                          <Badge text={d.is_refund ? 'Erstattung' : 'Bestellung'} color={d.is_refund ? colors.orange : colors.blue} />
                        </td>
                        <td style={tdStyle}>{formatDate(d.date)}</td>
                        <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 11 }}>{d.order_number}</td>
                        <td style={{ ...tdStyle, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}
                            title={d.title}>{d.title || `${d.items} Artikel`}</td>
                        <td style={{ ...tdStyle, fontSize: 11 }}>{d.vat_country || '—'}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontSize: 11 }}>
                          {d.shipping_vat ? <Amount value={d.is_refund ? d.shipping_vat : -d.shipping_vat} currency="EUR" /> : '—'}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 600 }}>
                          {d.vat_rate != null ? `${d.vat_rate}%` : '—'}
                        </td>
                        <td style={tdStyle}>
                          {d.tax_category ? <TaxCategoryBadge category={d.tax_category} /> : '—'}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>
                          <Amount value={d.is_refund ? d.amount : -d.amount} currency="EUR" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

        </Card>
      </>)}

      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
        {data.total} Ausgaben-Dokumente
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={() => { setEditMode(!editMode); setSelected(new Set()); }}
          style={{
            padding: '8px 14px', borderRadius: 6, border: editMode ? '2px solid #e74c3c' : '1px solid #ddd',
            background: editMode ? '#fce4ec' : '#fff', color: editMode ? '#e74c3c' : '#333',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {editMode ? 'Abbrechen' : 'Bearbeiten'}
        </button>
        {editMode && selected.size > 0 && (
          <button
            onClick={async () => {
              if (!confirm(`${selected.size} Rechnung(en) wirklich löschen?`)) return;
              setDeleting(true);
              try {
                await api.deleteDocuments([...selected]);
                setSelected(new Set());
                setEditMode(false);
                load();
              } catch (err: any) {
                alert('Fehler: ' + err.message);
              } finally {
                setDeleting(false);
              }
            }}
            disabled={deleting}
            style={{
              padding: '8px 14px', borderRadius: 6, border: 'none',
              background: '#e74c3c', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {deleting ? 'Wird gelöscht...' : `${selected.size} löschen`}
          </button>
        )}
        {editMode && data?.items?.length > 0 && (
          <button
            onClick={() => {
              if (selected.size === data.items.length) {
                setSelected(new Set());
              } else {
                setSelected(new Set(data.items.map((d: any) => d.document_id)));
              }
            }}
            style={{
              padding: '8px 14px', borderRadius: 6, border: '1px solid #ddd',
              background: '#fff', color: '#333', fontSize: 13, cursor: 'pointer',
            }}
          >
            {selected.size === data.items.length ? 'Keine auswählen' : 'Alle auswählen'}
          </button>
        )}
        <SearchInput value={search} onChange={setSearch} onSearch={doSearch} placeholder="Suche (Dateiname, Lieferant, Ref)..." />
        <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[
          { value: '', label: 'Alle' },
          { value: 'matched', label: 'Verknüpft' },
          { value: 'unmatched', label: 'Offen' },
        ]} />
        <Select value={source} onChange={(v) => { setSource(v); setPage(1); }} options={[
          { value: '', label: 'Alle Quellen' },
          { value: 'extracted_invoice', label: 'Extracted Invoice' },
          { value: 'invoice_file', label: 'Invoice File' },
          { value: 'invoice_scan', label: 'Belegerkennung' },
          { value: 'amazon', label: 'Amazon' },
          { value: 'stripe_fee', label: 'Stripe Gebühren' },
        ]} />
        <Tip text="Nur Rechnungen des Arbeitszeitraums anzeigen oder alle Jahre">
          <button onClick={() => { const v = !periodFilter; setPeriodFilter(v); localStorage.setItem('doc_periodFilter', String(v)); setPage(1); }}
            style={{
              padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600,
              background: periodFilter ? '#2c3e50' : '#ecf0f1', color: periodFilter ? '#fff' : '#333',
              border: periodFilter ? '1px solid #2c3e50' : '1px solid #ddd',
            }}>
            {periodFilter ? `${workingYear}${quarter ? ' Q' + quarter : ''}` : 'Alle Jahre'}
          </button>
        </Tip>
      </div>

      <Card>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
              {editMode && <th style={{ ...thStyle, width: 30 }} />}
              <SortTh field="document_date" label="Datum" current={sortField} order={sortOrder} onSort={(f, o) => { setSortField(f); setSortOrder(o); setPage(1); }} />
              <th style={thStyle}>Dokument</th>
              <th style={thStyle}>Lieferant</th>
              <th style={thStyle}>Quelle</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Netto</th>
              <SortTh field="total_amount_minor" label="Brutto" current={sortField} order={sortOrder} onSort={(f, o) => { setSortField(f); setSortOrder(o); setPage(1); }} align="right" />
              <th style={{ ...thStyle, textAlign: 'right' }}>FX</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Ust.</th>
              <th style={thStyle}>Steuer%</th>
              <th style={thStyle}>Kat.</th>
              <SortTh field="status" label="Status" current={sortField} order={sortOrder} onSort={(f, o) => { setSortField(f); setSortOrder(o); setPage(1); }} />
              <th style={thStyle}>Zahlung</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((d: any) => (
              <React.Fragment key={d.document_id}>
                <tr
                  ref={el => { rowRefs.current[d.document_id] = el; }}
                  style={{
                    borderBottom: '1px solid #f0f0f0', cursor: 'pointer',
                    background: highlightId === d.document_id ? '#fff9c4'
                      : selected.has(d.document_id) ? '#fff3e0'
                      : d.auto_match_tier === 'no_date' ? '#fde8e8'
                      : (dupSet.has(d.document_id) && !dismissedDups.has(d.document_id)) ? '#fff0f0'
                      : expanded === d.document_id ? '#f8f9fa' : 'transparent',
                    transition: 'background 0.5s',
                  }}
                  onClick={() => {
                    if (editMode) {
                      setSelected(prev => {
                        const next = new Set(prev);
                        next.has(d.document_id) ? next.delete(d.document_id) : next.add(d.document_id);
                        return next;
                      });
                    } else {
                      setExpanded(expanded === d.document_id ? null : d.document_id);
                    }
                  }}
                >
                  {editMode && (
                    <td style={{ ...tdStyle, width: 30 }}>
                      <input type="checkbox" checked={selected.has(d.document_id)} readOnly />
                    </td>
                  )}
                  <td style={tdStyle}>{formatDate(d.document_date)}</td>
                  <td style={tdStyle}>
                    {d.filename
                      ? <FileLink filename={d.filename} />
                      : <span style={{ color: '#999', fontSize: 12 }}>{d.source_document_ref?.slice(0, 40) || d.document_id.slice(0, 20)}</span>
                    }
                  </td>
                  <td style={tdStyle}>
                    <EditableCell docId={d.document_id} field="supplier_name" value={d.supplier_name || ''} type="text"
                      editingCell={editingCell} setEditingCell={setEditingCell} edits={edits} setField={setField} />
                  </td>
                  <td style={tdStyle}><SourceBadge source={d.source_system} /></td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <EditableCell docId={d.document_id} field="net_minor" value={d.total_amount_minor - (d.ust != null ? Math.round(d.ust * 100) : 0)} type="amount"
                      editingCell={editingCell} setEditingCell={setEditingCell} edits={edits} setField={setField} />
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <EditableCell docId={d.document_id} field="gross_minor" value={d.total_amount_minor} type="amount"
                      editingCell={editingCell} setEditingCell={setEditingCell} edits={edits} setField={setField} />
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12, color: '#888' }}>
                    {d.meta?.original_currency === 'USD' && d.meta?.original_amount_minor != null
                      ? `$${(Math.abs(d.meta.original_amount_minor) / 100).toFixed(2)}`
                      : d.currency_code === 'USD' && d.amount !== 0
                        ? `$${Math.abs(d.amount).toFixed(2)}`
                        : ''}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12 }}>
                    <EditableCell docId={d.document_id} field="vat_minor" value={d.ust != null ? Math.round(d.ust * 100) : 0} type="amount"
                      editingCell={editingCell} setEditingCell={setEditingCell} edits={edits} setField={setField} />
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center', fontSize: 12 }}>
                    <EditableCell docId={d.document_id} field="vat_rate" value={d.vat_rate ?? d.tax_rate ?? null} type="rate"
                      editingCell={editingCell} setEditingCell={setEditingCell} edits={edits} setField={setField} />
                  </td>
                  <td style={tdStyle}>
                    {d.tax_category ? <TaxCategoryBadge category={d.tax_category} /> : '—'}
                  </td>
                  <td style={tdStyle}>
                    {d.meta?.cash_payment
                      ? <Badge text="Bar" color={colors.green} />
                      : d.is_matched
                        ? d.auto_match_tier != null
                          ? d.auto_match_tier === 'no_date'
                            ? <Badge text="Auto Match" color={colors.red} />
                            : <Badge text={`Auto Match (${d.auto_match_tier}d)`} color={colors.blue} />
                          : <Badge text="Verknüpft" color={colors.green} />
                        : <Badge text="Offen" color={colors.orange} />
                    }
                  </td>
                  <td style={tdStyle}>
                    {d.linked_transactions?.length > 0
                      ? <span style={{ fontSize: 12 }}>
                          {d.linked_transactions.length} Zahlung(en)
                          {(() => {
                            const txns = d.linked_transactions;
                            if (txns.length === 1) {
                              const isFx = d.currency_code === 'USD' || d.meta?.original_currency === 'USD';
                              const mismatch = !isFx && txns[0].amount_minor != null && Math.abs(txns[0].amount_minor) !== Math.abs(d.total_amount_minor);
                              return mismatch ? <span title={`Beleg: ${(Math.abs(d.total_amount_minor)/100).toFixed(2)}€ ≠ Buchung: ${(Math.abs(txns[0].amount_minor)/100).toFixed(2)}€`}
                                style={{ color: '#e67e22', marginLeft: 4, cursor: 'help' }}>⚠</span> : null;
                            }
                            // Multi-txn: no individual mismatch warning (sum checked in detail view)
                            return null;
                          })()}
                        </span>
                      : <span style={{ color: '#999', fontSize: 12 }}>-</span>
                    }
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                    {dupSet.has(d.document_id) && !dismissedDups.has(d.document_id) && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 4 }}>
                        <Badge text="Duplikat" color={colors.red} />
                        <button onClick={async () => {
                          if (!confirm('Duplikat löschen?')) return;
                          await api.deleteDocuments([d.document_id]);
                          load();
                        }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: colors.red, fontSize: 14, padding: 2 }}
                          title="Löschen">✕</button>
                        <button onClick={() => setDismissedDups(prev => { const n = new Set(prev); n.add(d.document_id); return n; })}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', color: colors.green, fontSize: 14, padding: 2 }}
                          title="Kein Duplikat">✓</button>
                      </span>
                    )}
                    {edits[d.document_id] && Object.keys(edits[d.document_id]).length > 0 && (
                      <button onClick={(e) => { e.stopPropagation(); handleSave(d.document_id); }}
                        disabled={saving === d.document_id}
                        style={{
                          background: '#f39c12', color: '#fff', fontWeight: 700, border: 'none',
                          borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11,
                          marginRight: 4, opacity: saving === d.document_id ? 0.6 : 1,
                        }}>
                        {saving === d.document_id ? '...' : 'Übernehmen'}
                      </button>
                    )}
                    <RowMenu
                      doc={d}
                      isOpen={openMenu === d.document_id}
                      onToggle={() => setOpenMenu(openMenu === d.document_id ? null : d.document_id)}
                      onClose={() => setOpenMenu(null)}
                      onDelete={async (docId) => {
                        await api.deleteDocuments([docId]);
                        setOpenMenu(null);
                        load();
                      }}
                      onUnmatch={async (mgId) => {
                        await api.deleteMatch(mgId);
                        setOpenMenu(null);
                        load();
                      }}
                      onCashPayment={async (docId, active) => {
                        await api.updateDocumentVat(docId, { cash_payment: active, skip_propagation: true });
                        setOpenMenu(null);
                        load();
                      }}
                    />
                  </td>
                </tr>
                {expanded === d.document_id && (
                  <tr>
                    <td colSpan={10} style={{ padding: '12px 16px', background: '#f8f9fa' }}>
                      <DocDetail doc={d} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
        <Pagination page={data.page} pages={data.pages} onPage={setPage} />
      </Card>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: color ?? '#333' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#666' }}>{label}</div>
    </div>
  );
}

function DocDetail({ doc }: { doc: any }) {
  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
        <div><b>Dokument-ID:</b> <code style={{ fontSize: 11 }}>{doc.document_id}</code></div>
        <div><b>Quelle:</b> {doc.source_system}</div>
        <div><b>Referenz:</b> {doc.source_document_ref}</div>
      </div>

      {doc.filename && (
        <div style={{ marginBottom: 8 }}>
          <b>Datei:</b> <FileLink filename={doc.filename} />
        </div>
      )}

      {doc.vat_amount_minor != null && (
        <div style={{ marginBottom: 8 }}>
          <b>MwSt:</b> <Amount value={doc.vat_amount_minor / 100} currency={doc.currency_code} />
          {doc.vat_rate != null && <span> ({(doc.vat_rate * 100).toFixed(0)}%)</span>}
        </div>
      )}

      {doc.rule_id && (
        <div style={{ marginBottom: 8 }}>
          <b>Match-Regel:</b> <code style={{ fontSize: 11 }}>{doc.rule_id}</code>
        </div>
      )}

      {doc.linked_transactions?.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <b>Verknüpfte Zahlungen:</b>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {doc.linked_transactions.map((t: any) => {
              const isSingleMatch = doc.linked_transactions.length === 1;
              const isFx = doc.currency_code === 'USD' || doc.meta?.original_currency === 'USD';
              const mismatch = isSingleMatch && !isFx && t.amount_minor != null && Math.abs(t.amount_minor) !== Math.abs(doc.total_amount_minor);
              return (
                <div key={t.transaction_id} style={{
                  display: 'flex', gap: 16, alignItems: 'center', padding: '8px 12px',
                  background: mismatch ? '#fef9e7' : '#fff', borderRadius: 6,
                  border: mismatch ? '1px solid #f0c36d' : '1px solid #e0e0e0',
                }}>
                  <SourceBadge source={t.source_system} />
                  <span>{formatDate(t.posting_at)}</span>
                  <span style={{ flex: 1, color: '#555' }}>{t.description_raw?.slice(0, 60)}</span>
                  {t.counterparty_name && <span style={{ color: '#888' }}>{t.counterparty_name}</span>}
                  <Amount value={t.amount} currency={t.currency_code} />
                  {mismatch && (
                    <span style={{ color: '#e67e22', fontSize: 11, fontWeight: 600 }}
                      title={`Beleg: ${(Math.abs(doc.total_amount_minor)/100).toFixed(2)}€ ≠ Buchung: ${(Math.abs(t.amount_minor)/100).toFixed(2)}€`}>
                      ⚠ Betrag
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(!doc.linked_transactions || doc.linked_transactions.length === 0) && (
        <div style={{ marginTop: 8, color: '#999', fontStyle: 'italic' }}>
          Keine Zahlung verknüpft
        </div>
      )}

      {/* Stripe/PayPal fee breakdown from meta */}
      {doc.meta?.type === 'monthly_fee_summary' && doc.meta?.charge_count > 0 && (
        <div style={{ marginTop: 12 }}>
          <b>Gebührenaufschlüsselung ({doc.meta.charge_count} Transaktionen):</b>
          {doc.meta.charges?.length > 0 ? (
            <div style={{ marginTop: 6, maxHeight: 250, overflow: 'auto' }}>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid #ddd', color: '#888' }}>Datum</th>
                    <th style={{ textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid #ddd', color: '#888' }}>Beschreibung</th>
                    <th style={{ textAlign: 'right', padding: '3px 6px', borderBottom: '1px solid #ddd', color: '#888' }}>Umsatz</th>
                    <th style={{ textAlign: 'right', padding: '3px 6px', borderBottom: '1px solid #ddd', color: '#888' }}>Gebühr</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.meta.charges.map((c: any, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '3px 6px' }}>{formatDate(c.date)}</td>
                      <td style={{ padding: '3px 6px', color: '#555' }}>{c.description}</td>
                      <td style={{ padding: '3px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{(Math.abs(c.amount) / 100).toFixed(2)} €</td>
                      <td style={{ padding: '3px 6px', textAlign: 'right', fontFamily: 'monospace', color: colors.red }}>{(c.fee / 100).toFixed(2)} €</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '2px solid #ddd', fontWeight: 700 }}>
                    <td colSpan={3} style={{ padding: '3px 6px' }}>Gesamt</td>
                    <td style={{ padding: '3px 6px', textAlign: 'right', fontFamily: 'monospace', color: colors.red }}>
                      {(Math.abs(doc.total_amount_minor) / 100).toFixed(2)} €
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
              Detaillierte Aufschlüsselung nicht verfügbar. Bitte Stripe-Daten neu importieren.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TAX_CAT_COLORS: Record<string, { bg: string; fg: string }> = {
  AT:  { bg: '#e8f5e9', fg: '#2e7d32' },
  IGL: { bg: '#e3f2fd', fg: '#1565c0' },
  RC:  { bg: '#fff3e0', fg: '#e65100' },
};

function TaxCategoryBadge({ category }: { category: string }) {
  const c = TAX_CAT_COLORS[category] ?? { bg: '#f5f5f5', fg: '#666' };
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 3, fontSize: 11, fontWeight: 700,
      background: c.bg, color: c.fg,
    }}>
      {category}
    </span>
  );
}

const editInputStyle: React.CSSProperties = { padding: '2px 4px', fontSize: 12, borderRadius: 3, border: '1px solid #f39c12', outline: 'none', background: '#fffef5' };

function EditableCell({ docId, field, value, type, editingCell, setEditingCell, edits, setField }: {
  docId: string; field: string; value: any; type: 'text' | 'amount' | 'rate';
  editingCell: string | null; setEditingCell: (k: string | null) => void;
  edits: Record<string, Record<string, any>>; setField: (docId: string, field: string, value: any) => void;
}) {
  const key = `${docId}:${field}`;
  const isEditing = editingCell === key;
  const editedValue = edits[docId]?.[field];
  const changed = editedValue !== undefined;

  if (type === 'amount') {
    const minor = editedValue !== undefined ? editedValue : value;
    if (isEditing) {
      return (
        <input autoFocus
          defaultValue={(Math.abs(minor) / 100).toFixed(2).replace('.', ',')}
          onBlur={e => { const v = parseFloat(e.target.value.replace(',', '.')); if (!isNaN(v)) setField(docId, field, value < 0 ? -Math.round(v * 100) : Math.round(v * 100)); setEditingCell(null); }}
          onKeyDown={e => { if (e.key === 'Enter') { const v = parseFloat((e.target as HTMLInputElement).value.replace(',', '.')); if (!isNaN(v)) setField(docId, field, value < 0 ? -Math.round(v * 100) : Math.round(v * 100)); setEditingCell(null); } if (e.key === 'Escape') setEditingCell(null); }}
          style={{ ...editInputStyle, width: 80, textAlign: 'right' }} />
      );
    }
    const display = minor === 0 && !changed ? '—' : `${(Math.abs(minor) / 100).toFixed(2)} €`;
    return (
      <span onClick={e => { e.stopPropagation(); setEditingCell(key); }}
        style={{ cursor: 'pointer', padding: '1px 4px', borderRadius: 3, borderBottom: '1px dashed #ccc', background: changed ? '#fff3cd' : undefined,
          color: minor < 0 ? colors.red : minor > 0 ? colors.green : '#999' }}>
        {display}
      </span>
    );
  }

  if (type === 'rate') {
    const rate = editedValue !== undefined ? editedValue : value;
    if (isEditing) {
      return (
        <input autoFocus
          defaultValue={rate != null ? String(Math.round(rate)) : ''}
          onBlur={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setField(docId, field, v / 100); setEditingCell(null); }}
          onKeyDown={e => { if (e.key === 'Enter') { const v = parseInt((e.target as HTMLInputElement).value, 10); if (!isNaN(v)) setField(docId, field, v / 100); setEditingCell(null); } if (e.key === 'Escape') setEditingCell(null); }}
          style={{ ...editInputStyle, width: 44, textAlign: 'center' }} />
      );
    }
    const display = rate != null ? `${Math.round(rate)}%` : '—';
    return (
      <span onClick={e => { e.stopPropagation(); setEditingCell(key); }}
        style={{ cursor: 'pointer', padding: '1px 4px', borderRadius: 3, borderBottom: '1px dashed #ccc', background: changed ? '#fff3cd' : undefined, color: '#666' }}>
        {display}
      </span>
    );
  }

  // text
  const display = editedValue !== undefined ? editedValue : (value || '—');
  if (isEditing) {
    return (
      <input autoFocus value={display === '—' ? '' : display}
        onChange={e => setField(docId, field, e.target.value)}
        onBlur={() => setEditingCell(null)}
        onKeyDown={e => { if (e.key === 'Enter') setEditingCell(null); }}
        style={{ ...editInputStyle, width: 140 }} />
    );
  }
  return (
    <span onClick={e => { e.stopPropagation(); setEditingCell(key); }}
      style={{ cursor: 'pointer', padding: '1px 4px', borderRadius: 3, borderBottom: '1px dashed #ccc', background: changed ? '#fff3cd' : undefined }}>
      {display}
    </span>
  );
}

function RowMenu({ doc, isOpen, onToggle, onClose, onDelete, onUnmatch, onCashPayment }: {
  doc: any; isOpen: boolean; onToggle: () => void; onClose: () => void; onDelete: (docId: string) => void; onUnmatch: (mgId: string) => void; onCashPayment: (docId: string, active: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, onClose]);

  const menuItems: Array<{ label: string; href?: string; onClick?: () => void; color?: string }> = [];

  // "Gehe zu Buchung" — navigate to linked transaction
  if (doc.linked_transactions?.length > 0) {
    const t = doc.linked_transactions[0];
    menuItems.push({
      label: `Buchung (${t.source_system})`,
      href: `/?highlight=${encodeURIComponent(t.transaction_id)}&source=${encodeURIComponent(t.source_system)}`,
    });
  }

  // "Scan ansehen" — open in Belegerkennung list with scan highlighted
  if (doc.scan_id) {
    menuItems.push({
      label: 'Scan ansehen',
      href: `/belegerkennung?highlight=${encodeURIComponent(doc.scan_id)}`,
    });
  }

  // "Unmatch" — remove match group
  if (doc.is_matched && doc.match_group_id) {
    menuItems.push({
      label: 'Unmatch',
      color: colors.red,
      onClick: () => {
        if (!confirm('Verknüpfung wirklich aufheben?')) return;
        onUnmatch(doc.match_group_id);
      },
    });
  }

  // "Barzahlung" — toggle cash payment flag
  const isCash = doc.meta?.cash_payment;
  menuItems.push({
    label: isCash ? '✓ Barzahlung' : 'Barzahlung',
    color: isCash ? colors.green : undefined,
    onClick: () => { onCashPayment(doc.document_id, !isCash); },
  });

  // "Löschen"
  menuItems.push({
    label: 'Löschen',
    color: colors.red,
    onClick: () => {
      if (!confirm(`Rechnung "${doc.supplier_name || doc.filename || doc.document_id}" wirklich löschen?`)) return;
      onDelete(doc.document_id);
    },
  });

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={onToggle}
        style={{
          border: 'none', background: 'none', cursor: 'pointer',
          fontSize: 18, padding: '2px 6px', color: '#888', borderRadius: 4,
          lineHeight: 1,
        }}
        title="Optionen"
      >...</button>
      {isOpen && menuItems.length > 0 && (
        <div style={{
          position: 'absolute', right: 0, top: '100%', zIndex: 100,
          background: '#fff', border: '1px solid #ddd', borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.12)', minWidth: 160, padding: '4px 0',
        }}>
          {menuItems.map((item) => (
            <a
              key={item.label}
              href={item.href ?? '#'}
              onClick={item.onClick ? (e) => { e.preventDefault(); item.onClick!(); onClose(); } : undefined}
              style={{
                display: 'block', padding: '8px 14px', fontSize: 13,
                color: item.color ?? '#333', textDecoration: 'none', whiteSpace: 'nowrap',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f5')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {item.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4,
};
const thStyle: React.CSSProperties = {
  padding: '8px 12px', fontSize: 12, color: '#666', fontWeight: 600,
};
const tdStyle: React.CSSProperties = {
  padding: '8px 12px',
};

function SortTh({ field, label, current, order, onSort, align }: {
  field: string; label: string; current: string; order: 'asc' | 'desc';
  onSort: (field: string, order: 'asc' | 'desc') => void; align?: 'right';
}) {
  const active = current === field;
  const arrow = active ? (order === 'asc' ? ' \u25B2' : ' \u25BC') : '';
  return (
    <th
      style={{ ...thStyle, cursor: 'pointer', userSelect: 'none', textAlign: align ?? 'left', color: active ? '#333' : '#666' }}
      onClick={() => onSort(field, active && order === 'desc' ? 'asc' : 'desc')}
    >
      {label}{arrow}
    </th>
  );
}
