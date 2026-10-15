import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, StatCard, Button, colors } from '../components/shared';

export function Reports() {
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getReportSummary().then(setReport).finally(() => setLoading(false));
  }, []);

  if (loading) return <p>Loading...</p>;
  if (!report) return <p>Report konnte nicht geladen werden.</p>;

  const { summary: s } = report;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22 }}>Reports</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => { window.location.href = api.downloadReportJson(); }} color="#27ae60">
            Export JSON
          </Button>
          <Button onClick={() => { window.location.href = api.downloadReportCsv(); }} color="#2980b9">
            Export CSV
          </Button>
        </div>
      </div>

      {/* Run metadata */}
      <Card style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 32, fontSize: 13, color: '#666' }}>
          <div><b>Report ID:</b> <code>{report.report_id}</code></div>
          <div><b>Run ID:</b> <code>{report.run_id}</code></div>
          <div><b>Created:</b> {new Date(report.created_at).toLocaleString('de-DE')}</div>
          <div><b>Schema:</b> {Object.entries(report.schema_versions as Record<string, string>).map(([k, v]) => `${k} ${v}`).join(', ')}</div>
        </div>
      </Card>

      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        <StatCard label="Transaktionen" value={s.total_transactions} />
        <StatCard label="Matched" value={s.matched_transactions} color={colors.green} sub={pct(s.matched_transactions, s.total_transactions)} />
        <StatCard label="Unmatched" value={s.unmatched_transactions} color={colors.orange} />
        <StatCard label="Excluded" value={s.excluded_transactions} color={colors.gray} />
        <StatCard label="Dokumente" value={s.total_documents} />
        <StatCard label="Matched Docs" value={s.matched_documents} color={colors.green} sub={pct(s.matched_documents, s.total_documents)} />
        <StatCard label="Match Groups" value={s.match_groups_count} color={colors.blue} />
      </div>

      {/* Per-currency totals */}
      {report.currency_totals?.length > 0 && (
        <Card title="Summen pro Währung" style={{ marginBottom: 24 }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Währung</th>
                <th style={th}>Einnahmen</th>
                <th style={th}>Ausgaben</th>
                <th style={th}>Netto</th>
                <th style={th}>Transaktionen</th>
              </tr>
            </thead>
            <tbody>
              {report.currency_totals.map((ct: any) => (
                <tr key={ct.currency_code} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={td}><b>{ct.currency_code}</b></td>
                  <td style={{ ...td, color: colors.green }}>{fmtCur(ct.total_income_minor, ct.currency_code)}</td>
                  <td style={{ ...td, color: colors.red }}>{fmtCur(ct.total_expense_minor, ct.currency_code)}</td>
                  <td style={td}><b>{fmtCur(ct.net_minor, ct.currency_code)}</b></td>
                  <td style={td}>{ct.transaction_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* VAT summary */}
      {report.vat_summary?.length > 0 && (
        <Card title="USt nach Steuerkategorie" style={{ marginBottom: 24 }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Kategorie</th>
                <th style={th}>Dokumente</th>
                <th style={th}>Brutto</th>
                <th style={th}>Netto</th>
                <th style={th}>USt</th>
              </tr>
            </thead>
            <tbody>
              {report.vat_summary.map((vs: any, i: number) => (
                <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={td}>{catBadge(vs.tax_category)}</td>
                  <td style={td}>{vs.document_count}</td>
                  <td style={td}>{fmtEur(vs.gross_amount_minor)}</td>
                  <td style={td}>{fmtEur(vs.net_amount_minor)}</td>
                  <td style={td}><b>{fmtEur(vs.vat_amount_minor)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* By source */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        <Card title="Transaktionen nach Quelle" style={{ flex: 1, minWidth: 300 }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Quelle</th>
                <th style={th}>Gesamt</th>
                <th style={th}>Matched</th>
                <th style={th}>Unmatched</th>
                <th style={th}>Excluded</th>
                <th style={th}>Rate</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(s.by_source as Record<string, any>).map(([src, v]) => (
                <tr key={src} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={td}><b>{src}</b></td>
                  <td style={td}>{v.total}</td>
                  <td style={{ ...td, color: colors.green }}>{v.matched}</td>
                  <td style={{ ...td, color: colors.orange }}>{v.unmatched}</td>
                  <td style={{ ...td, color: colors.gray }}>{v.excluded}</td>
                  <td style={td}>{pct(v.matched, v.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Matches nach Regel" style={{ flex: 1, minWidth: 300 }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr><th style={th}>Regel</th><th style={th}>Anzahl</th></tr>
            </thead>
            <tbody>
              {Object.entries(s.by_rule as Record<string, number>)
                .sort(([, a], [, b]) => b - a)
                .map(([rule, count]) => (
                  <tr key={rule} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={td}><code>{rule}</code></td>
                    <td style={td}><b>{count}</b></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Card>
      </div>

      {/* Validation errors */}
      {report.errors?.length > 0 && (
        <Card title={`Validierungsfehler (${report.errors.length})`}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Entität</th>
                <th style={th}>Code</th>
                <th style={th}>Meldung</th>
              </tr>
            </thead>
            <tbody>
              {report.errors.map((e: any, i: number) => (
                <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={td}><code style={{ fontSize: 11 }}>{e.entity_id}</code></td>
                  <td style={{ ...td, color: colors.red }}>{e.code}</td>
                  <td style={td}>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #ddd', color: '#666', fontSize: 12 };
const td: React.CSSProperties = { padding: '6px 8px' };

function pct(part: number, total: number): string {
  return total > 0 ? `${((part / total) * 100).toFixed(1)}%` : '—';
}

function fmtEur(minor: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(minor / 100);
}

function fmtCur(minor: number, currency: string): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(minor / 100);
}

const CAT_COLORS: Record<string, string> = {
  AT: colors.green,
  IGL: colors.blue,
  RC: colors.orange,
};

function catBadge(cat: string | null) {
  if (!cat) return <span style={{ color: '#999' }}>Unkategorisiert</span>;
  const color = CAT_COLORS[cat] ?? colors.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11,
      fontWeight: 600, color: '#fff', background: color,
    }}>
      {cat}
    </span>
  );
}
