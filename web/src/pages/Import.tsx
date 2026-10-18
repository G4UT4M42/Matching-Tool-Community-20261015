import {useLegacyText} from '../i18n/legacy';
import {legacyCoreEnglish} from '../i18n/legacy-core';
import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { Card, Badge, colors, Amount, formatDate } from '../components/shared';
import { BankImport } from './BankImport';

type ImportStatus = 'idle' | 'loading' | 'success' | 'error';
type FileImportStatus = 'idle' | 'loading' | 'success' | 'error';

interface FileImportResultTxn {
  id: string;
  date: string;
  description: string;
  counterparty: string;
  amount_minor: number;
  currency: string;
  is_new: boolean;
}

interface FileImportResult {
  source: string;
  filename: string;
  fetched: number;
  imported: number;
  skipped: number;
  transactions: FileImportResultTxn[];
}

interface ImportResultTxn {
  id: string;
  type: string;
  amount_minor: number;
  currency: string;
  date: string;
  description: string;
  fee_minor: number | null;
  order_id: string | null;
  is_new: boolean;
}

interface FeeSummary {
  month: string;
  total_fee_minor: number;
  charge_count: number;
  is_new: boolean;
}

interface ImportResult {
  fetched: number;
  imported: number;
  skipped: number;
  date_range: { start: string; end: string };
  transactions: ImportResultTxn[];
  fee_summaries: FeeSummary[];
}

