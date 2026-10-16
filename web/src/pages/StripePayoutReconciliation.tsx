import React from 'react';
import {communityFetch} from '../api';
import {problemMessage} from '../i18n/community-problems';
import {payoutText,payoutReasonText} from '../i18n/community-payouts';
import {isPayoutId,payoutList,payoutReport,type PayoutReport,type PayoutSummary} from '../payout-contract';

export function StripePayoutReconciliation({environment,language,maySync,onRecorded,disabled=false}:{environment:'test'|'live';language:string;maySync:boolean;disabled?:boolean;onRecorded?:()=>Promise<unknown>}){
 const t=payoutText[language==='de'?'de':'en'];
 const [id,setId]=React.useState(''),[items,setItems]=React.useState<PayoutSummary[]>([]),[report,setReport]=React.useState<PayoutReport|null>(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[loaded,setLoaded]=React.useState(false);
 const life=React.useRef({mounted:true,epoch:0}),lock=React.useRef(false),path=`/api/community/integrations/stripe/${environment}/payouts`;
 React.useEffect(()=>{life.current.mounted=true;return()=>{life.current.mounted=false;life.current.epoch++;};},[]);
 const current=(epoch:number)=>life.current.mounted&&life.current.epoch===epoch;
 const request=async(suffix:string,method='GET',body?:unknown)=>{const response=await communityFetch(path+suffix,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!response.ok){const problem=await response.json().catch(()=>({}));const code=typeof problem?.code==='string'?problem.code:'';throw Error(payoutReasonText[code]?.[language==='de'?'de':'en']??problemMessage({code},language,t.error));}try{return await response.json() as unknown;}catch{throw Error(t.invalid);}};
 const run=async(action:(epoch:number)=>Promise<void>)=>{if(disabled||lock.current)return;lock.current=true;setBusy(true);setError('');const epoch=life.current.epoch;try{await action(epoch);}catch(error){if(current(epoch)){setReport(null);setItems([]);setLoaded(false);setError(error instanceof Error?error.message:t.error);}}finally{lock.current=false;if(current(epoch))setBusy(false);}};
 const load=async(epoch:number)=>{const raw=await request('');if(!current(epoch))return;let next:PayoutSummary[];try{next=payoutList(raw,environment);}catch{throw Error(t.invalid);}setItems(next);setLoaded(true);};
 const read=()=>void run(async epoch=>{const raw=await request('/'+encodeURIComponent(id));if(!current(epoch))return;try{setReport(payoutReport(raw,environment,id));}catch{throw Error(t.invalid);}});
 const status=(value:PayoutSummary['status'])=>t[value];
 const table=(components:PayoutReport['components'])=><div style={{overflowX:'auto'}}><table style={{borderCollapse:'collapse',width:'100%'}}><thead><tr>{[t.reference,t.kind,t.amount,t.fee,t.netLabel].map(label=><th key={label} style={{padding:'8px 12px',textAlign:'left',borderBottom:'1px solid #b8b8b8'}}>{label}</th>)}</tr></thead><tbody>{components.map(component=><tr key={component.reference}><td style={{overflowWrap:'anywhere',padding:'8px 12px'}}>{component.reference}</td><td style={{padding:'8px 12px'}}>{language==='de'?({payment:'Zahlung/Kauf',refund:'Erstattung',dispute:'Streitfall',fee:'Gebühr',payout:'Auszahlung',transfer:'Umbuchung',other:'Sonstiges'} as Record<string,string>)[component.classification]??component.classification:component.classification}</td><td style={{padding:'8px 12px',textAlign:'right',whiteSpace:'nowrap'}}>{component.amountMinor}</td><td style={{padding:'8px 12px',textAlign:'right',whiteSpace:'nowrap'}}>{component.feeMinor}</td><td style={{padding:'8px 12px',textAlign:'right',whiteSpace:'nowrap'}}>{component.netMinor}</td></tr>)}</tbody></table></div>;
 return <section style={{marginTop:32,minWidth:0}} aria-labelledby="stripe-payout-heading">
  <h2 id="stripe-payout-heading">{t.title}</h2><p>{t.intro}</p><p>{t.retry}</p>
  <button id="payout-load" disabled={busy||disabled} onClick={()=>void run(load)}>{t.load}</button>
  <form onSubmit={event=>{event.preventDefault();if(!maySync||!isPayoutId(id))return;void run(async epoch=>{const raw=await request('/reconcile','POST',{payoutId:id});if(!current(epoch))return;let next:PayoutReport;try{next=payoutReport(raw,environment,id);}catch{throw Error(t.invalid);}setReport(next);await load(epoch);if(current(epoch))await onRecorded?.();});}} style={{display:'grid',gap:8,marginTop:16,maxWidth:520}}>
   {items.length>0&&<label>{t.choose}<select id="payout-choice" disabled={busy||disabled} value={items.some(item=>item.payoutId===id)?id:''} onChange={event=>{setId(event.target.value);setReport(null);}}><option value="">{t.choose}</option>{items.map(item=><option key={item.payoutId} value={item.payoutId}>{item.payoutId} · {status(item.status)}</option>)}</select></label>}
   <label>{t.id}<input id="payout-id" required disabled={busy||disabled} pattern="po_[A-Za-z0-9]{1,128}" maxLength={131} value={id} onChange={event=>{setId(event.target.value);setReport(null);}} autoComplete="off"/></label>
   <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{maySync&&<button id="payout-reconcile" disabled={busy||disabled||!isPayoutId(id)}>{t.reconcile}</button>}<button id="payout-details" type="button" disabled={busy||disabled||!isPayoutId(id)} onClick={read}>{t.details}</button></div>
  </form>
  {busy&&<p role="status">{t.loading}</p>}{error&&<p role="alert">{error}</p>}
  {loaded&&<><h3>{t.history}</h3>{items.length===0?<p>{t.none}</p>:<ul data-testid="payout-history">{items.map(item=><li key={item.payoutId}>{item.payoutId} · {status(item.status)}{item.currency?` · ${item.currency}`:''}{item.observedAt?` · ${item.observedAt}`:''}</li>)}</ul>}</>}
  {report&&<div data-testid="payout-report" data-status={report.status} style={{overflowWrap:'anywhere'}}>
   <h3>{report.payoutId}</h3><p role="status">{t.status}: {status(report.status)}</p>{report.reason&&<p>{t.reason}: {payoutReasonText[report.reason]?.[language==='de'?'de':'en']??t.error}</p>}
   <p>{t.account}: {report.account}</p><p>{t.observed}: {report.observedAt}</p><p>{t.currency}: {report.currency} · {t.units}</p>
   <dl><dt>{t.bankAmount}</dt><dd>{report.amountMinor}</dd><dt>{t.gross}</dt><dd>{report.totals.grossMinor}</dd><dt>{t.fees}</dt><dd>{report.totals.feeMinor}</dd><dt>{t.net}</dt><dd>{report.totals.netMinor}</dd></dl>
   <h4>{t.components}</h4>{report.components.length?table(report.components):<p>{t.emptyComponents}</p>}
   {report.payoutLeg&&<><h4>{t.ownLeg}</h4>{table([report.payoutLeg])}<p>{language==='de'?'Erforderliche Deckung / Auszahlungsgebühr / Restdifferenz':'Required funding / payout fee / residual'}: {report.requiredFundingMinor} / {report.settlementFeeMinor} / {report.residualMinor}</p></>}
   {report.replayed&&<p>{t.replayed}</p>}
  </div>}
 </section>;
}
