import { useLegacyText } from '../i18n/legacy';
import { legacyAccountingEnglish, accountingNoticeText, type AccountingNotice } from '../i18n/legacy-accounting';
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Button, SearchInput, Amount, SourceBadge, FileLink, colors, formatDate, useWorkingYear } from '../components/shared';

export function ManualMatch({allowOriginalFiles=true}:{allowOriginalFiles?:boolean}={}) {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  const [txnSearch, setTxnSearch] = useState('');
  const [docSearch, setDocSearch] = useState('');
  const [txnResults, setTxnResults] = useState<any[]>([]);
  const [docResults, setDocResults] = useState<any[]>([]);
  const [selectedTxns, setSelectedTxns] = useState<string[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<AccountingNotice | null>(null);
  const { workingYear, quarter } = useWorkingYear();

  const searchTxns = async () => {
    if (!txnSearch) return;
    const res = await api.getTransactions({ search: txnSearch, status: 'unmatched', limit: '20', year: String(workingYear), ...(quarter ? { quarter: String(quarter) } : {}) });
    setTxnResults(res.items);
  };

  const searchDocs = async () => {
    if (!docSearch) return;
    const res = await api.getDocuments({ search: docSearch, status: 'unmatched', limit: '20', year: String(workingYear), ...(quarter ? { quarter: String(quarter) } : {}) });
    setDocResults(res.items);
  };

  const toggleTxn = (id: string) => {
    setSelectedTxns((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const toggleDoc = (id: string) => {
    setSelectedDocs((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const createMatch = async () => {
    if (selectedTxns.length === 0 && selectedDocs.length === 0) return;
    try {
      const result = await api.createMatch(selectedTxns, selectedDocs, reason);
      setMessage({ key: "Zuordnung erstellt: {p0}", values: { p0: result.match_group_id } });
      setSelectedTxns([]);
      setSelectedDocs([]);
      setReason('');
      // Refresh searches
      if (txnSearch) searchTxns();
      if (docSearch) searchDocs();
    } catch (err: any) {
      setMessage({ key: "Fehler: {p0}", values: { p0: err.message }, error: true });
    }
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>{text("Manuelle Zuordnung")}</h1>

      {message && (
        <div style={{
          padding: 12, marginBottom: 16, borderRadius: 6, fontSize: 13,
          background: message.error ? '#fce4ec' : '#e8f5e9',
          color: message.error ? colors.red : colors.green,
        }}>
          {accountingNoticeText(text, message)}
        </div>
      )}

      <div data-testid="manual-match-panels" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 16 }}>
        {/* Left panel: Transactions */}
        <Card title={text("Transaktionen auswählen")} style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <SearchInput value={txnSearch} onChange={setTxnSearch} placeholder={text("Transaktionen suchen...")} />
            <Button onClick={searchTxns}>{text("Suchen")}</Button>
          </div>

          {selectedTxns.length > 0 && (
            <div style={{ marginBottom: 8, fontSize: 12, color: colors.blue }}>
              {selectedTxns.length} {text("Transaktionen ausgewählt")}
            </div>
          )}

          <div style={{ maxHeight: 400, overflow: 'auto' }}>
            {txnResults.map((t: any) => (
              <div
                key={t.transaction_id}
                data-demo-selection="transaction"
                role="button" tabIndex={0} aria-pressed={selectedTxns.includes(t.transaction_id)} aria-label={t.transaction_id}
                onKeyDown={event=>{if(event.target===event.currentTarget&&(event.key==='Enter'||event.key===' ')){event.preventDefault();toggleTxn(t.transaction_id);}}}
                onClick={() => toggleTxn(t.transaction_id)}
                style={{
                  padding: '8px 12px', marginBottom: 4, borderRadius: 4, cursor: 'pointer', fontSize: 12,
                  background: selectedTxns.includes(t.transaction_id) ? '#e3f2fd' : '#f8f9fa',
                  border: selectedTxns.includes(t.transaction_id) ? '2px solid #2196f3' : '1px solid #eee',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><SourceBadge source={t.source_system} /> {formatDate(t.posting_at)}</span>
                  <Amount value={t.amount} currency={t.currency_code} />
                </div>
                <div style={{ color: '#666', marginTop: 2 }}>{t.description_raw?.slice(0, 60)}</div>
                <div style={{ color: '#999', marginTop: 1 }}>{t.counterparty_name ?? ''}</div>
              </div>
            ))}
          </div>
        </Card>

        {/* Right panel: Documents */}
        <Card title={text("Dokumente auswählen")} style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <SearchInput value={docSearch} onChange={setDocSearch} placeholder={text("Dokumente suchen...")} />
            <Button onClick={searchDocs}>{text("Suchen")}</Button>
          </div>

          {selectedDocs.length > 0 && (
            <div style={{ marginBottom: 8, fontSize: 12, color: colors.blue }}>
              {selectedDocs.length} {text("Dokumente ausgewählt")}
            </div>
          )}

          <div style={{ maxHeight: 400, overflow: 'auto' }}>
            {docResults.map((d: any) => (
              <div
                key={d.document_id}
                data-demo-selection="document"
                role="button" tabIndex={0} aria-pressed={selectedDocs.includes(d.document_id)} aria-label={d.document_id}
                onKeyDown={event=>{if(event.target===event.currentTarget&&(event.key==='Enter'||event.key===' ')){event.preventDefault();toggleDoc(d.document_id);}}}
                onClick={() => toggleDoc(d.document_id)}
                style={{
                  padding: '8px 12px', marginBottom: 4, borderRadius: 4, cursor: 'pointer', fontSize: 12,
                  background: selectedDocs.includes(d.document_id) ? '#e3f2fd' : '#f8f9fa',
                  border: selectedDocs.includes(d.document_id) ? '2px solid #2196f3' : '1px solid #eee',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><SourceBadge source={d.source_system} /> {formatDate(d.document_date)}</span>
                  <Amount value={d.amount} currency={d.currency_code} />
                </div>
                <div style={{ color: '#666', marginTop: 2 }}>{allowOriginalFiles?<FileLink filename={d.filename ?? d.source_document_ref} />:<span>{d.filename ?? d.source_document_ref}</span>}</div>
                <div style={{ color: '#999', marginTop: 1 }}>{d.supplier_name ?? ''}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Match action */}
      <Card style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label={text("Grund für manuelle Zuordnung (optional)")}
            placeholder={text("Grund für manuelle Zuordnung (optional)")}
            style={{ flex: '1 1 200px', minWidth: 0, padding: '8px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}
          />
          <Button
            onClick={createMatch}
            disabled={selectedTxns.length === 0 && selectedDocs.length === 0}
            color={colors.green}
          >
            {text("Zuordnung erstellen (")}{selectedTxns.length} {text("Buchungen +")} {selectedDocs.length} {text("Dokumente)")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
