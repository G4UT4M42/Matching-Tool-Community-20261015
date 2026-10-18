import {useLegacyText} from '../i18n/legacy';
import {legacyCoreEnglish} from '../i18n/legacy-core';
import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { Card, Badge, colors, Amount, formatDate } from '../components/shared';

interface BankAccount {
  uid: string;
  name: string | null;
  iban: string | null;
  currency: string;
  balance: number;
}

interface BankStatus {
  connected: boolean;
  configured: boolean;
  expired?: boolean;
  bank_name?: string;
  session_status?: string;
  accounts?: BankAccount[];
}

interface BankTxn {
  id: string;
  date: string;
  description: string;
  counterparty: string;
  iban: string;
  amount_minor: number;
  currency: string;
  is_new: boolean;
}

interface BankImportResult {
  fetched: number;
  imported: number;
  skipped: number;
  date_range: { start: string; end: string };
  transactions: BankTxn[];
}

interface BankSearchResult {
  name: string;
  country: string;
}

export function BankImport({ startDate, endDate }: { startDate: string; endDate: string }) {
  const lt = useLegacyText(legacyCoreEnglish);
  const [status, setStatus] = useState<BankStatus | null>(null);
  const [bankSearch, setBankSearch] = useState('');
  const [bankResults, setBankResults] = useState<BankSearchResult[]>([]);
  const [selectedBank, setSelectedBank] = useState<BankSearchResult | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<BankImportResult | null>(null);
  const [error, setError] = useState('');

  // Load status on mount
  useEffect(() => {
    api.getBankStatus().then(setStatus).catch(() =>
      setStatus({ connected: false, configured: false })
    );
  }, []);

  // Check URL params for connection result
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('bank') === 'connected') {
      api.getBankStatus().then(setStatus).catch(() => {});
      window.history.replaceState({}, '', '/import');
    }
    const err = params.get('error');
    if (err) {
      setError(decodeURIComponent(err));
      window.history.replaceState({}, '', '/import');
    }
  }, []);

  const handleBankSearch = async () => {
    if (!bankSearch.trim()) return;
    try {
      const res = await api.searchBanks(bankSearch, 'AT');
      setBankResults(res.banks ?? []);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleConnect = async () => {
    if (!selectedBank) return;
    setConnecting(true);
    setError('');
    try {
      const res = await api.connectBank(selectedBank.name, selectedBank.country);
      if (res.redirect_url) {
        window.location.href = res.redirect_url;
      }
    } catch (err: any) {
      setError(err.message);
      setConnecting(false);
    }
  };

  const toggleAccount = (uid: string) => {
    setSelectedAccounts(prev =>
      prev.includes(uid) ? prev.filter(x => x !== uid) : [...prev, uid]
    );
  };

  const handleImport = async () => {
    if (selectedAccounts.length === 0) return;
    setImporting(true);
    setError('');
    setImportResult(null);
    try {
      const res = await api.importBank(selectedAccounts, startDate, endDate);
      setImportResult(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <Card title={lt("Bank Import (Enable Banking / PSD2)")} style={{ flex: '1 1 500px', maxWidth: 700 }}>
        <p style={{ color: '#666', fontSize: 14, margin: '0 0 16px' }}>
          {lt("Importiert Kontoumsätze via PSD2 direkt von der Bank (Erste Sparkasse).")}</p>

        {!status?.configured && (
          <div style={{
            padding: '8px 12px', background: '#fff3cd', border: '1px solid #ffc107',
            borderRadius: 4, fontSize: 13, marginBottom: 16, color: '#856404',
          }}>
            {lt("Bitte zuerst Enable Banking konfigurieren: Application ID und Private Key in den Settings hinterlegen (")}<code>eb_application_id</code>, <code>eb_private_key_pem</code>).
          </div>
        )}

        {status?.expired && (
          <div style={{
            padding: '8px 12px', background: '#fdecea', border: '1px solid #e74c3c',
            borderRadius: 4, fontSize: 13, marginBottom: 16, color: '#c0392b',
          }}>
            {lt("Bankverbindung abgelaufen (90 Tage). Bitte erneut verbinden.")}</div>
        )}

        {/* Bank search + connect (not yet connected) */}
        {status?.configured && !status?.connected && (
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>{lt("Bank suchen")}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={bankSearch}
                onChange={e => setBankSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleBankSearch()}
                placeholder={lt("z.B. Erste Sparkasse")}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button onClick={handleBankSearch} style={btnStyle}>{lt("Suchen")}</button>
            </div>

            {bankResults.length > 0 && (
              <div style={{ marginTop: 8, maxHeight: 200, overflow: 'auto', border: '1px solid #eee', borderRadius: 4 }}>
                {bankResults.map(b => (
                  <div
                    key={b.name}
                    onClick={() => setSelectedBank(b)}
                    style={{
                      padding: '8px 12px', cursor: 'pointer', fontSize: 13,
                      background: selectedBank?.name === b.name ? '#e3f2fd' : 'transparent',
                      borderBottom: '1px solid #f0f0f0',
                    }}
                  >
                    <strong>{b.name}</strong>
                    <span style={{ color: '#888', marginLeft: 8 }}>{b.country}</span>
                  </div>
                ))}
              </div>
            )}

            {selectedBank && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  {lt("Ausgewählt:")}{' '}<strong>{selectedBank.name}</strong>
                </div>
                <button
                  onClick={handleConnect}
                  disabled={connecting}
                  style={{
                    padding: '10px 24px', background: '#e74c3c', color: '#fff',
                    border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                    opacity: connecting ? 0.6 : 1,
                  }}
                >
                  {connecting ? lt("Verbinde...") : lt("Mit Bank verbinden")}
                </button>
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                  {lt("Du wirst zur Bank weitergeleitet (George / s Identity) um die Verbindung zu autorisieren.")}</div>
              </div>
            )}
          </div>
        )}

        {/* Connected: show accounts + import */}
        {status?.connected && status.accounts && (
          <div>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '6px 12px', background: '#f0fff0', border: '1px solid #27ae60',
              borderRadius: 4, fontSize: 13, marginBottom: 12,
            }}>
              <span style={{ color: '#27ae60', fontWeight: 600 }}>{lt("Verbunden:")}{' '}</span>
              <span>{status.bank_name ?? 'Bank'}</span>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>{lt("Konten auswählen")}</label>
              {status.accounts.map(a => (
                <div
                  key={a.uid}
                  onClick={() => toggleAccount(a.uid)}
                  style={{
                    padding: '8px 12px', marginBottom: 4, borderRadius: 4, cursor: 'pointer',
                    background: selectedAccounts.includes(a.uid) ? '#e3f2fd' : '#f8f9fa',
                    border: selectedAccounts.includes(a.uid) ? '2px solid #2196f3' : '1px solid #eee',
                    fontSize: 13,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>
                      <strong>{a.name ?? lt("Konto")}</strong>
                      {a.iban && <span style={{ color: '#888', marginLeft: 8, fontFamily: 'monospace', fontSize: 12 }}>{a.iban}</span>}
                    </span>
                    <Amount value={a.balance} currency={a.currency} />
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={handleImport}
              disabled={importing || selectedAccounts.length === 0}
              style={{
                padding: '10px 24px', background: '#e74c3c', color: '#fff',
                border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                opacity: (importing || selectedAccounts.length === 0) ? 0.6 : 1,
              }}
            >
              {importing ? lt("Importiere...") : lt("Bank Import starten ({value0} Konto/en)", {value0: selectedAccounts.length})}
            </button>
          </div>
        )}

        {error && (
          <div style={{
            marginTop: 12, padding: 12, background: '#fdecea', color: '#c0392b',
            borderRadius: 6, fontSize: 14,
          }}>
            {error}
          </div>
        )}
      </Card>

      {/* Bank import results */}
      {importResult && (
        <div style={{ marginTop: 24 }}>
          <Card title={lt("Bank Import-Ergebnis")}>
            <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
              <StatBox label={lt("Von Bank abgerufen")} value={importResult.fetched} />
              <StatBox label={lt("Neu importiert")} value={importResult.imported} color={colors.green} />
              <StatBox label={lt("Bereits vorhanden")} value={importResult.skipped} color={colors.darkGray} />
            </div>

            {importResult.transactions.length > 0 && (
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
                  {importResult.transactions.map((t, i) => (
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
                      <td style={{ ...tdStyle, maxWidth: 300, fontSize: 13 }}>
                        {t.description || '—'}
                      </td>
                      <td style={tdStyle}>
                        <div>{t.counterparty || '—'}</div>
                        {t.iban && (
                          <div style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>
                            {t.iban}
                          </div>
                        )}
                      </td>
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
    </>
  );
}

// --- Local helpers ---

function StatBox({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: color ?? '#333' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#666' }}>{label}</div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  padding: '8px 12px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14,
};

const btnStyle: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 4, border: '1px solid #ddd', background: '#fff',
  cursor: 'pointer', fontSize: 13, fontWeight: 600,
};

const thStyle: React.CSSProperties = {
  padding: '8px 12px', fontSize: 12, color: '#666', fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: '8px 12px',
};
