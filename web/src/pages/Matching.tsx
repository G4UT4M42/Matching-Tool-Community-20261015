import React, { useState, useEffect } from 'react';
import { Card, StatCard, colors, Badge, Amount, Button, Select, useWorkingYear } from '../components/shared';
import { api } from '../api';
import { MatchingGovernance } from '../components/matching/MatchingGovernance';

interface TxnEntry {
  transaction_id: string;
  posting_at: string;
  amount_minor: number;
  description_raw: string;
  counterparty_name: string;
  source_system: string;
  counterparty_iban: string;
  booking_reference: string;
  payment_reference: string;
}

interface Category {
  category: string;
  count: number;
  totalMinor: number;
  percent: number;
  transactions: TxnEntry[];
}

interface VendorGroup {
  vendor: string;
  count: number;
  totalMinor: number;
  minDate: string;
  maxDate: string;
  transactions: TxnEntry[];
}

interface AggregateStats {
  total: number;
  matched: number;
  percent: number;
}

interface DocEntry {
  document_id: string;
  document_date: string;
  total_amount_minor: number;
  supplier_name: string;
  source_system: string;
  filename: string | null;
}

interface DocVendorGroup {
  vendor: string;
  count: number;
  totalMinor: number;
  documents: DocEntry[];
}

interface MatchResult {
  ok: boolean;
  totalTransactions: number;
  totalDocuments: number;
  matchedTransactions: number;
  matchedDocuments: number;
  newMatchedTransactions: number;
  newMatchedDocuments: number;
  matchGroups: number;
  matchPercent: number;
  unmatchedTotal: number;
  categories: Category[];
  missingInvoices: VendorGroup[];
  unmatchedDocs: DocVendorGroup[];
  sourceStats: Record<string, AggregateStats>;
  konten: AggregateStats;
  einnahmen: AggregateStats;
  rechnungen: AggregateStats;
}

const SOURCE_LABELS: Record<string, string> = {
  sparkasse: 'Sparkasse', visa: 'Visa', paypal: 'PayPal', stripe: 'Stripe',
  enablebanking: 'Bank', income: 'Einnahmen', invoice_file: 'Rechnungen',
  extracted_invoice: 'Belegerkennung', amazon: 'Amazon', invoice_scan: 'Scan',
};

function RateCard({ label, stats }: { label: string; stats: AggregateStats }) {
  const pctColor = stats.percent > 80 ? colors.green : stats.percent > 50 ? colors.orange : stats.percent === 0 ? colors.gray : colors.red;
  return (
    <div style={{
      background: '#fff', borderRadius: 8, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      textAlign: 'center', minWidth: 160,
    }}>
      <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: pctColor }}>{stats.percent}%</div>
      <div style={{ fontSize: 12, color: '#999' }}>{stats.matched} von {stats.total}</div>
    </div>
  );
}

const CAT_LABELS: Record<string, string> = {
  fehlende_rechnungen: 'Fehlende Rechnungen',
  offene_zahlungseingänge_paypal: 'Offene Zahlungseingänge PayPal',
  offene_zahlungen_paypal: 'Offene Zahlungen PayPal',
  offene_stripe: 'Offene Stripe-Buchungen',
  offene_eingänge_bank: 'Offene Eingänge Bank',
  offene_erstattungen_visa: 'Offene Erstattungen Visa',
  umbuchungen: 'Umbuchungen',
  kontoführung: 'Kontoführung / Abschluss',
  sonstige: 'Sonstige',
};

const CAT_COLORS: Record<string, string> = {
  fehlende_rechnungen: '#e74c3c',
  offene_zahlungseingänge_paypal: '#3498db',
  offene_zahlungen_paypal: '#2980b9',
  offene_stripe: '#9b59b6',
  offene_eingänge_bank: '#27ae60',
  offene_erstattungen_visa: '#16a085',
  umbuchungen: '#f39c12',
  kontoführung: '#95a5a6',
  sonstige: '#7f8c8d',
};

