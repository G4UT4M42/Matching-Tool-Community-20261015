import React from 'react';
import { communityFetch } from '../api';
import { useLanguage } from '../i18n/locale';
import { bankingText } from '../i18n/community-banking';

type Status={configured:boolean;provider:string;accountRef:string|null;capabilities:Array<{paymentInitiation:boolean;qualification:string}>};
type Account={accountRef:string;currency:string;name:string;iban?:string};
const csrf=()=>document.querySelector<HTMLMetaElement>('meta[name="community-csrf"]')?.content??'';
async function request<T>(path:string,method='GET',body?:unknown):Promise<T>{
  const response=await communityFetch(`/api/community-banking${path}`,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf()},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok){const problem=await response.json().catch(()=>({code:'BANK_OPERATION_FAILED'}));throw new Error(problem.code)}
  return response.status===204?undefined as T:response.json() as Promise<T>;
}
export function CommunityBanking(){
  const {language}=useLanguage(),t=bankingText[language==='de'?'de':'en'];
  const [status,setStatus]=React.useState<Status|null>(null),[accounts,setAccounts]=React.useState<Account[]>([]);
  const [accountRef,setAccountRef]=React.useState(''),[credential,setCredential]=React.useState(''),[from,setFrom]=React.useState(''),[to,setTo]=React.useState('');
  const [busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[result,setResult]=React.useState('');
  const load=React.useCallback(async()=>setStatus(await request<Status>('/status')),[]);
  React.useEffect(()=>{void load().catch(e=>setError(e.message))},[load]);
  const run=async(action:()=>Promise<void>)=>{setBusy(true);setError('');try{await action();await load()}catch(e){setError(e instanceof Error?e.message:t.error)}finally{setBusy(false)}};
  return <section style={{maxWidth:900,margin:'auto'}}><h1>{t.title}</h1><p>{t.intro}</p><p>{t.readOnly}</p><p>{t.provider}: enablebanking-ais · {status?.capabilities[0]?.qualification==='MOCK_SOFTWARE_QUALIFIED'?t.mock:t.live}</p>
    <p>{t.status}: {status?.configured?t.configured:t.noConnection}{status?.accountRef?` · ${status.accountRef}`:''}</p>{error&&<p role="alert" style={{color:'#a21d22'}}>{error}</p>}{busy&&<p role="status">{t.loading}</p>}
    <form onSubmit={e=>{e.preventDefault();void run(async()=>{await request('/configure','POST',{accountRef,credential});setCredential('')})}} style={{display:'grid',gap:12,maxWidth:420}}>
      <label>{t.account}<input required value={accountRef} onChange={e=>setAccountRef(e.target.value)}/></label>
      <label>{t.credential}<input required type="password" autoComplete="off" value={credential} onChange={e=>setCredential(e.target.value)}/></label>
      <button disabled={busy}>{t.configure}</button>
    </form>
    <button disabled={busy||!status?.configured} onClick={()=>void run(async()=>setAccounts(await request<Account[]>('/accounts')))}>{t.accounts}</button>
    {accounts.length===0?<p>{t.none}</p>:<ul>{accounts.map(a=><li key={a.accountRef}>{a.name} · {a.iban??a.accountRef} · {a.currency}</li>)}</ul>}
    <form onSubmit={e=>{e.preventDefault();void run(async()=>{const data=await request<{imported:number;skipped:number}>('/sync','POST',{from,to});setResult(`${data.imported} / ${data.skipped}`)})}} style={{display:'flex',gap:10,flexWrap:'wrap'}}>
      <label>{t.from}<input type="date" required value={from} onChange={e=>setFrom(e.target.value)}/></label><label>{t.to}<input type="date" required value={to} onChange={e=>setTo(e.target.value)}/></label><button disabled={busy||!status?.configured}>{t.sync}</button>
    </form>{result&&<p role="status">{result}</p>}
  </section>;
}
