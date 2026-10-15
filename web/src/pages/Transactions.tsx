import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Card, Pagination, SearchInput, Select, StatusBadge, SourceBadge, Amount, Badge, FileLink, colors, formatDate, usePageSize, useWorkingYear, Tip } from '../components/shared';
import { BankImport } from './BankImport';

const TABS: { key: string; label: string; color: string }[] = [
  { key: 'sparkasse', label: 'Sparkasse', color: '#e74c3c' },
  { key: 'visa', label: 'Visa', color: '#2980b9' },
  { key: 'paypal', label: 'PayPal', color: '#3498db' },
  { key: 'stripe', label: 'Stripe', color: '#9b59b6' },
];

// Sources that support CSV/XLSX file import
const FILE_IMPORT_SOURCES = ['sparkasse', 'visa'];

// Persist/restore Konten view state across navigation
const TXN_STATE_KEY = 'txn_view_state';
function saveTxnState(state: { tab: string; page: number; scroll: number; status: string; search: string }) {
  try { sessionStorage.setItem(TXN_STATE_KEY, JSON.stringify(state)); } catch {}
}
function loadTxnState(): { tab: string; page: number; scroll: number; status: string; search: string } | null {
  try {
    const raw = sessionStorage.getItem(TXN_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function Transactions() {
  const [searchParams] = useSearchParams();
  const hasUrlParams = searchParams.has('highlight') || searchParams.has('source');
  const saved = hasUrlParams ? null : loadTxnState();

  const [activeTab, setActiveTab] = useState(searchParams.get('source') || saved?.tab || 'sparkasse');
  const [data, setData] = useState<any>(null);
  const [counts, setCounts] = useState<Record<string, { total: number; matched: number; unmatched: number }>>({});
  const [status, setStatus] = useState(saved?.status || '');
  const [search, setSearch] = useState(saved?.search || '');
  const [page, setPage] = useState(saved?.page || 1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [sortField, setSortField] = useState('posting_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [privatDialog, setPrivatDialog] = useState<{ txn: any } | null>(null);
  const [provisionalDialog, setProvisionalDialog] = useState<{ txn: any } | null>(null);
  const [manualMatchDialog, setManualMatchDialog] = useState<{ txn: any } | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const { pageSize, setPageSize } = usePageSize();
  const { workingYear, quarter } = useWorkingYear();
  const [periodFilter, setPeriodFilter] = useState(() => localStorage.getItem('txn_periodFilter') !== 'false');
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const pendingScroll = useRef(saved?.scroll ?? 0);

  // Save view state whenever key values change
  useEffect(() => {
    const main = document.querySelector('main');
    saveTxnState({ tab: activeTab, page, scroll: main?.scrollTop ?? 0, status, search });
  }, [activeTab, page, status, search]);

  // Also save scroll on scroll events
  useEffect(() => {
    const main = document.querySelector('main');
    if (!main) return;
    const handler = () => {
      saveTxnState({ tab: activeTab, page, scroll: main.scrollTop, status, search });
    };
    main.addEventListener('scroll', handler, { passive: true });
    return () => main.removeEventListener('scroll', handler);
  }, [activeTab, page, status, search]);

  // Restore scroll position after data loads
  useEffect(() => {
    if (!data || !pendingScroll.current) return;
    const main = document.querySelector('main');
    if (main) {
      setTimeout(() => { main.scrollTop = pendingScroll.current; pendingScroll.current = 0; }, 50);
    }
  }, [data]);

  const refreshCounts = () => {
    api.getSummary(workingYear, quarter).then((s: any) => {
      setCounts(s.transactions?.by_source ?? {});
    });
  };

  // Load counts on mount and when working period changes
  useEffect(() => { refreshCounts(); }, [workingYear, quarter]);

  const load = useCallback(() => {
    const params: Record<string, string> = { page: String(page), limit: String(pageSize), source: activeTab, sort: sortField, order: sortOrder };
    if (status) params.status = status;
    if (search) params.search = search;
    if (periodFilter) {
      params.year = String(workingYear);
      if (quarter) params.quarter = String(quarter);
    }
    api.getTransactions(params).then(setData);
  }, [page, pageSize, activeTab, status, search, sortField, sortOrder, periodFilter, workingYear, quarter]);

  useEffect(() => { load(); }, [load]);

  const doSearch = () => { setPage(1); };

  const switchTab = (tab: string) => {
    setActiveTab(tab);
    setPage(1);
    setExpanded(null);
    setDetail(null);
    setHighlightId(null);
    setShowImport(false);
  };

  const expand = async (id: string) => {
    if (expanded === id) { setExpanded(null); setDetail(null); return; }
    setExpanded(id);
    setDetail(await api.getTransaction(id));
  };

  const jumpTo = async (txnId: string) => {
    try {
      const target = await api.getTransaction(txnId);
      if (!target) return;
      const targetSource = target.source_system;
      setExpanded(null);
      setDetail(null);
      if (targetSource !== activeTab) {
        setActiveTab(targetSource);
        setStatus('');
        setSearch('');
        setPage(1);
      }
      setHighlightId(txnId);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!highlightId || !data) return;
    const found = data.items?.find((t: any) => t.transaction_id === highlightId);
    if (found) {
      setTimeout(() => {
        const row = rowRefs.current[highlightId];
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => setHighlightId(null), 3000);
      }, 150);
    }
  }, [highlightId, data]);

  // Handle URL params: ?highlight=TXN-xxx&source=sparkasse
  useEffect(() => {
    const hlId = searchParams.get('highlight');
    const hlSource = searchParams.get('source');
    if (hlId) {
      if (hlSource && hlSource !== activeTab) setActiveTab(hlSource);
      // Search for the transaction to find correct page
      api.getTransactions({ search: hlId, source: hlSource || activeTab, limit: '1' }).then((res: any) => {
        if (res.items?.length > 0) {
          setSearch(hlId);
          setPage(1);
          setHighlightId(hlId);
        } else {
          // Try without source filter
          jumpTo(hlId);
        }
      }).catch(() => jumpTo(hlId));
    }
  }, []);

  const onImportDone = () => {
    refreshCounts();
    load();
  };

  // Show all tabs (even empty ones for import)
  const visibleTabs = TABS.filter(t =>
    (counts[t.key]?.total ?? 0) > 0 || FILE_IMPORT_SOURCES.includes(t.key) || t.key === 'paypal' || t.key === 'stripe' || t.key === 'enablebanking'
  );

  const hasImport = FILE_IMPORT_SOURCES.includes(activeTab) || activeTab === 'paypal' || activeTab === 'stripe' || activeTab === 'enablebanking';

  const openPrivatDialog = (txn: any) => setPrivatDialog({ txn });

  const handleMarkSingle = async (txnId: string) => {
    await api.setDisposition(txnId, 'privat');
    setPrivatDialog(null);
    load();
  };

  const handleMarkVendor = async (vendorName: string) => {
    await api.addPrivateVendor(vendorName);
    setPrivatDialog(null);
    load();
  };

  const handleResetPrivat = async (txnId: string) => {
    await api.setDisposition(txnId, 'open');
    load();
  };

  if (!data) return <p>Loading...</p>;

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Konten</h1>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '2px solid #eee', marginBottom: 16 }}>
        {visibleTabs.map(tab => {
          const c = counts[tab.key];
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => switchTab(tab.key)}
              style={{
                padding: '10px 20px', border: 'none', cursor: 'pointer',
                background: isActive ? '#fff' : 'transparent',
                borderBottom: isActive ? `3px solid ${tab.color}` : '3px solid transparent',
                color: isActive ? '#333' : '#888',
                fontWeight: isActive ? 700 : 400,
                fontSize: 14, marginBottom: -2,
                transition: 'all 0.15s',
              }}
            >
              {tab.label}
              {c && (
                <span style={{ marginLeft: 8, fontSize: 11, color: '#999', fontWeight: 400 }}>
                  {c.total}
                  {c.total > 0 && (
                    <span style={{
                      marginLeft: 6, fontWeight: 600,
                      color: c.matched / c.total > 0.8 ? '#27ae60' : c.matched / c.total > 0.5 ? '#f39c12' : '#e74c3c',
                    }}>
                      {Math.round(c.matched / c.total * 100)}%
                    </span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Import toggle + Filters row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {hasImport && (
          <button
            onClick={() => setShowImport(!showImport)}
            style={{
              padding: '8px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              background: showImport ? '#e8f5e9' : '#f8f9fa',
              border: showImport ? '1px solid #27ae60' : '1px solid #ddd',
              color: showImport ? '#27ae60' : '#555',
            }}
          >
            {showImport ? 'Import ausblenden' : 'Import'}
          </button>
        )}
        <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[
          { value: '', label: 'Alle Status' },
          { value: 'matched', label: 'Matched' },
          { value: 'unmatched', label: 'Unmatched' },
        ]} />
        <SearchInput value={search} onChange={setSearch} placeholder="Suche Beschreibung/Gegenkonto..." />
        <button onClick={doSearch} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #ddd', cursor: 'pointer' }}>Suchen</button>
        <Tip text="Nur Buchungen des Arbeitszeitraums anzeigen oder alle Jahre">
          <button onClick={() => { const v = !periodFilter; setPeriodFilter(v); localStorage.setItem('txn_periodFilter', String(v)); setPage(1); }}
            style={{
              padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600,
              background: periodFilter ? '#2c3e50' : '#ecf0f1', color: periodFilter ? '#fff' : '#333',
              border: periodFilter ? '1px solid #2c3e50' : '1px solid #ddd',
            }}>
            {periodFilter ? `${workingYear}${quarter ? ' Q' + quarter : ''}` : 'Alle Jahre'}
          </button>
        </Tip>
        <span style={{ fontSize: 13, color: '#666' }}>{data.total} Ergebnisse</span>
        <div style={{ marginLeft: 'auto' }}>
          <select value={String(pageSize)} onChange={e => setPageSize(Number(e.target.value))}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}>
            <option value="100">100</option>
            <option value="500">500</option>
            <option value="1000">1000</option>
            <option value="99999">Alle</option>
          </select>
        </div>
      </div>

      {/* Import panel (conditionally shown) */}
      {showImport && FILE_IMPORT_SOURCES.includes(activeTab) && (
        <FileImportPanel source={activeTab as 'sparkasse' | 'visa'} onDone={onImportDone} />
      )}
      {showImport && activeTab === 'paypal' && (
        <PayPalImportPanel onDone={onImportDone} />
      )}
      {showImport && activeTab === 'stripe' && (
        <StripeImportPanel onDone={onImportDone} />
      )}
      {showImport && activeTab === 'enablebanking' && (
        <div style={{ marginBottom: 16 }}>
          <BankImport startDate={defaultStartDate()} endDate={defaultEndDate()} />
        </div>
      )}

      {/* Transaction table */}
      <Card>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {([
                  { label: 'Datum', field: 'posting_at' },
                  { label: 'Beschreibung', field: 'description_raw' },
                  { label: 'Gegenkonto', field: 'counterparty_name' },
                  { label: 'Betrag', field: 'amount_minor' },
                  ...(['visa', 'paypal'].includes(activeTab) ? [{ label: 'FX', field: '' }] : []),
                  { label: 'Beleg', field: '' },
                  { label: 'Status', field: 'status' },
                  { label: '', field: '' },
                ] as { label: string; field: string }[]).map((col, i) => (
                  <th key={i} style={{
                    ...thStyle,
                    cursor: col.field ? 'pointer' : 'default',
                    userSelect: 'none',
                  }} onClick={() => {
                    if (!col.field) return;
                    if (sortField === col.field) {
                      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                    } else {
                      setSortField(col.field);
                      setSortOrder(col.field === 'posting_at' ? 'desc' : 'asc');
                    }
                    setPage(1);
                  }}>
                    {col.label}
                    {col.field && sortField === col.field && (
                      <span style={{ marginLeft: 4, fontSize: 10 }}>{sortOrder === 'asc' ? '\u25B2' : '\u25BC'}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((t: any) => (
                <React.Fragment key={t.transaction_id}>
                  <tr
                    ref={el => { rowRefs.current[t.transaction_id] = el; }}
                    onClick={() => expand(t.transaction_id)}
                    style={{
                      borderBottom: '1px solid #f0f0f0',
                      cursor: 'pointer',
                      opacity: (t.disposition === 'privat' || t.disposition === 'steuerzahlung' || t.disposition === 'ok_no_match') ? 0.5 : 1,
                      background: highlightId === t.transaction_id
                        ? '#fff9c4'
                        : (t.disposition === 'privat' || t.disposition === 'steuerzahlung' || t.disposition === 'ok_no_match') ? '#f5f5f5'
                        : expanded === t.transaction_id ? '#f0f7ff' : 'transparent',
                      transition: 'background 0.5s',
                    }}
                  >
                    <td style={tdStyle}>{formatDate(t.posting_at)}</td>
                    <td style={tdStyle}>
                      {t.description_raw?.slice(0, 70)}{t.description_raw?.length > 70 ? '...' : ''}
                    </td>
                    <td style={tdStyle}>{t.counterparty_name ?? '—'}</td>
                    <td style={tdStyle}><Amount value={t.amount} currency={t.currency_code} /></td>
                    {['visa', 'paypal'].includes(activeTab) && (
                      <td style={{ ...tdStyle, fontFamily: 'monospace', color: '#888' }}>
                        {t.fx?.original_amount_minor != null
                          ? `${t.fx.original_currency_code === 'USD' ? '$' : t.fx.original_currency_code + ' '}${(Math.abs(t.fx.original_amount_minor) / 100).toFixed(2)}`
                          : ''}
                      </td>
                    )}
                    <td style={tdStyle} onClick={e => e.stopPropagation()}>
                      {t.linked_docs?.length > 0
                        ? (() => {
                            const isFx = t.meta?.fx_amount || t.description_raw?.includes('$');
                            const docsSum = t.linked_docs.reduce((s: number, d: any) => s + Math.abs(d.total_amount_minor ?? 0), 0);
                            const isCombo = t.linked_docs.length > 1;
                            const sumMismatch = !isFx && docsSum > 0 && Math.abs(docsSum - Math.abs(t.amount_minor)) > 1;
                            const result = t.linked_docs.map((d: any) => {
                            const singleMismatch = !isFx && !isCombo && d.total_amount_minor != null && d.total_amount_minor !== 0 && Math.abs(d.total_amount_minor) !== Math.abs(t.amount_minor);
                            const mismatch = isCombo ? false : singleMismatch;
                            return (
                              <div key={d.document_id}>
                                <FileLink filename={d.filename || d.source_document_ref} />
                                {mismatch && (
                                  <span title={`Beleg: ${(Math.abs(d.total_amount_minor)/100).toFixed(2)}€ ≠ Buchung: ${(Math.abs(t.amount_minor)/100).toFixed(2)}€`}
                                    style={{ color: '#e67e22', fontSize: 10, marginLeft: 4, cursor: 'help' }}>
                                    ⚠
                                  </span>
                                )}
                              </div>
                            );
                          });
                          if (isCombo && sumMismatch) {
                            return [...result, <div key="sum-warn" style={{ fontSize: 10, color: '#e67e22', marginTop: 2 }}
                              title={`Summe Belege: ${(docsSum/100).toFixed(2)}€ ≠ Buchung: ${(Math.abs(t.amount_minor)/100).toFixed(2)}€`}>
                              ⚠ Summe weicht ab
                            </div>];
                          }
                          return result;
                          })()
                        : <span style={{ color: '#ccc' }}>—</span>
                      }
                    </td>
                    <td style={tdStyle}>
                      {t.disposition === 'ok_no_match'
                        ? <Badge text="OK" color={colors.gray} />
                        : t.disposition === 'steuerzahlung'
                          ? <Badge text="Steuerzahlung" color={colors.gray} />
                          : t.disposition === 'privat'
                            ? <Badge text="Privat" color={colors.gray} />
                            : <StatusBadge matched={t.is_matched} />
                      }
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                      {(t.disposition === 'privat' || t.disposition === 'steuerzahlung' || t.disposition === 'ok_no_match') ? (
                        <button
                          onClick={() => handleResetPrivat(t.transaction_id)}
                          style={{ ...privatBtnStyle, color: colors.blue }}
                          title="Status aufheben"
                        >
                          Zurücksetzen
                        </button>
                      ) : (
                        <button
                          onClick={() => openPrivatDialog(t)}
                          style={privatBtnStyle}
                        >
                          Privat
                        </button>
                      )}
                      <TxnRowMenu
                        txn={t}
                        isOpen={openMenu === t.transaction_id}
                        onToggle={() => setOpenMenu(openMenu === t.transaction_id ? null : t.transaction_id)}
                        onClose={() => setOpenMenu(null)}
                        onOk={async (txnId, note) => {
                          await api.setDisposition(txnId, 'ok_no_match', note);
                          load();
                        }}
                        onUnmatch={async (mgId) => {
                          await api.deleteMatch(mgId);
                          setOpenMenu(null);
                          load();
                        }}
                        onInvoiceBot={async (vendorName, date, amount) => {
                          setOpenMenu(null);
                          window.location.href = `/invoice-bot?vendor=${encodeURIComponent(vendorName)}&date=${encodeURIComponent(date.slice(0,10))}&amount=${Math.abs(amount)}`;
                        }}
                        onProvisionalRelease={(txn) => {
                          setOpenMenu(null);
                          setProvisionalDialog({ txn });
                        }}
                        onManualMatch={(txn) => {
                          setOpenMenu(null);
                          setManualMatchDialog({ txn });
                        }}
                      />
                    </td>
                  </tr>

                  {expanded === t.transaction_id && detail && (
                    <tr><td colSpan={7} style={{ padding: 0 }}>
                      <TransactionDetail detail={detail} currentId={t.transaction_id} onJump={jumpTo} dispositionNote={t.disposition_note} disposition={t.disposition} onRefresh={() => { api.getTransaction(t.transaction_id).then(setDetail); load(); }} />
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <Pagination page={data.page} pages={data.pages} onPage={setPage} />
      </Card>

      {/* Privat Dialog */}
      {privatDialog && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }} onClick={() => setPrivatDialog(null)}>
          <div
            style={{
              background: '#fff', borderRadius: 12, padding: 24, maxWidth: 480, width: '90%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Als privat markieren</h3>
            <p style={{ fontSize: 13, color: '#555', margin: '0 0 8px' }}>
              <b>{formatDate(privatDialog.txn.posting_at)}</b> — {privatDialog.txn.description_raw?.slice(0, 60)}
            </p>
            <p style={{ fontSize: 13, color: '#555', margin: '0 0 20px' }}>
              Gegenkonto: <b>{privatDialog.txn.counterparty_name ?? '—'}</b> — <Amount value={privatDialog.txn.amount} currency={privatDialog.txn.currency_code} />
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {privatDialog.txn.counterparty_name && (
                <button
                  onClick={() => handleMarkVendor(privatDialog.txn.counterparty_name)}
                  style={{
                    padding: '12px 16px', borderRadius: 8, border: '1px solid #ddd', background: '#fff',
                    cursor: 'pointer', textAlign: 'left', fontSize: 13,
                  }}
                  onMouseOver={e => (e.currentTarget.style.background = '#f0f7ff')}
                  onMouseOut={e => (e.currentTarget.style.background = '#fff')}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    Alle Zahlungen an "{privatDialog.txn.counterparty_name}" als privat markieren
                  </div>
                  <div style={{ fontSize: 12, color: '#888' }}>
                    Vendor wird zur Privat-Liste hinzugefügt. Zukünftige Zahlungen werden automatisch als privat markiert.
                  </div>
                </button>
              )}
              <button
                onClick={() => handleMarkSingle(privatDialog.txn.transaction_id)}
                style={{
                  padding: '12px 16px', borderRadius: 8, border: '1px solid #ddd', background: '#fff',
                  cursor: 'pointer', textAlign: 'left', fontSize: 13,
                }}
                onMouseOver={e => (e.currentTarget.style.background = '#f0f7ff')}
                onMouseOut={e => (e.currentTarget.style.background = '#fff')}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  Nur diese Zahlung als privat markieren
                </div>
                <div style={{ fontSize: 12, color: '#888' }}>
                  Nur diese einzelne Buchung wird als privat gesetzt.
                </div>
              </button>
              <button
                onClick={() => setPrivatDialog(null)}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none', background: '#f0f0f0',
                  cursor: 'pointer', fontSize: 13, color: '#666', marginTop: 4,
                }}
              >
                Abbrechen
              </button>
            </div>
          </div>
        </div>
      )}
      {manualMatchDialog && (
        <ManualMatchDialog
          txn={manualMatchDialog.txn}
          onClose={() => setManualMatchDialog(null)}
          onDone={() => { setManualMatchDialog(null); load(); refreshCounts(); }}
        />
      )}
      {provisionalDialog && (
        <ProvisionalReleaseDialog
          txn={provisionalDialog.txn}
          onClose={() => setProvisionalDialog(null)}
          onDone={() => { setProvisionalDialog(null); load(); refreshCounts(); }}
        />
      )}
    </div>
  );
}

function ProvisionalReleaseDialog({ txn, onClose, onDone }: { txn: any; onClose: () => void; onDone: () => void }) {
  const [vendor, setVendor] = useState(txn.counterparty_name ?? '');
  const [country, setCountry] = useState('AT');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!vendor.trim()) return alert('Bitte Vendor eingeben');
    if (!country.trim()) return alert('Bitte Land eingeben');
    setSaving(true);
    try {
      await api.createEigenbeleg(
        txn.transaction_id,
        vendor.trim(),
        country.trim().toUpperCase(),
        description || undefined,
        true, // provisional — needs real receipt
      );
      onDone();
    } catch (e: any) {
      alert('Fehler: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    padding: '8px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, width: '100%', boxSizing: 'border-box',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: '#fff', borderRadius: 12, padding: 24, maxWidth: 420, width: '90%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
      }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16, color: '#e67e22' }}>Vorübergehend freigeben</h3>
        <p style={{ fontSize: 12, color: '#888', margin: '0 0 16px' }}>
          Erstellt einen Eigenbeleg und gibt die Buchung für Berichte frei. Die Rechnung kann nachträglich hochgeladen werden.
        </p>
        <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px' }}>
          <b>{formatDate(txn.posting_at)}</b> — <Amount value={txn.amount} currency={txn.currency_code} />
          <br /><span style={{ color: '#888' }}>{txn.description_raw?.slice(0, 60)}</span>
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Vendor *</label>
            <input value={vendor} onChange={e => setVendor(e.target.value)} style={inputStyle} placeholder="z.B. Spotify AB" />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Land *</label>
            <input value={country} onChange={e => setCountry(e.target.value)} style={inputStyle} placeholder="z.B. AT, DE, SE" />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Beschreibung</label>
            <input value={description} onChange={e => setDescription(e.target.value)} style={inputStyle} placeholder="z.B. Spotify Premium Abo" />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={handleSave} disabled={saving}
              style={{
                flex: 1, padding: '10px', borderRadius: 6, border: 'none', fontSize: 13,
                background: '#e67e22', color: '#fff', fontWeight: 600, cursor: saving ? 'default' : 'pointer',
              }}>
              {saving ? 'Wird erstellt...' : 'Freigeben'}
            </button>
            <button onClick={onClose}
              style={{ padding: '10px 16px', borderRadius: 6, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontSize: 13 }}>
              Abbrechen
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ManualMatchDialog({ txn, onClose, onDone }: { txn: any; onClose: () => void; onDone: () => void }) {
  const [docs, setDocs] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [matching, setMatching] = useState(false);
  const [page, setPage] = useState(1);
  const LIMIT = 20;

  const loadDocs = () => {
    setLoading(true);
    const params: Record<string, string> = { page: String(page), limit: String(LIMIT), type: 'expense', status: 'unmatched', sort: 'document_date', order: 'desc' };
    if (search) params.search = search;
    api.getDocuments(params).then((r: any) => { setDocs(r.items || []); setLoading(false); });
  };

  useEffect(() => { loadDocs(); }, [page]);

  const doSearch = () => { setPage(1); loadDocs(); };

  const toggleSelect = (docId: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(docId) ? n.delete(docId) : n.add(docId);
      return n;
    });
  };

  const handleMatch = async () => {
    if (selected.size === 0) return;
    setMatching(true);
    try {
      await api.createMatch([txn.transaction_id], [...selected], 'manual_match_dialog');
      onDone();
    } catch (e: any) {
      alert('Fehler: ' + e.message);
    } finally {
      setMatching(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 12, width: '90%', maxWidth: 800, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.25)' }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #ddd', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>Manuell verknüpfen</h3>
            <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
              {formatDate(txn.posting_at)} — <Amount value={txn.amount} currency={txn.currency_code} /> — {txn.description_raw?.slice(0, 50)}
            </div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 20, cursor: 'pointer', color: '#888' }}>✕</button>
        </div>

        {/* Search */}
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') doSearch(); }}
            placeholder="Suche (Lieferant, Datei, Betrag)..."
            style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }} />
          <button onClick={doSearch} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #ddd', cursor: 'pointer', fontSize: 13 }}>Suchen</button>
          {selected.size > 0 && (
            <button onClick={handleMatch} disabled={matching}
              style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: colors.green, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              {matching ? '...' : `${selected.size} verknüpfen`}
            </button>
          )}
        </div>

        {/* Documents list */}
        <div style={{ flex: 1, overflow: 'auto', padding: '0' }}>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#888' }}>Laden...</div>
          ) : docs.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#888' }}>Keine offenen Rechnungen gefunden</div>
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8f9fa' }}>
                  <th style={{ padding: '6px 8px', width: 30 }}></th>
                  <th style={{ padding: '6px 8px', textAlign: 'left', color: '#666' }}>Datum</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left', color: '#666' }}>Dokument</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left', color: '#666' }}>Lieferant</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right', color: '#666' }}>Betrag</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d: any) => {
                  const isSelected = selected.has(d.document_id);
                  const amountMatch = Math.abs(d.total_amount_minor) === Math.abs(txn.amount_minor);
                  return (
                    <tr key={d.document_id}
                      onClick={() => toggleSelect(d.document_id)}
                      style={{
                        cursor: 'pointer', borderBottom: '1px solid #f0f0f0',
                        background: isSelected ? '#e8f5e9' : amountMatch ? '#f0f7ff' : undefined,
                      }}
                      onMouseOver={e => { if (!isSelected) e.currentTarget.style.background = '#fafafa'; }}
                      onMouseOut={e => { if (!isSelected) e.currentTarget.style.background = amountMatch ? '#f0f7ff' : ''; }}>
                      <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                        <input type="checkbox" checked={isSelected} readOnly style={{ cursor: 'pointer' }} />
                      </td>
                      <td style={{ padding: '6px 8px' }}>{formatDate(d.document_date)}</td>
                      <td style={{ padding: '6px 8px' }}>
                        {d.filename ? <span style={{ color: colors.blue }}>{d.filename.slice(0, 40)}</span> : <span style={{ color: '#999' }}>{d.document_id.slice(0, 20)}</span>}
                      </td>
                      <td style={{ padding: '6px 8px' }}>{d.supplier_name || '—'}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: amountMatch ? 700 : 400, color: amountMatch ? colors.green : undefined }}>
                        {(Math.abs(d.total_amount_minor) / 100).toFixed(2)} €
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        <div style={{ padding: '8px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
            style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #ddd', cursor: 'pointer', fontSize: 12 }}>← Zurück</button>
          <span style={{ fontSize: 12, color: '#666' }}>Seite {page}</span>
          <button onClick={() => { setPage(p => p + 1); }} disabled={docs.length < LIMIT}
            style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #ddd', cursor: 'pointer', fontSize: 12 }}>Weiter →</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Import panels
// ============================================================

function FileImportPanel({ source, onDone }: { source: 'sparkasse' | 'visa'; onDone: () => void }) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  const handleImport = async () => {
    if (!selectedFile) return;
    setStatus('loading');
    setError('');
    setResult(null);
    try {
      const res = await api.importFile(selectedFile, source);
      setResult(res);
      setStatus('success');
      onDone();
    } catch (err: any) {
      setError(err.message);
      setStatus('error');
    }
  };

  const label = source === 'sparkasse' ? 'Sparkasse' : 'Visa';

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#333' }}>{label} Datei importieren (XLSX)</span>
        <input
          type="file"
          accept=".xlsx,.xls"
          onChange={e => { setSelectedFile(e.target.files?.[0] ?? null); setResult(null); setStatus('idle'); }}
          style={{ fontSize: 13 }}
        />
        {selectedFile && (
          <span style={{ fontSize: 12, color: '#666' }}>
            {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
          </span>
        )}
        <button
          onClick={handleImport}
          disabled={status === 'loading' || !selectedFile}
          style={{
            padding: '8px 20px', background: '#e67e22', color: '#fff',
            border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            opacity: (status === 'loading' || !selectedFile) ? 0.6 : 1,
          }}
        >
          {status === 'loading' ? 'Importiere...' : 'Importieren'}
        </button>
      </div>

      {status === 'error' && (
        <div style={{ marginTop: 10, padding: 10, background: '#fdecea', color: '#c0392b', borderRadius: 6, fontSize: 13 }}>
          {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 20, marginBottom: 10 }}>
            <StatBox label="Gelesen" value={result.fetched} />
            <StatBox label="Neu importiert" value={result.imported} color={colors.green} />
            <StatBox label="Bereits vorhanden" value={result.skipped} color={colors.darkGray} />
          </div>
          {result.transactions?.length > 0 && (
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #eee' }}>
                    <th style={importThStyle}>Status</th>
                    <th style={importThStyle}>Datum</th>
                    <th style={importThStyle}>Beschreibung</th>
                    <th style={importThStyle}>Gegenkonto</th>
                    <th style={{ ...importThStyle, textAlign: 'right' }}>Betrag</th>
                  </tr>
                </thead>
                <tbody>
                  {result.transactions.map((t: any, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f0f0f0', background: t.is_new ? '#f0fff0' : 'transparent' }}>
                      <td style={importTdStyle}><Badge text={t.is_new ? 'NEU' : 'existiert'} color={t.is_new ? colors.green : colors.gray} /></td>
                      <td style={importTdStyle}>{formatDate(t.date)}</td>
                      <td style={{ ...importTdStyle, maxWidth: 250 }}>{t.description || '—'}</td>
                      <td style={importTdStyle}>{t.counterparty || '—'}</td>
                      <td style={{ ...importTdStyle, textAlign: 'right' }}><Amount value={t.amount_minor / 100} currency={t.currency} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function StripeImportPanel({ onDone }: { onDone: () => void }) {
  const [startDate, setStartDate] = useState(defaultStartDate());
  const [endDate, setEndDate] = useState(defaultEndDate());
  const [apiKey, setApiKey] = useState('');
  const [savedKeyInfo, setSavedKeyInfo] = useState<{ is_set: boolean; masked: string | null } | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getSetting('stripe_api_key').then(data => {
      setSavedKeyInfo({ is_set: data.is_set, masked: data.masked });
    }).catch(() => {});
  }, []);

  const typeBadgeColor: Record<string, string> = {
    charge: colors.green, payout: colors.blue, stripe_fee: colors.orange,
    refund: colors.red, standalone_fee: colors.orange, payment: colors.green, transfer: colors.blue,
  };

  const handleImport = async () => {
    setStatus('loading');
    setError('');
    setResult(null);
    try {
      const res = await api.importStripe(startDate, endDate, apiKey || undefined);
      setResult(res);
      setStatus('success');
      if (apiKey) {
        setSavedKeyInfo({ is_set: true, masked: apiKey.slice(0, 7) + '...' + apiKey.slice(-4) });
        setApiKey('');
      }
      onDone();
    } catch (err: any) {
      setError(err.message);
      setStatus('error');
    }
  };

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#333', alignSelf: 'center' }}>Stripe API Import</span>
        <div>
          <label style={labelStyle}>Von</label>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Bis</label>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={inputStyle} />
        </div>
        {getQuarterPresets().map(p => (
          <button
            key={p.label}
            onClick={() => { setStartDate(p.start); setEndDate(p.end); }}
            style={{
              padding: '6px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
              background: startDate === p.start && endDate === p.end ? '#eaf2ff' : '#f8f9fa',
              border: startDate === p.start && endDate === p.end ? '1px solid #2980b9' : '1px solid #ddd',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <label style={labelStyle}>API Key</label>
          {savedKeyInfo?.is_set && !apiKey ? (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '6px 12px', background: '#f0fff0', border: '1px solid #27ae60',
              borderRadius: 4, fontSize: 12,
            }}>
              <span style={{ color: '#27ae60', fontWeight: 600 }}>Gespeichert</span>
              <code style={{ fontSize: 11 }}>{savedKeyInfo.masked}</code>
              <button
                onClick={() => api.deleteSetting('stripe_api_key').then(() => setSavedKeyInfo({ is_set: false, masked: null }))}
                style={{ background: 'none', border: 'none', color: '#e74c3c', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}
              >
                entfernen
              </button>
            </div>
          ) : (
            <input
              type="password"
              placeholder="sk_live_... oder sk_test_..."
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              style={{ ...inputStyle, width: 300 }}
            />
          )}
        </div>
        <button
          onClick={handleImport}
          disabled={status === 'loading'}
          style={{
            padding: '8px 20px', background: '#9b59b6', color: '#fff',
            border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            opacity: status === 'loading' ? 0.6 : 1, alignSelf: 'flex-end',
          }}
        >
          {status === 'loading' ? 'Importiere...' : 'Stripe Import starten'}
        </button>
      </div>

      {status === 'error' && (
        <div style={{ padding: 10, background: '#fdecea', color: '#c0392b', borderRadius: 6, fontSize: 13 }}>{error}</div>
      )}

      {result && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 20, marginBottom: 10 }}>
            <StatBox label="Abgerufen" value={result.fetched} />
            <StatBox label="Neu importiert" value={result.imported} color={colors.green} />
            <StatBox label="Bereits vorhanden" value={result.skipped} color={colors.darkGray} />
          </div>
          {result.transactions?.length > 0 && (
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #eee' }}>
                    <th style={importThStyle}>Status</th>
                    <th style={importThStyle}>Datum</th>
                    <th style={importThStyle}>Typ</th>
                    <th style={importThStyle}>Beschreibung</th>
                    <th style={{ ...importThStyle, textAlign: 'right' }}>Betrag</th>
                    <th style={{ ...importThStyle, textAlign: 'right' }}>Gebühr</th>
                  </tr>
                </thead>
                <tbody>
                  {result.transactions.map((t: any, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f0f0f0', background: t.is_new ? '#f0fff0' : 'transparent' }}>
                      <td style={importTdStyle}><Badge text={t.is_new ? 'NEU' : 'existiert'} color={t.is_new ? colors.green : colors.gray} /></td>
                      <td style={importTdStyle}>{formatDate(t.date)}</td>
                      <td style={importTdStyle}><Badge text={t.type} color={typeBadgeColor[t.type] ?? colors.gray} /></td>
                      <td style={{ ...importTdStyle, maxWidth: 250 }}>
                        {t.description || '—'}
                        {t.order_id && <span style={{ fontSize: 10, color: '#888', marginLeft: 4 }}>#{t.order_id}</span>}
                      </td>
                      <td style={{ ...importTdStyle, textAlign: 'right' }}><Amount value={t.amount_minor / 100} currency={t.currency} /></td>
                      <td style={{ ...importTdStyle, textAlign: 'right', color: '#999' }}>
                        {t.fee_minor != null && t.fee_minor !== 0 ? <Amount value={-t.fee_minor / 100} currency={t.currency} /> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.fee_summaries?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4 }}>Monatliche Gebühren-Belege:</div>
              {result.fee_summaries.map((fs: any) => (
                <div key={fs.month} style={{ display: 'flex', gap: 16, fontSize: 12, padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <Badge text={fs.is_new ? 'NEU' : 'aktualisiert'} color={fs.is_new ? colors.green : colors.blue} />
                  <span>{fs.month}</span>
                  <span>{fs.charge_count} Charges</span>
                  <Amount value={-fs.total_fee_minor / 100} currency="EUR" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function PayPalImportPanel({ onDone }: { onDone: () => void }) {
  const [startDate, setStartDate] = useState(defaultStartDate());
  const [endDate, setEndDate] = useState(defaultEndDate());
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [savedId, setSavedId] = useState<{ is_set: boolean; masked: string | null } | null>(null);
  const [savedSecret, setSavedSecret] = useState<{ is_set: boolean; masked: string | null } | null>(null);
  const [sandbox, setSandbox] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getSetting('paypal_client_id').then(data => setSavedId({ is_set: data.is_set, masked: data.masked })).catch(() => {});
    api.getSetting('paypal_client_secret').then(data => setSavedSecret({ is_set: data.is_set, masked: data.masked })).catch(() => {});
    api.getSetting('paypal_sandbox').then(data => { if (data.value === 'true') setSandbox(true); }).catch(() => {});
  }, []);

  const typeBadgeColor: Record<string, string> = {
    payment: colors.green, payout: colors.blue, refund: colors.red,
    fee: colors.orange, chargeback: colors.red, currency_conversion: colors.gray,
  };

  const handleImport = async () => {
    setStatus('loading');
    setError('');
    setResult(null);
    try {
      const res = await api.importPayPal(
        startDate, endDate,
        clientId || undefined, clientSecret || undefined,
        sandbox,
      );
      setResult(res);
      setStatus('success');
      if (clientId) {
        setSavedId({ is_set: true, masked: clientId.slice(0, 8) + '...' });
        setClientId('');
      }
      if (clientSecret) {
        setSavedSecret({ is_set: true, masked: clientSecret.slice(0, 8) + '...' });
        setClientSecret('');
      }
      onDone();
    } catch (err: any) {
      setError(err.message);
      setStatus('error');
    }
  };

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#333', alignSelf: 'center' }}>PayPal API Import</span>
        <div>
          <label style={labelStyle}>Von</label>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Bis</label>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={inputStyle} />
        </div>
        {getQuarterPresets().map(p => (
          <button
            key={p.label}
            onClick={() => { setStartDate(p.start); setEndDate(p.end); }}
            style={{
              padding: '6px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
              background: startDate === p.start && endDate === p.end ? '#eaf2ff' : '#f8f9fa',
              border: startDate === p.start && endDate === p.end ? '1px solid #2980b9' : '1px solid #ddd',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <label style={labelStyle}>Client ID</label>
          {savedId?.is_set && !clientId ? (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '6px 12px', background: '#f0fff0', border: '1px solid #27ae60',
              borderRadius: 4, fontSize: 12,
            }}>
              <span style={{ color: '#27ae60', fontWeight: 600 }}>Gespeichert</span>
              <code style={{ fontSize: 11 }}>{savedId.masked}</code>
              <button
                onClick={() => api.deleteSetting('paypal_client_id').then(() => setSavedId({ is_set: false, masked: null }))}
                style={{ background: 'none', border: 'none', color: '#e74c3c', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}
              >
                entfernen
              </button>
            </div>
          ) : (
            <input
              type="text"
              placeholder="PayPal Client ID"
              value={clientId}
              onChange={e => setClientId(e.target.value)}
              style={{ ...inputStyle, width: 280 }}
            />
          )}
        </div>
        <div>
          <label style={labelStyle}>Client Secret</label>
          {savedSecret?.is_set && !clientSecret ? (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '6px 12px', background: '#f0fff0', border: '1px solid #27ae60',
              borderRadius: 4, fontSize: 12,
            }}>
              <span style={{ color: '#27ae60', fontWeight: 600 }}>Gespeichert</span>
              <code style={{ fontSize: 11 }}>{savedSecret.masked}</code>
              <button
                onClick={() => api.deleteSetting('paypal_client_secret').then(() => setSavedSecret({ is_set: false, masked: null }))}
                style={{ background: 'none', border: 'none', color: '#e74c3c', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}
              >
                entfernen
              </button>
            </div>
          ) : (
            <input
              type="password"
              placeholder="PayPal Client Secret"
              value={clientSecret}
              onChange={e => setClientSecret(e.target.value)}
              style={{ ...inputStyle, width: 280 }}
            />
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" id="pp-sandbox" checked={sandbox} onChange={e => setSandbox(e.target.checked)} />
          <label htmlFor="pp-sandbox" style={{ fontSize: 12, color: '#666' }}>Sandbox</label>
        </div>
        <button
          onClick={handleImport}
          disabled={status === 'loading'}
          style={{
            padding: '8px 20px', background: '#3498db', color: '#fff',
            border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            opacity: status === 'loading' ? 0.6 : 1, alignSelf: 'flex-end',
          }}
        >
          {status === 'loading' ? 'Importiere...' : 'PayPal Import starten'}
        </button>
      </div>

      {status === 'error' && (
        <div style={{ padding: 10, background: '#fdecea', color: '#c0392b', borderRadius: 6, fontSize: 13 }}>{error}</div>
      )}

      {result && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 20, marginBottom: 10 }}>
            <StatBox label="Abgerufen" value={result.fetched} />
            <StatBox label="Neu importiert" value={result.imported} color={colors.green} />
            <StatBox label="Bereits vorhanden" value={result.skipped} color={colors.darkGray} />
          </div>
          {result.transactions?.length > 0 && (
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #eee' }}>
                    <th style={importThStyle}>Status</th>
                    <th style={importThStyle}>Datum</th>
                    <th style={importThStyle}>Typ</th>
                    <th style={importThStyle}>Beschreibung</th>
                    <th style={importThStyle}>Gegenkonto</th>
                    <th style={{ ...importThStyle, textAlign: 'right' }}>Betrag</th>
                    <th style={{ ...importThStyle, textAlign: 'right' }}>Gebühr</th>
                  </tr>
                </thead>
                <tbody>
                  {result.transactions.map((t: any, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f0f0f0', background: t.is_new ? '#f0fff0' : 'transparent' }}>
                      <td style={importTdStyle}><Badge text={t.is_new ? 'NEU' : 'existiert'} color={t.is_new ? colors.green : colors.gray} /></td>
                      <td style={importTdStyle}>{formatDate(t.date)}</td>
                      <td style={importTdStyle}><Badge text={t.type} color={typeBadgeColor[t.type] ?? colors.gray} /></td>
                      <td style={{ ...importTdStyle, maxWidth: 250 }}>{t.description || '—'}</td>
                      <td style={importTdStyle}>{t.counterparty || '—'}</td>
                      <td style={{ ...importTdStyle, textAlign: 'right' }}><Amount value={t.amount_minor / 100} currency={t.currency} /></td>
                      <td style={{ ...importTdStyle, textAlign: 'right', color: '#999' }}>
                        {t.fee_minor !== 0 ? <Amount value={t.fee_minor / 100} currency={t.currency} /> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.fee_summaries?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4 }}>Monatliche Gebühren-Belege:</div>
              {result.fee_summaries.map((fs: any) => (
                <div key={fs.month} style={{ display: 'flex', gap: 16, fontSize: 12, padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <Badge text={fs.is_new ? 'NEU' : 'aktualisiert'} color={fs.is_new ? colors.green : colors.blue} />
                  <span>{fs.month}</span>
                  <span>{fs.txn_count} Transaktionen</span>
                  <Amount value={-fs.total_fee_minor / 100} currency="EUR" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ============================================================
// Transaction detail sub-components
// ============================================================

function TransactionDetail({ detail, currentId, onJump, dispositionNote, disposition, onRefresh }: {
  detail: any; currentId: string; onJump: (id: string) => void; dispositionNote?: string | null; disposition?: string; onRefresh?: () => void;
}) {
  const mg = detail.match_group;
  const linkedTxnIds: string[] = mg ? (mg.transaction_ids as string[]).filter((id: string) => id !== currentId) : [];
  const linkedDocIds: string[] = mg ? (mg.document_ids as string[]) : [];

  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ ok?: boolean; error?: string; results?: any[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: File[]) => {
    const accepted = files.filter(f => /\.(pdf|jpe?g|png)$/i.test(f.name) || f.type === 'application/pdf' || f.type?.startsWith('image/'));
    if (!accepted.length) { setUploadResult({ error: 'Nur PDF, JPG, PNG — Datei: ' + files.map(f => `${f.name} (${f.type})`).join(', ') }); return; }
    setUploading(true);
    setUploadResult(null);
    try {
      const res = await api.uploadAndMatch(accepted, currentId);
      setUploadResult(res);
      if (res.ok) onRefresh?.();
    } catch (err: any) {
      setUploadResult({ error: err.message });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{ padding: 16, background: '#f8f9fa', borderBottom: '2px solid #e0e0e0', fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>Detail</h4>
          <DetailRow label="ID" value={<code style={{ fontSize: 11, wordBreak: 'break-all' }}>{detail.transaction_id}</code>} />
          <DetailRow label="Beschreibung" value={detail.description_raw} />
          <DetailRow label="Betrag" value={<Amount value={detail.amount} currency={detail.currency_code} />} />
          <DetailRow label="Datum" value={formatDate(detail.posting_at)} />
          <DetailRow label="Gegenkonto" value={detail.counterparty_name ?? '—'} />
          <DetailRow label="IBAN" value={detail.counterparty_iban ?? '—'} />
          <DetailRow label="Buchungsreferenz" value={detail.booking_reference ?? '—'} />
          <DetailRow label="Zahlungsreferenz" value={detail.payment_reference ?? '—'} />
          {dispositionNote && <DetailRow label="Notiz" value={<span style={{ fontStyle: 'italic' }}>{dispositionNote}</span>} />}

          {/* PayPal enriched details */}
          {detail.meta?.enriched && (
            <div style={{ marginTop: 8, padding: '6px 10px', background: '#f0f7ff', borderRadius: 6, border: '1px solid #d0e3f7', fontSize: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4, color: '#2471a3' }}>PayPal Details</div>
              {detail.meta.payer_name && <DetailRow label="Zahler" value={detail.meta.payer_name} />}
              {detail.meta.payer_email && <DetailRow label="E-Mail" value={detail.meta.payer_email} />}
              {detail.meta.subject && <DetailRow label="Betreff" value={detail.meta.subject} />}
              {detail.meta.note && <DetailRow label="Notiz" value={detail.meta.note} />}
              {detail.meta.invoice_id && <DetailRow label="Rechnungsnr." value={detail.meta.invoice_id} />}
              {detail.meta.cart_items?.length > 0 && (
                <DetailRow label="Artikel" value={detail.meta.cart_items.map((i: any) => `${i.name}${i.quantity ? ' x' + i.quantity : ''}`).join(', ')} />
              )}
              {detail.meta.fee_minor !== 0 && <DetailRow label="PayPal-Gebühr" value={`${(detail.meta.fee_minor / 100).toFixed(2)} ${detail.meta.fee_currency ?? 'EUR'}`} />}
              {detail.meta.paypal_txn_id && <DetailRow label="PP-Txn-ID" value={<code style={{ fontSize: 10 }}>{detail.meta.paypal_txn_id}</code>} />}
            </div>
          )}

          {/* Enrich button for PayPal transactions without details */}
          {detail.source_system === 'paypal' && !detail.meta?.enriched && (
            <PayPalEnrichButton txnId={currentId} onDone={() => onRefresh?.()} />
          )}
        </div>

        {mg && (
          <div style={{ flex: 1, minWidth: 280 }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>Verknüpfung</h4>
            <DetailRow label="Regel" value={<code style={{ fontSize: 11 }}>{mg.rule_id}</code>} />
            <DetailRow label="Status" value={mg.status} />

            {(mg.evidence?.paypal_split || mg.evidence?.type === 'paypal_split_payment') && (
              <div style={{ marginTop: 8, padding: '6px 10px', background: '#eaf4fd', borderRadius: 6, border: '1px solid #c5ddf0', fontSize: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 4, color: '#2471a3' }}>PayPal Splitzahlung</div>
                <div>PayPal-Guthaben: <strong>{(((mg.evidence.split_balance_portion ?? mg.evidence.balance_portion ?? 0)) / 100).toFixed(2)} EUR</strong></div>
                <div>Karte/Bank: <strong>{(((mg.evidence.split_card_portion ?? mg.evidence.card_portion ?? 0)) / 100).toFixed(2)} EUR</strong></div>
                <div style={{ borderTop: '1px solid #c5ddf0', marginTop: 4, paddingTop: 4 }}>Gesamt: <strong>{(((mg.evidence.split_total ?? mg.evidence.total ?? 0)) / 100).toFixed(2)} EUR</strong></div>
              </div>
            )}

            {linkedTxnIds.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>Verknüpfte Transaktionen:</div>
                {linkedTxnIds.map((id: string) => (
                  <LinkedTransactionRow key={id} txnId={id} onJump={onJump} />
                ))}
              </div>
            )}

            {linkedDocIds.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>Verknüpfte Dokumente:</div>
                {linkedDocIds.map((id: string) => (
                  <LinkedDocumentRow key={id} docId={id} onRefresh={onRefresh} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Drop zone for invoice upload */}
        <div style={{ flex: '0 0 180px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>Beleg zuordnen</h4>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(Array.from(e.dataTransfer.files)); }}
            onClick={() => fileRef.current?.click()}
            style={{
              padding: 16, borderRadius: 8, textAlign: 'center', cursor: uploading ? 'wait' : 'pointer',
              border: dragging ? '2px solid #2980b9' : '2px dashed #ccc',
              background: dragging ? '#eaf4fd' : uploading ? '#f0f0f0' : '#fff',
              transition: 'all 0.15s',
              minHeight: 80, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <input ref={fileRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files) handleFiles(Array.from(e.target.files)); e.target.value = ''; }} />
            {uploading ? (
              <span style={{ color: '#888', fontSize: 12 }}>Wird verarbeitet...</span>
            ) : (
              <>
                <span style={{ fontSize: 20, marginBottom: 4 }}>+</span>
                <span style={{ color: '#888', fontSize: 11, lineHeight: 1.3 }}>Rechnung hierher ziehen<br/>oder klicken</span>
              </>
            )}
          </div>
          {uploadResult && (
            <div style={{ fontSize: 11, marginTop: 4 }}>
              {uploadResult.error && <div style={{ color: '#c0392b' }}>{uploadResult.error}</div>}
              {uploadResult.results?.map((r: any, i: number) => (
                <div key={i}>
                  <div style={{ color: r.error ? '#c0392b' : '#27ae60' }}>
                    {r.error ? `${r.filename}: ${r.error}` : `${r.filename} verknüpft`}
                  </div>
                  {r.warning && (
                    <div style={{ color: '#e67e22', background: '#fef9e7', border: '1px solid #f0c36d', borderRadius: 4, padding: '4px 6px', marginTop: 4 }}>
                      {r.warning}
                    </div>
                  )}
                  {r.matchInfo && r.matchInfo.length > 0 && (
                    <div style={{ background: '#fef0f0', border: '1px solid #e6a0a0', borderRadius: 4, padding: '6px 8px', marginTop: 4 }}>
                      <div style={{ fontWeight: 600, color: '#c0392b', marginBottom: 4 }}>Beleg bereits verknüpft mit:</div>
                      {r.matchInfo.map((m: any, j: number) => (
                        <div key={j} style={{ marginBottom: 4 }}>
                          <div style={{ fontSize: 10, color: '#888' }}>Regel: {m.rule_id}</div>
                          {m.transaction_ids?.map((tid: string) => (
                            <a key={tid}
                              href={`/?highlight=${encodeURIComponent(tid)}`}
                              style={{ display: 'block', color: colors.blue, textDecoration: 'none', fontSize: 11, borderBottom: '1px dashed #2980b9' }}>
                              Buchung: {tid.slice(0, 20)}...
                            </a>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <EigenbelegButton txn={detail} onDone={onRefresh || (() => {})} />
        </div>
      </div>
    </div>
  );
}

function PayPalEnrichButton({ txnId, onDone }: { txnId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok?: boolean; error?: string } | null>(null);

  const enrich = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.enrichPayPalTransaction(txnId);
      setResult(res);
      if (res.ok) onDone();
    } catch (err: any) {
      setResult({ ok: false, error: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={enrich} disabled={busy}
        style={{
          padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: busy ? 'wait' : 'pointer',
          background: '#2471a3', color: '#fff', border: 'none', fontWeight: 600,
        }}>
        {busy ? 'Lade PayPal-Details...' : 'PayPal-Details laden'}
      </button>
      {result?.error && <span style={{ marginLeft: 8, color: '#c0392b', fontSize: 11 }}>{result.error}</span>}
    </div>
  );
}

function EigenbelegButton({ txn, onDone }: { txn: any; onDone: () => void }) {
  const [show, setShow] = useState(false);
  const [vendor, setVendor] = useState(txn.counterparty_name ?? '');
  const [country, setCountry] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!vendor.trim()) return alert('Bitte Vendor eingeben');
    if (!country.trim()) return alert('Bitte Land eingeben (z.B. AT, DE, IE)');
    setBusy(true);
    try {
      const res = await api.createEigenbeleg(txn.transaction_id, vendor.trim(), country.trim().toUpperCase(), description || undefined);
      setResult(`Eigenbeleg ${res.eigenbelegNumber} erstellt`);
      setShow(false);
      onDone();
    } catch (e: any) {
      alert('Fehler: ' + e.message);
    } finally {
      setBusy(false);
    }
  };

  if (result) return <div style={{ fontSize: 11, color: '#27ae60', marginTop: 8 }}>{result}</div>;

  if (!show) {
    return (
      <button onClick={() => setShow(true)}
        style={{
          marginTop: 8, padding: '6px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
          background: '#fff', color: '#e67e22', border: '1px solid #e67e22', fontWeight: 600, width: '100%',
        }}>
        Eigenbeleg erstellen
      </button>
    );
  }

  const inputStyle: React.CSSProperties = { padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 12, width: '100%', boxSizing: 'border-box' as const };

  return (
    <div style={{ marginTop: 8, background: '#fffef5', border: '1px solid #f0c36d', borderRadius: 6, padding: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Eigenbeleg erstellen</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div>
          <label style={{ fontSize: 11, color: '#666' }}>Vendor *</label>
          <input value={vendor} onChange={e => setVendor(e.target.value)} style={inputStyle} placeholder="z.B. Google One" />
        </div>
        <div>
          <label style={{ fontSize: 11, color: '#666' }}>Land *</label>
          <input value={country} onChange={e => setCountry(e.target.value)} style={inputStyle} placeholder="z.B. IE, AT, DE" />
        </div>
        <div>
          <label style={{ fontSize: 11, color: '#666' }}>Beschreibung</label>
          <input value={description} onChange={e => setDescription(e.target.value)} style={inputStyle} placeholder="z.B. Teilerstattung Google One" />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button onClick={handleCreate} disabled={busy}
            style={{ flex: 1, padding: '6px', borderRadius: 4, fontSize: 11, cursor: 'pointer', background: '#e67e22', color: '#fff', border: 'none', fontWeight: 600 }}>
            {busy ? '...' : 'Erstellen'}
          </button>
          <button onClick={() => setShow(false)}
            style={{ padding: '6px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer', background: '#eee', border: 'none' }}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}

function LinkedTransactionRow({ txnId, onJump }: { txnId: string; onJump: (id: string) => void }) {
  const [txn, setTxn] = useState<any>(null);
  useEffect(() => {
    api.getTransaction(txnId).then(setTxn).catch(() => {});
  }, [txnId]);

  if (!txn) return <div style={{ padding: '4px 0', color: '#999', fontSize: 12 }}>Laden...</div>;

  return (
    <div
      onClick={() => onJump(txnId)}
      style={{
        padding: '6px 10px', marginBottom: 4, borderRadius: 6, cursor: 'pointer',
        background: '#fff', border: '1px solid #e0e0e0',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        transition: 'border-color 0.15s',
      }}
      onMouseOver={e => (e.currentTarget.style.borderColor = '#2980b9')}
      onMouseOut={e => (e.currentTarget.style.borderColor = '#e0e0e0')}
      title="Klicken um zur Transaktion zu springen"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SourceBadge source={txn.source_system} />
        <span style={{ fontSize: 12 }}>{formatDate(txn.posting_at)}</span>
        <span style={{ color: '#555', fontSize: 12 }}>{txn.description_raw?.slice(0, 40)}</span>
      </div>
      <Amount value={txn.amount} currency={txn.currency_code} />
    </div>
  );
}

function LinkedDocumentRow({ docId, onRefresh }: { docId: string; onRefresh?: () => void }) {
  const [doc, setDoc] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    api.getDocument(docId).then(setDoc).catch(() => {});
  }, [docId]);

  const scanId = doc?.meta?.scan_id;
  const filename = doc?.filename;
  const supplier = doc?.supplier_name;
  const amount = doc?.total_amount_minor;
  const date = doc?.document_date;
  const needsReceipt = doc?.meta?.needs_receipt;

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('files', file);
      form.append('document_id', docId);
      const res = await fetch('/api/documents/eigenbeleg/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error((await res.json()).error || 'Upload fehlgeschlagen');
      api.getDocument(docId).then(setDoc); // refresh
      onRefresh?.();
    } catch (e: any) {
      alert('Fehler: ' + e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{
      padding: '6px 10px', marginBottom: 4, borderRadius: 6, fontSize: 12,
      background: needsReceipt ? '#fef0f0' : '#fff',
      border: needsReceipt ? '1px solid #e6a0a0' : '1px solid #e0e0e0',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {filename ? <FileLink filename={filename} /> : <span style={{ color: '#999' }}>{docId.slice(0, 20)}</span>}
          {supplier && <span style={{ color: '#888', marginLeft: 8 }}>{supplier}</span>}
          {amount != null && <span style={{ fontFamily: 'monospace', marginLeft: 8, color: amount < 0 ? '#c0392b' : '#27ae60' }}>{(Math.abs(amount) / 100).toFixed(2)} EUR</span>}
          {date && <span style={{ color: '#aaa', marginLeft: 8 }}>{formatDate(date)}</span>}
          {needsReceipt && <span style={{ marginLeft: 8, color: '#c0392b', fontWeight: 600, fontSize: 11 }}>Rechnung fehlt</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {needsReceipt && (
            <>
              <button onClick={() => fileRef.current?.click()} disabled={uploading}
                style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, cursor: 'pointer', background: '#e74c3c', color: '#fff', border: 'none', fontWeight: 600 }}>
                {uploading ? '...' : 'Rechnung hochladen'}
              </button>
              <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }}
                onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0]); e.target.value = ''; }} />
            </>
          )}
          {scanId ? (
            <a href={`/belegerkennung?scan=${encodeURIComponent(scanId)}`}
              style={{ fontSize: 11, color: '#2980b9', textDecoration: 'none', whiteSpace: 'nowrap' }}>
              Scan anzeigen
            </a>
          ) : doc?.source_system === 'invoice_scan' && doc?.document_id ? (
            <a href={`/belegerkennung?doc=${encodeURIComponent(doc.document_id)}`}
              style={{ fontSize: 11, color: '#2980b9', textDecoration: 'none', whiteSpace: 'nowrap' }}>
              Scan anzeigen
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', padding: '3px 0', fontSize: 13 }}>
      <span style={{ width: 140, color: '#888', flexShrink: 0 }}>{label}:</span>
      <span style={{ color: '#333' }}>{value}</span>
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

// ============================================================
// Helpers
// ============================================================

function defaultStartDate() {
  const now = new Date();
  const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  return qStart.toISOString().slice(0, 10);
}

function defaultEndDate() {
  return new Date().toISOString().slice(0, 10);
}

function getQuarterPresets() {
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
  for (let q = 0; q < 4; q++) {
    const startMonth = q * 3;
    const endMonth = startMonth + 2;
    const start = `${year - 1}-${String(startMonth + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(year - 1, endMonth + 1, 0).getDate();
    const end = `${year - 1}-${String(endMonth + 1).padStart(2, '0')}-${lastDay}`;
    presets.push({ label: `Q${q + 1} ${year - 1}`, start, end });
  }
  presets.push({ label: `Ganzes Jahr ${year}`, start: `${year}-01-01`, end: `${year}-12-31` });
  presets.push({ label: `Ganzes Jahr ${year - 1}`, start: `${year - 1}-01-01`, end: `${year - 1}-12-31` });
  return presets;
}

function TxnRowMenu({ txn, isOpen, onToggle, onClose, onOk, onUnmatch, onInvoiceBot, onProvisionalRelease, onManualMatch }: {
  txn: any; isOpen: boolean; onToggle: () => void; onClose: () => void; onOk: (txnId: string, note: string) => void; onUnmatch: (mgId: string) => void; onInvoiceBot?: (vendorName: string, date: string, amount: number) => void; onProvisionalRelease?: (txn: any) => void; onManualMatch?: (txn: any) => void;
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

  const menuItems: Array<{ label: string; href?: string; onClick?: () => void; color?: string; tip?: string }> = [];

  // "OK" — mark as ok_no_match with optional note
  if (txn.disposition !== 'ok_no_match') {
    menuItems.push({
      label: 'OK',
      tip: 'Buchung als geprüft markieren (kein Beleg nötig)',
      onClick: () => {
        const note = prompt('Beschreibung (optional):') ?? '';
        onOk(txn.transaction_id, note || 'ok');
        onClose();
      },
    });
  }

  // "Gegenbuchung" — navigate to linked transaction (Umbuchungen)
  if (txn.linked_txn_ids?.length > 0) {
    for (const linkedId of txn.linked_txn_ids) {
      menuItems.push({
        label: 'Gegenbuchung',
        tip: 'Zur verknüpften Gegenbuchung (Umbuchung) springen',
        href: `/?highlight=${encodeURIComponent(linkedId)}`,
      });
    }
  }

  // "Beleg ansehen" — navigate to linked document in Rechnungen/Einkuenfte
  if (txn.linked_docs?.length > 0) {
    for (const doc of txn.linked_docs) {
      const label = doc.source_system === 'income' ? 'Einkunft ansehen' : 'Rechnung ansehen';
      const target = doc.source_system === 'income'
        ? `/einkuenfte?highlight=${encodeURIComponent(doc.document_id)}`
        : `/rechnungen?highlight=${encodeURIComponent(doc.document_id)}`;
      menuItems.push({ label, href: target, tip: 'Verknüpften Beleg in Rechnungen/Einnahmen anzeigen' });
    }
  }

  // "Unmatch" — remove match group
  if (txn.is_matched && txn.match_group_id) {
    menuItems.push({
      label: 'Unmatch',
      tip: 'Verknüpfung zwischen Buchung und Beleg aufheben',
      color: colors.red,
      onClick: () => {
        if (!confirm('Verknüpfung wirklich aufheben?')) return;
        onUnmatch(txn.match_group_id);
      },
    });
  }

  // "Manuell verknüpfen" — open document picker to match
  if (!txn.is_matched && onManualMatch) {
    menuItems.push({
      label: 'Manuell verknüpfen',
      tip: 'Rechnung aus der Belegliste auswählen und mit dieser Buchung verknüpfen',
      color: colors.blue,
      onClick: () => onManualMatch(txn),
    });
  }

  // "Vorübergehend freigeben" — create provisional document for unmatched transactions
  if (!txn.is_matched && onProvisionalRelease) {
    menuItems.push({
      label: 'Vorübergehend freigeben',
      tip: 'Buchung für Berichte freigeben (Platzhalter bis echte Rechnung vorliegt)',
      color: '#e67e22',
      onClick: () => onProvisionalRelease(txn),
    });
  }

  // "Invoice Bot" — auto-collect invoice for unmatched transactions
  if (!txn.is_matched && txn.amount_minor < 0 && onInvoiceBot) {
    const vendorName = txn.counterparty_name || txn.description_raw?.slice(0, 40);
    if (vendorName) {
      menuItems.push({
        label: 'Invoice Bot',
        tip: 'Rechnung automatisch vom Portal des Vendors holen',
        color: '#8e24aa',
        onClick: () => {
          onInvoiceBot(vendorName, txn.posting_at, txn.amount_minor);
        },
      });
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block', marginLeft: 4 }}>
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
          {menuItems.map((item, i) => (
            <Tip key={i} text={item.tip || item.label}>
              <a
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
            </Tip>
          ))}
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', borderBottom: '2px solid #ddd', color: '#666', fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: '8px 12px', verticalAlign: 'top',
};

const importThStyle: React.CSSProperties = {
  padding: '6px 10px', fontSize: 11, color: '#666', fontWeight: 600, textAlign: 'left',
};

const importTdStyle: React.CSSProperties = {
  padding: '6px 10px',
};

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 600, color: '#555', marginBottom: 2,
};

const inputStyle: React.CSSProperties = {
  padding: '6px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13,
};

const privatBtnStyle: React.CSSProperties = {
  padding: '3px 8px', borderRadius: 4, border: '1px solid #ddd', background: '#fff',
  cursor: 'pointer', fontSize: 11, color: '#888', whiteSpace: 'nowrap',
};