export function Matching() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [error, setError] = useState('');
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [expandedVendors, setExpandedVendors] = useState<Set<string>>(new Set());
  const [expandedDocVendors, setExpandedDocVendors] = useState<Set<string>>(new Set());
  const [botRunning, setBotRunning] = useState<string | null>(null);
  const [botStatus, setBotStatus] = useState<Record<string, string>>({});
  const [botFiles, setBotFiles] = useState<Record<string, any[]>>({});
  const [openSort, setOpenSort] = useState<'count' | 'amount' | 'name'>('count');
  const { workingYear, quarter } = useWorkingYear();

  // Load current status on mount
  useEffect(() => {
    api.getMatchStatus(workingYear, quarter).then(setResult).catch(() => {});
  }, [workingYear, quarter]);

  const handleMatch = async () => {
    setRunning(true);
    setError('');
    try {
      await api.runMatching();
      setResult(await api.getMatchStatus(workingYear, quarter));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  const refreshStatus = async () => {
    setResult(await api.getMatchStatus(workingYear, quarter));
  };

  const toggleCat = (cat: string) => {
    setExpandedCats(prev => { const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n; });
  };
  const toggleVendor = (v: string) => {
    setExpandedVendors(prev => { const n = new Set(prev); n.has(v) ? n.delete(v) : n.add(v); return n; });
  };

  const handleFetchInvoices = async (vendor: string, minDate: string, maxDate: string) => {
    setBotRunning(vendor);
    setBotStatus(prev => ({ ...prev, [vendor]: 'Starte Bot-Browser...' }));
    try {
      await api.botLaunchBrowser();
      setBotStatus(prev => ({ ...prev, [vendor]: 'Suche Portal...' }));
      const portals = await api.botGetPortals();
      const portal = portals.find((p: any) =>
        vendor.toLowerCase().includes(p.name.toLowerCase()) ||
        p.name.toLowerCase().includes(vendor.toLowerCase().split(' ')[0])
      );
      if (!portal) {
        setBotStatus(prev => ({ ...prev, [vendor]: `Kein Portal für "${vendor}" konfiguriert.` }));
        setBotRunning(null);
        return;
      }
      const start = new Date(minDate);
      start.setDate(start.getDate() - 7);
      const startStr = start.toISOString().slice(0, 10);
      const endStr = maxDate.slice(0, 10);
      setBotStatus(prev => ({ ...prev, [vendor]: `Sammlung ${portal.name} (${startStr} — ${endStr})...` }));
      const run = await api.botStartRun(portal.id, startStr, endStr);
      setBotStatus(prev => ({ ...prev, [vendor]: `Run ${run.id} gestartet...` }));

      let finished = false;
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const rd = await api.botGetRun(run.id);
        if (['completed', 'partial'].includes(rd.status)) {
          const stats = typeof rd.stats === 'string' ? JSON.parse(rd.stats) : rd.stats;
          setBotStatus(prev => ({ ...prev, [vendor]: `${stats.downloaded} heruntergeladen, ${stats.imported} importiert` }));
          finished = true;
          const runFiles = await api.botGetRunFiles(run.id).catch(() => []);
          if (runFiles.length > 0) setBotFiles(prev => ({ ...prev, [vendor]: runFiles }));
          if (stats.imported > 0 || stats.downloaded > 0) {
            const nr = await api.runMatching();
            setResult(nr);
            setBotStatus(prev => ({ ...prev, [vendor]: prev[vendor] + ` — ${nr.newMatchedTransactions} neue Matches` }));
          }
          break;
        }
        if (['failed', 'cancelled'].includes(rd.status)) {
          setBotStatus(prev => ({ ...prev, [vendor]: `Fehlgeschlagen: ${rd.errorMessage || rd.status}` }));
          finished = true; break;
        }
        if (rd.status === 'waiting_for_login') {
          setBotStatus(prev => ({ ...prev, [vendor]: 'Login nötig — bitte im Browser einloggen.' }));
          finished = true; break;
        }
        const events = await api.botGetRunEvents(run.id).catch(() => []);
        const last = events[events.length - 1];
        if (last) setBotStatus(prev => ({ ...prev, [vendor]: last.message }));
      }
      if (!finished) setBotStatus(prev => ({ ...prev, [vendor]: 'Timeout — Run läuft im Hintergrund.' }));
    } catch (err: any) {
      setBotStatus(prev => ({ ...prev, [vendor]: `Fehler: ${err.message}` }));
    } finally {
      setBotRunning(null);
    }
  };

  const handleInvoiceBot = async (vendorName: string, minDate: string, maxDate: string, amountHint: string) => {
    setBotRunning(vendorName);
    setBotStatus(prev => ({ ...prev, [vendorName]: 'Suche Portal-Profil...' }));
    try {
      // Check if portal exists for this vendor
      const { portal } = await api.botFindPortalByVendor(vendorName);
      let portalId: string;

      if (portal) {
        portalId = portal.id;
        setBotStatus(prev => ({ ...prev, [vendorName]: `Portal "${portal.name}" gefunden — starte Sammlung...` }));
      } else {
        // Auto-create new portal
        setBotStatus(prev => ({ ...prev, [vendorName]: 'Erstelle neues Portal-Profil...' }));
        const newPortal = await api.botAutoCreatePortal({
          vendorName,
          dateFrom: minDate.slice(0, 10),
          dateTo: maxDate.slice(0, 10),
          amountHint,
        });
        portalId = newPortal.id;
        setBotStatus(prev => ({ ...prev, [vendorName]: `Portal "${newPortal.name}" erstellt — starte Sammlung...` }));
      }

      // Start collection run
      const run = await api.botStartRun(portalId, minDate.slice(0, 10), maxDate.slice(0, 10));
      setBotStatus(prev => ({ ...prev, [vendorName]: `Run ${run.id} gestartet...` }));

      // Poll for completion
      let finished = false;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const rd = await api.botGetRun(run.id);
        if (['completed', 'partial'].includes(rd.status)) {
          const stats = rd.stats;
          setBotStatus(prev => ({
            ...prev, [vendorName]: `${stats.downloaded} heruntergeladen, ${stats.imported} importiert`,
          }));
          finished = true;
          if (stats.imported > 0 || stats.downloaded > 0) {
            const nr = await api.runMatching();
            setResult(nr);
            setBotStatus(prev => ({
              ...prev, [vendorName]: prev[vendorName] + ` — ${nr.newMatchedTransactions} neue Matches`,
            }));
          }
          break;
        }
        if (['failed', 'cancelled'].includes(rd.status)) {
          setBotStatus(prev => ({
            ...prev, [vendorName]: `Fehlgeschlagen: ${rd.errorMessage || rd.status}`,
          }));
          finished = true;
          break;
        }
        // Show progress from events
        const events = await api.botGetRunEvents(run.id).catch(() => []);
        const last = events[events.length - 1];
        if (last) setBotStatus(prev => ({ ...prev, [vendorName]: last.message }));
      }
      if (!finished) setBotStatus(prev => ({ ...prev, [vendorName]: 'Timeout — Run läuft im Hintergrund.' }));
    } catch (err: any) {
      setBotStatus(prev => ({ ...prev, [vendorName]: `Fehler: ${err.message}` }));
    } finally {
      setBotRunning(null);
    }
  };

  const handleRequestEmail = async (vendor: VendorGroup) => {
    const { email } = await api.getVendorEmail(vendor.vendor);
    const to = email ?? '';
    const n = vendor.count;

    const lines = vendor.transactions.map(t => {
      const date = t.posting_at.slice(0, 10);
      const amount = Math.abs(t.amount_minor / 100).toFixed(2).replace('.', ',');
      const ref = t.booking_reference || t.payment_reference || t.description_raw.slice(0, 40);
      const iban = t.counterparty_iban ? ` – IBAN ${t.counterparty_iban}` : '';
      return `${date} – ${amount} EUR – ${ref}${iban}`;
    }).join('\n');

    const subject = `Anfrage: Fehlende Rechnung${n > 1 ? 'en' : ''} – ${vendor.vendor}`;
    const body = [
      'Sehr geehrte Damen und Herren,',
      '',
      `für die folgende${n > 1 ? 'n' : ''} ${n} Buchung${n > 1 ? 'en' : ''} konnten wir in unserer Ablage keine Rechnung zuordnen. Wir bitten Sie höflich, uns die entsprechenden Belege zukommen zu lassen:`,
      '',
      lines,
      '',
      'Vielen Dank im Voraus.',
      '',
      'Mit freundlichen Grüßen',
    ].join('\n');

    await api.composeEmail(to, subject, body);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 24, margin: 0, color: '#263244' }}>Matching-Zentrale</h1>
          <div style={{ fontSize: 12, color: '#7b8593', marginTop: 5 }}>Zuordnen, prüfen und Abschlussqualität steuern · {quarter ? `Q${quarter} ` : ''}{workingYear}</div>
        </div>
      </div>

      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <Button onClick={handleMatch} disabled={running} color={colors.green}>
            {running ? 'Regeln werden ausgeführt…' : 'Matching-Regeln ausführen'}
          </Button>
          <span style={{ color: '#7a8492', fontSize: 12 }}>Wendet Regeln auf offene Einträge an. Proposed-Gruppen werden dadurch nicht automatisch bestätigt.</span>
          {error && <span style={{ color: colors.red, fontSize: 13 }}>{error}</span>}
          {result && !running && (
            <span style={{ color: colors.green, fontSize: 13 }}>
              {result.newMatchedTransactions} neue Matches gefunden
            </span>
          )}
        </div>
      </Card>

      {result && (
        <>
          <MatchingGovernance result={result} year={workingYear} quarter={quarter} onChanged={refreshStatus} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '24px 0 10px' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18, color: '#2b3544' }}>Offene Arbeit</h2>
              <div style={{ fontSize: 12, color: '#818b98', marginTop: 3 }}>Ungeklärte Buchungen und nicht zugeordnete Rechnungen</div>
            </div>
            <Select value={openSort} onChange={value => setOpenSort(value as 'count' | 'amount' | 'name')} options={[
              { value: 'count', label: 'Nach Anzahl' },
              { value: 'amount', label: 'Nach Betrag' },
              { value: 'name', label: 'Alphabetisch' },
            ]} />
          </div>

          {/* Categories */}
          {result.categories.length > 0 && (
            <Card title={`Offene Einträge nach Buchungsart (${result.unmatchedTotal})`} style={{ marginBottom: 20 }}>
              {[...result.categories].sort((a, b) => openSort === 'amount'
                ? Math.abs(b.totalMinor) - Math.abs(a.totalMinor)
                : openSort === 'name'
                  ? (CAT_LABELS[a.category] || a.category).localeCompare(CAT_LABELS[b.category] || b.category)
                  : b.count - a.count).map(cat => {
                const label = CAT_LABELS[cat.category] || cat.category;
                const color = CAT_COLORS[cat.category] || colors.gray;
                const isExpanded = expandedCats.has(cat.category);
                const isMissing = cat.category === 'fehlende_rechnungen';

                return (
                  <div key={cat.category} style={{ border: '1px solid #eee', borderRadius: 6, marginBottom: 8, overflow: 'hidden' }}>
                    {/* Category header */}
                    <div
                      onClick={() => !isMissing && toggleCat(cat.category)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '10px 14px', background: '#fafafa',
                        cursor: isMissing ? 'default' : 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 4, height: 24, borderRadius: 2, background: color }} />
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
                        <Badge text={`${cat.count}`} color={color} />
                        <span style={{ fontSize: 12, color: '#999' }}>
                          {cat.percent}% der offenen Einträge
                        </span>
                      </div>
                      <Amount value={cat.totalMinor / 100} />
                    </div>

                    {/* For fehlende_rechnungen: show vendor sub-groups */}
                    {isMissing && result.missingInvoices.length > 0 && (
                      <div style={{ borderTop: '1px solid #eee' }}>
                        {[...result.missingInvoices].sort((a, b) => openSort === 'amount'
                          ? Math.abs(b.totalMinor) - Math.abs(a.totalMinor)
                          : openSort === 'name' ? a.vendor.localeCompare(b.vendor) : b.count - a.count).map(vendor => (
                          <div key={vendor.vendor} style={{ borderBottom: '1px solid #f5f5f5' }}>
                            <div
                              onClick={() => toggleVendor(vendor.vendor)}
                              style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                padding: '8px 14px 8px 28px', cursor: 'pointer',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontSize: 13, fontWeight: 500 }}>{vendor.vendor}</span>
                                <Badge text={`${vendor.count}x`} color={colors.orange} />
                                <span style={{ fontSize: 11, color: '#999' }}>
                                  {vendor.minDate.slice(0, 10)} — {vendor.maxDate.slice(0, 10)}
                                </span>
                              </div>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <Amount value={vendor.totalMinor / 100} />
                                {botStatus[vendor.vendor] && (
                                  <span style={{
                                    fontSize: 11, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    color: botStatus[vendor.vendor].includes('Fehler') || botStatus[vendor.vendor].includes('Kein Portal')
                                      ? colors.red : botStatus[vendor.vendor].includes('heruntergeladen') ? colors.green : colors.blue,
                                  }}>
                                    {botStatus[vendor.vendor]}
                                  </span>
                                )}
                                <Button
                                  onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); handleFetchInvoices(vendor.vendor, vendor.minDate, vendor.maxDate); }}
                                  disabled={botRunning !== null}
                                  color={colors.blue}
                                  style={{ fontSize: 11, padding: '3px 8px' }}
                                >
                                  Rechnungen holen
                                </Button>
                                <Button
                                  onClick={async (e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); await handleRequestEmail(vendor); }}
                                  color="#e67e22"
                                  style={{ fontSize: 11, padding: '3px 8px' }}
                                >
                                  per Email anfordern
                                </Button>
                                <Button
                                  onClick={async (e: React.MouseEvent<HTMLButtonElement>) => {
                                    e.stopPropagation();
                                    await handleInvoiceBot(vendor.vendor, vendor.minDate, vendor.maxDate,
                                      Math.abs(vendor.totalMinor / 100).toFixed(2) + ' EUR');
                                  }}
                                  disabled={botRunning !== null}
                                  color="#8e24aa"
                                  style={{ fontSize: 11, padding: '3px 8px' }}
                                >
                                  Invoice Bot
                                </Button>
                              </div>
                            </div>

                            {/* Downloaded files */}
                            {botFiles[vendor.vendor]?.length > 0 && (
                              <div style={{ padding: '4px 28px 8px', background: '#f0faf0' }}>
                                {botFiles[vendor.vendor].map((f: any) => (
                                  <div key={f.id} style={{ fontSize: 12, padding: '2px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <a href={`/api/invoice-bot/files/${f.id}/open`} target="_blank" rel="noreferrer"
                                      style={{ color: colors.blue, textDecoration: 'none', borderBottom: '1px dashed #2980b9' }}>
                                      {f.originalFilename}
                                    </a>
                                    {f.invoiceDate && <span style={{ color: '#999' }}>{f.invoiceDate}</span>}
                                    <Badge text={f.importStatus} color={
                                      f.importStatus === 'imported' ? colors.green :
                                      f.importStatus === 'duplicate' ? colors.orange : colors.gray
                                    } />
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Expanded vendor transactions */}
                            {expandedVendors.has(vendor.vendor) && (
                              <div style={{ padding: '0 28px 8px' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                  <thead><tr>
                                    <th style={thStyle}>Datum</th><th style={thStyle}>Betrag</th><th style={thStyle}>Beschreibung</th>
                                  </tr></thead>
                                  <tbody>
                                    {vendor.transactions.map(t => (
                                      <tr key={t.transaction_id} style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }}
                                        onClick={() => { window.location.href = `/?highlight=${encodeURIComponent(t.transaction_id)}&source=${encodeURIComponent(t.source_system)}`; }}
                                        onMouseOver={e => (e.currentTarget.style.background = '#f0f7ff')}
                                        onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                                        <td style={tdStyle}>{t.posting_at.slice(0, 10)}</td>
                                        <td style={tdStyle}><Amount value={t.amount_minor / 100} /></td>
                                        <td style={tdStyle}>{t.description_raw}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* For other categories: expandable transaction list */}
                    {!isMissing && isExpanded && (
                      <div style={{ padding: '0 14px 10px', borderTop: '1px solid #eee' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead><tr style={{ background: '#f8f8f8' }}>
                            <th style={thStyle}>Datum</th><th style={thStyle}>Betrag</th>
                            <th style={thStyle}>Empfänger</th><th style={thStyle}>Beschreibung</th>
                          </tr></thead>
                          <tbody>
                            {cat.transactions.slice(0, 30).map(t => (
                              <tr key={t.transaction_id} style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }}
                                onClick={() => { window.location.href = `/?highlight=${encodeURIComponent(t.transaction_id)}&source=${encodeURIComponent(t.source_system)}`; }}
                                onMouseOver={e => (e.currentTarget.style.background = '#f0f7ff')}
                                onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                                <td style={tdStyle}>{t.posting_at.slice(0, 10)}</td>
                                <td style={tdStyle}><Amount value={t.amount_minor / 100} /></td>
                                <td style={tdStyle}>{t.counterparty_name}</td>
                                <td style={{ ...tdStyle, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {t.description_raw}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {cat.transactions.length > 30 && (
                          <div style={{ fontSize: 11, color: '#999', padding: 4 }}>
                            ... und {cat.transactions.length - 30} weitere
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
          )}
          {/* Unmatched Documents by Vendor */}
          {result.unmatchedDocs?.length > 0 && (
            <Card title={`Offene Rechnungen nach Lieferant (${result.unmatchedDocs.reduce((s, v) => s + v.count, 0)})`} style={{ marginBottom: 20 }}>
              {[...result.unmatchedDocs].sort((a, b) => openSort === 'amount'
                ? Math.abs(b.totalMinor) - Math.abs(a.totalMinor)
                : openSort === 'name' ? a.vendor.localeCompare(b.vendor) : b.count - a.count).map(vg => {
                const isExp = expandedDocVendors.has(vg.vendor);
                return (
                  <div key={vg.vendor} style={{ borderBottom: '1px solid #f5f5f5' }}>
                    <div
                      onClick={() => setExpandedDocVendors(prev => { const n = new Set(prev); n.has(vg.vendor) ? n.delete(vg.vendor) : n.add(vg.vendor); return n; })}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '8px 14px', cursor: 'pointer',
                      }}
                      onMouseOver={e => (e.currentTarget.style.background = '#fafafa')}
                      onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{vg.vendor}</span>
                        <Badge text={`${vg.count}x`} color={colors.orange} />
                      </div>
                      <Amount value={vg.totalMinor / 100} />
                    </div>
                    {isExp && (
                      <div style={{ padding: '0 14px 8px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead><tr style={{ background: '#f8f8f8' }}>
                            <th style={thStyle}>Datum</th><th style={thStyle}>Betrag</th>
                            <th style={thStyle}>Quelle</th><th style={thStyle}>Dokument</th>
                          </tr></thead>
                          <tbody>
                            {vg.documents.map(d => (
                              <tr key={d.document_id} style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }}
                                onClick={() => { window.location.href = `/rechnungen?highlight=${encodeURIComponent(d.document_id)}`; }}
                                onMouseOver={e => (e.currentTarget.style.background = '#f0f7ff')}
                                onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                                <td style={tdStyle}>{d.document_date?.slice(0, 10) ?? '—'}</td>
                                <td style={tdStyle}><Amount value={d.total_amount_minor / 100} /></td>
                                <td style={tdStyle}>{SOURCE_LABELS[d.source_system] || d.source_system}</td>
                                <td style={{ ...tdStyle, maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {d.filename ?? d.document_id.slice(0, 20)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid #ddd', color: '#666', fontWeight: 600, fontSize: 11,
};
const tdStyle: React.CSSProperties = {
  padding: '5px 10px', verticalAlign: 'top',
};
