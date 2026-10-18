import { useLegacyText } from '../../i18n/legacy';
import { legacyAccountingEnglish, accountingNoticeText, type AccountingNotice } from '../../i18n/legacy-accounting';
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Amount, Badge, Button, Card, FileLink, SearchInput, Select, colors, formatDate } from '../shared';

type Tab = 'overview' | 'review' | 'report';
type SortKey = 'created_at' | 'amount' | 'rule' | 'transactions' | 'documents';

interface MetricBucket {
  groups: number;
  transactions: number;
  documents: number;
  amountMinor: number;
}

interface RuleBucket {
  groups: number;
  proposed: number;
  confirmed: number;
  transactions: number;
  documents: number;
  amountMinor: number;
}

interface MatchingGovernanceProps {
  result: any;
  year: number;
  quarter: number | null;
  onChanged: () => Promise<void> | void;
  allowOriginalFiles?: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  accepted: 'Akzeptiert', confirmed: 'Bestätigt', manual: 'Manuell', proposed: "Vorgeschlagen", rejected: 'Verworfen',
};

const SOURCE_LABELS: Record<string, string> = {
  sparkasse: 'Sparkasse', visa: 'Visa', paypal: 'PayPal', stripe: 'Stripe', enablebanking: 'Bank',
  income: 'Einnahmen', invoice_file: 'Rechnungen', extracted_invoice: 'Belegerkennung', amazon: 'Amazon',
  invoice_scan: 'Scan', bank_fee: 'Bankbelege', stripe_fee: 'Stripe-Gebühren', aliexpress: 'AliExpress',
};

const statusColor = (status: string) => status === 'proposed' ? colors.blue
  : ['accepted', 'confirmed', 'manual'].includes(status) ? colors.green
    : status === 'rejected' ? colors.red : colors.gray;

const periodLabel = (year: number, quarter: number | null) => quarter ? `Q${quarter} ${year}` : String(year);

const QUALITY_LABELS: Record<string, { label: string; color: string; critical?: boolean }> = {
  PAYPAL_EVENT_NOT_T0300: { label: 'PayPal-Bein ≠ T0300', color: colors.red, critical: true },
  PHYSICAL_EVIDENCE_REUSED: { label: 'Beleg mehrfach verwendet', color: colors.red, critical: true },
  AMOUNT_MISMATCH: { label: 'Betrag abweichend', color: colors.red, critical: true },
  LONG_DATE_GAP: { label: 'Großer Datumsabstand', color: colors.orange },
  MISSING_EVIDENCE: { label: 'Evidenz fehlt', color: colors.orange },
  NO_DOCUMENT: { label: 'Ohne Dokument', color: colors.gray },
};

