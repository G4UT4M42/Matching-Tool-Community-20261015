import React from 'react';
import { communityFetch } from '../api';
import {problemMessage} from '../i18n/community-problems';
import { useLanguage } from '../i18n/locale';
import { integrationMessages } from '../i18n/community-integrations';

type Provider = 'paypal' | 'stripe';
type Environment = 'sandbox' | 'test' | 'live';
type Status = { configured: boolean; lastSuccess: string | null; lastError: string | null };
export function CommunityIntegrations({permissions}:{permissions?:readonly string[]}={}) {
  const may=(permission:string)=>permissions===undefined||permissions.includes(permission);
  const { language } = useLanguage();
  const m = integrationMessages[language === 'de' ? 'de' : 'en'];
  const [history,setHistory]=React.useState<Array<{id:string;occurred_at:string;operation:string;phase:string;outcome:string;imported?:number;code?:string}>>([]);
  const [provider, setProvider] = React.useState<Provider>('paypal');
  const [environment, setEnvironment] = React.useState<Environment>('sandbox');
  const [clientId, setClientId] = React.useState('');
  const [clientSecret, setClientSecret] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [status, setStatus] = React.useState<Status | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const path = `/api/community/integrations/${provider}/${environment}`;
  const scope=React.useRef({path,epoch:0}),refreshSequence=React.useRef(0);if(scope.current.path!==path)scope.current={path,epoch:scope.current.epoch+1};
  const refresh = React.useCallback(async () => {
    const epoch=scope.current.epoch,sequence=++refreshSequence.current;
    const [response,entries]=await Promise.all([communityFetch(path),communityFetch(path+'/history')]);
    if (!response.ok||!entries.ok) throw new Error('STATUS_FAILED');
    const [nextStatus,nextHistory]=await Promise.all([response.json(),entries.json()]);
    if(scope.current.path!==path||scope.current.epoch!==epoch||sequence!==refreshSequence.current)return;
    setStatus(nextStatus as Status);setHistory(nextHistory.items);
  }, [path]);
  React.useEffect(() => { setStatus(null); setNotice(''); void refresh().catch(() => setNotice(m.error)); }, [refresh, m.error]);
  const invoke = async (method: string, suffix = '', body?: unknown) => {
    setBusy(true); setNotice('');
    try {
      const response = await communityFetch(path + suffix, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) throw new Error(problemMessage(await response.json().catch(()=>({})),language));
      await refresh(); if(scope.current.path===path)setNotice(m.success);
    } catch(error) { setNotice(error instanceof Error?error.message:m.error); }
    finally { setBusy(false); }
  };
  const configure = (event: React.FormEvent) => {
    event.preventDefault();
    const credentials = provider === 'paypal' ? { clientId, clientSecret } : { apiKey };
    setClientId(''); setClientSecret(''); setApiKey('');
    void invoke('PUT', '', { credentials });
  };
  const changeProvider = (next: Provider) => { if(busy)return;setProvider(next); setEnvironment(next === 'paypal' ? 'sandbox' : 'test'); setClientId(''); setClientSecret(''); setApiKey(''); };
  return <section style={{ maxWidth: 660, padding: 24 }}>
    <h1>{m.title}</h1>
    <p>{m.consent}</p>
    <form onSubmit={configure} autoComplete="off">
      <label htmlFor="integration-provider">{m.provider}</label>
      <select disabled={busy} id="integration-provider" value={provider} onChange={event => changeProvider(event.target.value as Provider)}><option value="paypal">{m.paypal}</option><option value="stripe">{m.stripe}</option></select>
      <label htmlFor="integration-environment" style={{ marginLeft: 16 }}>{m.environment}</label>
      <select disabled={busy} id="integration-environment" value={environment} onChange={event => { setEnvironment(event.target.value as Environment); setClientId(''); setClientSecret(''); setApiKey(''); }}>
        <option value={provider === 'paypal' ? 'sandbox' : 'test'}>{provider === 'paypal' ? m.sandbox : m.test}</option><option value="live">{m.live}</option>
      </select>
      <p data-testid="integration-status">{status?.configured ? m.configured : m.unconfigured}</p>
      {may('integrations:configure')&&(provider === 'paypal' ? <>
        <label htmlFor="integration-client-id">{m.clientId}</label><input id="integration-client-id" type="password" autoComplete="off" value={clientId} onChange={event => setClientId(event.target.value)} required />
        <label htmlFor="integration-client-secret">{m.clientSecret}</label><input id="integration-client-secret" type="password" autoComplete="off" value={clientSecret} onChange={event => setClientSecret(event.target.value)} required />
      </> : <><label htmlFor="integration-api-key">{m.apiKey}</label><input id="integration-api-key" type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} required /></>)}
      {may('integrations:configure')&&<div style={{ marginTop: 16 }}><button type="submit" disabled={busy}>{status?.configured ? m.reconnect : m.configure}</button></div>}
    </form>
    <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
      {may('integrations:configure')&&<button type="button" disabled={busy || !status?.configured} onClick={() => void invoke('POST', '/test')}>{m.testConnection}</button>}
      {may('integrations:sync')&&<button type="button" disabled={busy || !status?.configured} onClick={() => void invoke('POST', '/sync')}>{m.synchronize}</button>}
      {may('integrations:configure')&&<button type="button" disabled={busy || !status?.configured} onClick={() => void invoke('DELETE')}>{m.disconnect}</button>}
    </div>
    <p>{m.lastSuccess}: {status?.lastSuccess ?? m.never}</p><p>{m.lastError}: {status?.lastError ?? m.never}</p>
    <h2>{language==='de'?'Verbindungs- und Synchronisierungsverlauf':'Connection and synchronization history'}</h2>
    <div style={{overflowX:'auto'}}><table><thead><tr>{(language==='de'?['Zeit','Vorgang','Phase','Ergebnis','Importiert']:['Time','Operation','Phase','Outcome','Imported']).map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{history.map(entry=><tr key={entry.id}><td>{entry.occurred_at}</td><td>{language==='de'?({configure:'Konfiguration',test:'Verbindungstest',sync:'Synchronisierung',disconnect:'Trennen'} as Record<string,string>)[entry.operation]:entry.operation}</td><td>{language==='de'?(entry.phase==='started'?'Begonnen':'Abgeschlossen'):entry.phase}</td><td>{language==='de'?({started:'Begonnen',succeeded:'Erfolgreich',failed:'Fehlgeschlagen'} as Record<string,string>)[entry.outcome]:entry.outcome}{entry.code?' · '+entry.code:''}</td><td>{entry.imported??'—'}</td></tr>)}</tbody></table></div>
    {notice && <p role="status">{notice}</p>}{busy && <p role="status">{m.busy}</p>}
  </section>;
}
