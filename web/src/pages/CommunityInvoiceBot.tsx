import React, { useEffect, useState } from 'react';
import { communityFetch } from '../api';
import { useLanguage } from '../i18n/locale';
import { communityInvoiceBotText } from '../i18n/community-invoice-bot';

type Portal = { id: string; label: string; origin: string };
type Invoice = { source_id: string; filename: string; date?: string };
type Run = { id: string; adapter_id: string; status: string; discovered: Invoice[]; imported: string[]; error?: string };
const base = '/api/community/invoice-bot';
export function CommunityInvoiceBot() {
  const { language } = useLanguage();
  const t = communityInvoiceBotText[language === 'de' ? 'de' : 'en'];
  const [portals, setPortals] = useState<Portal[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await communityFetch(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? data.code ?? 'Invoice Bot operation failed');
    return data;
  };
  const load = async () => {
    const [portalData, runData] = await Promise.all([request('/portals'), request('/runs')]);
    setPortals(portalData.items); setRuns(runData.items);
    const states = await Promise.all((portalData.items as Portal[]).map(async portal => [portal.id, (await request(`/portals/${portal.id}/status`)).connected] as const));
    setConnected(Object.fromEntries(states));
  };
  useEffect(() => { void load().catch(error => setError(error.message)); }, []);
  const act = async (path: string, body?: unknown) => {
    setBusy(true); setError('');
    try { await request(path, 'POST', body); await load(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <main style={{ maxWidth: 1000, margin: '1rem auto', padding: 16 }}>
    <h1>{t.title}</h1>{error && <p role="alert">{error}</p>}
    <h2>{t.portals}</h2>
    {portals.length === 0 && <p>{t.noPortal}</p>}
    {portals.map(portal => <section key={portal.id} style={{ padding: 12, border: '1px solid #ccc', marginBottom: 12 }}>
      <h3>{portal.label}</h3><p>{portal.origin}</p><p>{t.status}: {connected[portal.id] ? 'connected' : 'disconnected'}</p>
      {!connected[portal.id] ? <button disabled={busy} onClick={() => void act(`/portals/${portal.id}/connect`)}>{t.connect}</button> : <>
        <button disabled={busy} onClick={() => void act(`/portals/${portal.id}/discover`)}>{t.discover}</button>{' '}
        <button disabled={busy} onClick={() => void act(`/portals/${portal.id}/disconnect`)}>{t.disconnect}</button>
      </>}
    </section>)}
    <h2>{t.runs}</h2>
    {runs.map(run => <section key={run.id} style={{ padding: 12, border: '1px solid #ccc', marginBottom: 12 }}>
      <h3>{run.adapter_id} · {run.status}</h3>{run.error && <p role="alert">{run.error}</p>}
      {run.discovered.length > 0 && <><p>{t.select}</p>{run.discovered.map(invoice => <label key={invoice.source_id} style={{ display: 'block' }}>
        <input type="checkbox" checked={selected.includes(invoice.source_id)} disabled={run.imported.includes(invoice.source_id)} onChange={event => setSelected(event.target.checked ? [...selected, invoice.source_id] : selected.filter(id => id !== invoice.source_id))} /> {invoice.filename} {invoice.date ?? ''} {run.imported.includes(invoice.source_id) ? '✓' : ''}
      </label>)}<button disabled={busy || !selected.length} onClick={() => void act(`/runs/${run.id}/import`, { source_ids: selected })}>{t.import}</button></>}
      {run.status === 'running' && <button disabled={busy} onClick={() => void act(`/runs/${run.id}/cancel`)}>{t.cancel}</button>}
      {(run.status === 'failed' || run.status === 'cancelled') && <button disabled={busy} onClick={() => void act(`/portals/${run.adapter_id}/discover`)}>{t.retry}</button>}
    </section>)}
  </main>;
}
