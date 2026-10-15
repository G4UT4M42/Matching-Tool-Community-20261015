import React, { useState } from 'react';

type Source = 'sparkasse' | 'visa';
export type StatementReviewRequest = (url: string, init: RequestInit) => Promise<Response>;
interface ReviewRow {
  row: number; date: string; description: string; counterparty: string;
  amount_minor: number; currency: string; reference: string | null;
}
interface Preview {
  token: string; filename: string; source: Source; account_id: string;
  file_sha256: string; fetched: number; totals_minor_by_currency: Record<string,number>;
  preview: ReviewRow[]; remaining_rows: number; expires_in_seconds: number;
  payment_execution: false;
}
interface Result { imported: number; skipped: number; fetched: number; payment_execution: false }
const ui = {
  en: { title:'Review bank statement', account:'Local account identifier', source:'Statement source', file:'Choose CSV or XLSX file',
    explain:'Preview every statement before importing. Only an explicit confirmation writes financial records.',
    inspect:'Preview statement', confirm:'Confirm import', loading:'Processing…', cancel:'Discard preview',
    date:'Date',counterparty:'Counterparty',amount:'Amount in currency minor units',reference:'Reference',
    preview:'Rows previewed',remaining:'Additional rows not shown',original:'Source file fingerprint',
    totals:'Exact signed totals by currency (minor units)', result:'Import result', new:'New records',existing:'Already present',
    invalid:'Choose a supported file and a local account identifier first.',
    error:'Statement review failed. Inspect the error code and retry with a new preview.',
    noPayment:'No payment or bank connection is executed by this workflow.',
    restart:'The financial state changed. Preview again before confirmation.',
  },
  de: { title:'Kontoauszug prüfen',account:'Lokales Konto-Kennzeichen',source:'Auszugsquelle',file:'CSV- oder XLSX-Datei wählen',
    explain:'Prüfen Sie den Auszug vor dem Import. Erst eine ausdrückliche Bestätigung speichert Buchungen.',
    inspect:'Auszug prüfen',confirm:'Import bestätigen',loading:'Wird verarbeitet…',cancel:'Vorschau verwerfen',
    date:'Datum',counterparty:'Gegenpartei',amount:'Betrag in kleinsten Währungseinheiten',reference:'Referenz',
    preview:'Vorschauzeilen',remaining:'Weitere nicht angezeigte Zeilen',original:'Dateiprüfsumme',
    totals:'Exakte vorzeichenbehaftete Summen nach Währung',result:'Importergebnis',new:'Neue Buchungen',existing:'Bereits vorhanden',
    invalid:'Wählen Sie eine unterstützte Datei und ein lokales Konto-Kennzeichen.',
    error:'Die Prüfung ist fehlgeschlagen. Kontrollieren Sie den Fehlercode und erstellen Sie eine neue Vorschau.',
    noPayment:'Dieser Vorgang führt weder eine Zahlung noch eine Bankverbindung aus.',
    restart:'Die Finanzdaten haben sich geändert. Erstellen Sie vor der Bestätigung eine neue Vorschau.',
  },
} as const;
const inputStyle: React.CSSProperties = {display:'block',minWidth:0,width:'100%',padding:10,border:'1px solid #aaa',borderRadius:6,boxSizing:'border-box'};
const buttonStyle: React.CSSProperties = {padding:'10px 16px',borderRadius:6,border:'1px solid #555',cursor:'pointer'};

