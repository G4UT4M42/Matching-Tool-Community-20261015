import React from 'react';
import { communityFetch } from '../api';
import {problemMessage} from '../i18n/community-problems';
import { useLanguage } from '../i18n/locale';
import { integrationMessages } from '../i18n/community-integrations';

type Provider = 'paypal' | 'stripe';
type Environment = 'sandbox' | 'test' | 'live';
type Status = { configured: boolean; lastSuccess: string | null; lastError: string | null };
type HistoryEntry={id:string;occurred_at:string;operation:string;phase:string;outcome:string;imported?:number;code?:string};
class IntegrationUiError extends Error {}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function responseStatus(value:unknown,provider:Provider,environment:Environment):Status|null{
  if(!object(value)||typeof value.configured!=='boolean'||value.lastSuccess!==null&&(typeof value.lastSuccess!=='string'||value.lastSuccess.length>64||!Number.isFinite(Date.parse(value.lastSuccess)))||value.lastError!==null&&(typeof value.lastError!=='string'||value.lastError.length>200)||value.provider!==undefined&&value.provider!==provider||value.environment!==undefined&&value.environment!==environment)return null;
  return{configured:value.configured,lastSuccess:value.lastSuccess as string|null,lastError:value.lastError as string|null};
}
function responseHistory(value:unknown):HistoryEntry[]|null{
  if(!object(value)||!Array.isArray(value.items)||value.items.length>100)return null;
  const items:HistoryEntry[]=[],ids=new Set<string>();
  for(const item of value.items){
    if(!object(item)||typeof item.id!=='string'||!item.id||item.id.length>200||ids.has(item.id)||typeof item.occurred_at!=='string'||item.occurred_at.length>64||!Number.isFinite(Date.parse(item.occurred_at))||!['configure','test','sync','disconnect'].includes(String(item.operation))||!(item.phase==='started'&&item.outcome==='started'||item.phase==='completed'&&['succeeded','failed'].includes(String(item.outcome)))||item.imported!==undefined&&(!Number.isSafeInteger(item.imported)||Number(item.imported)<0||item.operation!=='sync'||item.outcome!=='succeeded')||item.code!==undefined&&(typeof item.code!=='string'||!/^[A-Z][A-Z0-9_]{1,99}$/.test(item.code)))return null;
    ids.add(item.id);items.push({id:item.id,occurred_at:item.occurred_at,operation:String(item.operation),phase:String(item.phase),outcome:String(item.outcome),...(item.imported!==undefined?{imported:Number(item.imported)}:{}),...(item.code!==undefined?{code:String(item.code)}:{})});
  }
  return items;
}
export function CommunityIntegrations({permissions}:{permissions?:readonly string[]}={}) {
  const may=(permission:string)=>permissions===undefined||permissions.includes(permission);
  const { language } = useLanguage();
  const m = integrationMessages[language === 'de' ? 'de' : 'en'];
  const [history,setHistory]=React.useState<HistoryEntry[]>([]);
  const [provider, setProvider] = React.useState<Provider>('paypal');
  const [environment, setEnvironment] = React.useState<Environment>('sandbox');
  const [clientId, setClientId] = React.useState('');
  const [clientSecret, setClientSecret] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [status, setStatus] = React.useState<Status | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const path = `/api/community/integrations/${provider}/${environment}`;
  const invalidResponse=language==='de'?'Die lokale Integrationsantwort ist ungültig. Seite neu laden und erneut versuchen. Bei erneutem Fehler die Anwendung neu starten.':'The local integration response is invalid. Reload the page and try again. If it persists, restart the application.';
  const scope=React.useRef({path,language,epoch:0}),refreshSequence=React.useRef(0);if(scope.current.path!==path||scope.current.language!==language)scope.current={path,language,epoch:scope.current.epoch+1};
  const refresh = React.useCallback(async () => {
    const epoch=scope.current.epoch,sequence=++refreshSequence.current;
    const current=()=>scope.current.path===path&&scope.current.language===language&&scope.current.epoch===epoch&&sequence===refreshSequence.current;
    try{
      const [response,entries]=await Promise.all([communityFetch(path),communityFetch(path+'/history')]);
      if(!current())return false;
      if(!response.ok||!entries.ok){const failed=!response.ok?response:entries;throw new IntegrationUiError(problemMessage(await failed.json().catch(()=>({})),language,m.error));}
      let rawStatus:unknown,rawHistory:unknown;
      try{[rawStatus,rawHistory]=await Promise.all([response.json(),entries.json()]);}catch{throw new IntegrationUiError(invalidResponse);}
      if(!current())return false;
      const nextStatus=responseStatus(rawStatus,provider,environment),nextHistory=responseHistory(rawHistory);
      if(!nextStatus||!nextHistory)throw new IntegrationUiError(invalidResponse);
      setStatus(nextStatus);setHistory(nextHistory);return true;
    }catch(error){if(!current())return false;setStatus(null);setHistory([]);throw new Error(error instanceof IntegrationUiError?error.message:m.error);}
  }, [path,provider,environment,language,invalidResponse,m.error]);
  React.useEffect(() => { const epoch=scope.current.epoch;setStatus(null);setHistory([]);setNotice(''); void refresh().catch(error => {if(scope.current.path===path&&scope.current.language===language&&scope.current.epoch===epoch)setNotice(error instanceof Error?error.message:m.error);}); }, [refresh, m.error,path,language]);
  const invoke = async (method: string, suffix = '', body?: unknown) => {
    setBusy(true); setNotice('');
    try {
      const response = await communityFetch(path + suffix, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if(scope.current.path!==path||scope.current.language!==language)return;
      if (!response.ok) {const message=problemMessage(await response.json().catch(()=>({})),language);const refreshed=await refresh();if(refreshed)throw new Error(message);return;}
      const refreshed=await refresh(); if(refreshed&&scope.current.path===path&&scope.current.language===language)setNotice(m.success);
    } catch(error) { if(scope.current.path===path&&scope.current.language===language)setNotice(error instanceof Error?error.message:m.error); }
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
      <p data-testid="integration-status">{status===null?(language==='de'?'Status nicht verfügbar':'Status unavailable'):status.configured ? m.configured : m.unconfigured}</p>
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
    <div style={{overflowX:'auto'}}><table><thead><tr>{(language==='de'?['Zeit','Vorgang','Phase','Ergebnis','Importiert']:['Time','Operation','Phase','Outcome','Imported']).map(label=><th key={label}>{label}</th>)}</tr></thead><tbody data-testid="integration-history">{history.map(entry=><tr key={entry.id} data-operation={entry.operation} data-outcome={entry.outcome}><td>{entry.occurred_at}</td><td>{language==='de'?({configure:'Konfiguration',test:'Verbindungstest',sync:'Synchronisierung',disconnect:'Trennen'} as Record<string,string>)[entry.operation]:entry.operation}</td><td>{language==='de'?(entry.phase==='started'?'Begonnen':'Abgeschlossen'):entry.phase}</td><td>{language==='de'?({started:'Begonnen',succeeded:'Erfolgreich',failed:'Fehlgeschlagen'} as Record<string,string>)[entry.outcome]:entry.outcome}{entry.code?' · '+entry.code:''}</td><td>{entry.imported??'—'}</td></tr>)}</tbody></table></div>
    {notice && <p role="status">{notice}</p>}{busy && <p role="status">{m.busy}</p>}
  </section>;
}
