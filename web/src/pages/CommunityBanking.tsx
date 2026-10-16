import React from 'react';
import {communityFetch} from '../api';
import {problemMessage} from '../i18n/community-problems';
import {useLanguage} from '../i18n/locale';
import {bankingText,bankProblemText} from '../i18n/community-banking';
import {availableBanks,bankAccounts,bankingStatus,consentAuthorization,type Bank,type BankAccount,type BankEnvironment,type BankingStatus} from '../banking-contract';

export function CommunityBanking({permissions}:{permissions?:readonly string[]}={}){
 const mayConfigure=permissions===undefined||permissions.includes('integrations:configure'),maySync=permissions===undefined||permissions.includes('integrations:sync');
 const {language}=useLanguage(),t=bankingText[language==='de'?'de':'en'];
 const [status,setStatus]=React.useState<BankingStatus|null>(null),[accounts,setAccounts]=React.useState<BankAccount[]>([]),[banks,setBanks]=React.useState<Bank[]>([]);
 const [accountRef,setAccountRef]=React.useState(''),[applicationId,setApplicationId]=React.useState(''),[sessionId,setSessionId]=React.useState(''),[privateKeyPem,setPrivateKeyPem]=React.useState('');
 const [environment,setEnvironment]=React.useState<BankEnvironment>('sandbox'),[country,setCountry]=React.useState('AT'),[bankName,setBankName]=React.useState(''),[psuType,setPsuType]=React.useState<'personal'|'business'>('personal');
 const [authorization,setAuthorization]=React.useState<{flowId:string;authorizationUrl:string}|null>(null),[selectedAccount,setSelectedAccount]=React.useState('');
 const [from,setFrom]=React.useState(''),[to,setTo]=React.useState(''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[result,setResult]=React.useState('');
 const scope=React.useRef({key:'',epoch:0,mounted:true}),locked=React.useRef(false),sequence=React.useRef(0);
 const scopeKey=JSON.stringify([language,permissions??null]);
 if(scope.current.key!==scopeKey)scope.current={key:scopeKey,epoch:scope.current.epoch+1,mounted:true};
 const current=(epoch:number)=>scope.current.mounted&&scope.current.epoch===epoch;
 const request=async(path:string,method='GET',body?:unknown):Promise<unknown>=>{
  const response=await communityFetch(`/api/community-banking${path}`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok){const body=await response.json().catch(()=>({})),code=typeof body?.code==='string'?body.code:'';throw new Error(bankProblemText[code]?.[language==='de'?'de':'en']??problemMessage({code},language,t.error));}
  if(response.status===204)return undefined;
  try{return await response.json();}catch{throw new Error(t.invalidResponse);}
 };
 const clearAuthority=()=>{setStatus(null);setAccounts([]);setBanks([]);setBankName('');setAuthorization(null);setSelectedAccount('');};
 const load=async(epoch:number)=>{const order=++sequence.current;try{const raw=await request('/status');if(!current(epoch)||order!==sequence.current)return;const next=bankingStatus(raw,window.location.origin);setStatus(next);setAuthorization(previous=>previous?.flowId===next.pendingConsent?.flowId?previous:null);if(next.pendingConsent?.stage!=='accounts_ready')setSelectedAccount('');}catch{if(current(epoch)&&order===sequence.current){clearAuthority();throw new Error(t.invalidResponse);}}};
 React.useEffect(()=>{scope.current.mounted=true;const epoch=scope.current.epoch;setStatus(null);setBanks([]);setAccounts([]);setAuthorization(null);setSelectedAccount('');setPrivateKeyPem('');setSessionId('');setError('');void load(epoch).catch(()=>{if(current(epoch)){setStatus(null);setError(t.invalidResponse);}});return()=>{scope.current.mounted=false;scope.current.epoch++;};},[scopeKey]);
 const run=async(action:(epoch:number)=>Promise<void>)=>{if(locked.current)return;locked.current=true;setBusy(true);setError('');setResult('');const epoch=scope.current.epoch;let actionFinished=false;try{await action(epoch);actionFinished=true;if(current(epoch))await load(epoch);}catch(e){if(current(epoch)){let message=e instanceof Error?e.message:t.error;if(!actionFinished)try{await load(epoch);}catch{message=t.invalidResponse;}if(current(epoch))setError(message);}}finally{locked.current=false;if(scope.current.mounted)setBusy(false);}};
 const pending=status?.pendingConsent,ready=pending?.stage==='accounts_ready';
 const formStyle={display:'grid',gap:12,maxWidth:560} as const;
 return <section style={{maxWidth:900,margin:'auto',padding:24}}>
  <h1>{t.title}</h1><p>{t.intro}</p><p>{t.readOnly}</p><p>{t.provider}: enablebanking-ais · {status?.capabilities[0]?.qualification==='MOCK_SOFTWARE_QUALIFIED'?t.mock:t.live}</p>
  <p data-testid="bank-status">{t.status}: {status===null?t.unavailable:status.configured?t.configured:t.noConnection}{status?.accountRef?` · ${status.accountRef}`:''}</p>
  {status?.applicationEnvironment&&<p>{t.environment}: {status.applicationEnvironment==='sandbox'?t.sandbox:t.production}</p>}
  {error&&<p role="alert" style={{color:'#a21d22'}}>{error}</p>}{busy&&<p role="status">{t.loading}</p>}
  {mayConfigure&&<>
   <h2>{t.applicationSetup}</h2><p>{t.authorization}</p>
   {status&&<p>{t.callback}<br/><code id="bank-callback-url" style={{overflowWrap:'anywhere'}}>{status.callbackUrl}</code></p>}
   <form autoComplete="off" onSubmit={e=>{e.preventDefault();const credential={applicationId,privateKeyPem,environment};setPrivateKeyPem('');setSessionId('');void run(async epoch=>{await request('/application','POST',credential);if(current(epoch)){setBanks([]);setBankName('');setAuthorization(null);setAccounts([]);}});}} style={formStyle}>
    <fieldset disabled={busy||!status} style={formStyle}>
     <label>{t.environment}<select id="bank-environment" value={environment} onChange={e=>{setEnvironment(e.target.value as BankEnvironment);setPrivateKeyPem('');setSessionId('');}}><option value="sandbox">{t.sandbox}</option><option value="live">{t.production}</option></select></label>
     <label>{t.application}<input id="bank-application-id" required value={applicationId} onChange={e=>setApplicationId(e.target.value)}/></label>
     <label>{t.key}<textarea id="bank-private-key" required autoComplete="off" spellCheck={false} value={privateKeyPem} onChange={e=>setPrivateKeyPem(e.target.value)}/></label>
     <button id="bank-save-application">{t.saveApplication}</button>
    </fieldset>
   </form>
   <h2>{t.bankConsent}</h2>
   <form onSubmit={e=>{e.preventDefault();void run(async epoch=>{const expected=status!.applicationEnvironment!;const raw=await request('/banks?'+new URLSearchParams({country}));let list:Bank[];try{list=availableBanks(raw,expected,country);}catch{throw Error(t.invalidResponse);}if(current(epoch)){setBanks(list);setBankName('');}});}} style={formStyle}>
    <label>{t.country}<input id="bank-country" disabled={busy||!status?.applicationConfigured||!!pending} pattern="[A-Z]{2}" maxLength={2} required value={country} onChange={e=>{setCountry(e.target.value.toUpperCase());setBanks([]);setBankName('');}}/></label>
    <button id="bank-load-banks" disabled={busy||!status?.applicationConfigured||!!pending}>{t.findBanks}</button>
   </form>
   {banks.length>0&&<form style={formStyle} onSubmit={e=>{e.preventDefault();void run(async epoch=>{const raw=await request('/consents','POST',{bank:{name:bankName,country},psuType});let flow:ReturnType<typeof consentAuthorization>;try{flow=consentAuthorization(raw,status!.applicationEnvironment!);}catch{throw Error(t.invalidResponse);}if(current(epoch)){setAuthorization(flow);setSelectedAccount('');}});}}>
    <label>{t.bank}<select id="bank-choice" disabled={busy||!!pending} required value={bankName} onChange={e=>setBankName(e.target.value)}><option value="">{t.chooseBank}</option>{banks.map(bank=><option key={bank.name} value={bank.name}>{bank.name}</option>)}</select></label>
    <label>{t.accountType}<select id="bank-psu-type" disabled={busy||!!pending} value={psuType} onChange={e=>setPsuType(e.target.value as 'personal'|'business')}><option value="personal">{t.personal}</option><option value="business">{t.business}</option></select></label>
    <button id="bank-start-consent" disabled={busy||!!pending||!bankName}>{t.startConsent}</button>
   </form>}
   {pending&&<div data-testid="bank-consent" style={{marginTop:16}}>
    <p role="status">{t[pending.stage]} · {t.expires}: {pending.expiresAt}</p>
    {pending.stage==='awaiting_callback'&&<><p>{t.providerStep}</p>{authorization?.flowId===pending.flowId&&<p><a id="bank-authorize" href={authorization.authorizationUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t.authorize}</a></p>}<p>{t.returnStep}</p></>}
    {!ready&&<><button disabled={busy} id="bank-refresh-consent" onClick={()=>void run(async()=>{})}>{t.refresh}</button> <button disabled={busy||pending.stage!=='callback_received'} id="bank-complete-consent" onClick={()=>void run(async()=>{await request(`/consents/${encodeURIComponent(pending.flowId)}/complete`,'POST',{});})}>{t.complete}</button></>}
    {ready&&<form style={formStyle} onSubmit={e=>{e.preventDefault();void run(async epoch=>{await request(`/consents/${encodeURIComponent(pending.flowId)}/select`,'POST',{accountRef:selectedAccount});if(current(epoch)){setAccounts([]);setSelectedAccount('');setAuthorization(null);}});}}>
     <label>{t.chooseAccount}<select id="bank-consent-account" disabled={busy} required value={selectedAccount} onChange={e=>setSelectedAccount(e.target.value)}><option value="">{t.chooseAccount}</option>{pending.accounts?.map(account=><option key={account.accountRef} value={account.accountRef} disabled={account.currency!=='EUR'}>{account.name} · {account.currency} · {account.accountRef}</option>)}</select></label><button id="bank-select-account" disabled={busy||!selectedAccount}>{t.activate}</button>
    </form>}
    <button id="bank-cancel-consent" disabled={busy} onClick={()=>void run(async epoch=>{await request(`/consents/${encodeURIComponent(pending.flowId)}/cancel`,'POST',{});if(current(epoch)){setAuthorization(null);setSelectedAccount('');}})}>{t.cancel}</button>
   </div>}
   <details style={{marginTop:24}}><summary>{t.advanced}</summary><p>{t.advancedHelp}</p>
    <form autoComplete="off" style={formStyle} onSubmit={e=>{e.preventDefault();const body={environment,accountRef,credential:{applicationId,sessionId,privateKeyPem}};setPrivateKeyPem('');setSessionId('');void run(async epoch=>{await request('/configure','POST',body);if(current(epoch))setAccounts([]);});}}>
     <fieldset disabled={busy||!status||!!pending} style={formStyle}>
      <label>{t.account}<input id="bank-account-ref" required value={accountRef} onChange={e=>setAccountRef(e.target.value)}/></label>
      <label>{t.session}<input id="bank-session-id" required type="password" autoComplete="off" value={sessionId} onChange={e=>setSessionId(e.target.value)}/></label>
      <p>{t.sharedFields}</p><button>{t.configure}</button>
     </fieldset>
    </form>
   </details>
  </>}
  <div style={{display:'flex',gap:12,flexWrap:'wrap',marginTop:24}}>
   {mayConfigure&&<button disabled={busy||!status?.configured} onClick={()=>void run(async epoch=>{await request('/disconnect','POST',{});if(current(epoch)){setAccounts([]);setAuthorization(null);setPrivateKeyPem('');setSessionId('');}})}>{t.disconnect}</button>}
   <button disabled={busy||!status?.configured} onClick={()=>void run(async epoch=>{let next:BankAccount[];try{next=bankAccounts(await request('/accounts'));}catch{throw Error(t.invalidResponse);}if(current(epoch))setAccounts(next);})}>{t.accounts}</button>
  </div>
  {accounts.length===0?<p>{t.none}</p>:<ul>{accounts.map(account=><li key={account.accountRef}>{account.name} · {account.iban??account.accountRef} · {account.currency}</li>)}</ul>}
  {maySync&&<form onSubmit={e=>{e.preventDefault();void run(async epoch=>{const data=await request('/sync','POST',{from,to}) as {imported:unknown;skipped:unknown};if(!data||!Number.isSafeInteger(data.imported)||Number(data.imported)<0||!Number.isSafeInteger(data.skipped)||Number(data.skipped)<0)throw Error(t.invalidResponse);if(current(epoch))setResult(`${t.imported}: ${data.imported} · ${t.skipped}: ${data.skipped}`);});}} style={{display:'flex',gap:10,flexWrap:'wrap'}}>
   <label>{t.from}<input id="bank-import-from" type="date" required disabled={busy} value={from} onChange={e=>setFrom(e.target.value)}/></label><label>{t.to}<input id="bank-import-to" type="date" required disabled={busy} value={to} onChange={e=>setTo(e.target.value)}/></label><button disabled={busy||!status?.configured}>{t.sync}</button>
  </form>}{result&&<p role="status">{result}</p>}
 </section>;
}
