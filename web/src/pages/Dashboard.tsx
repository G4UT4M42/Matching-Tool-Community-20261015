import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, StatCard, Button, colors, useWorkingYear } from '../components/shared';

export function Dashboard() {
  const [data, setData] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const { workingYear, quarter } = useWorkingYear();

  const load = () => {
    api.getSummary(workingYear, quarter).then(setData);
    api.getReportSummary().then(setReport).catch(() => {});
  };
  useEffect(() => { load(); }, [workingYear, quarter]);

  const rerun = async () => {
    setRunning(true);
    try {
      await api.runMatching();
      await load();
    } finally {
      setRunning(false);
    }
  };

  if (!data) return <p>Loading...</p>;

  const { transactions: txn, documents: doc, matches } = data;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22 }}>Dashboard</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => { window.location.href = api.downloadReportJson(); }} color="#27ae60">
            Export JSON
          </Button>
          <Button onClick={() => { window.location.href = api.downloadReportCsv(); }} color="#2980b9">
            Export CSV
          </Button>
          <Button onClick={rerun} disabled={running} color="#2c3e50">
            {running ? 'Running...' : 'Re-run Pipeline'}
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        <StatCard label="Transactions" value={txn.total} />
        <StatCard label="Matched Txns" value={txn.matched} color={colors.green} sub={`${((txn.matched / txn.total) * 100).toFixed(1)}%`} />
        <StatCard label="Unmatched Txns" value={txn.unmatched} color={colors.orange} />
        <StatCard label="Documents" value={doc.total} />
        <StatCard label="Matched Docs" value={doc.matched} color={colors.green} sub={`${((doc.matched / doc.total) * 100).toFixed(1)}%`} />
        <StatCard label="Match Groups" value={matches.total} color={colors.blue} />
        <StatCard label="Exclusions" value={data.exclusions} color={colors.gray} />
      </div>

      {/* By source */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        <Card title="Transactions by Source" style={{ flex: 1, minWidth: 300 }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Source</th>
                <th style={th}>Total</th>
                <th style={th}>Matched</th>
                <th style={th}>Unmatched</th>
                <th style={th}>Rate</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(txn.by_source as Record<string, any>).map(([src, v]) => (
                <tr key={src} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={td}><b>{src}</b></td>
                  <td style={td}>{v.total}</td>
                  <td style={{ ...td, color: colors.green }}>{v.matched}</td>
                  <td style={{ ...td, color: colors.orange }}>{v.unmatched}</td>
                  <td style={td}>{((v.matched / v.total) * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Documents by Source" style={{ flex: 1, minWidth: 300 }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Source</th>
                <th style={th}>Total</th>
                <th style={th}>Matched</th>
                <th style={th}>Unmatched</th>
                <th style={th}>Rate</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(doc.by_source as Record<string, any>).map(([src, v]) => (
                <tr key={src} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={td}><b>{src}</b></td>
                  <td style={td}>{v.total}</td>
                  <td style={{ ...td, color: colors.green }}>{v.matched}</td>
                  <td style={{ ...td, color: colors.orange }}>{v.unmatched}</td>
                  <td style={td}>{((v.matched / v.total) * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {/* Currency totals & VAT summary */}
      {report && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
          {report.currency_totals?.length > 0 && (
            <Card title="Per-Currency Totals" style={{ flex: 1, minWidth: 300 }}>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Currency</th>
                    <th style={th}>Income</th>
                    <th style={th}>Expenses</th>
                    <th style={th}>Net</th>
                    <th style={th}>Txns</th>
                  </tr>
                </thead>
                <tbody>
                  {report.currency_totals.map((ct: any) => (
                    <tr key={ct.currency_code} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={td}><b>{ct.currency_code}</b></td>
                      <td style={{ ...td, color: colors.green }}>{fmt(ct.total_income_minor)}</td>
                      <td style={{ ...td, color: colors.red }}>{fmt(ct.total_expense_minor)}</td>
                      <td style={td}><b>{fmt(ct.net_minor)}</b></td>
                      <td style={td}>{ct.transaction_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {report.vat_summary?.length > 0 && (
            <Card title="VAT by Tax Category" style={{ flex: 1, minWidth: 300 }}>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Category</th>
                    <th style={th}>Docs</th>
                    <th style={th}>Gross</th>
                    <th style={th}>Net</th>
                    <th style={th}>VAT</th>
                  </tr>
                </thead>
                <tbody>
                  {report.vat_summary.map((vs: any, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={td}><b>{vs.tax_category ?? 'Uncategorized'}</b></td>
                      <td style={td}>{vs.document_count}</td>
                      <td style={td}>{fmt(vs.gross_amount_minor)}</td>
                      <td style={td}>{fmt(vs.net_amount_minor)}</td>
                      <td style={td}>{fmt(vs.vat_amount_minor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {report.errors?.length > 0 && (
            <Card title={`Validation Errors (${report.errors.length})`} style={{ flex: '1 1 100%' }}>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Entity</th>
                    <th style={th}>Code</th>
                    <th style={th}>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {report.errors.slice(0, 20).map((e: any, i: number) => (
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
      )}

      {/* By rule */}
      <Card title="Matches by Rule">
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr><th style={th}>Rule</th><th style={th}>Count</th></tr>
          </thead>
          <tbody>
            {Object.entries(matches.by_rule as Record<string, number>)
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
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #ddd', color: '#666', fontSize: 12 };
const td: React.CSSProperties = { padding: '6px 8px' };

/** Format minor units (cents) to EUR string */
function fmt(minor: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(minor / 100);
}