function Kpi({ label, value, hint, tone = '#24324a' }: { label: string; value: React.ReactNode; hint: string; tone?: string }) {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  return (
    <div style={{ padding: '17px 18px', border: '1px solid #e4e9f0', borderRadius: 10, background: '#fff', minWidth: 180, flex: '1 1 180px' }}>
      <div style={{ fontSize: 12, color: '#6b7585', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 28, lineHeight: 1.2, fontWeight: 750, color: tone, margin: '7px 0 4px' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#8b94a3', lineHeight: 1.35 }}>{hint}</div>
    </div>
  );
}

function ProgressLine({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  const percent = total > 0 ? Math.min(100, Math.round(value / total * 1000) / 10) : 0;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
        <span style={{ fontWeight: 600, color: '#3b4658' }}>{label}</span>
        <span style={{ color: '#6f7887' }}>{value} / {total} · {percent}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 8, background: '#edf1f5', overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', background: color, borderRadius: 8 }} />
      </div>
    </div>
  );
}

function SortButton({ label, field, active, order, onSort }: {
  label: string; field: SortKey; active: SortKey; order: 'asc' | 'desc'; onSort: (field: SortKey) => void;
}) {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  return (
    <button onClick={() => onSort(field)} style={{ border: 0, padding: 0, background: 'transparent', color: active === field ? '#1d5fa7' : '#5f6978', fontWeight: 700, cursor: 'pointer', fontSize: 11 }}>
      {label} {active === field ? (order === 'asc' ? '▲' : '▼') : '↕'}
    </button>
  );
}

export function MatchingGovernance({ result, year, quarter, onChanged, allowOriginalFiles = true }: MatchingGovernanceProps) {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  const [tab, setTab] = useState<Tab>('overview');
  const [proposed, setProposed] = useState<any[]>([]);
  const [proposedTotal, setProposedTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<AccountingNotice | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('created_at');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const pageSize = 40;

  const statusStats = (result.statusStats ?? {}) as Record<string, MetricBucket>;
  const ruleStats = (result.ruleStats ?? {}) as Record<string, RuleBucket>;
  const qualityStats = (result.qualityStats ?? {}) as Record<string, number>;
  const proposedGroups = statusStats.proposed?.groups ?? 0;
  const confirmedGroups = Object.entries(statusStats)
    .filter(([status]) => ['accepted', 'confirmed', 'manual'].includes(status))
    .reduce((sum, [, bucket]) => sum + bucket.groups, 0);
  const criticalGroups = Object.entries(qualityStats)
    .filter(([signal]) => QUALITY_LABELS[signal]?.critical)
    .reduce((sum, [, count]) => sum + count, 0);
  const period = periodLabel(year, quarter);

  const loadProposed = async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {
        status: 'proposed', year: String(year), limit: '99999', search,
        sort, order,
      };
      if (quarter) params.quarter = String(quarter);
      const data = await api.getMatches(params);
      setProposed(data.items ?? []);
      setProposedTotal(data.total ?? 0);
    } catch (err: any) {
      setMessage({ key: "Fehler beim Laden: {p0}", values: { p0: err.message }, error: true });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tab !== 'review') return;
    const timer = window.setTimeout(loadProposed, 180);
    return () => window.clearTimeout(timer);
  }, [tab, year, quarter, search, sort, order]);

  useEffect(() => { setPage(1); }, [search, sort, order, year, quarter]);

  const accept = async (group: any) => {
    const label = `${group.rule_id} / ${group.match_group_id}`;
    if (!window.confirm(text("Diesen Vorschlag fachlich akzeptieren?\n\n{p0}", { p0: label }))) return;
    setLoading(true);
    try {
      await api.acceptMatch(group.match_group_id, `Geprüft und akzeptiert in der Matching-Übersicht (${period})`);
      setMessage({ key: "Match {p0} wurde akzeptiert.", values: { p0: group.match_group_id } });
      await Promise.all([loadProposed(), Promise.resolve(onChanged())]);
    } catch (err: any) {
      setMessage({ key: "Akzeptieren fehlgeschlagen: {p0}", values: { p0: err.message }, error: true });
      setLoading(false);
    }
  };

  const reject = async (group: any) => {
    const reason = window.prompt(text('Warum soll dieser Vorschlag verworfen werden? Die Gruppe wird entfernt und die Einträge werden wieder freigegeben.'));
    if (reason === null) return;
    if (!window.confirm(text("Vorschlag {p0} wirklich entfernen?", { p0: group.match_group_id }))) return;
    setLoading(true);
    try {
      await api.deleteMatch(group.match_group_id, reason.trim() || 'In der Proposed-Prüfung verworfen');
      setMessage({ key: "Vorschlag verworfen{p0}", values: { p0: reason.trim() ? `: ${reason.trim()}` : '.' } });
      await Promise.all([loadProposed(), Promise.resolve(onChanged())]);
    } catch (err: any) {
      setMessage({ key: "Verwerfen fehlgeschlagen: {p0}", values: { p0: err.message }, error: true });
      setLoading(false);
    }
  };

  const handleSort = (field: SortKey) => {
    if (sort === field) setOrder(value => value === 'asc' ? 'desc' : 'asc');
    else { setSort(field); setOrder('asc'); }
  };

  const reportRules = useMemo(() => Object.entries(ruleStats)
    .sort((a, b) => b[1].groups - a[1].groups), [ruleStats]);
  const reportSources = useMemo(() => Object.entries(result.sourceStats ?? {})
    .sort((a: any, b: any) => b[1].total - a[1].total), [result.sourceStats]);
  const pageItems = proposed.slice((page - 1) * pageSize, page * pageSize);
  const pages = Math.max(1, Math.ceil(proposed.length / pageSize));

  const exportCsv = () => {
    const rows = [['Regel', 'Gruppen', 'Proposed', 'Bestaetigt', 'Transaktionen', 'Dokumente', 'Betrag_EUR']];
    for (const [rule, data] of reportRules) {
      rows.push([rule, data.groups, data.proposed, data.confirmed, data.transactions, data.documents, (data.amountMinor / 100).toFixed(2)] as any[]);
    }
    const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `matchbericht-${period.replace(' ', '-')}.csv`; link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid #dfe5ec', marginBottom: 16, flexWrap: 'wrap' }}>
        {([
          ['overview', text("Übersicht")],
          ['review', text("Proposed prüfen ({p0})", { p0: proposedGroups })],
          ['report', text("Matchbericht")],
        ] as Array<[Tab, string]>).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            border: 0, borderBottom: tab === id ? '3px solid #2f74b5' : '3px solid transparent',
            padding: '10px 14px', background: 'transparent', color: tab === id ? '#1f568a' : '#6d7785',
            fontWeight: tab === id ? 700 : 600, cursor: 'pointer', fontSize: 13,
          }}>{label}</button>
        ))}
      </div>

      {message && (
        <div style={{ padding: '10px 12px', borderRadius: 7, background: message.error ? '#fff0ef' : '#edf8f1', color: message.error ? '#a83b31' : '#257246', fontSize: 12, marginBottom: 12 }}>
          {accountingNoticeText(text, message)}
        </div>
      )}

      {tab === 'overview' && (
        <>
          {proposedGroups > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', flexWrap: 'wrap', padding: '14px 16px', border: '1px solid #cfe0f2', borderLeft: '5px solid #2f74b5', borderRadius: 9, background: '#f5f9fd', marginBottom: 14 }}>
              <div>
                <div style={{ fontWeight: 750, color: '#234f7b', fontSize: 14 }}>{proposedGroups} {text("Gruppen warten auf fachliche Prüfung")}</div>
                <div style={{ color: '#60748a', fontSize: 12, marginTop: 3 }}>{text("Diese Vorschläge sind technisch zugeordnet, zählen aber nicht als bestätigter Abschluss.")}</div>
              </div>
              <Button onClick={() => setTab('review')} color="#2f74b5">{text("Prüfung öffnen")}</Button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
            <Kpi label={text("Fachlich bestätigt")} value={`${result.confirmedPercent ?? 0}%`} hint={text("{p0} von {p1} Transaktionen", { p0: result.confirmedTransactions ?? 0, p1: result.totalTransactions })} tone={colors.green} />
            <Kpi label={text("Technisch zugeordnet")} value={`${result.matchPercent}%`} hint={text("Enthält Proposed und Sonderdispositionen")} tone="#2f74b5" />
            <Kpi label={text("Vorgeschlagen")} value={proposedGroups} hint={text("{p0} Transaktionen zur Prüfung", { p0: statusStats.proposed?.transactions ?? 0 })} tone={colors.orange} />
            <Kpi label={text("Operativ offen")} value={result.unmatchedTotal} hint={text("Noch ohne Match oder genehmigte Disposition")} tone={result.unmatchedTotal ? colors.red : colors.green} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1.1fr) minmax(280px, .9fr)', gap: 14 }}>
            <Card title={text("Fortschritt {p0}", { p0: period })}>
              <ProgressLine label={text("Fachlich bestätigt")} value={result.confirmedTransactions ?? 0} total={result.totalTransactions} color={colors.green} />
              <ProgressLine label={text("Technisch zugeordnet")} value={result.matchedTransactions} total={result.totalTransactions} color="#2f74b5" />
              <ProgressLine label={text("Dokumente zugeordnet")} value={result.matchedDocuments} total={result.totalDocuments} color="#8e62bb" />
              <div style={{ fontSize: 11, color: '#8b94a3', marginTop: 10 }}>{text("Die fachliche Quote zählt nur akzeptierte, bestätigte oder manuelle Gruppen sowie genehmigte Sonderdispositionen.")}</div>
            </Card>
            <Card title={text("Prüfsignale")}>
              {[
                { label: text("Proposed-Gruppen"), value: proposedGroups, color: colors.blue, action: () => setTab('review') },
                { label: text("Kritische automatische Signale"), value: criticalGroups, color: colors.red, action: () => setTab('review') },
                { label: text("Gruppen ohne Dokument"), value: result.groupsWithoutDocuments ?? 0, color: colors.orange },
                { label: text("Offene Transaktionen"), value: result.unmatchedTotal, color: colors.red },
                { label: text("Offene Rechnungen"), value: result.unmatchedDocs?.reduce((sum: number, row: any) => sum + row.count, 0) ?? 0, color: '#8e62bb' },
              ].map(item => (
                <button key={item.label} onClick={item.action} disabled={!item.action} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', border: 0, borderBottom: '1px solid #edf0f3', background: 'transparent', cursor: item.action ? 'pointer' : 'default' }}>
                  <span style={{ fontSize: 13, color: '#495466' }}>{item.label}</span>
                  <Badge text={String(item.value)} color={item.color} />
                </button>
              ))}
            </Card>
          </div>
        </>
      )}

      {tab === 'review' && (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 17, color: '#2b3442' }}>{text("Proposed-Gruppen prüfen")}</h3>
              <p style={{ margin: '5px 0 0', fontSize: 12, color: '#727d8c', maxWidth: 680 }}>{text("Prüfe Referenz, Gegenpartei, Betrag, Datum und Originalbeleg. Akzeptieren bestätigt den Vorschlag auditierbar; Verwerfen löst die Gruppe auf.")}</p>
            </div>
            <Badge text={text("{p0} offen", { p0: proposedTotal })} color={proposedTotal ? colors.blue : colors.green} />
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
            <SearchInput value={search} onChange={setSearch} placeholder={text("Regel, Lieferant, Referenz oder ID…")} />
            <Select value={sort} onChange={value => setSort(value as SortKey)} options={[
              { value: 'created_at', label: text("Nach Erstellzeit") }, { value: 'amount', label: text("Nach Betrag") },
              { value: 'rule', label: text("Nach Regel") }, { value: 'transactions', label: text("Nach Transaktionen") },
              { value: 'documents', label: text("Nach Dokumenten") },
            ]} />
            <button onClick={() => setOrder(value => value === 'asc' ? 'desc' : 'asc')} style={secondaryBtn}>{order === 'asc' ? text("Aufsteigend ↑") : text("Absteigend ↓")}</button>
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid #e5e9ee', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ background: '#f7f9fb' }}>
                <th style={th}><SortButton label={text("Regel")} field="rule" active={sort} order={order} onSort={handleSort} /></th>
                <th style={th}>{text("Buchung / Partner")}</th>
                <th style={th}><SortButton label={text("Betrag")} field="amount" active={sort} order={order} onSort={handleSort} /></th>
                <th style={th}><SortButton label={text("Belege")} field="documents" active={sort} order={order} onSort={handleSort} /></th>
                <th style={th}>{text("Prüfsignal")}</th><th style={{ ...th, textAlign: 'right' }}>{text("Aktion")}</th>
              </tr></thead>
              <tbody>
                {pageItems.map(group => {
                  const tx = group.transactions?.[0];
                  const signals: string[] = group.quality_signals ?? [];
                  const isExpanded = expanded === group.match_group_id;
                  return (
                    <React.Fragment key={group.match_group_id}>
                      <tr style={{ borderTop: '1px solid #edf0f3', background: isExpanded ? '#f8fbfe' : '#fff' }}>
                        <td style={td}><code style={{ fontSize: 10.5, color: '#355675' }}>{group.rule_id}</code><div style={muted}>{formatDate(group.created_at)}</div></td>
                        <td style={{ ...td, minWidth: 240 }}><div style={{ fontWeight: 650, color: '#303b4a' }}>{tx?.counterparty_name || tx?.description_raw || text("Interne Abstimmung")}</div><div style={muted}>{tx ? `${formatDate(tx.posting_at)} · ${tx.source_system}` : text("{p0} Transaktionen", { p0: group.transactions?.length ?? 0 })}</div></td>
                        <td style={td}><Amount value={group.amount_total} /></td>
                        <td style={td}><span style={{ fontWeight: 650 }}>{group.documents?.length ?? 0}</span>{group.documents?.[0] && <div style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{allowOriginalFiles ? <FileLink filename={group.documents[0].filename ?? group.documents[0].source_document_ref} /> : <span>{group.documents[0].filename ?? group.documents[0].source_document_ref}</span>}</div>}</td>
                        <td style={{ ...td, minWidth: 170 }}>{signals.length ? <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{signals.map(signal => { const meta = QUALITY_LABELS[signal] ?? { label: signal, color: colors.gray }; return <Badge key={signal} text={text(meta.label)} color={meta.color} />; })}</div> : <Badge text={text("Keine Warnung")} color={colors.green} />}</td>
                        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button onClick={() => setExpanded(isExpanded ? null : group.match_group_id)} style={secondaryBtn}>{isExpanded ? text("Schließen") : text("Prüfen")}</button>{' '}
                          <button onClick={() => accept(group)} disabled={loading} style={{ ...actionBtn, background: colors.green }}>{text("Akzeptieren")}</button>{' '}
                          <button onClick={() => reject(group)} disabled={loading} style={{ ...actionBtn, background: '#fff', color: colors.red, border: `1px solid ${colors.red}` }}>{text("Verwerfen")}</button>
                        </td>
                      </tr>
                      {isExpanded && <tr><td colSpan={6} style={{ padding: 0 }}><GroupDetail group={group} allowOriginalFiles={allowOriginalFiles} /></td></tr>}
                    </React.Fragment>
                  );
                })}
                {!loading && pageItems.length === 0 && <tr><td colSpan={6} style={{ padding: 28, textAlign: 'center', color: '#8892a0' }}>{text("Keine vorgeschlagenen Gruppen für diesen Filter.")}</td></tr>}
                {loading && pageItems.length === 0 && <tr><td colSpan={6} style={{ padding: 28, textAlign: 'center', color: '#8892a0' }}>{text("Wird geladen…")}</td></tr>}
              </tbody>
            </table>
          </div>
          {pages > 1 && <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <button onClick={() => setPage(value => Math.max(1, value - 1))} disabled={page === 1} style={secondaryBtn}>{text("Zurück")}</button>
            <span style={{ fontSize: 12, color: '#687383' }}>{text("Seite")} {page} {text("von")} {pages}</span>
            <button onClick={() => setPage(value => Math.min(pages, value + 1))} disabled={page === pages} style={secondaryBtn}>{text("Weiter")}</button>
          </div>}
        </Card>
      )}

      {tab === 'report' && (
        <div id="matching-report">
          <Card style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div><h3 style={{ margin: 0, fontSize: 18 }}>{text("Matchbericht")} {period}</h3><div style={{ fontSize: 12, color: '#7a8492', marginTop: 5 }}>{text("Live-Bericht aus dem aktuellen Matching-Zustand · vorgeschlagene und bestätigte Gruppen getrennt")}</div></div>
              <div style={{ display: 'flex', gap: 8 }}><button onClick={exportCsv} style={secondaryBtn}>{text("CSV exportieren")}</button><button onClick={() => window.print()} style={secondaryBtn}>{text("Drucken / PDF")}</button></div>
            </div>
          </Card>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
            <Kpi label={text("Transaktionen")} value={result.totalTransactions} hint={text("{p0} operativ offen", { p0: result.unmatchedTotal })} />
            <Kpi label={text("Bestätigte Quote")} value={`${result.confirmedPercent ?? 0}%`} hint={text("{p0} bestätigte Gruppen", { p0: confirmedGroups })} tone={colors.green} />
            <Kpi label={text("Vorgeschlagen")} value={proposedGroups} hint={text("Noch nicht fachlich freigegeben")} tone={colors.orange} />
            <Kpi label={text("Dokumente")} value={`${result.matchedDocuments}/${result.totalDocuments}`} hint={text("{p0} ohne Zuordnung", { p0: result.totalDocuments - result.matchedDocuments })} tone="#8e62bb" />
          </div>
          <Card title={text("Workflowstatus")} style={{ marginBottom: 14 }}>
            <ReportTable headers={['Status', text("Gruppen"), text("Transaktionen"), text("Dokumente"), text("Betrag")]} rows={Object.entries(statusStats).sort((a, b) => b[1].groups - a[1].groups).map(([status, data]) => [<Badge text={text(STATUS_LABELS[status] ?? status)} color={statusColor(status)} />, data.groups, data.transactions, data.documents, <Amount value={data.amountMinor / 100} />])} />
          </Card>
          <Card title={text("Automatische Prüfsignale")} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: '#7b8593', marginBottom: 8 }}>{text("Signale priorisieren die manuelle Prüfung; sie sind kein automatisches Fehlurteil.")}</div>
            <ReportTable headers={[text("Signal"), text("Betroffene Gruppen"), text("Priorität")]} rows={Object.entries(qualityStats).sort((a, b) => b[1] - a[1]).map(([signal, count]) => { const meta = QUALITY_LABELS[signal] ?? { label: signal, color: colors.gray }; return [<Badge text={text(meta.label)} color={meta.color} />, count, meta.critical ? text("Kritisch") : text("Prüfen")]; })} />
          </Card>
          <Card title={text("Regelabdeckung")} style={{ marginBottom: 14 }}>
            <ReportTable headers={[text("Regel"), text("Gruppen"), text("Vorgeschlagen"), text("Bestätigt"), text("Transaktionen"), text("Dokumente"), text("Betrag")]} rows={reportRules.map(([rule, data]) => [<code style={{ fontSize: 11 }}>{rule}</code>, data.groups, data.proposed, data.confirmed, data.transactions, data.documents, <Amount value={data.amountMinor / 100} />])} />
          </Card>
          <Card title={text("Abdeckung nach Quelle")}>
            <ReportTable headers={[text("Quelle"), text("Erledigt"), text("Gesamt"), text("Quote")]} rows={reportSources.map(([source, data]: any) => [text(SOURCE_LABELS[source] ?? source), data.matched, data.total, `${data.percent}%`])} />
          </Card>
        </div>
      )}
    </section>
  );
}

