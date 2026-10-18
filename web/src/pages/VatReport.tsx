import { useLegacyText } from '../i18n/legacy';
import { legacyAccountingEnglish, accountingWarningText } from '../i18n/legacy-accounting';
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Button, colors, FileLink, Tip, CopyValue, useWorkingYear, workingPeriodDates } from '../components/shared';

interface VatLine {
  document_id: string;
  filename: string | null;
  document_date: string;
  supplier_name: string | null;
  country_code: string | null;
  country_raw: string | null;
  net_minor: number;
  vat_minor: number;
  gross_minor: number;
  vat_rate: number | null;
  source_system: string;
  is_reverse_charge: boolean;
  linked_transactions: any[];
}

interface Bucket {
  label?: string;
  code?: string;
  title?: string;
  total_net_minor: number;
  total_vat_minor: number;
  total_gross_minor: number;
  lines: VatLine[];
}

export function VatReport() {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  const { workingYear, quarter } = useWorkingYear();
  const currentYear = new Date().getFullYear();
  const currentQuarter = Math.ceil((new Date().getMonth() + 1) / 3);
  const qStart = `${currentYear}-${String((currentQuarter - 1) * 3 + 1).padStart(2, '0')}-01`;
  const qEndMonth = currentQuarter * 3;
  const qEndDay = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][qEndMonth - 1];
  const qEnd = `${currentYear}-${String(qEndMonth).padStart(2, '0')}-${qEndDay}`;

  const [start, setStart] = useState(() => {
    return sessionStorage.getItem('vatReport_start') || qStart;
  });
  const [end, setEnd] = useState(() => {
    return sessionStorage.getItem('vatReport_end') || qEnd;
  });
  const [report, setReport] = useState<any>(() => {
    const saved = sessionStorage.getItem('vatReport_data');
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
    sessionStorage.removeItem('vatReport_data');
  }, [workingYear, quarter]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.getVatReport(start, end);
      setReport(r);
      sessionStorage.setItem('vatReport_data', JSON.stringify(r));
      sessionStorage.setItem('vatReport_start', start);
      sessionStorage.setItem('vatReport_end', end);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>{text("Umsatzsteuer-Bericht Österreich")}</h1>

      {/* Period selector */}
      <Card style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label style={labelStyle}>{text("Von:")}</label>
          <input type="date" value={start} onChange={e => setStart(e.target.value)} style={inputStyle} />
          <label style={labelStyle}>{text("Bis:")}</label>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={inputStyle} />
          <Tip text={text("USt-Bericht für den gewählten Zeitraum generieren")}>
            <Button onClick={load} disabled={loading} color="#2c3e50">
              {loading ? text("Wird erstellt...") : text("Bericht erstellen")}
            </Button>
          </Tip>
          {report && (
            <Tip text={text("Bericht als PDF speichern")}>
              <Button onClick={() => {
                window.open(`/api/report/vat/pdf?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, '_blank');
              }} color="#8e44ad">
                {text("Bericht festschreiben (PDF)")}
              </Button>
            </Tip>
          )}
          {/* Quick period buttons */}
          {[1, 2, 3, 4].map(q => {
            const qs = `${currentYear}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
            const qm = q * 3;
            const qd = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][qm - 1];
            const qe = `${currentYear}-${String(qm).padStart(2, '0')}-${qd}`;
            return (
              <button key={q} onClick={() => { setStart(qs); setEnd(qe); }}
                style={{ ...btnSmall, background: start === qs && end === qe ? '#2c3e50' : '#ecf0f1', color: start === qs && end === qe ? '#fff' : '#333' }}>
                Q{q}
              </button>
            );
          })}
          <span style={{ borderLeft: '1px solid #ccc', margin: '0 4px' }} />
          {[1, 2, 3, 4].map(q => {
            const ly = currentYear - 1;
            const qs = `${ly}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
            const qm = q * 3;
            const qd = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][qm - 1];
            const qe = `${ly}-${String(qm).padStart(2, '0')}-${qd}`;
            return (
              <button key={`ly-${q}`} onClick={() => { setStart(qs); setEnd(qe); }}
                style={{ ...btnSmall, background: start === qs && end === qe ? '#2c3e50' : '#ecf0f1', color: start === qs && end === qe ? '#fff' : '#333' }}>
                Q{q}/{ly}
              </button>
            );
          })}
          {(() => {
            const ly = `${currentYear - 1}`;
            const lyStart = `${ly}-01-01`;
            const lyEnd = `${ly}-12-31`;
            return (
              <button onClick={() => { setStart(lyStart); setEnd(lyEnd); }}
                style={{ ...btnSmall, background: start === lyStart && end === lyEnd ? '#2c3e50' : '#ecf0f1', color: start === lyStart && end === lyEnd ? '#fff' : '#333' }}>
                {ly}
              </button>
            );
          })()}
        </div>
      </Card>

      {error && <div style={{ color: colors.red, marginBottom: 16 }}>{error}</div>}

      {report && (
        <div style={{ marginBottom: 16 }}>
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder={text("Suche (Lieferant, Datei, Betrag)...")}
            style={{ ...inputStyle, width: 350 }}
          />
          {search && <button onClick={() => setSearch('')} style={{ ...btnSmall, marginLeft: 8 }}>{text("Zurücksetzen")}</button>}
        </div>
      )}

      {report && (
        <>
          {/* ============= REVENUE (Umsatz) ============= */}
          <h2 style={h2Style}>{text("A) Umsatz (Revenues)")}</h2>

          {/* 000 Summe der Umsätze */}
          <Card style={{ marginBottom: 16, background: '#f8f9fa' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span style={{ display: 'inline-block', background: '#2c3e50', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>
                000
              </span>
              <span style={{ fontWeight: 700, fontSize: 16 }}>{text("Summe der Umsätze")}</span>
            </div>
            <div style={{ display: 'flex', gap: 32, fontSize: 14, marginTop: 12 }}>
              <div>
                <CopyValue minor={report.revenue_total_net_minor} label={text("Netto")} style={{ fontSize: 22, color: colors.green }} />
              </div>
              <div>
                <div style={{ color: '#666', fontSize: 12 }}>{text("USt")}</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtEur(report.revenue_total_vat_minor, locale)}</div>
              </div>
              <div>
                <div style={{ color: '#666', fontSize: 12 }}>{text("Brutto")}</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtEur(report.revenue_total_gross_minor, locale)}</div>
              </div>
            </div>
          </Card>

          {/* Umsätze Österreich */}
          <RevenueBucketCard bucket={report.revenue_at} title={text("Umsätze Österreich")} onReload={load} search={search} />

          {/* Umsätze non-EU */}
          <RevenueBucketCard bucket={report.revenue_non_eu} title={text("Umsätze aus nicht EU Ländern mit 0% USt.")} onReload={load} search={search} />

          {/* Excluded EU revenue: only count in reconciliation, not shown as card */}

          {/* ============= INPUT VAT (Vorsteuer) ============= */}
          <h2 style={{ ...h2Style, marginTop: 32 }}>{text("B) Vorsteuer / Input VAT")}</h2>

          <VatCategoryCard cat={report.cat_072} onReload={load} search={search} />
          <VatCategoryCard cat={report.cat_076} onReload={load} search={search} />
          <VatCategoryCard cat={report.cat_065} onReload={load} search={search} />
          <VatCategoryCard cat={report.cat_066} onReload={load} search={search} />

          {/* 057 = mirror of 066 but for USt declaration (greyed out, USt copyable) */}
          {report.cat_066?.lines?.length > 0 && (
            <Card style={{ marginBottom: 12, opacity: 0.6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ background: '#2c3e50', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>057</span>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{text("Reverse Charge — Steuerschuld gem. Art 196 MwStSyst-RL")}</span>
                  <span style={{ color: '#999', fontSize: 12 }}>({report.cat_066.lines.length})</span>
                </div>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 13, flexShrink: 0 }}>
                  <span>{text("Netto:")} <b>{fmtEur(Math.abs(report.cat_066.total_net_minor), locale)}</b></span>
                  <CopyValue minor={Math.round(Math.abs(report.cat_066.total_net_minor) * 0.2)} label={text("USt 20%")} />
                </div>
              </div>
            </Card>
          )}

          <VatCategoryCard cat={report.cat_060} onReload={load} search={search} />
          {report.cat_061?.lines?.length > 0 && <VatCategoryCard cat={report.cat_061} onReload={load} search={search} />}
          {report.other_no_vat?.lines?.length > 0 && <VatCategoryCard cat={report.other_no_vat} onReload={load} search={search} />}

          {/* ============= RECONCILIATION ============= */}
          <h2 style={{ ...h2Style, marginTop: 32 }}>{text("Abstimmung")}</h2>
          <Card style={{ marginBottom: 16 }}>
            <table style={{ fontSize: 13, borderCollapse: 'collapse' }}>
              <tbody>
                <tr><td style={tdR}>{text("Dokumente im Zeitraum:")}</td><td style={tdV}>{report.total_documents_processed}</td></tr>
                <tr><td style={tdR}>{text("Umsätze Österreich:")}</td><td style={tdV}>{report.revenue_at.lines.length}</td></tr>
                <tr><td style={tdR}>{text("Umsätze nicht-EU:")}</td><td style={tdV}>{report.revenue_non_eu.lines.length}</td></tr>
                <tr><td style={tdR}>{text("Einnahmen EU (ausgeschlossen):")}</td><td style={tdV}>{report.revenue_excluded_eu.lines.length}</td></tr>
                <tr><td style={tdR}>{text("060 AT Vorsteuer:")}</td><td style={tdV}>{report.cat_060.lines.length}</td></tr>
                <tr><td style={tdR}>{text("061 EUSt:")}</td><td style={tdV}>{report.cat_061.lines.length}</td></tr>
                <tr><td style={tdR}>{text("065 IGL Vorsteuer:")}</td><td style={tdV}>{report.cat_065.lines.length}</td></tr>
                <tr><td style={tdR}>{text("066 Reverse Charge:")}</td><td style={tdV}>{report.cat_066.lines.length}</td></tr>
                <tr><td style={tdR}>{text("072 IGL Erwerbe:")}</td><td style={tdV}>{report.cat_072.lines.length}</td></tr>
                <tr><td style={tdR}>{text("076 Im Bestimmungsland besteuert:")}</td><td style={tdV}>{report.cat_076.lines.length}</td></tr>
                {report.other_no_vat?.lines?.length > 0 && <tr><td style={tdR}>{text("Sonstige Ausgaben (keine USt):")}</td><td style={tdV}>{report.other_no_vat.lines.length}</td></tr>}
                <tr style={{ borderTop: '2px solid #ddd' }}>
                  <td style={{ ...tdR, color: report.total_unclassified > 0 ? colors.red : colors.green }}>
                    {text("Nicht klassifiziert:")}
                  </td>
                  <td style={tdV}>{report.total_unclassified}</td>
                </tr>
              </tbody>
            </table>
          </Card>

          {/* Unclassified */}
          {report.unclassified_lines.length > 0 && (
            <Card title={text("Nicht klassifiziert ({p0})", { p0: report.unclassified_lines.length })} style={{ marginBottom: 16 }}>
              <DetailTable lines={report.unclassified_lines} showCountry onReload={load} search={search} />
            </Card>
          )}

          {/* Warnings */}
          {report.integrity_warnings.length > 0 && (
            <Card title={text("Hinweise ({p0})", { p0: report.integrity_warnings.length })} style={{ marginBottom: 16 }}>
              <ul style={{ fontSize: 12, color: '#888', maxHeight: 200, overflow: 'auto', margin: 0, paddingLeft: 20 }}>
                {report.integrity_warnings.slice(0, 50).map((w: string, i: number) => {
                  const docMatch = w.match(/^(DOC-[A-Za-z0-9_-]+)/);
                  if (docMatch) {
                    const docId = docMatch[1];
                    const rest = w.slice(docId.length);
                    return (
                      <li key={i}>
                        <a href={`/?highlight=${encodeURIComponent(docId)}&source=document`}
                          style={{ color: colors.blue, textDecoration: 'none', borderBottom: '1px dashed #2980b9' }}>
                          {docId}
                        </a>
                        {accountingWarningText(text, rest)}
                      </li>
                    );
                  }
                  return <li key={i}>{accountingWarningText(text, w)}</li>;
                })}
                {report.integrity_warnings.length > 50 && (
                  <li>{text("... und")} {report.integrity_warnings.length - 50} {text("weitere")}</li>
                )}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RevenueBucketCard({ bucket, title, muted, onReload, search }: { bucket: Bucket; title: string; muted?: boolean; onReload?: () => void; search?: string }) {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  const [open, setOpen] = useState(false);
  const opacity = muted ? 0.5 : 1;
  return (
    <Card style={{ marginBottom: 12, opacity }}>
      <div style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {bucket.code && bucket.code !== '---' && (
              <span style={{ background: '#2c3e50', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>
                {bucket.code}
              </span>
            )}
            <span style={{ fontWeight: 600, fontSize: 14 }}>{text(title)}</span>
            <span style={{ color: '#999', fontSize: 12 }}>({bucket.lines.length})</span>
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 13, flexShrink: 0 }}>
            <CopyValue minor={bucket.total_net_minor} label={text("Netto")} />
            <span>{text("USt:")} <b>{fmtEur(bucket.total_vat_minor, locale)}</b></span>
            <span>{text("Brutto:")} <b>{fmtEur(bucket.total_gross_minor, locale)}</b></span>
            <span style={{ color: '#999' }}>{open ? '\u25B2' : '\u25BC'}</span>
          </div>
        </div>
      </div>
      {open && bucket.lines.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <DetailTable lines={bucket.lines} showCountry onReload={onReload} search={search} />
        </div>
      )}
    </Card>
  );
}

function VatCategoryCard({ cat, onReload, search }: { cat: Bucket & { code?: string; title?: string }; onReload?: () => void; search?: string }) {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  const [open, setOpen] = useState(false);
  const hasLines = cat.lines.length > 0;
  return (
    <Card style={{ marginBottom: 12, opacity: hasLines ? 1 : 0.5 }}>
      <div style={{ cursor: hasLines ? 'pointer' : 'default' }}
        onClick={() => hasLines && setOpen(!open)}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ background: '#2c3e50', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>
              {cat.code}
            </span>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{text(cat.title || "")}</span>
            <span style={{ color: '#999', fontSize: 12 }}>({cat.lines.length})</span>
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 13, flexShrink: 0 }}>
            {cat.code === '061' ? (
              <CopyValue minor={Math.abs(cat.total_net_minor)} label={text("Netto")} />
            ) : cat.code === '060' || cat.code === '065' ? (
              <>
                <span>{text("Netto:")} <b>{fmtEur(Math.abs(cat.total_net_minor), locale)}</b></span>
                <CopyValue minor={Math.abs(cat.total_vat_minor)} label={text("USt")} />
              </>
            ) : cat.code === '076' ? (
              <CopyValue minor={Math.abs(cat.total_net_minor + cat.total_vat_minor)} label={text("Brutto")} />
            ) : cat.code === '072' ? (
              <>
                <CopyValue minor={Math.abs(cat.total_net_minor)} label={text("Netto")} />
                <span>{text("USt 20%:")} <b>{fmtEur(Math.round(Math.abs(cat.total_net_minor) * 0.2), locale)}</b></span>
              </>
            ) : (
              <>
                <CopyValue minor={Math.abs(cat.total_net_minor)} label={text("Netto")} />
                <span>{text("USt:")} <b>{fmtEur(Math.abs(cat.total_vat_minor), locale)}</b></span>
              </>
            )}
          {hasLines && <span style={{ color: '#999' }}>{open ? '\u25B2' : '\u25BC'}</span>}
          </div>
        </div>
      </div>
      {open && hasLines && (
        <div style={{ marginTop: 12 }}>
          <DetailTable lines={cat.lines} showCountry onReload={onReload} search={search} />
        </div>
      )}
    </Card>
  );
}

function DetailTable({ lines, showCountry, onReload, search }: { lines: VatLine[]; showCountry?: boolean; onReload?: () => void; search?: string }) {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  const filtered = search
    ? lines.filter(l => {
        const s = search.toLowerCase();
        return (l.supplier_name ?? '').toLowerCase().includes(s) ||
          (l.filename ?? '').toLowerCase().includes(s) ||
          (l.country_code ?? '').toLowerCase().includes(s) ||
          String(Math.abs(l.gross_minor) / 100).includes(s);
      })
    : lines;
  if (search && filtered.length === 0) return <div style={{ fontSize: 12, color: '#999', padding: 8 }}>{text("Keine Treffer")}</div>;
  const [edits, setEdits] = useState<Record<string, Record<string, any>>>({});
  const [editing, setEditing] = useState<string | null>(null); // "docId:field"
  const [saving, setSaving] = useState<string | null>(null);

  const setField = (docId: string, field: string, value: any) => {
    setEdits(prev => ({ ...prev, [docId]: { ...prev[docId], [field]: value } }));
  };

  const handleSave = async (docId: string) => {
    const changes = edits[docId];
    if (!changes || Object.keys(changes).length === 0) return;

    // If vat_rate changed, ask whether to apply to all vendor docs
    let applyVatToVendor = false;
    if (changes.vat_rate !== undefined) {
      const line = lines.find(l => l.document_id === docId);
      const vendor = line?.supplier_name ?? 'diesen Lieferanten';
      applyVatToVendor = confirm(
        text("USt-Satz auf {p0}% geändert.\n\nFür ALLE Rechnungen von \"{p1}\" übernehmen?\n\n• OK = Alle Rechnungen dieses Vendors\n• Abbrechen = Nur diese Rechnung", { p0: Math.round(changes.vat_rate * 100), p1: vendor })
      );
    }

    setSaving(docId);
    try {
      await api.updateDocumentVat(docId, { ...changes, apply_vat_to_vendor: applyVatToVendor });
      setEdits(prev => { const n = { ...prev }; delete n[docId]; return n; });
      setEditing(null);
      onReload?.();
    } catch (e: any) {
      alert(text('Fehler: ') + e.message);
    } finally {
      setSaving(null);
    }
  };

  const editKey = (docId: string, field: string) => `${docId}:${field}`;

  const EditableText = ({ docId, field, value, style: s }: { docId: string; field: string; value: string; style?: React.CSSProperties }) => {
    const key = editKey(docId, field);
    const isEditing = editing === key;
    const editedValue = edits[docId]?.[field];
    const display = editedValue !== undefined ? editedValue : value;
    const changed = editedValue !== undefined && editedValue !== value;

    if (isEditing) {
      return (
        <input
          autoFocus
          value={display}
          onChange={e => setField(docId, field, e.target.value)}
          onBlur={() => setEditing(null)}
          onKeyDown={e => { if (e.key === 'Enter') setEditing(null); if (e.key === 'Escape') { setEditing(null); setEdits(prev => { const n = { ...prev }; if (n[docId]) { delete n[docId][field]; if (Object.keys(n[docId]).length === 0) delete n[docId]; } return n; }); } }}
          style={{ ...editInputStyle, width: field === 'country_code' ? 36 : 120, ...(s ?? {}) }}
        />
      );
    }
    return (
      <span
        onClick={() => setEditing(key)}
        style={{ ...editableStyle, ...(s ?? {}), background: changed ? '#fff3cd' : undefined }}
        title={text("Klicken zum Bearbeiten")}
      >
        {display || '—'}
      </span>
    );
  };

  const EditableAmount = ({ docId, field, minor, style: s }: { docId: string; field: string; minor: number; style?: React.CSSProperties }) => {
    const key = editKey(docId, field);
    const isEditing = editing === key;
    const editedValue = edits[docId]?.[field];
    const currentMinor = editedValue !== undefined ? editedValue : minor;
    const changed = editedValue !== undefined && editedValue !== minor;

    if (isEditing) {
      return (
        <input
          autoFocus
          defaultValue={(Math.abs(currentMinor) / 100).toFixed(2).replace('.', ',')}
          onBlur={e => {
            const val = parseFloat(e.target.value.replace(',', '.'));
            if (!isNaN(val)) setField(docId, field, minor < 0 ? -Math.round(val * 100) : Math.round(val * 100));
            setEditing(null);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') { const val = parseFloat((e.target as HTMLInputElement).value.replace(',', '.')); if (!isNaN(val)) setField(docId, field, minor < 0 ? -Math.round(val * 100) : Math.round(val * 100)); setEditing(null); }
            if (e.key === 'Escape') { setEditing(null); setEdits(prev => { const n = { ...prev }; if (n[docId]) { delete n[docId][field]; if (Object.keys(n[docId]).length === 0) delete n[docId]; } return n; }); }
          }}
          style={{ ...editInputStyle, width: 80, textAlign: 'right', ...(s ?? {}) }}
        />
      );
    }
    return (
      <span
        onClick={() => setEditing(key)}
        style={{ ...editableStyle, ...(s ?? {}), background: changed ? '#fff3cd' : undefined }}
        title={text("Klicken zum Bearbeiten")}
      >
        {fmtEur(Math.abs(currentMinor), locale)}
      </span>
    );
  };

  const EditableRate = ({ docId, rate }: { docId: string; rate: number | null }) => {
    const key = editKey(docId, 'vat_rate');
    const isEditing = editing === key;
    const editedValue = edits[docId]?.['vat_rate'];
    const currentRate = editedValue !== undefined ? editedValue : rate;
    const changed = editedValue !== undefined && editedValue !== rate;
    const display = currentRate != null ? `${Math.round(currentRate * 100)}%` : '—';

    if (isEditing) {
      return (
        <input
          autoFocus
          defaultValue={currentRate != null ? String(Math.round(currentRate * 100)) : ''}
          onBlur={e => {
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val)) setField(docId, 'vat_rate', val / 100);
            setEditing(null);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') { const val = parseInt((e.target as HTMLInputElement).value, 10); if (!isNaN(val)) setField(docId, 'vat_rate', val / 100); setEditing(null); }
            if (e.key === 'Escape') { setEditing(null); setEdits(prev => { const n = { ...prev }; if (n[docId]) { delete n[docId]['vat_rate']; if (Object.keys(n[docId]).length === 0) delete n[docId]; } return n; }); }
          }}
          style={{ ...editInputStyle, width: 44, textAlign: 'center' }}
        />
      );
    }
    return (
      <span
        onClick={() => setEditing(key)}
        style={{ ...editableStyle, background: changed ? '#fff3cd' : undefined }}
        title={text("Klicken zum Bearbeiten")}
      >
        {display}
      </span>
    );
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>{text("Datum")}</th>
            {showCountry && <th style={th}>{text("Land")}</th>}
            <th style={th}>{text("Lieferant")}</th>
            <th style={th}>{text("Netto")}</th>
            <th style={th}>{text("USt")}</th>
            <th style={th}>{text("Brutto")}</th>
            <th style={th}>{text("USt%")}</th>
            <th style={th}>{text("Datei")}</th>
            <th style={th}>{text("Buchung")}</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((l, i) => {
            const isRefund = l.source_system === 'income' ? l.gross_minor < 0 : l.gross_minor > 0;
            const amtColor = isRefund ? colors.green : undefined;
            const hasEdits = edits[l.document_id] && Object.keys(edits[l.document_id]).length > 0;
            const isSaving = saving === l.document_id;
            return (
            <tr key={i} style={{ borderBottom: '1px solid #f0f0f0', background: isRefund ? '#f0fff0' : hasEdits ? '#fffef5' : undefined }}>
              <td style={td}>{fmtDate(l.document_date, locale)}</td>
              {showCountry && (
                <td style={td}>
                  <EditableText docId={l.document_id} field="country_code" value={l.country_code ?? l.country_raw ?? ''} />
                </td>
              )}
              <td style={td}>
                <EditableText docId={l.document_id} field="supplier_name" value={l.supplier_name ?? ''} style={{ maxWidth: 180 }} />
              </td>
              <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right', color: amtColor }}>
                {isRefund ? '+' : ''}<EditableAmount docId={l.document_id} field="net_minor" minor={l.net_minor} />
              </td>
              <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right', color: amtColor }}>
                {isRefund ? '+' : ''}<EditableAmount docId={l.document_id} field="vat_minor" minor={l.vat_minor} />
              </td>
              <td style={{ ...td, fontFamily: 'monospace', textAlign: 'right', color: amtColor }}>
                {isRefund ? '+' : ''}<EditableAmount docId={l.document_id} field="gross_minor" minor={l.gross_minor} />
              </td>
              <td style={{ ...td, textAlign: 'center' }}>
                <EditableRate docId={l.document_id} rate={l.vat_rate} />
              </td>
              <td style={td}><FileLink filename={l.filename} /></td>
              <td style={td}>
                {l.linked_transactions?.length > 0 ? (
                  <div style={{ fontSize: 11 }}>
                    {l.linked_transactions.map((t: any, j: number) => {
                      const isCombo = t.doc_count > 1;
                      const mismatch = !isCombo && Math.abs(t.amount_minor) !== Math.abs(l.gross_minor) && l.gross_minor !== 0;
                      return (
                        <a key={j}
                          href={`/?highlight=${encodeURIComponent(t.transaction_id)}&source=${encodeURIComponent(t.source_system)}`}
                          style={{ display: 'block', whiteSpace: 'nowrap', textDecoration: 'none', color: 'inherit', borderBottom: '1px dashed #2980b9', marginBottom: 2 }}
                          title={text("Buchung öffnen: {p0}", { p0: t.transaction_id })}>
                          <span style={{ color: '#999' }}>{fmtDate(t.posting_at, locale)}</span>
                          {' '}
                          <span style={{ fontWeight: 600, color: colors.blue }}>{t.source_system}</span>
                          {' '}
                          <span style={{ fontFamily: 'monospace', color: t.amount_minor < 0 ? colors.red : colors.green }}>
                            {fmtEur(Math.abs(t.amount_minor), locale)}
                          </span>
                          {t.counterparty_name && <span style={{ color: '#666' }}> {t.counterparty_name}</span>}
                          {mismatch && <span style={{ color: '#e67e22', marginLeft: 4 }} title={text("Beleg: {p0} ≠ Buchung: {p1}", { p0: fmtEur(Math.abs(l.gross_minor), locale), p1: fmtEur(Math.abs(t.amount_minor), locale) })}>⚠</span>}
                        </a>
                      );
                    })}
                  </div>
                ) : (
                  <span style={{ color: '#ccc', fontSize: 11 }}>—</span>
                )}
              </td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                {hasEdits && (
                  <Tip text={text("Änderungen speichern und Bericht neu klassifizieren")}>
                    <button
                      onClick={() => handleSave(l.document_id)}
                      disabled={isSaving}
                      style={{
                        background: '#f39c12', color: '#fff', fontWeight: 700, border: 'none',
                        borderRadius: 4, padding: '4px 12px', cursor: isSaving ? 'default' : 'pointer',
                        fontSize: 11, opacity: isSaving ? 0.6 : 1,
                      }}
                    >
                      {isSaving ? '...' : text("Übernehmen")}
                    </button>
                  </Tip>
                )}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles & helpers
// ---------------------------------------------------------------------------

const h2Style: React.CSSProperties = { fontSize: 18, marginBottom: 12, borderBottom: '2px solid #ddd', paddingBottom: 8 };
const th: React.CSSProperties = { textAlign: 'left', padding: '4px 8px', borderBottom: '2px solid #ddd', color: '#666', fontSize: 11 };
const td: React.CSSProperties = { padding: '4px 8px' };
const tdR: React.CSSProperties = { padding: '4px 12px', textAlign: 'right', color: '#666' };
const tdV: React.CSSProperties = { padding: '4px 12px', fontWeight: 600 };
const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600 };
const inputStyle: React.CSSProperties = { padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13 };
const btnSmall: React.CSSProperties = { padding: '4px 10px', borderRadius: 4, border: '1px solid #ddd', cursor: 'pointer', fontSize: 12, fontWeight: 600 };
const editableStyle: React.CSSProperties = { cursor: 'pointer', padding: '1px 4px', borderRadius: 3, borderBottom: '1px dashed #ccc' };
const editInputStyle: React.CSSProperties = { padding: '2px 4px', fontSize: 12, borderRadius: 3, border: '1px solid #f39c12', outline: 'none', background: '#fffef5' };

function fmtEur(minor: number, locale = 'de-DE'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(minor / 100);
}

function fmtDate(iso: string | null, locale = 'de-DE'): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return locale === 'de-DE' ? `${d}.${m}.${y}` : `${d}/${m}/${y}`;
}