export function Import() {
  const lt = useLegacyText(legacyCoreEnglish);
  // Default: current quarter
  const now = new Date();
  const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const defaultStart = qStart.toISOString().slice(0, 10);
  const defaultEnd = now.toISOString().slice(0, 10);

  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [apiKey, setApiKey] = useState('');
  const [savedKeyInfo, setSavedKeyInfo] = useState<{ is_set: boolean; masked: string | null } | null>(null);
  const [status, setStatus] = useState<ImportStatus>('idle');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');

  // File upload state
  const [fileSource, setFileSource] = useState<'sparkasse' | 'visa'>('sparkasse');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileStatus, setFileStatus] = useState<FileImportStatus>('idle');
  const [fileResult, setFileResult] = useState<FileImportResult | null>(null);
  const [fileError, setFileError] = useState('');

  const handleFileImport = async () => {
    if (!selectedFile) return;
    setFileStatus('loading');
    setFileError('');
    setFileResult(null);
    try {
      const res = await api.importFile(selectedFile, fileSource);
      setFileResult(res);
      setFileStatus('success');
    } catch (err: any) {
      setFileError(err.message);
      setFileStatus('error');
    }
  };

  // Load saved API key status on mount
  useEffect(() => {
    api.getSetting('stripe_api_key').then(data => {
      setSavedKeyInfo({ is_set: data.is_set, masked: data.masked });
    }).catch(() => {});
  }, []);

  const handleImport = async () => {
    setStatus('loading');
    setError('');
    setResult(null);
    try {
      const res = await api.importStripe(startDate, endDate, apiKey || undefined);
      setResult(res);
      setStatus('success');
      // If a new key was provided, it's now saved — update status
      if (apiKey) {
        setSavedKeyInfo({ is_set: true, masked: apiKey.slice(0, 7) + '...' + apiKey.slice(-4) });
        setApiKey('');
      }
    } catch (err: any) {
      setError(err.message);
      setStatus('error');
    }
  };

  const typeBadgeColor: Record<string, string> = {
    charge: colors.green,
    payout: colors.blue,
    stripe_fee: colors.orange,
    refund: colors.red,
    standalone_fee: colors.orange,
    payment: colors.green,
    transfer: colors.blue,
  };

  return (
    <div>
      <h2 style={{ margin: '0 0 20px' }}>{lt("Datenimport")}</h2>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>

        {/* Stripe Import Card */}
        <Card title="Stripe Import" style={{ flex: '1 1 500px', maxWidth: 700 }}>
          <p style={{ color: '#666', fontSize: 14, margin: '0 0 16px' }}>
            {lt("Importiert Balance Transactions direkt von der Stripe API in die lokale Datenbank.")}</p>

          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label style={labelStyle}>{lt("Von")}</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>{lt("Bis")}</label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                style={inputStyle}
              />
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label style={labelStyle}>{lt("Stripe-API-Schlüssel")}</label>
            {savedKeyInfo?.is_set && !apiKey && (
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '6px 12px', background: '#f0fff0', border: '1px solid #27ae60',
                borderRadius: 4, fontSize: 13, marginBottom: 8,
              }}>
                <span style={{ color: '#27ae60', fontWeight: 600 }}>{lt("Gespeichert:")}{' '}</span>
                <code style={{ fontSize: 12 }}>{savedKeyInfo.masked}</code>
                <button
                  onClick={() => {
                    api.deleteSetting('stripe_api_key').then(() => {
                      setSavedKeyInfo({ is_set: false, masked: null });
                    });
                  }}
                  style={{
                    background: 'none', border: 'none', color: '#e74c3c',
                    cursor: 'pointer', fontSize: 12, textDecoration: 'underline',
                  }}
                >
                  {lt("entfernen")}</button>
              </div>
            )}
            <input
              type="password"
              placeholder={savedKeyInfo?.is_set ? lt("Gespeicherter Key wird verwendet") : lt("sk_live_... oder sk_test_...")}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              style={{ ...inputStyle, width: '100%', maxWidth: 400 }}
            />
            <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
              {savedKeyInfo?.is_set
                ? lt("Neuen Key eingeben um den gespeicherten zu ersetzen, oder leer lassen.")
                : lt("Wird beim ersten Import automatisch gespeichert.")}
            </div>
          </div>

          <button
            onClick={handleImport}
            disabled={status === 'loading'}
            style={{
              marginTop: 16, padding: '10px 24px', background: '#9b59b6', color: '#fff',
              border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer',
              opacity: status === 'loading' ? 0.6 : 1,
            }}
          >
            {status === 'loading' ? lt("Importiere...") : lt("Stripe Import starten")}
          </button>

          {status === 'error' && (
            <div style={{
              marginTop: 12, padding: 12, background: '#fdecea', color: '#c0392b',
              borderRadius: 6, fontSize: 14,
            }}>
              {error}
            </div>
          )}
        </Card>

        {/* Bank Import (Enable Banking) Card */}
        <BankImport startDate={startDate} endDate={endDate} />

        {/* File Upload Import Card */}
        <Card title={lt("Datei Import (CSV / XLSX)")} style={{ flex: '1 1 500px', maxWidth: 700 }}>
          <p style={{ color: '#666', fontSize: 14, margin: '0 0 16px' }}>
            {lt("Importiert Sparkasse oder Visa Kontoumsätze aus CSV/XLSX-Dateien.")}</p>

          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
            <div>
              <label style={labelStyle}>{lt("Quelle")}</label>
              <select
                value={fileSource}
                onChange={e => setFileSource(e.target.value as 'sparkasse' | 'visa')}
                style={{ ...inputStyle, minWidth: 160 }}
              >
                <option value="sparkasse">Sparkasse</option>
                <option value="visa">Visa</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{lt("Datei auswählen")}</label>
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={e => setSelectedFile(e.target.files?.[0] ?? null)}
                style={{ fontSize: 13 }}
              />
            </div>
          </div>

          {selectedFile && (
            <div style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
              {lt("Ausgewählt:")}{' '}<strong>{selectedFile.name}</strong> ({(selectedFile.size / 1024).toFixed(1)} KB)
            </div>
          )}

          <button
            onClick={handleFileImport}
            disabled={fileStatus === 'loading' || !selectedFile}
            style={{
              padding: '10px 24px', background: '#e67e22', color: '#fff',
              border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer',
              opacity: (fileStatus === 'loading' || !selectedFile) ? 0.6 : 1,
            }}
          >
            {fileStatus === 'loading' ? lt("Importiere...") : lt("Datei importieren")}
          </button>

          {fileStatus === 'error' && (
            <div style={{
              marginTop: 12, padding: 12, background: '#fdecea', color: '#c0392b',
              borderRadius: 6, fontSize: 14,
            }}>
              {fileError}
            </div>
          )}
        </Card>

        {/* Quick date presets */}
        <Card title={lt("Schnellauswahl")} style={{ flex: '0 0 200px' }}>
          {getQuarterPresets(lt).map(p => (
            <button
              key={p.label}
              onClick={() => { setStartDate(p.start); setEndDate(p.end); }}
              style={{
                display: 'block', width: '100%', padding: '8px 12px', marginBottom: 6,
                background: startDate === p.start && endDate === p.end ? '#eaf2ff' : '#f8f9fa',
                border: startDate === p.start && endDate === p.end ? '1px solid #2980b9' : '1px solid #ddd',
                borderRadius: 4, cursor: 'pointer', fontSize: 13, textAlign: 'left',
              }}
            >
              {p.label}
            </button>
          ))}
        </Card>
      </div>

      {/* Results */}
      {result && (
        <div style={{ marginTop: 24 }}>
          <Card title={lt("Import-Ergebnis")}>
            <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
              <StatBox label={lt("Von Stripe abgerufen")} value={result.fetched} />
              <StatBox label={lt("Neu importiert")} value={result.imported} color={colors.green} />
              <StatBox label={lt("Bereits vorhanden")} value={result.skipped} color={colors.darkGray} />
            </div>

            {result.transactions.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>{lt("Datum")}</th>
                    <th style={thStyle}>{lt("Typ")}</th>
                    <th style={thStyle}>{lt("Beschreibung / Order")}</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>{lt("Betrag")}</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>{lt("Gebühr")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.transactions.map((t, i) => (
                    <tr key={i} style={{
                      borderBottom: '1px solid #f0f0f0',
                      background: t.is_new ? '#f0fff0' : 'transparent',
                    }}>
                      <td style={tdStyle}>
                        {t.is_new
                          ? <Badge text={lt("NEU")} color={colors.green} />
                          : <Badge text={lt("existiert")} color={colors.gray} />
                        }
                      </td>
                      <td style={tdStyle}>{formatDate(t.date)}</td>
                      <td style={tdStyle}>
                        <Badge text={t.type} color={typeBadgeColor[t.type] ?? colors.gray} />
                      </td>
                      <td style={{ ...tdStyle, fontSize: 13, maxWidth: 300 }}>
                        <div>{t.description || '—'}</div>
                        {t.order_id && (
                          <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                            Order #{t.order_id}
                          </div>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <Amount value={t.amount_minor / 100} currency={t.currency} />
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: '#999', fontSize: 12 }}>
                        {t.fee_minor != null && t.fee_minor !== 0
                          ? <Amount value={-t.fee_minor / 100} currency={t.currency} />
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {/* Monthly Fee Summaries */}
          {result.fee_summaries?.length > 0 && (
            <Card title={lt("Monatliche Gebühren-Belege")} style={{ marginTop: 16 }}>
              <p style={{ color: '#666', fontSize: 13, margin: '0 0 12px' }}>
                {lt("Automatisch erstellte Ausgabebelege — Stripe Gebühren pro Monat zusammengefasst.")}</p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>{lt("Monat")}</th>
                    <th style={thStyle}>{lt("Anzahl Charges")}</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>{lt("Gesamtgebühr")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.fee_summaries.map((fs) => (
                    <tr key={fs.month} style={{
                      borderBottom: '1px solid #f0f0f0',
                      background: fs.is_new ? '#f0fff0' : 'transparent',
                    }}>
                      <td style={tdStyle}>
                        {fs.is_new
                          ? <Badge text={lt("NEU")} color={colors.green} />
                          : <Badge text={lt("aktualisiert")} color={colors.blue} />
                        }
                      </td>
                      <td style={tdStyle}>{fs.month}</td>
                      <td style={tdStyle}>{fs.charge_count}</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <Amount value={-fs.total_fee_minor / 100} currency="EUR" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      )}
      {/* File Import Results */}
      {fileResult && (
        <div style={{ marginTop: 24 }}>
          <Card title={lt("Datei Import-Ergebnis: {value0}", {value0: fileResult.filename})}>
            <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
              <StatBox label={lt("Aus Datei gelesen")} value={fileResult.fetched} />
              <StatBox label={lt("Neu importiert")} value={fileResult.imported} color={colors.green} />
              <StatBox label={lt("Bereits vorhanden")} value={fileResult.skipped} color={colors.darkGray} />
            </div>

            {fileResult.transactions.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>{lt("Datum")}</th>
                    <th style={thStyle}>{lt("Beschreibung")}</th>
                    <th style={thStyle}>{lt("Gegenkonto")}</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>{lt("Betrag")}</th>
                  </tr>
                </thead>
                <tbody>
                  {fileResult.transactions.map((t, i) => (
                    <tr key={i} style={{
                      borderBottom: '1px solid #f0f0f0',
                      background: t.is_new ? '#f0fff0' : 'transparent',
                    }}>
                      <td style={tdStyle}>
                        {t.is_new
                          ? <Badge text={lt("NEU")} color={colors.green} />
                          : <Badge text={lt("existiert")} color={colors.gray} />
                        }
                      </td>
                      <td style={tdStyle}>{formatDate(t.date)}</td>
                      <td style={{ ...tdStyle, maxWidth: 300 }}>{t.description || '—'}</td>
                      <td style={tdStyle}>{t.counterparty || '—'}</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <Amount value={t.amount_minor / 100} currency={t.currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

// --- Helpers ---

function StatBox({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: color ?? '#333' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#666' }}>{label}</div>
    </div>
  );
}

function getQuarterPresets(lt: (text: string, values?: Record<string, string | number>) => string) {
  const now = new Date();
  const year = now.getFullYear();
  const presets = [];

  for (let q = 0; q < 4; q++) {
    const startMonth = q * 3;
    const endMonth = startMonth + 2;
    const start = `${year}-${String(startMonth + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(year, endMonth + 1, 0).getDate();
    const end = `${year}-${String(endMonth + 1).padStart(2, '0')}-${lastDay}`;
    presets.push({ label: `Q${q + 1} ${year}`, start, end });
  }

  // Previous year quarters
  for (let q = 0; q < 4; q++) {
    const startMonth = q * 3;
    const endMonth = startMonth + 2;
    const start = `${year - 1}-${String(startMonth + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(year - 1, endMonth + 1, 0).getDate();
    const end = `${year - 1}-${String(endMonth + 1).padStart(2, '0')}-${lastDay}`;
    presets.push({ label: `Q${q + 1} ${year - 1}`, start, end });
  }

  // Full previous year
  presets.push({ label: lt("Ganzes Jahr {value0}", {value0: year - 1}), start: `${year - 1}-01-01`, end: `${year - 1}-12-31` });

  return presets;
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14,
};

const thStyle: React.CSSProperties = {
  padding: '8px 12px', fontSize: 12, color: '#666', fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: '8px 12px',
};
