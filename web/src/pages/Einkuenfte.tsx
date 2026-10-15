import React, { useEffect, useState, useRef } from 'react';
import { api } from '../api';
import { Card, Pagination, SearchInput, Select, Amount, Badge, FileLink, SourceBadge, colors, formatDate, usePageSize, useWorkingYear } from '../components/shared';

type ImportStatus = 'idle' | 'loading' | 'success' | 'error';

export function Einkuenfte() {
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sortField, setSortField] = useState('document_date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const { pageSize } = usePageSize();
  const { workingYear, quarter } = useWorkingYear();

  // Import state
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus>('idle');
  const [importResult, setImportResult] = useState<any>(null);
  const [importError, setImportError] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [belegeInfo, setBelegeInfo] = useState<any>(null);
  const [summary, setSummary] = useState<any>(null);

  const load = () => {
    const params: Record<string, string> = { page: String(page), limit: String(pageSize), type: 'income', sort: sortField, order: sortOrder };
    if (search) params.search = search;
    if (status) params.status = status;
    params.year = String(workingYear);
    if (quarter) params.quarter = String(quarter);
    api.getDocuments(params).then(setData);
  };

  useEffect(() => { load(); }, [page, pageSize, status, sortField, sortOrder, search, workingYear, quarter]);
  useEffect(() => {
    api.getBelegeInfo().then(setBelegeInfo).catch(() => {});
    api.getSummary(workingYear, quarter).then(setSummary).catch(() => {});
  }, [importResult, workingYear, quarter]);

  const doSearch = () => { setPage(1); load(); };

  // EU-OSS
  const [ossData, setOssData] = useState<any>(null);
  const [ossYear, setOssYear] = useState(String(workingYear));
  const loadOss = () => { fetch(`/api/report/eu-oss?year=${ossYear}`).then(r => r.json()).then(setOssData).catch(() => {}); };
  useEffect(() => { loadOss(); }, [ossYear]);
  useEffect(() => { setOssYear(String(workingYear)); }, [workingYear]);

  // WC PDF upload
  const wcFileRef = useRef<HTMLInputElement>(null);
  const [wcDragging, setWcDragging] = useState(false);
  const [wcUploading, setWcUploading] = useState(false);
  const [wcResults, setWcResults] = useState<any[] | null>(null);

  const handleWcUpload = async (files: File[]) => {
    const pdfs = files.filter(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    if (pdfs.length === 0) return;
    setWcUploading(true);
    setWcResults(null);
    try {
      const form = new FormData();
      for (const f of pdfs) form.append('files', f);
      const res = await fetch('/api/income/upload-wc', { method: 'POST', body: form });
      const data = await res.json();
      setWcResults(data.results || []);
      load();
    } catch (e: any) {
      setWcResults([{ error: e.message }]);
    } finally {
      setWcUploading(false);
    }
  };

  const handleImport = async () => {
    if (!importFile) return;
    setImportStatus('loading');
    setImportError('');
    setImportResult(null);
    try {
      const res = await api.importDocuments(importFile, 'income');
      setImportResult(res);
      setImportStatus('success');
      load(); // refresh list
    } catch (err: any) {
      setImportError(err.message);
      setImportStatus('error');
    }
  };

  if (!data) return <p>Loading...</p>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Einkünfte (Einnahmen)</h1>
        {(() => {
          const inc = summary?.documents?.by_source?.income;
          if (!inc || inc.total === 0) return null;
          const pct = Math.round(inc.matched / inc.total * 100);
          return (
            <span style={{
              fontSize: 14, fontWeight: 700, padding: '4px 12px', borderRadius: 12,
              background: pct > 80 ? '#e8f5e9' : pct > 50 ? '#fff8e1' : '#fce4ec',
              color: pct > 80 ? '#27ae60' : pct > 50 ? '#f39c12' : '#e74c3c',
            }}>
              {pct}% gematcht ({inc.matched}/{inc.total})
            </span>
          );
        })()}
        <button
          onClick={() => setShowImport(!showImport)}
          style={{
            padding: '6px 14px', background: showImport ? '#eee' : '#27ae60', color: showImport ? '#333' : '#fff',
            border: 'none', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {showImport ? 'Import ausblenden' : 'Import'}
        </button>
        {belegeInfo?.years && Object.keys(belegeInfo.years).sort().reverse().map(year => (
          <button
            key={year}
            onClick={() => api.openBelegeFolder('einkuenfte', year)}
            style={{
              padding: '6px 14px', background: '#f0f0f0', color: '#333',
              border: '1px solid #ddd', borderRadius: 4, fontSize: 13, cursor: 'pointer',
            }}
          >
            {year} ({belegeInfo.years[year].einkuenfte} Dateien)
          </button>
        ))}
      </div>

      {/* WooCommerce PDF Upload */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div
            onDragOver={e => { e.preventDefault(); setWcDragging(true); }}
            onDragLeave={() => setWcDragging(false)}
            onDrop={e => { e.preventDefault(); setWcDragging(false); handleWcUpload(Array.from(e.dataTransfer.files)); }}
            onClick={() => wcFileRef.current?.click()}
            style={{
              padding: 16, borderRadius: 8, textAlign: 'center', cursor: wcUploading ? 'wait' : 'pointer',
              border: wcDragging ? '2px solid #27ae60' : '2px dashed #ccc',
              background: wcDragging ? '#e8f5e9' : wcUploading ? '#f0f0f0' : '#fff',
              minWidth: 200, minHeight: 60, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <input ref={wcFileRef} type="file" multiple accept=".pdf" style={{ display: 'none' }}
              onChange={e => { if (e.target.files) handleWcUpload(Array.from(e.target.files)); e.target.value = ''; }} />
            {wcUploading ? (
              <span style={{ color: '#888', fontSize: 12 }}>Wird verarbeitet...</span>
            ) : (
              <>
                <span style={{ fontSize: 18, marginBottom: 4 }}>+</span>
                <span style={{ color: '#888', fontSize: 11, lineHeight: 1.3 }}>WooCommerce Rechnungen<br/>hierher ziehen oder klicken</span>
              </>
            )}
          </div>
          {wcResults && wcResults.length > 0 && (
            <div style={{ flex: 1, fontSize: 12 }}>
              {wcResults.map((r: any, i: number) => (
                <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
                  {r.error ? (
                    <span style={{ color: colors.red }}>{r.filename}: {r.error}</span>
                  ) : (
                    <span style={{ color: colors.green }}>
                      {r.isRefund ? 'Gutschrift' : 'Rechnung'} {r.ref} — {r.customer} — {Math.abs(r.gross).toFixed(2)}€
                      {r.vatRate > 0 && ` (${r.vatRate}% USt: ${Math.abs(r.vat).toFixed(2)}€)`}
                      {r.country && ` [${r.country}]`}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {showImport && (
        <Card style={{ marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Einkünfte importieren (XLS / CSV)</h3>
          <p style={{ color: '#666', fontSize: 13, margin: '0 0 12px' }}>
            Importiert Einnahmen-Dokumente aus einer Excel- oder CSV-Datei.
            Erwartet die Spalten: Belegnummer, Rechnungsdatum, Brutto, Netto, Steuer, First/Last Name, etc.
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
                padding: '8px 20px', background: '#27ae60', color: '#fff',
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
                      <th style={thStyle}>Belegnr.</th>
                      <th style={thStyle}>Kunde</th>
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
      )}

      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
        {data.total} Einnahmen-Dokumente
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <SearchInput value={search} onChange={setSearch} onSearch={doSearch} placeholder="Suche (Dateiname, Kunde, Ref)..." />
        <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[
          { value: '', label: 'Alle' },
          { value: 'matched', label: 'Verknüpft' },
          { value: 'unmatched', label: 'Offen' },
        ]} />
      </div>

      <Card>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
              <SortHeader field="document_date" label="Datum" current={sortField} order={sortOrder} onSort={(f, o) => { setSortField(f); setSortOrder(o); setPage(1); }} />
              <th style={thStyle}>Dokument</th>
              <th style={thStyle}>Order</th>
              <SortHeader field="supplier_name" label="Kunde / Ref" current={sortField} order={sortOrder} onSort={(f, o) => { setSortField(f); setSortOrder(o); setPage(1); }} />
              <th style={thStyle}>Land</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Netto</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>USt</th>
              <SortHeader field="total_amount_minor" label="Brutto" current={sortField} order={sortOrder} onSort={(f, o) => { setSortField(f); setSortOrder(o); setPage(1); }} align="right" />
              <th style={{ ...thStyle, textAlign: 'center' }}>USt%</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Zahlung</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((d: any) => (
              <React.Fragment key={d.document_id}>
                <tr
                  style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer', background: expanded === d.document_id ? '#f8f9fa' : 'transparent' }}
                  onClick={() => setExpanded(expanded === d.document_id ? null : d.document_id)}
                >
                  <td style={tdStyle}>{formatDate(d.document_date)}</td>
                  <td style={tdStyle}>
                    {d.filename
                      ? <FileLink filename={d.filename}>{d.source_document_ref || d.filename}</FileLink>
                      : <span style={{ color: '#999', fontSize: 12 }}>{d.source_document_ref || d.document_id.slice(0, 20)}</span>
                    }
                  </td>
                  <td style={{ ...tdStyle, fontSize: 12, fontFamily: 'monospace', color: '#666' }}>{d.meta?.order_id ?? '-'}</td>
                  <td style={tdStyle}>{d.supplier_name || d.source_document_ref || '-'}</td>
                  <td style={{ ...tdStyle, fontSize: 12, color: '#666' }}>{d.meta?.land ?? d.vat_country ?? '—'}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>
                    {(() => {
                      const vat = d.vat_amount_minor ?? (d.ust != null ? Math.round(d.ust * 100) : 0);
                      const net = d.total_amount_minor - vat;
                      return <span style={{ color: net >= 0 ? colors.green : colors.red }}>{(net / 100).toFixed(2)} €</span>;
                    })()}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: '#888' }}>
                    {(() => {
                      const vat = d.vat_amount_minor ?? (d.ust != null ? Math.round(d.ust * 100) : 0);
                      return vat !== 0 ? `${(Math.abs(vat) / 100).toFixed(2)} €` : '—';
                    })()}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <Amount value={d.amount} currency={d.currency_code} />
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center', fontSize: 12, color: '#666' }}>
                    {d.vat_rate != null ? `${Math.round(d.vat_rate * 100)}%` : d.tax_rate != null ? `${d.tax_rate}%` : '—'}
                  </td>
                  <td style={tdStyle}>
                    {d.is_matched
                      ? <Badge text="Verknüpft" color={colors.green} />
                      : <Badge text="Offen" color={colors.orange} />
                    }
                  </td>
                  <td style={tdStyle}>
                    {d.linked_transactions?.length > 0
                      ? <div style={{ fontSize: 11 }}>
                          {d.linked_transactions.map((t: any, j: number) => (
                            <a key={j}
                              href={`/?highlight=${encodeURIComponent(t.transaction_id)}&source=${encodeURIComponent(t.source_system)}`}
                              style={{ display: 'block', whiteSpace: 'nowrap', textDecoration: 'none', color: 'inherit', borderBottom: '1px dashed #2980b9', marginBottom: 2 }}
                              onClick={e => e.stopPropagation()}>
                              <span style={{ color: '#999' }}>{formatDate(t.posting_at)}</span>
                              {' '}
                              <span style={{ fontWeight: 600, color: colors.blue }}>{t.source_system}</span>
                              {' '}
                              <span style={{ fontFamily: 'monospace', color: t.amount_minor < 0 ? colors.red : colors.green }}>
                                {(Math.abs(t.amount_minor) / 100).toFixed(2)} €
                              </span>
                            </a>
                          ))}
                        </div>
                      : <span style={{ color: '#999', fontSize: 12 }}>-</span>
                    }
                  </td>
                </tr>
                {expanded === d.document_id && (
                  <tr>
                    <td colSpan={11} style={{ padding: '12px 16px', background: '#f8f9fa' }}>
                      <DocDetail doc={d} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            <tr style={{ borderTop: '2px solid #ddd', background: '#f8f9fa' }}>
              <td colSpan={5} style={{ ...tdStyle, fontWeight: 700 }}>Summe (Seite {data.page}/{data.pages})</td>
              {(() => {
                const items = data.items;
                const grossSum = items.reduce((s: number, d: any) => s + d.total_amount_minor, 0);
                const vatSum = items.reduce((s: number, d: any) => s + (d.vat_amount_minor ?? (d.ust != null ? Math.round(d.ust * 100) : 0)), 0);
                const netSum = grossSum - vatSum;
                return <>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>
                    <span style={{ color: netSum >= 0 ? colors.green : colors.red }}>{(netSum / 100).toFixed(2)} €</span>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: '#888' }}>
                    {(Math.abs(vatSum) / 100).toFixed(2)} €
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>
                    <span style={{ color: grossSum >= 0 ? colors.green : colors.red }}>{(grossSum / 100).toFixed(2)} €</span>
                  </td>
                </>;
              })()}
              <td colSpan={3}></td>
            </tr>
          </tbody>
        </table>
        <Pagination page={data.page} pages={data.pages} onPage={setPage} />
      </Card>

      {/* EU-OSS Section */}
      <Card style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>EU-OSS — EU One Stop Shop</h2>
          <div style={{ display: 'flex', gap: 6 }}>
            {[new Date().getFullYear(), new Date().getFullYear() - 1].map(y => (
              <button key={y} onClick={() => setOssYear(String(y))}
                style={{
                  padding: '4px 10px', borderRadius: 4, border: '1px solid #ddd', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  background: ossYear === String(y) ? '#2c3e50' : '#ecf0f1', color: ossYear === String(y) ? '#fff' : '#333',
                }}>
                {y}
              </button>
            ))}
          </div>
        </div>
        {ossData?.quarters && (() => {
          const quarters = ossData.quarters;
          const allCountries = [...new Set(Object.values(quarters).flatMap((q: any) => Object.keys(q)))].sort() as string[];
          if (allCountries.length === 0) return <div style={{ color: '#999', fontSize: 13 }}>Keine EU-OSS Daten für {ossYear}</div>;

          return (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #ddd' }}>
                    <th style={{ ...thStyle, textAlign: 'left' }}>Land</th>
                    {['Q1', 'Q2', 'Q3', 'Q4'].map(q => (
                      <React.Fragment key={q}>
                        <th style={{ ...thStyle, textAlign: 'right', borderLeft: '1px solid #eee' }} colSpan={2}>{q} {ossYear}</th>
                      </React.Fragment>
                    ))}
                    <th style={{ ...thStyle, textAlign: 'right', borderLeft: '2px solid #ddd' }} colSpan={2}>Gesamt</th>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #eee' }}>
                    <th style={thStyle}></th>
                    {['Q1', 'Q2', 'Q3', 'Q4'].map(q => (
                      <React.Fragment key={q}>
                        <th style={{ ...thStyle, textAlign: 'right', fontSize: 10, color: '#999', borderLeft: '1px solid #eee' }}>Netto</th>
                        <th style={{ ...thStyle, textAlign: 'right', fontSize: 10, color: '#999' }}>USt</th>
                      </React.Fragment>
                    ))}
                    <th style={{ ...thStyle, textAlign: 'right', fontSize: 10, color: '#999', borderLeft: '2px solid #ddd' }}>Netto</th>
                    <th style={{ ...thStyle, textAlign: 'right', fontSize: 10, color: '#999' }}>USt</th>
                  </tr>
                </thead>
                <tbody>
                  {allCountries.map(country => {
                    let totalNet = 0, totalVat = 0;
                    return (
                      <tr key={country} style={{ borderBottom: '1px solid #f0f0f0' }}>
                        <td style={{ ...tdStyle, fontWeight: 600 }}>{country}</td>
                        {['Q1', 'Q2', 'Q3', 'Q4'].map(q => {
                          const d = quarters[q]?.[country];
                          if (d) { totalNet += d.net; totalVat += d.vat; }
                          return (
                            <React.Fragment key={q}>
                              <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', borderLeft: '1px solid #eee' }}>
                                {d ? (d.net / 100).toFixed(2) : '—'}
                              </td>
                              <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: colors.red }}>
                                {d ? (d.vat / 100).toFixed(2) : '—'}
                              </td>
                            </React.Fragment>
                          );
                        })}
                        <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, borderLeft: '2px solid #ddd' }}>
                          {(totalNet / 100).toFixed(2)}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: colors.red }}>
                          {(totalVat / 100).toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                  <tr style={{ borderTop: '2px solid #ddd', fontWeight: 700 }}>
                    <td style={tdStyle}>Gesamt</td>
                    {['Q1', 'Q2', 'Q3', 'Q4'].map(q => {
                      const qData = quarters[q] ?? {};
                      const qNet = Object.values(qData).reduce((s: number, d: any) => s + d.net, 0);
                      const qVat = Object.values(qData).reduce((s: number, d: any) => s + d.vat, 0);
                      return (
                        <React.Fragment key={q}>
                          <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', borderLeft: '1px solid #eee' }}>
                            {(qNet / 100).toFixed(2)}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: colors.red }}>
                            {(qVat / 100).toFixed(2)}
                          </td>
                        </React.Fragment>
                      );
                    })}
                    {(() => {
                      let gNet = 0, gVat = 0;
                      for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
                        for (const d of Object.values(quarters[q] ?? {}) as any[]) { gNet += d.net; gVat += d.vat; }
                      }
                      return <>
                        <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', borderLeft: '2px solid #ddd' }}>{(gNet / 100).toFixed(2)}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: colors.red }}>{(gVat / 100).toFixed(2)}</td>
                      </>;
                    })()}
                  </tr>
                </tbody>
              </table>
            </div>
          );
        })()}
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

      {doc.rule_id && (
        <div style={{ marginBottom: 8 }}>
          <b>Match-Regel:</b> <code style={{ fontSize: 11 }}>{doc.rule_id}</code>
        </div>
      )}

      {doc.linked_transactions?.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <b>Verknüpfte Zahlungen:</b>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {doc.linked_transactions.map((t: any) => (
              <div key={t.transaction_id} style={{
                display: 'flex', gap: 16, alignItems: 'center', padding: '8px 12px',
                background: '#fff', borderRadius: 6, border: '1px solid #e0e0e0',
              }}>
                <SourceBadge source={t.source_system} />
                <span>{formatDate(t.posting_at)}</span>
                <span style={{ flex: 1, color: '#555' }}>{t.description_raw?.slice(0, 60)}</span>
                {t.counterparty_name && <span style={{ color: '#888' }}>{t.counterparty_name}</span>}
                <Amount value={t.amount} currency={t.currency_code} />
              </div>
            ))}
          </div>
        </div>
      )}

      {(!doc.linked_transactions || doc.linked_transactions.length === 0) && (
        <div style={{ marginTop: 8, color: '#999', fontStyle: 'italic' }}>
          Keine Zahlung verknüpft
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '8px 12px', fontSize: 12, color: '#666', fontWeight: 600,
};
const tdStyle: React.CSSProperties = {
  padding: '8px 12px',
};

function SortHeader({ field, label, current, order, onSort, align }: {
  field: string; label: string; current: string; order: 'asc' | 'desc';
  onSort: (field: string, order: 'asc' | 'desc') => void; align?: string;
}) {
  const active = current === field;
  return (
    <th style={{ ...thStyle, textAlign: (align as any) ?? 'left', cursor: 'pointer', userSelect: 'none' }}
      onClick={() => onSort(field, active && order === 'desc' ? 'asc' : 'desc')}>
      {label} {active ? (order === 'desc' ? '▼' : '▲') : ''}
    </th>
  );
}
