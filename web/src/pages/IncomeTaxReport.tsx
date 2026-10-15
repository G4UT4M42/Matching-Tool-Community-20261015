import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Button, colors, FileLink, Tip, CopyValue, useWorkingYear, workingPeriodDates } from '../components/shared';

interface TaxLine {
  document_id: string;
  document_date: string;
  supplier_name: string | null;
  net_minor: number;
  vat_minor: number;
  gross_minor: number;
  filename: string | null;
  source_system: string;
  needs_receipt: boolean;
  description: string | null;
  details: { category: string; lines: string[] } | null;
  linked_transactions: any[];
  issue_accepted: { issue: string; reason: string; date: string } | null;
}

interface TaxCategory {
  kz: string;
  title: string;
  total_net_minor: number;
  lines: TaxLine[];
}

export function IncomeTaxReport() {
  const { workingYear, quarter } = useWorkingYear();
  const currentYear = new Date().getFullYear();
  const [start, setStart] = useState(() => sessionStorage.getItem('incomeTax_start') || `${currentYear}-01-01`);
  const [end, setEnd] = useState(() => sessionStorage.getItem('incomeTax_end') || `${currentYear}-12-31`);
  const [report, setReport] = useState<any>(() => {
    const saved = sessionStorage.getItem('incomeTax_data');
    return saved ? JSON.parse(saved) : null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const dates = workingPeriodDates(workingYear, quarter);
    setStart(dates.start);
    setEnd(dates.end);
    setReport(null);
    sessionStorage.removeItem('incomeTax_data');
  }, [workingYear, quarter]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.getIncomeTaxReport(start, end);
      setReport(r);
      sessionStorage.setItem('incomeTax_data', JSON.stringify(r));
      sessionStorage.setItem('incomeTax_start', start);
      sessionStorage.setItem('incomeTax_end', end);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Einkommensteuer-Bericht (E1a)</h1>

      {/* Period selector */}
      <Card style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={labelStyle}>Von:</label>
          <input type="date" value={start} onChange={e => setStart(e.target.value)} style={inputStyle} />
          <label style={labelStyle}>Bis:</label>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={inputStyle} />
          <Tip text="Einkommensteuer-Bericht (E1a) für den gewählten Zeitraum generieren">
            <Button onClick={load} disabled={loading} color="#2c3e50">
              {loading ? 'Wird erstellt...' : 'Bericht erstellen'}
            </Button>
          </Tip>
          {report && (
            <Tip text="Bericht als PDF speichern">
              <Button onClick={() => {
                window.open(`/api/report/income-tax/pdf?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, '_blank');
              }} color="#8e44ad">
                Bericht festschreiben (PDF)
              </Button>
            </Tip>
          )}
          {[currentYear, currentYear - 1, currentYear - 2].map(y => (
            <button key={y} onClick={() => { setStart(`${y}-01-01`); setEnd(`${y}-12-31`); }}
              style={{ ...btnSmall, background: start === `${y}-01-01` && end === `${y}-12-31` ? '#2c3e50' : '#ecf0f1', color: start === `${y}-01-01` && end === `${y}-12-31` ? '#fff' : '#333' }}>
              {y}
            </button>
          ))}
        </div>
      </Card>

      {error && <div style={{ color: colors.red, marginBottom: 16 }}>{error}</div>}

      {report && (
        <div style={{ marginBottom: 16 }}>
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Suche (Lieferant, Datei, Betrag)..."
            style={{ ...inputStyle, width: 350 }}
          />
          {search && <button onClick={() => setSearch('')} style={{ ...btnSmall, marginLeft: 8 }}>Zurücksetzen</button>}
        </div>
      )}

      {report && (
        <>
          {/* ============= SUMMARY ============= */}
          <Card style={{ marginBottom: 20, background: '#f8f9fa' }}>
            <div style={{ display: 'flex', gap: 48, fontSize: 14 }}>
              <div>
                <div style={{ color: '#666', fontSize: 12 }}>Betriebseinnahmen</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: colors.green }}>{fmtEur(report.revenue_total_net_minor)}</div>
              </div>
              <div>
                <div style={{ color: '#666', fontSize: 12 }}>Betriebsausgaben</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: colors.red }}>{fmtEur(report.expenses_total_net_minor)}</div>
              </div>
              <div>
                <div style={{ color: '#666', fontSize: 12 }}>Gewinn / Verlust</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: report.profit_minor >= 0 ? colors.green : colors.red }}>
                  {report.profit_minor >= 0 ? '+' : '-'}{fmtEur(Math.abs(report.profit_minor))}
                  {report.profit_minor < 0 && ' (Verlust)'}
                </div>
              </div>
              <div>
                <div style={{ color: '#666', fontSize: 12 }}>Dokumente</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{report.total_documents_processed}</div>
              </div>
            </div>
          </Card>

          {/* ============= ISSUE CHECKLIST ============= */}
          {(() => {
            const allLines: TaxLine[] = [...report.revenue_lines, ...report.categories.flatMap((c: TaxCategory) => c.lines), ...report.unclassified];
            const missingReceipt = allLines.filter(l => l.needs_receipt && !l.issue_accepted);
            const amountMismatch = allLines.filter(l => {
              if (!l.linked_transactions?.length) return false;
              // Skip fee summaries (1 doc → many txns) and combo matches (1 txn → many docs)
              if (l.source_system === 'stripe_fee') return false;
              if (l.linked_transactions.length > 1) return false;
              return l.linked_transactions.some((t: any) => !(t.doc_count > 1) && Math.abs(t.amount_minor) !== Math.abs(l.gross_minor) && l.gross_minor !== 0);
            });
            const issues = [...missingReceipt.map(l => ({ ...l, issue: 'receipt' as const })), ...amountMismatch.filter(l => !l.needs_receipt && !l.issue_accepted).map(l => ({ ...l, issue: 'mismatch' as const }))];
            if (issues.length === 0) return null;
            return (
              <Card style={{ marginBottom: 20, border: '1px solid #e6a0a0', background: '#fef8f8' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <h3 style={{ margin: 0, fontSize: 15, color: '#c0392b' }}>
                    Prüfliste ({issues.length} {issues.length === 1 ? 'Problem' : 'Probleme'})
                  </h3>
                  <div style={{ fontSize: 12, color: '#888' }}>
                    {missingReceipt.length > 0 && <span style={{ marginRight: 12 }}>🔴 {missingReceipt.length} Belege fehlen</span>}
                    {amountMismatch.filter(l => !l.needs_receipt).length > 0 && <span>⚠ {amountMismatch.filter(l => !l.needs_receipt).length} Beträge abweichend</span>}
                  </div>
                </div>
                <div style={{ maxHeight: 300, overflow: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...thStyle, width: 60 }}>Problem</th>
                        <th style={thStyle}>Datum</th>
                        <th style={thStyle}>Lieferant</th>
                        <th style={thStyle}>Beleg</th>
                        <th style={thStyle}>Buchung</th>
                        <th style={thStyle}>Datei</th>
                        <th style={thStyle}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {issues.map((l, i) => {
                        const txn = l.linked_transactions?.[0];
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid #f0e0e0', background: l.issue === 'receipt' ? '#fef0f0' : '#fef9e7' }}>
                            <td style={tdStyle}>
                              {l.issue === 'receipt'
                                ? <span style={{ color: '#c0392b', fontWeight: 600, fontSize: 11 }}>Beleg fehlt</span>
                                : <span style={{ color: '#e67e22', fontWeight: 600, fontSize: 11 }}>⚠ Betrag</span>
                              }
                            </td>
                            <td style={tdStyle}>{fmtDate(l.document_date)}</td>
                            <td style={tdStyle}>{l.supplier_name ?? '—'}</td>
                            <td style={{ ...tdStyle, fontFamily: 'monospace' }}>
                              <a href={`/rechnungen?highlight=${encodeURIComponent(l.document_id)}`}
                                style={{ color: colors.blue, textDecoration: 'none', borderBottom: '1px dashed #2980b9' }}>
                                {fmtEur(Math.abs(l.gross_minor))}
                              </a>
                            </td>
                            <td style={{ ...tdStyle, fontFamily: 'monospace' }}>
                              {txn ? (
                                <a href={`/?highlight=${encodeURIComponent(txn.transaction_id)}&source=${encodeURIComponent(txn.source_system)}`}
                                  style={{ color: colors.blue, textDecoration: 'none', borderBottom: '1px dashed #2980b9' }}>
                                  {fmtEur(Math.abs(txn.amount_minor))}
                                </a>
                              ) : '—'}
                            </td>
                            <td style={tdStyle}>
                              {l.needs_receipt
                                ? <ReceiptUpload docId={l.document_id} onDone={load} />
                                : <FileLink filename={l.filename} />
                              }
                            </td>
                            <td style={tdStyle}>
                              <AcceptIssueButton docId={l.document_id} issue={l.issue} onDone={load} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })()}

          {/* ============= REVENUE ============= */}
          <CollapsibleCard kz="9040" title="Betriebseinnahmen (Umsätze)" total={report.revenue_total_net_minor} lines={report.revenue_lines} color={colors.green} search={search} />

          {/* ============= EXPENSE CATEGORIES ============= */}
          <h2 style={h2Style}>Betriebsausgaben</h2>

          {report.categories.map((cat: TaxCategory) => (
            <CollapsibleCard key={cat.kz} kz={cat.kz} title={cat.title} total={cat.total_net_minor} lines={cat.lines}
              showKzTags={cat.kz === '9230'} onReload={load} search={search} />
          ))}

          {/* Unclassified */}
          {report.unclassified.length > 0 && (
            <CollapsibleCard kz="—" title={`Nicht zugeordnet (${report.unclassified.length})`} total={
              report.unclassified.reduce((s: number, l: TaxLine) => s + Math.abs(l.net_minor), 0)
            } lines={report.unclassified} color={colors.red} showKzTags onReload={load} search={search} />
          )}

          {/* ============= RECONCILIATION ============= */}
          <h2 style={h2Style}>Zusammenfassung</h2>
          <Card style={{ marginBottom: 16 }}>
            <table style={{ fontSize: 13, borderCollapse: 'collapse' }}>
              <tbody>
                <tr>
                  <td style={tdR}>9040 Betriebseinnahmen:</td>
                  <td style={{ ...tdV, color: colors.green }}>{fmtEur(report.revenue_total_net_minor)}</td>
                </tr>
                {report.categories.map((cat: TaxCategory) => (
                  <tr key={cat.kz}>
                    <td style={tdR}>{cat.kz} {cat.title}:</td>
                    <td style={tdV}>{fmtEur(cat.total_net_minor)}</td>
                  </tr>
                ))}
                {report.unclassified.length > 0 && (
                  <tr>
                    <td style={{ ...tdR, color: colors.red }}>Nicht zugeordnet:</td>
                    <td style={{ ...tdV, color: colors.red }}>
                      {fmtEur(report.unclassified.reduce((s: number, l: TaxLine) => s + Math.abs(l.net_minor), 0))}
                      {' '}({report.unclassified.length})
                    </td>
                  </tr>
                )}
                <tr style={{ borderTop: '2px solid #ddd' }}>
                  <td style={{ ...tdR, fontWeight: 700 }}>Summe Ausgaben:</td>
                  <td style={{ ...tdV, fontWeight: 700 }}>{fmtEur(report.expenses_total_net_minor)}</td>
                </tr>
                <tr>
                  <td style={{ ...tdR, fontWeight: 700 }}>Gewinn:</td>
                  <td style={{ ...tdV, fontWeight: 700, color: report.profit_minor >= 0 ? colors.green : colors.red }}>
                    {report.profit_minor >= 0 ? '+' : '-'}{fmtEur(Math.abs(report.profit_minor))}
                  </td>
                </tr>
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CollapsibleCard({ kz, title, total, lines, color, showKzTags, onReload, search }: {
  kz: string; title: string; total: number; lines: TaxLine[]; color?: string;
  showKzTags?: boolean; onReload?: () => void; search?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ background: '#2c3e50', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>
              {kz}
            </span>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
            <span style={{ color: '#999', fontSize: 12 }}>({lines.length})</span>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexShrink: 0 }}>
            <CopyValue minor={total} style={{ fontSize: 16, color: color ?? '#333' }} />
            <span style={{ color: '#999' }}>{open ? '\u25B2' : '\u25BC'}</span>
          </div>
        </div>
      </div>
      {open && lines.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <DetailTable lines={lines} showKzTags={showKzTags} onReload={onReload} currentKz={showKzTags ? undefined : kz} search={search} />
        </div>
      )}
    </Card>
  );
}

const KZ_OPTIONS = [
  { kz: '9100', label: 'Waren' },
  { kz: '9110', label: 'Personal' },
  { kz: '9130', label: 'AfA' },
  { kz: '9180', label: 'Miete' },
  { kz: '9190', label: 'Lizenzen' },
  { kz: '9225', label: 'SVA' },
  { kz: '9230', label: 'Sonstige' },
  { kz: '9275', label: 'Arbeitszimmer' },
];

function KzTagRow({ line, onReload }: { line: TaxLine; onReload?: () => void }) {
  const [saving, setSaving] = useState(false);

  const handleAssign = async (kz: string) => {
    const vendor = line.supplier_name ?? '';
    if (!vendor) return;

    const allVendor = confirm(
      `Kategorie ${kz} zuweisen.\n\nFür ALLE Rechnungen von "${vendor}"?\n\n` +
      `• OK = Alle (Vendor-Einstellung)\n• Abbrechen = Nur diese Rechnung`
    );

    setSaving(true);
    try {
      if (allVendor) {
        // Update vendor override with tax_category_kz
        await api.updateVendor(vendor, { tax_category_kz: kz });
      } else {
        // Update only this document's meta
        await api.updateDocumentVat(line.document_id, { tax_category_kz: kz });
      }
      onReload?.();
    } catch (e: any) {
      alert('Fehler: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  if (saving) return <span style={{ fontSize: 10, color: '#888' }}>...</span>;

  return (
    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
      {KZ_OPTIONS.map(o => (
        <Tip key={o.kz} text={`KZ ${o.kz}: Dieser Kategorie zuweisen`}>
          <button onClick={() => handleAssign(o.kz)}
            style={{
              padding: '1px 6px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
              background: '#ecf0f1', color: '#2c3e50', border: '1px solid #bdc3c7',
              fontWeight: 500, lineHeight: '16px',
            }}>
            {o.label}
          </button>
        </Tip>
      ))}
      <span style={{ borderLeft: '1px solid #ccc', height: 14, margin: '0 2px' }} />
      {line.gross_minor > 0 ? (
        <Tip text="Als Einnahme klassifizieren (wird zu Betriebseinnahmen verschoben)">
          <button onClick={() => handleAssign('9040')}
            style={{
              padding: '1px 6px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
              background: '#d5f5e3', color: '#1e8449', border: '1px solid #82e0aa',
              fontWeight: 500, lineHeight: '16px',
            }}>
            Einnahme
          </button>
        </Tip>
      ) : (
        <Tip text="Als Erstattung/Gutschrift klassifizieren">
          <button onClick={() => handleAssign('refund')}
            style={{
              padding: '1px 6px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
              background: '#d6eaf8', color: '#2471a3', border: '1px solid #85c1e9',
              fontWeight: 500, lineHeight: '16px',
            }}>
            Erstattung
          </button>
        </Tip>
      )}
    </div>
  );
}

function ReceiptUpload({ docId, onDone }: { docId: string; onDone?: () => void }) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('files', file);
      form.append('document_id', docId);
      const res = await fetch('/api/documents/eigenbeleg/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error((await res.json()).error || 'Upload fehlgeschlagen');
      onDone?.();
    } catch (e: any) {
      alert('Fehler: ' + e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color: '#c0392b', fontSize: 11, fontWeight: 600 }}>Rechnung fehlt</span>
      <button onClick={() => fileRef.current?.click()} disabled={uploading}
        style={{
          padding: '2px 8px', borderRadius: 4, fontSize: 10, cursor: 'pointer',
          background: '#e74c3c', color: '#fff', border: 'none', fontWeight: 600,
        }}>
        {uploading ? '...' : 'Hochladen'}
      </button>
      <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }}
        onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); e.target.value = ''; }} />
    </div>
  );
}

function KzDropdown({ line, currentKz, onReload }: { line: TaxLine; currentKz: string; onReload?: () => void }) {
  const [saving, setSaving] = useState(false);

  const handleChange = async (newKz: string) => {
    if (newKz === currentKz || !newKz) return;
    const vendor = line.supplier_name ?? '';
    if (!vendor) return;

    const allVendor = confirm(
      `Kategorie auf ${newKz} ändern.\n\nFür ALLE Rechnungen von "${vendor}"?\n\n` +
      `• OK = Alle (Vendor-Einstellung)\n• Abbrechen = Nur diese Rechnung`
    );

    setSaving(true);
    try {
      if (allVendor) {
        await api.updateVendor(vendor, { tax_category_kz: newKz });
      } else {
        await api.updateDocumentVat(line.document_id, { tax_category_kz: newKz });
      }
      onReload?.();
    } catch (e: any) {
      alert('Fehler: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  if (saving) return <span style={{ fontSize: 10, color: '#888' }}>...</span>;

  return (
    <select value={currentKz} onChange={e => handleChange(e.target.value)}
      style={{ padding: '1px 4px', fontSize: 10, borderRadius: 3, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}>
      {KZ_OPTIONS.map(o => (
        <option key={o.kz} value={o.kz}>{o.kz} {o.label}</option>
      ))}
    </select>
  );
}

function AcceptIssueButton({ docId, issue, onDone }: { docId: string; issue: string; onDone?: () => void }) {
  const [saving, setSaving] = useState(false);

  const handleAccept = async () => {
    const reason = prompt(`Grund für die Akzeptierung der Abweichung:\n(z.B. "Teilerstattung", "FX-Differenz", "Rabatt")`)
    if (!reason?.trim()) return;
    setSaving(true);
    try {
      await api.updateDocumentVat(docId, {
        issue_accepted: { issue, reason: reason.trim(), date: new Date().toISOString().slice(0, 10) },
        skip_propagation: true,
      });
      onDone?.();
    } catch (e: any) {
      alert('Fehler: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <button onClick={handleAccept} disabled={saving}
      style={{ padding: '2px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer', background: '#fff', color: colors.green, border: '1px solid ' + colors.green, fontWeight: 600 }}>
      {saving ? '...' : 'Akzeptieren'}
    </button>
  );
}

const editInputStyle: React.CSSProperties = { padding: '2px 4px', fontSize: 12, borderRadius: 3, border: '1px solid #f39c12', outline: 'none', background: '#fffef5' };

function InlineEdit({ docId, field, value, type, editingCell, setEditingCell, edits, setField }: {
  docId: string; field: string; value: any; type: 'text' | 'amount';
  editingCell: string | null; setEditingCell: (k: string | null) => void;
  edits: Record<string, Record<string, any>>; setField: (docId: string, field: string, value: any) => void;
}) {
  const key = `${docId}:${field}`;
  const isEditing = editingCell === key;
  const editedValue = edits[docId]?.[field];
  const changed = editedValue !== undefined;
  const [localText, setLocalText] = useState('');

  if (type === 'amount') {
    const minor = editedValue !== undefined ? editedValue : value;
    if (isEditing) {
      return (
        <input autoFocus
          defaultValue={(Math.abs(minor) / 100).toFixed(2).replace('.', ',')}
          onBlur={e => {
            const v = parseFloat(e.target.value.replace(',', '.'));
            if (!isNaN(v)) setField(docId, field, value < 0 ? -Math.round(v * 100) : Math.round(v * 100));
            setEditingCell(null);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const v = parseFloat((e.target as HTMLInputElement).value.replace(',', '.'));
              if (!isNaN(v)) setField(docId, field, value < 0 ? -Math.round(v * 100) : Math.round(v * 100));
              setEditingCell(null);
            }
            if (e.key === 'Escape') setEditingCell(null);
          }}
          style={{ ...editInputStyle, width: 80, textAlign: 'right' }} />
      );
    }
    return (
      <span onClick={e => { e.stopPropagation(); setEditingCell(key); }}
        style={{ cursor: 'pointer', padding: '1px 4px', borderRadius: 3, borderBottom: '1px dashed #ccc',
          background: changed ? '#fff3cd' : undefined, color: minor < 0 ? colors.red : colors.green }}>
        {minor < 0 ? '-' : ''}{fmtEur(Math.abs(minor))}
      </span>
    );
  }

  // text
  const display = editedValue !== undefined ? editedValue : (value || '—');
  if (isEditing) {
    return (
      <input autoFocus defaultValue={display === '—' ? '' : display}
        onBlur={e => { setField(docId, field, e.target.value); setEditingCell(null); }}
        onKeyDown={e => { if (e.key === 'Enter') { setField(docId, field, (e.target as HTMLInputElement).value); setEditingCell(null); } if (e.key === 'Escape') setEditingCell(null); }}
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

function EditableDetails({ docId, details, onReload }: { docId: string; details: { category: string; lines: string[] }; onReload?: () => void }) {
  const [lines, setLines] = useState(details.lines);
  const [category, setCategory] = useState(details.category);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [changed, setChanged] = useState(false);
  const [saving, setSaving] = useState(false);

  const updateLine = (idx: number, value: string) => {
    const newLines = [...lines];
    newLines[idx] = value;
    setLines(newLines);
    setChanged(true);
  };

  const addLine = () => {
    setLines([...lines, '']);
    setEditIdx(lines.length);
    setChanged(true);
  };

  const removeLine = (idx: number) => {
    setLines(lines.filter((_, i) => i !== idx));
    setChanged(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateDocumentVat(docId, {
        details: { category, lines: lines.filter(l => l.trim()) },
      });
      setChanged(false);
      setEditIdx(null);
      onReload?.();
    } catch (e: any) {
      alert('Fehler: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ fontSize: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        {editIdx === -1 ? (
          <input autoFocus value={category} onChange={e => { setCategory(e.target.value); setChanged(true); }}
            onBlur={() => setEditIdx(null)} onKeyDown={e => { if (e.key === 'Enter') setEditIdx(null); }}
            style={{ fontWeight: 600, color: '#2c3e50', fontSize: 11, padding: '1px 4px', border: '1px solid #f39c12', borderRadius: 3, background: '#fffef5' }} />
        ) : (
          <span onClick={() => setEditIdx(-1)} style={{ fontWeight: 600, color: '#2c3e50', cursor: 'pointer', borderBottom: '1px dashed #ccc' }}>
            {category}
          </span>
        )}
        {changed && (
          <button onClick={handleSave} disabled={saving}
            style={{ background: '#f39c12', color: '#fff', fontWeight: 700, border: 'none', borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 10 }}>
            {saving ? '...' : 'Speichern'}
          </button>
        )}
      </div>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: '#555', lineHeight: 1.8 }}>
        {lines.map((line, k) => (
          <li key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {editIdx === k ? (
              <input autoFocus value={line} onChange={e => updateLine(k, e.target.value)}
                onBlur={() => setEditIdx(null)} onKeyDown={e => { if (e.key === 'Enter') setEditIdx(null); }}
                style={{ flex: 1, fontSize: 11, padding: '1px 4px', border: '1px solid #f39c12', borderRadius: 3, background: '#fffef5' }} />
            ) : (
              <span onClick={() => setEditIdx(k)} style={{ cursor: 'pointer', borderBottom: '1px dashed transparent', flex: 1 }}
                onMouseOver={e => (e.currentTarget.style.borderBottomColor = '#ccc')}
                onMouseOut={e => (e.currentTarget.style.borderBottomColor = 'transparent')}>
                {line || <span style={{ color: '#ccc' }}>(leer)</span>}
              </span>
            )}
            <button onClick={() => removeLine(k)} style={{ border: 'none', background: 'none', color: '#ccc', cursor: 'pointer', fontSize: 12, padding: 0 }} title="Zeile entfernen">✕</button>
          </li>
        ))}
      </ul>
      <button onClick={addLine} style={{ border: 'none', background: 'none', color: '#2980b9', cursor: 'pointer', fontSize: 10, marginTop: 4, padding: 0 }}>+ Zeile hinzufügen</button>
    </div>
  );
}

function DetailTable({ lines, showKzTags, onReload, currentKz, search }: { lines: TaxLine[]; showKzTags?: boolean; onReload?: () => void; currentKz?: string; search?: string }) {
  const filtered = search
    ? lines.filter(l => {
        const s = search.toLowerCase();
        return (l.supplier_name ?? '').toLowerCase().includes(s) ||
          (l.filename ?? '').toLowerCase().includes(s) ||
          (l.description ?? '').toLowerCase().includes(s) ||
          String(Math.abs(l.gross_minor) / 100).includes(s);
      })
    : lines;
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) => setExpandedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Inline editing
  const [edits, setEdits] = useState<Record<string, Record<string, any>>>({});
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [savingDoc, setSavingDoc] = useState<string | null>(null);
  const setField = (docId: string, field: string, value: any) => {
    setEdits(prev => ({ ...prev, [docId]: { ...prev[docId], [field]: value } }));
  };
  const handleSaveDoc = async (docId: string) => {
    const changes = edits[docId];
    if (!changes || Object.keys(changes).length === 0) return;
    setSavingDoc(docId);
    try {
      await api.updateDocumentVat(docId, { ...changes, skip_propagation: true });
      setEdits(prev => { const n = { ...prev }; delete n[docId]; return n; });
      setEditingCell(null);
      onReload?.();
    } catch (e: any) { alert('Fehler: ' + e.message); }
    finally { setSavingDoc(null); }
  };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Datum</th>
            <th style={th}>Lieferant</th>
            <th style={th}>Netto</th>
            <th style={th}>USt</th>
            <th style={th}>Brutto</th>
            <th style={th}>Datei</th>
            <th style={th}>Buchung</th>
            <th style={th}>KZ</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((l, i) => {
            const isNegative = l.gross_minor < 0;
            const amtColor = isNegative ? colors.red : colors.green;
            const hasMismatch = l.linked_transactions?.some((t: any) => !(t.doc_count > 1) && Math.abs(t.amount_minor) !== Math.abs(l.gross_minor) && l.gross_minor !== 0);
            const rowBg = l.needs_receipt ? '#fef0f0' : hasMismatch ? '#fef9e7' : undefined;
            return (
              <React.Fragment key={i}>
              <tr style={{ borderBottom: '1px solid #f0f0f0', background: edits[l.document_id] ? '#fffef5' : rowBg }}>
                <td style={td}>{fmtDate(l.document_date)}</td>
                <td style={td}>
                  {l.details ? (
                    <span onClick={() => toggleExpand(l.document_id)} style={{ cursor: 'pointer', borderBottom: '1px dashed #999' }} title="Details anzeigen">
                      <InlineEdit docId={l.document_id} field="supplier_name" value={l.supplier_name ?? ''} type="text"
                        editingCell={editingCell} setEditingCell={setEditingCell} edits={edits} setField={setField} />
                      {' '}{expandedIds.has(l.document_id) ? '\u25B2' : '\u25BC'}
                    </span>
                  ) : (
                    <InlineEdit docId={l.document_id} field="supplier_name" value={l.supplier_name ?? ''} type="text"
                      editingCell={editingCell} setEditingCell={setEditingCell} edits={edits} setField={setField} />
                  )}
                  {l.description && <div style={{ fontSize: 10, color: '#888' }}>{l.description}</div>}
                </td>
                <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right' }}>
                  <InlineEdit docId={l.document_id} field="net_minor" value={l.net_minor} type="amount"
                    editingCell={editingCell} setEditingCell={setEditingCell} edits={edits} setField={setField} />
                </td>
                <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right' }}>
                  <InlineEdit docId={l.document_id} field="vat_minor" value={l.vat_minor} type="amount"
                    editingCell={editingCell} setEditingCell={setEditingCell} edits={edits} setField={setField} />
                </td>
                <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right' }}>
                  <InlineEdit docId={l.document_id} field="gross_minor" value={l.gross_minor} type="amount"
                    editingCell={editingCell} setEditingCell={setEditingCell} edits={edits} setField={setField} />
                </td>
                <td style={td}>
                  {l.needs_receipt ? (
                    <ReceiptUpload docId={l.document_id} onDone={onReload} />
                  ) : (
                    <FileLink filename={l.filename} />
                  )}
                </td>
                <td style={td}>
                  {l.linked_transactions?.length > 0 ? (
                    <div style={{ fontSize: 11 }}>
                      {l.linked_transactions.map((t: any, j: number) => {
                        // Only show mismatch for 1:1 matches (not combo matches where one txn covers multiple docs)
                        const isCombo = t.doc_count > 1;
                        const mismatch = !isCombo && t.amount_minor != null && Math.abs(t.amount_minor) !== Math.abs(l.gross_minor) && l.gross_minor !== 0;
                        return (
                          <a key={j}
                            href={`/?highlight=${encodeURIComponent(t.transaction_id)}&source=${encodeURIComponent(t.source_system)}`}
                            style={{ display: 'block', whiteSpace: 'nowrap', textDecoration: 'none', color: 'inherit', borderBottom: '1px dashed #2980b9', marginBottom: 2 }}>
                            <span style={{ color: '#999' }}>{fmtDate(t.posting_at)}</span>
                            {' '}
                            <span style={{ fontWeight: 600, color: colors.blue }}>{t.source_system}</span>
                            {' '}
                            <span style={{ fontFamily: 'monospace', color: t.amount_minor < 0 ? colors.red : colors.green }}>
                              {fmtEur(Math.abs(t.amount_minor))}
                            </span>
                            {mismatch && <span style={{ color: '#e67e22', marginLeft: 4 }} title={`Beleg: ${fmtEur(Math.abs(l.gross_minor))} ≠ Buchung: ${fmtEur(Math.abs(t.amount_minor))}`}>⚠</span>}
                          </a>
                        );
                      })}
                    </div>
                  ) : (
                    <span style={{ color: '#ccc', fontSize: 11 }}>—</span>
                  )}
                </td>
                <td style={td}>
                  {showKzTags
                    ? <KzTagRow line={l} onReload={onReload} />
                    : currentKz
                      ? <KzDropdown line={l} currentKz={currentKz} onReload={onReload} />
                      : null
                  }
                  {edits[l.document_id] && Object.keys(edits[l.document_id]).length > 0 && (
                    <button onClick={() => handleSaveDoc(l.document_id)} disabled={savingDoc === l.document_id}
                      style={{ marginLeft: 6, background: '#f39c12', color: '#fff', fontWeight: 700, border: 'none', borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 10 }}>
                      {savingDoc === l.document_id ? '...' : 'Übernehmen'}
                    </button>
                  )}
                </td>
              </tr>
              {l.details && expandedIds.has(l.document_id) && (
                <tr key={`${i}-details`} style={{ background: '#f8f9fa' }}>
                  <td colSpan={8} style={{ padding: '8px 16px 12px 40px' }}>
                    <EditableDetails docId={l.document_id} details={l.details} onReload={onReload} />
                  </td>
                </tr>
              )}
              </React.Fragment>
            );
          })}
          <tr style={{ borderTop: '2px solid #ddd', background: '#f8f9fa' }}>
            <td style={{ ...td, fontWeight: 700 }} colSpan={2}>Summe</td>
            <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right', fontWeight: 700 }}>
              {fmtEur(Math.abs(filtered.reduce((s, l) => s + l.net_minor, 0)))}
            </td>
            <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right', color: '#aaa' }}>
              {fmtEur(Math.abs(filtered.reduce((s, l) => s + l.vat_minor, 0)))}
            </td>
            <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right', color: '#aaa' }}>
              {fmtEur(Math.abs(filtered.reduce((s, l) => s + l.gross_minor, 0)))}
            </td>
            <td colSpan={3}></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles & helpers
// ---------------------------------------------------------------------------

const h2Style: React.CSSProperties = { fontSize: 18, marginBottom: 12, borderBottom: '2px solid #ddd', paddingBottom: 8, marginTop: 32 };
const th: React.CSSProperties = { textAlign: 'left', padding: '4px 8px', borderBottom: '2px solid #ddd', color: '#666', fontSize: 11 };
const thStyle: React.CSSProperties = { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #e6a0a0', color: '#888', fontSize: 11 };
const tdStyle: React.CSSProperties = { padding: '4px 8px' };
const td: React.CSSProperties = { padding: '4px 8px' };
const tdR: React.CSSProperties = { padding: '4px 12px', textAlign: 'right', color: '#666' };
const tdV: React.CSSProperties = { padding: '4px 12px', fontWeight: 600 };
const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600 };
const inputStyle: React.CSSProperties = { padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13 };
const btnSmall: React.CSSProperties = { padding: '4px 10px', borderRadius: 4, border: '1px solid #ddd', cursor: 'pointer', fontSize: 12, fontWeight: 600 };

function fmtEur(minor: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(minor / 100);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}