function GroupDetail({ group, allowOriginalFiles = true }: { group: any; allowOriginalFiles?: boolean }) {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  return (
    <div style={{ padding: '14px 18px 16px', background: '#f7fafc', borderTop: '1px solid #dfe8f0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        <div><div style={detailTitle}>{text("Transaktionen")}</div>{group.transactions?.map((tx: any) => <div key={tx.transaction_id} style={detailBox}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><b>{formatDate(tx.posting_at)} · {tx.source_system}</b><Amount value={tx.amount} /></div><div style={{ marginTop: 4 }}>{tx.counterparty_name || tx.description_raw}</div><code style={detailCode}>{tx.transaction_id}</code></div>)}</div>
        <div><div style={detailTitle}>{text("Dokumente")}</div>{group.documents?.length ? group.documents.map((doc: any) => <div key={doc.document_id} style={detailBox}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>{allowOriginalFiles ? <FileLink filename={doc.filename ?? doc.source_document_ref} /> : <span>{doc.filename ?? doc.source_document_ref}</span>}<Amount value={doc.amount} /></div><div style={{ marginTop: 4 }}>{doc.supplier_name || doc.source_system} · {formatDate(doc.document_date)}</div><code style={detailCode}>{doc.document_id}</code></div>) : <div style={{ ...detailBox, color: '#a16816' }}>{text("Kein Dokument verknüpft. Bei Transfers oder Gebühren kann das fachlich korrekt sein; Evidenz und Regel besonders prüfen.")}</div>}</div>
      </div>
      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div><div style={detailTitle}>{text("Evidenz")}</div><pre style={pre}>{JSON.stringify(group.evidence ?? {}, null, 2)}</pre></div>
        <div><div style={detailTitle}>{text("Begründungscodes")}</div><div style={{ ...detailBox, minHeight: 48 }}>{group.reason_codes?.length ? group.reason_codes.map((code: string) => <Badge key={code} text={code} color="#6c7d90" />) : <span style={{ color: '#8d96a2' }}>{text("Keine Reason Codes gespeichert")}</span>}</div><code style={detailCode}>{group.match_group_id}</code></div>
      </div>
    </div>
  );
}

function ReportTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  return <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}><thead><tr>{headers.map(header => <th key={header} style={th}>{header}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i} style={{ borderTop: '1px solid #edf0f3' }}>{row.map((cell, j) => <td key={j} style={td}>{cell}</td>)}</tr>)}</tbody></table></div>;
}