/** The host must supply an authenticated, same-origin CSRF-aware request callback. */
export function CommunityStatementReview({ locale = 'en', request }: { locale?: 'en' | 'de'; request: StatementReviewRequest }) {
  const t = ui[locale];
  const [source, setSource] = useState<Source>('sparkasse');
  const [account, setAccount] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const forget = () => {setPreview(null);setResult(null);setError('');};
  const accepted = Boolean(file && file.size > 0 && file.size <= 10*1024*1024 &&
    /\.(csv|xlsx)$/i.test(file.name) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(account));
  async function handleResponse(response: Response): Promise<any> {
    const data = await response.json().catch(() => ({code:'RESPONSE_INVALID'}));
    if (!response.ok) {
      const code = typeof data?.code === 'string' && /^[A-Z0-9_]{3,80}$/.test(data.code) ? data.code : 'REQUEST_FAILED';
      throw new Error(code);
    }
    return data;
  }
  const inspect = async () => {
    if (!accepted || !file || busy) {setError(t.invalid);return;}
    setBusy(true);forget();
    try {
      const form = new FormData();
      form.append('source',source);form.append('account_id',account);form.append('file',file,file.name);
      const response = await request('/api/import/preview',{method:'POST',body:form,credentials:'same-origin'});
      const data = await handleResponse(response) as Preview;
      if (!/^[A-Za-z0-9_-]{43}$/.test(data.token) || data.payment_execution !== false) throw new Error('RESPONSE_INVALID');
      setPreview(data);
    } catch (reason) {setError(reason instanceof Error ? reason.message : t.error);}
    finally {setBusy(false);}
  };
  const confirm = async () => {
    if (!preview || busy) return;
    setBusy(true);setError('');
    try {
      const response = await request('/api/import/commit',{method:'POST',body:JSON.stringify({token:preview.token}),
        headers:{'Content-Type':'application/json'},credentials:'same-origin'});
      const data = await handleResponse(response) as Result;
      if (data.payment_execution !== false) throw new Error('RESPONSE_INVALID');
      setResult(data);setPreview(null);setFile(null);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : 'REQUEST_FAILED';
      setError(code === 'STALE_ACCOUNTING_STATE' ? t.restart : code);
      if (['STALE_ACCOUNTING_STATE','REVIEW_EXPIRED'].includes(code)) setPreview(null);
    } finally {setBusy(false);}
  };
  const discard = async () => {
    if (!preview || busy) return;
    setBusy(true);setError('');
    try {
      const response = await request('/api/import/discard',{method:'POST',
        body:JSON.stringify({token:preview.token}),headers:{'Content-Type':'application/json'},
        credentials:'same-origin'});
      const data = await handleResponse(response) as {discarded: boolean; financial_records_changed: boolean};
      if (!data.discarded || data.financial_records_changed !== false) throw new Error('RESPONSE_INVALID');
      forget();
    } catch (reason) {setError(reason instanceof Error ? reason.message : t.error);}
    finally {setBusy(false);}
  };
  return <section style={{maxWidth:960,margin:'0 auto',fontFamily:'system-ui, sans-serif',lineHeight:1.5}}>
    <h1>{t.title}</h1><p>{t.explain}</p>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:12}}>
      <label>{t.source}<select aria-label={t.source} value={source} onChange={event=>{setSource(event.target.value as Source);forget();}} style={inputStyle} disabled={busy||Boolean(preview)}>
        <option value="sparkasse">Sparkasse</option><option value="visa">Visa</option>
      </select></label>
      <label>{t.account}<input aria-label={t.account} style={inputStyle} value={account}
        onChange={event=>{setAccount(event.target.value);forget();}} disabled={busy||Boolean(preview)} maxLength={80} /></label>
      <label>{t.file}<input aria-label={t.file} type="file" accept=".csv,.xlsx" style={inputStyle} disabled={busy||Boolean(preview)}
        onChange={event=>{setFile(event.target.files?.[0]??null);forget();}} /></label>
    </div>
    <div style={{display:'flex',flexWrap:'wrap',gap:10,marginTop:16}}>
      {!preview && <button type="button" style={buttonStyle} disabled={!accepted||busy} onClick={()=>void inspect()}>{busy?t.loading:t.inspect}</button>}
      {preview && <>
        <button type="button" style={buttonStyle} disabled={busy} onClick={()=>void confirm()}>{busy?t.loading:t.confirm}</button>
        <button type="button" style={buttonStyle} disabled={busy} onClick={()=>void discard()}>{t.cancel}</button>
      </>}
    </div>
    {error && <p role="alert" style={{color:'#a11'}}>{error}</p>}
    {preview && <article aria-label={t.preview}>
      <h2>{t.preview}: {preview.fetched}</h2><p>{t.original}: <code>{preview.file_sha256}</code></p>
      <h3>{t.totals}</h3>
      <ul>{Object.entries(preview.totals_minor_by_currency).map(([currency,amount])=><li key={currency}>{currency}: {amount}</li>)}</ul>
      <div style={{overflowX:'auto'}}>
        <table style={{borderCollapse:'collapse',width:'100%',minWidth:520}}>
          <thead><tr><th>{t.date}</th><th>{t.counterparty}</th><th>{t.amount}</th><th>{t.reference}</th></tr></thead>
          <tbody>{preview.preview.map(row=><tr key={row.row}><td>{row.date}</td><td>{row.counterparty}</td>
            <td style={{textAlign:'right'}}>{row.amount_minor} {row.currency}</td><td>{row.reference??'—'}</td></tr>)}</tbody>
        </table>
      </div>
      {preview.remaining_rows>0&&<p>{t.remaining}: {preview.remaining_rows}</p>}
      <p>{t.noPayment}</p>
    </article>}
    {result&&<div role="status"><h2>{t.result}</h2><p>{t.new}: {result.imported}; {t.existing}: {result.skipped}</p><p>{t.noPayment}</p></div>}
  </section>;
}
