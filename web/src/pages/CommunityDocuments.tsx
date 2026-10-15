import React, { useEffect, useState } from 'react';
import { communityFetch } from '../api';
import {problemMessage} from '../i18n/community-problems';
import { minorUnitDecimal } from '../format/money';
import { useLanguage } from '../i18n/locale';
import { communityDocumentsText } from '../i18n/community-documents';
import {documentWarningMessage} from '../i18n/document-warnings';

type Fields = {document_type?:'invoice'|'credit_note'; invoice_number?: string; supplier_name?: string; document_date?: string; total_amount_minor?: number; net_amount_minor?: number; vat_amount_minor?: number; currency_code?: string; payment_reference?: string; iban?: string; due_date?: string };
type RecordItem = { id: string; filename: string; status: string; hash: string; fields: Fields; recognition: { confidence: number; raw_text: string; warnings: string[] }; history: Array<{ at: string; actor: string; action: string; fields?: Fields }> };
const base = '/api/community/documents';
const amount = (value: number | undefined, currency: string) => value === undefined ? '' : minorUnitDecimal(value, currency);
export function CommunityDocuments({permissions}:{permissions?:readonly string[]}={}) {
  const mayWrite=permissions===undefined||permissions.includes('documents:write');
  const { language } = useLanguage();
  const t = communityDocumentsText[language === 'de' ? 'de' : 'en'];
  const statusLabel=(value:string)=>language==='de'?({review:'In Prüfung',confirmed:'Bestätigt',rejected:'Abgelehnt',archived:'Archiviert',uploaded:'Hochgeladen',corrected:'Korrigiert',imported:'Importiert',archive:'Archiviert',restore:'Wiederhergestellt',reject:'Abgelehnt'} as Record<string,string>)[value]??value:value;
  const fieldLabel=(key:string)=>({document_type:t.documentType,invoice_number:t.invoice,supplier_name:t.supplier,document_date:t.date,total_amount_minor:t.gross,net_amount_minor:t.net,vat_amount_minor:t.vat,currency_code:t.currency,payment_reference:t.reference,iban:t.iban,due_date:t.dueDate} as Record<string,string>)[key]??key.replace(/_/g,' ');
  const [items, setItems] = useState<RecordItem[]>([]);
  const [selected, setSelected] = useState<RecordItem | null>(null);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; mime: string } | null>(null);
  const load = async (q = query) => {
    const response = await communityFetch(`${base}?q=${encodeURIComponent(q)}`);
    if (!response.ok) throw new Error(problemMessage(await response.json()));
    const data = await response.json() as { items: RecordItem[] }; setItems(data.items);
    if (selected) { const updated = data.items.find(item => item.id === selected.id); if (updated) choose(updated); }
  };
  const choose = (item: RecordItem) => {
    if (preview) { URL.revokeObjectURL(preview.url); setPreview(null); }
    setSelected(item); setForm({document_type:item.fields.document_type??'invoice', invoice_number: item.fields.invoice_number ?? '', supplier_name: item.fields.supplier_name ?? '', document_date: item.fields.document_date ?? '', total_amount: amount(item.fields.total_amount_minor, item.fields.currency_code ?? 'EUR'), net_amount: amount(item.fields.net_amount_minor, item.fields.currency_code ?? 'EUR'), vat_amount: amount(item.fields.vat_amount_minor, item.fields.currency_code ?? 'EUR'), currency_code: item.fields.currency_code ?? 'EUR', payment_reference: item.fields.payment_reference ?? '', iban: item.fields.iban ?? '', due_date: item.fields.due_date ?? '' });
  };
  useEffect(() => { void load('').catch(error => setError(error.message)); }, []);
  const call = async (path: string, method: string, body?: BodyInit, headers?: HeadersInit) => {
    setBusy(true); setError('');
    try {
      const response = await communityFetch(`${base}${path}`, { method, body, headers });
      const result = await response.json();
      if (!response.ok) throw new Error(problemMessage(result));
      await load();
      if (result.record) choose(result.record);
      else if (result.id) choose(result);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const content = async (download: boolean) => {
    if (!selected) return;
    setError('');
    try {
      const response = await communityFetch(`${base}/${encodeURIComponent(selected.id)}/content`);
      if (!response.ok) throw new Error(problemMessage(await response.json().catch(()=>({})),language));
      const mime = response.headers.get('content-type') ?? 'application/octet-stream';
      const url = URL.createObjectURL(await response.blob());
      if (download) { const link = document.createElement('a'); link.href = url; link.download = selected.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      else { if (preview) URL.revokeObjectURL(preview.url); setPreview({ url, mime }); }
    } catch (error) { setError((error as Error).message); }
  };
  return <section style={{ maxWidth: 1200, margin: '1rem auto', padding: 16 }}>
    <h1>{t.title}</h1>
    <form onSubmit={event => { event.preventDefault(); void load().catch(error => setError(error.message)); }}>
      <label>{t.search} <input value={query} onChange={event => setQuery(event.target.value)} /></label> <button type="submit">{t.search}</button>
    </form>
    {mayWrite&&<label>{t.upload} <input id="document-upload-file" type="file" accept=".pdf,.png,.jpg,.jpeg" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) { const data = new FormData(); data.append('file', file); void call('/upload', 'POST', data); } }} /></label>}
    {mayWrite&&([['invoice', t.importInvoice], ['income', t.importIncome]] as const).map(([kind, label]) => <label key={kind} style={{ display: 'block', marginTop: 8 }}>{label} <input id={`document-${kind}-file`} type="file" accept=".csv,.xlsx" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) { const data = new FormData(); data.append('file', file); void call(`/import/${kind}`, 'POST', data); } }} /></label>)}
    {error && <p role="alert">{error}</p>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,340px),1fr))', gap: 16, marginTop: 16 }}>
      <section><h2>{t.title}</h2><ul>{items.map(item => <li key={item.id}><button type="button" data-document-id={item.id} onClick={() => choose(item)}>{item.filename} · {statusLabel(item.status)}</button></li>)}</ul></section>
      {selected ? <section><h2>{t.review}: {selected.filename}</h2>
        <p>SHA-256: <code>{selected.hash}</code></p>
        <button type="button" onClick={() => void content(false)}>{t.preview}</button>{' '}
        <button type="button" onClick={() => void content(true)}>{t.download}</button>
        {preview && (preview.mime.startsWith('image/') ? <img alt={selected.filename} src={preview.url} style={{ display: 'block', maxWidth: '100%', maxHeight: 500, marginTop: 8 }} /> : preview.mime === 'application/pdf' ? <iframe title={t.preview} src={preview.url} sandbox="" style={{ display: 'block', width: '100%', height: 500, marginTop: 8 }} /> : <p>{t.previewHelp}</p>)}
        <dl>{Object.entries(selected.fields).map(([key, value]) => <React.Fragment key={key}><dt>{fieldLabel(key)}</dt><dd>{key.endsWith('_minor') && typeof value === 'number' ? amount(value, selected.fields.currency_code ?? 'EUR') : String(value)}</dd></React.Fragment>)}</dl>
        {mayWrite&&selected.status === 'review' && <form onSubmit={event => { event.preventDefault(); void call(`/${selected.id}/fields`, 'PUT', JSON.stringify(form), { 'Content-Type': 'application/json' }); }}>
          <label>{t.documentType} <select id="document-field-document_type" value={form.document_type??'invoice'} onChange={event=>setForm({...form,document_type:event.target.value})}><option value="invoice">{t.invoiceType}</option><option value="credit_note">{t.creditNote}</option></select></label>
          {([['invoice_number',t.invoice],['supplier_name',t.supplier],['document_date',t.date],['total_amount',t.gross],['net_amount',t.net],['vat_amount',t.vat],['currency_code',t.currency],['payment_reference',t.reference],['iban',t.iban],['due_date',t.dueDate]] as const).map(([key,label]) => <label key={key} style={{ display: 'block', margin: '0.5rem 0' }}>{label} <input id={'document-field-'+key} value={form[key] ?? ''} onChange={event => setForm({ ...form, [key]: event.target.value })} /></label>)}
          <button disabled={busy} type="submit">{t.save}</button>
        </form>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          {mayWrite&&selected.status === 'review' && <><button disabled={busy} onClick={() => void call(`/${selected.id}/confirm`, 'POST')}>{t.confirm}</button><button disabled={busy} onClick={() => void call(`/${selected.id}/reject`, 'POST')}>{t.reject}</button></>}
          {mayWrite&&selected.status !== 'archived' && <button disabled={busy} onClick={() => void call(`/${selected.id}/archive`, 'POST')}>{t.archive}</button>}
          {mayWrite&&selected.status === 'archived' && <button disabled={busy} onClick={() => void call(`/${selected.id}/restore`, 'POST')}>{t.restore}</button>}
        </div>
        <details><summary>{t.evidence} · {Math.round(selected.recognition.confidence * 100)}%</summary><ul>{selected.recognition.warnings.map((warning,index) => <li key={index}>{documentWarningMessage(warning,language==='de'?'de':'en')}</li>)}</ul><pre style={{ whiteSpace: 'pre-wrap' }}>{selected.recognition.raw_text}</pre></details>
        <details><summary>{t.history}</summary><ol>{selected.history.map((entry,index) => <li key={index}>{entry.at} · {statusLabel(entry.action)} · {entry.actor}{entry.fields && <ul>{Object.entries(entry.fields).map(([key,value]) => <li key={key}>{fieldLabel(key)}: {String(value)}</li>)}</ul>}</li>)}</ol></details>
      </section> : <p>{t.select}</p>}
    </div>
  </section>;
}