const th: React.CSSProperties = { textAlign: 'left', padding: '9px 10px', color: '#5f6978', fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '9px 10px', verticalAlign: 'middle', color: '#384354' };
const muted: React.CSSProperties = { color: '#8a94a2', fontSize: 10.5, marginTop: 4 };
const secondaryBtn: React.CSSProperties = { padding: '6px 10px', borderRadius: 5, border: '1px solid #ccd4dd', background: '#fff', color: '#4e5b6b', cursor: 'pointer', fontSize: 11, fontWeight: 650 };
const actionBtn: React.CSSProperties = { padding: '6px 9px', borderRadius: 5, border: 0, color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 700 };
const detailTitle: React.CSSProperties = { fontSize: 11, fontWeight: 750, textTransform: 'uppercase', letterSpacing: '.04em', color: '#697586', marginBottom: 6 };
const detailBox: React.CSSProperties = { padding: 10, border: '1px solid #e0e6ec', borderRadius: 6, background: '#fff', marginBottom: 7, fontSize: 11.5 };
const detailCode: React.CSSProperties = { display: 'block', marginTop: 5, fontSize: 9.5, color: '#8490a0', wordBreak: 'break-all' };
const pre: React.CSSProperties = { margin: 0, padding: 10, borderRadius: 6, border: '1px solid #e0e6ec', background: '#fff', fontSize: 10, whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' };
