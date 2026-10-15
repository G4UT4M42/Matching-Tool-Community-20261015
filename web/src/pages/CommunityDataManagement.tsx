import React from 'react';
import { communityFetch } from '../api';
import {problemMessage} from '../i18n/community-problems';
import { useLanguage } from '../i18n/locale';
import { persistenceText } from '../i18n/community-persistence';

type Summary = { counts: { transactions: number; documents: number; match_groups: number; audit_events: number }; totals_minor_by_currency: Record<string, number>; match_statuses: Record<string, number> };
type Manifest = { created_at: string; financial: Summary; files: Record<string, { bytes: number; sha256: string }> };
type Backup = { id: string; manifest: Manifest };
type Stage = { id: string; fingerprint: string; manifest: Manifest };
const base = '/api/community/persistence';
async function result<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await communityFetch(base + path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(problemMessage(body));
  }
  return response.json() as Promise<T>;
}
function Financial({ value, labels }: { value: Summary; labels: typeof persistenceText.en | typeof persistenceText.de }) {
  return <dl style={{ display: 'grid', gridTemplateColumns: 'max-content auto', gap: '4px 16px' }}>
    <dt>{labels.count}</dt><dd>{value.counts.transactions}</dd>
    <dt>{labels.documents}</dt><dd>{value.counts.documents}</dd>
    <dt>{labels.matches}</dt><dd>{value.counts.match_groups}</dd>
    <dt>{labels.total}</dt><dd>{Object.entries(value.totals_minor_by_currency).map(([currency, amount]) => `${currency} ${amount}`).join(', ') || '—'}</dd>
  </dl>;
}
export function CommunityDataManagement() {
  const { language } = useLanguage();
  const t = language.startsWith('de') ? persistenceText.de : persistenceText.en;
  const [backups, setBackups] = React.useState<Backup[]>([]);
  const [file, setFile] = React.useState<File | null>(null);
  const [stage, setStage] = React.useState<Stage | null>(null);
  const [sources, setSources] = React.useState<Array<{ id: string; label: string }>>([]);
  const [sourceId, setSourceId] = React.useState('');
  const [sourceRoot,setSourceRoot]=React.useState(''),[sourceLabel,setSourceLabel]=React.useState('');
  const [legacyPreview, setLegacyPreview] = React.useState<{ fingerprint: string; counts: Summary['counts']; signed_totals_minor_by_currency: Record<string, number> } | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const refresh = React.useCallback(async () => {
    const data = await result<{ backups: Backup[] }>('/backups');
    setBackups(data.backups);
  }, []);
  React.useEffect(() => {
    void refresh().catch(error => setError(String(error)));
    void result<{ sources: Array<{ id: string; label: string }> }>('/legacy/sources').then(value => setSources(value.sources)).catch(() => {});
  }, [refresh]);
  async function run(action: () => Promise<void>) {
    setError(''); setNotice(''); setBusy(true);
    try { await action(); } catch (problem) { setError(problem instanceof Error ? problem.message : t.error); }
    finally { setBusy(false); }
  }
  async function download(id: string) {
    const response = await communityFetch(`${base}/backups/${id}/download`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `community-backup-${id}.zip`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  }
  return <section style={{ padding: 24, maxWidth: 900 }}>
    <h1>{t.title}</h1>
    {error && <p role="alert" style={{ color: '#a21d22' }}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <section aria-label={t.backups}>
      <h2>{t.backups}</h2>
      <button disabled={busy} onClick={() => void run(async () => { await result('/backups', { method: 'POST' }); await refresh(); })}>{t.create}</button>
      <ul>{backups.map(backup => <li key={backup.id} data-backup-id={backup.id} style={{ margin: '16px 0' }}>
        <strong>{new Date(backup.manifest.created_at).toLocaleString(language)}</strong>
        <Financial value={backup.manifest.financial} labels={t} />
        <button disabled={busy} onClick={() => void run(() => download(backup.id))}>{t.download}</button>
      </li>)}</ul>
    </section>
    <section aria-label={t.restore}>
      <h2>{t.restore}</h2>
      <label>{t.choose} <input id="restore-backup-file" type="file" accept=".zip,application/zip" onChange={event => { setFile(event.target.files?.[0] ?? null); setStage(null); }} /></label>
      <button disabled={!file || busy} onClick={() => void run(async () => {
        if (!file) return;
        const staged = await result<Stage>('/restore/stage', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: await file.arrayBuffer() });
        setStage(staged);
      })}>{t.stage}</button>
      {stage && <div role="group" aria-label={t.staged} data-restore-stage-id={stage.id}>
        <p>{t.staged}</p><Financial value={stage.manifest.financial} labels={t} />
        <p>{t.warning}</p>
        <button disabled={busy} onClick={() => void run(async () => {
          await result(`/restore/${stage.id}/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint: stage.fingerprint }) });
          setStage(null); setNotice(t.title); await refresh();
        })}>{t.confirm}</button>
      </div>}
    </section>
    <section aria-label={t.legacy}>
      <h2>{t.legacy}</h2>
      <form onSubmit={event=>{event.preventDefault();void run(async()=>{const selected=await result<{id:string;label:string}>('/legacy/sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root:sourceRoot,label:sourceLabel})});setSources([selected]);setSourceId(selected.id);setLegacyPreview(null);});}} style={{display:'grid',gap:8,maxWidth:600}}>
        <label>{t.sourceLabel}<input id="legacy-source-label" required value={sourceLabel} onChange={event=>setSourceLabel(event.target.value)}/></label><label>{t.sourceRoot}<input id="legacy-source-root" required value={sourceRoot} onChange={event=>setSourceRoot(event.target.value)}/></label><button disabled={busy}>{t.selectSource}</button>
      </form><p>{t.sourceHelp}</p>
      {sources.length === 0 ? <p>{t.noSources}</p> : <>
        <label>{t.source} <select value={sourceId} onChange={event => { setSourceId(event.target.value); setLegacyPreview(null); }}>
          <option value="">—</option>{sources.map(source => <option value={source.id} key={source.id}>{source.label}</option>)}
        </select></label>
        <button disabled={!sourceId || busy} onClick={() => void run(async () => {
          setLegacyPreview(await result(`/legacy/${sourceId}/inspect`, { method: 'POST' }));
        })}>{t.inspect}</button>
        {legacyPreview && <div>
          <p>{t.count}: {legacyPreview.counts.transactions}; {t.documents}: {legacyPreview.counts.documents}; {t.matches}: {legacyPreview.counts.match_groups}</p>
          <p>{t.total}: {Object.entries(legacyPreview.signed_totals_minor_by_currency).map(([currency, amount]) => `${currency} ${amount}`).join(', ')}</p>
          <button disabled={busy} onClick={() => void run(async () => {
            const converted = await result<Stage>(`/legacy/${sourceId}/stage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint: legacyPreview.fingerprint }) });
            setStage(converted); setNotice(t.staged); await refresh();
          })}>{t.migrate}</button>
        </div>}
      </>}
    </section>
  </section>;
}
