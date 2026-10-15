import React, { useEffect, useState } from 'react';
import { communityFetch } from '../api';
import {problemMessage} from '../i18n/community-problems';
import { useLanguage } from '../i18n/locale';
import { communityInvoiceBotText } from '../i18n/community-invoice-bot';

type Portal = { id: string; label: string; origin: string;help?:string;receipt_capture?:boolean };
type Invoice = { source_id: string; filename: string; date?: string;evidence_kind?:'provider-download'|'receipt-capture';source_origin?:string;capture?:{width:number;height:number;unconfirmed:true} };
type ReceiptTarget={id:string;origin:string;tab_number:number};
type Run = { id: string; adapter_id: string; status: string; discovered: Invoice[]; imported: string[]; error?: string };
const base = '/api/community/invoice-bot';
export function CommunityInvoiceBot({permissions}:{permissions?:readonly string[]}={}) {
  const mayConfigure=permissions===undefined||permissions.includes('integrations:configure'),maySync=permissions===undefined||permissions.includes('integrations:sync');
  const { language } = useLanguage();
  const t = communityInvoiceBotText[language === 'de' ? 'de' : 'en'];
  const [portals, setPortals] = useState<Portal[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<Record<string,string[]>>({});
  const [targets,setTargets]=useState<Record<string,ReceiptTarget[]>>({});
  const [target,setTarget]=useState<Record<string,string>>({});
  const [receiptConfirmed,setReceiptConfirmed]=useState<Record<string,boolean>>({});
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await communityFetch(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });
    const data = await response.json();
    if (!response.ok) throw new Error(problemMessage(data));
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
    try { await request(path, 'POST', body);setSelected({}); await load(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const findReceiptTabs=async(id:string)=>{
    setBusy(true);setError('');setTarget(value=>({...value,[id]:''}));setReceiptConfirmed(value=>({...value,[id]:false}));
    try{const found=await request(`/portals/${id}/receipt-targets`);setTargets(value=>({...value,[id]:found}));}catch(error){setError((error as Error).message);}finally{setBusy(false);}
  };
  const captureReceipt=async(id:string)=>{await act(`/portals/${id}/capture-receipt`,{tab_id:target[id],confirm_receipt_only:receiptConfirmed[id]===true});setTargets(value=>({...value,[id]:[]}));setTarget(value=>({...value,[id]:''}));setReceiptConfirmed(value=>({...value,[id]:false}));};
  return <section style={{ maxWidth: 1000, margin: '1rem auto', padding: 16 }}>
    <h1>{t.title}</h1><p>{t.assisted}</p><p>{t.authorization}</p>{error && <p role="alert">{error}</p>}
    <h2>{t.portals}</h2>
    {portals.length === 0 && <p>{t.noPortal}</p>}
    {portals.map(portal => <section key={portal.id} data-portal={portal.id} style={{ padding: 12, border: '1px solid #ccc', marginBottom: 12 }}>
      <h3>{portal.label}</h3><p>{portal.origin}</p><p>{t.status}: {connected[portal.id] ? t.connected : t.disconnected}</p>
      {portal.id==='aliexpress'&&<p>{t.aliexpress}</p>}{portal.id==='bambulab-eu'&&<p>{t.bambu}</p>}{portal.id==='austrian-post-orders'&&<p>{t.postOrders}</p>}
      {portal.help&&<p><a href={portal.help} target="_blank" rel="noopener noreferrer">{t.providerHelp}</a></p>}
      {!connected[portal.id] ? mayConfigure&&<button disabled={busy} onClick={() => void act(`/portals/${portal.id}/connect`)}>{t.connect}</button> : <>
        <button disabled={busy||!maySync} onClick={() => void act(`/portals/${portal.id}/discover`)}>{t.discover}</button>{' '}
        <button disabled={busy||!mayConfigure} onClick={() => void act(`/portals/${portal.id}/disconnect`)}>{t.disconnect}</button>
      </>}
      {connected[portal.id]&&portal.receipt_capture&&maySync&&<fieldset disabled={busy} style={{marginTop:12}}>
        <legend>{t.receiptCapture}</legend><p>{t.receiptInstructions}</p>
        <button onClick={()=>void findReceiptTabs(portal.id)}>{t.findReceiptTabs}</button>
        {targets[portal.id]&&targets[portal.id].length===0&&<p>{t.noReceiptTabs}</p>}
        {targets[portal.id]?.map(item=><label key={item.id} style={{display:'block'}}><input type="radio" name={'receipt-tab-'+portal.id} value={item.id} checked={target[portal.id]===item.id} onChange={()=>{setTarget(value=>({...value,[portal.id]:item.id}));setReceiptConfirmed(value=>({...value,[portal.id]:false}));}}/>{t.receiptTab} {item.tab_number} · {item.origin}</label>)}
        {!!target[portal.id]&&<label style={{display:'block',margin:'8px 0'}}><input type="checkbox" data-receipt-confirm={portal.id} checked={receiptConfirmed[portal.id]===true} onChange={event=>setReceiptConfirmed(value=>({...value,[portal.id]:event.target.checked}))}/>{t.receiptConsent}</label>}
        <button data-capture-receipt={portal.id} disabled={busy||!target[portal.id]||!receiptConfirmed[portal.id]} onClick={()=>void captureReceipt(portal.id)}>{t.captureSelectedReceipt}</button>
      </fieldset>}
    </section>)}
    <h2>{t.runs}</h2>
    {runs.map(run => <section key={run.id} data-run={run.id} style={{ padding: 12, border: '1px solid #ccc', marginBottom: 12 }}>
      <h3>{run.adapter_id} · {language==='de'?({running:'Wird ausgeführt',discovered:'Gefunden',imported:'Importiert',failed:'Fehlgeschlagen',cancelled:'Abgebrochen'} as Record<string,string>)[run.status]??run.status:run.status}</h3>{run.error && <p role="alert">{problemMessage({code:run.error},language,run.error)}</p>}
      {run.discovered.length > 0 && <><p>{t.select}</p>{run.discovered.map(invoice => <label key={invoice.source_id} style={{ display: 'block' }}>
        <input type="checkbox" checked={(selected[run.id]??[]).includes(invoice.source_id)} disabled={!maySync||run.imported.includes(invoice.source_id)} onChange={event => setSelected(value=>({...value,[run.id]:event.target.checked ? [...(value[run.id]??[]),invoice.source_id] : (value[run.id]??[]).filter(id => id !== invoice.source_id)}))} /> {invoice.filename} {invoice.date ?? ''} {run.imported.includes(invoice.source_id) ? '✓' : ''}
        <small style={{display:'block',marginLeft:24}}>{invoice.evidence_kind==='receipt-capture'?t.receiptEvidence:t.downloadEvidence}{invoice.source_origin?' · '+invoice.source_origin:''}{invoice.capture?' · '+invoice.capture.width+'×'+invoice.capture.height:''}</small>
      </label>)}<button disabled={busy || !maySync || !(selected[run.id]??[]).length} onClick={() => void act(`/runs/${run.id}/import`, { source_ids: selected[run.id]??[] })}>{t.import}</button></>}
      {run.status === 'running' && <button disabled={busy} onClick={() => void act(`/runs/${run.id}/cancel`)}>{t.cancel}</button>}
      {(run.status === 'failed' || run.status === 'cancelled') && <button disabled={busy} onClick={() => void act(`/portals/${run.adapter_id}/discover`)}>{t.retry}</button>}
    </section>)}
  </section>;
}
