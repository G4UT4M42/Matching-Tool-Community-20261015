import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { communityFetch, getCommunityAccessToken, setCommunityAccessToken, setCommunityCsrfToken } from '../api';
import { useLanguage } from '../i18n/locale';

export interface AccountPrincipal {
  subject: string; workspace_id: string; username: string; role: string;
  session_id: string; permissions: string[]; reauthenticated_at: number;
}
interface AccountSession {
  mode: 'accounts' | 'synthetic-preview'; authenticated: boolean; principal?: AccountPrincipal;
  csrf_token?: string; setup_required?: boolean; setup_available?: boolean; absolute_expires_at?: number;
}
interface AccountContextValue { principal: AccountPrincipal | null; demo: boolean; refresh: () => Promise<void>; signOut: () => Promise<void> }
const AccountContext = createContext<AccountContextValue | null>(null);
export function useCommunityAccount(): AccountContextValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error('The account access provider is required');
  return value;
}
const copy = {
  en: {
    title:'Matching Tool Community', checking:'Checking local access…', unavailable:'The local account service could not be reached.', retry:'Retry',
    setup:'Create your local account', login:'Sign in', username:'Username', password:'Password', confirm:'Confirm password', code:'Local setup code',
    codeHelp:'Use the temporary setup code displayed by your local launcher. It authorizes the first owner of this installation.',
    passwordHelp:'Use a unique passphrase of 15 to 128 characters. Spaces and password managers are supported.',
    mismatch:'The passwords do not match.', language:'Language', busy:'Working…', create:'Create account', submit:'Sign in',
    loginFailed:'The username or password is incorrect.', setupFailed:'The setup code is wrong, expired or already used.',
    setupUnavailable:'Restart the local launcher to receive a new setup code.', invalidPassword:'Choose a less predictable passphrase of 15 to 128 characters.',
    invalidUsername:'Use 3 to 64 letters, digits, dots, underscores or hyphens for the username.', wait:'Too many attempts. Wait a minute before trying again.',
    sessionExpired:'Your session has expired. Sign in again.', failed:'The operation could not be completed. Try again after checking the local service.',
    csrf:'The session confirmation changed. Reload the application before retrying.', permission:'This account does not have permission for the requested action.',
    preview:'Synthetic demonstration', previewHelp:'This mode uses fictional data. It cannot open an account-owned installation or execute bank transfers.',
    token:'Local access token', unlock:'Unlock demo', tokenFailed:'Access denied. Check the token in the local launcher terminal.',
    signOut:'Sign out', account:'Account', reauthenticate:'Confirm current password', currentPassword:'Current password', newPassword:'New password',
    changePassword:'Change password', passwordChanged:'Password changed. Other sessions were signed out.', recentlyConfirmed:'Password confirmed for five minutes.',
    management:'Workspace accounts', manageHelp:'Roles are enforced by the server. Payment preparation and approval are separate permissions.',
    createUser:'Add account', role:'Role', enabled:'Enabled', disabled:'Disabled', enable:'Enable', disable:'Disable', saveRole:'Save role',
    owner:'Owner', bookkeeper:'Bookkeeper', viewer:'Viewer', payment_approver:'Payment approver', reauth:'Confirm your password before managing accounts.',
    lastOwner:'At least one enabled owner must remain.', usernameTaken:'This username already exists.', created:'Account created.', updated:'Account updated; its prior sessions were revoked.',
    confirmUpdate:'Apply this account change and revoke existing sessions?', signedIn:'Signed in as',
  },
  de: {
    title:'Matching Tool Community', checking:'Lokaler Zugriff wird geprüft…', unavailable:'Der lokale Kontodienst ist nicht erreichbar.', retry:'Erneut versuchen',
    setup:'Lokales Konto erstellen', login:'Anmelden', username:'Benutzername', password:'Passwort', confirm:'Passwort bestätigen', code:'Lokaler Einrichtungscode',
    codeHelp:'Verwenden Sie den temporären Einrichtungscode aus dem lokalen Startprogramm. Er autorisiert den ersten Eigentümer dieser Installation.',
    passwordHelp:'Verwenden Sie eine eigene Passphrase mit 15 bis 128 Zeichen. Leerzeichen und Passwortmanager werden unterstützt.',
    mismatch:'Die Passwörter stimmen nicht überein.', language:'Sprache', busy:'Wird ausgeführt…', create:'Konto erstellen', submit:'Anmelden',
    loginFailed:'Benutzername oder Passwort ist falsch.', setupFailed:'Der Einrichtungscode ist falsch, abgelaufen oder bereits verwendet.',
    setupUnavailable:'Starten Sie das lokale Startprogramm erneut, um einen neuen Einrichtungscode zu erhalten.', invalidPassword:'Verwenden Sie eine weniger vorhersehbare Passphrase mit 15 bis 128 Zeichen.',
    invalidUsername:'Verwenden Sie für den Benutzernamen 3 bis 64 Buchstaben, Ziffern, Punkte, Unterstriche oder Bindestriche.', wait:'Zu viele Versuche. Warten Sie eine Minute und versuchen Sie es erneut.',
    sessionExpired:'Ihre Sitzung ist abgelaufen. Melden Sie sich erneut an.', failed:'Der Vorgang ist fehlgeschlagen. Prüfen Sie den lokalen Dienst und versuchen Sie es erneut.',
    csrf:'Die Sitzungsbestätigung hat sich geändert. Laden Sie die Anwendung vor einem neuen Versuch neu.', permission:'Dieses Konto ist für den angeforderten Vorgang nicht berechtigt.',
    preview:'Synthetische Demonstration', previewHelp:'Dieser Modus verwendet fiktive Daten. Er kann weder einen kontogeschützten Arbeitsbereich öffnen noch Bankzahlungen ausführen.',
    token:'Lokaler Zugriffscode', unlock:'Demo öffnen', tokenFailed:'Zugriff verweigert. Prüfen Sie den Code im lokalen Startprogramm.',
    signOut:'Abmelden', account:'Konto', reauthenticate:'Aktuelles Passwort bestätigen', currentPassword:'Aktuelles Passwort', newPassword:'Neues Passwort',
    changePassword:'Passwort ändern', passwordChanged:'Passwort geändert. Andere Sitzungen wurden abgemeldet.', recentlyConfirmed:'Passwort für fünf Minuten bestätigt.',
    management:'Konten des Arbeitsbereichs', manageHelp:'Rollen werden serverseitig geprüft. Zahlungsvorbereitung und Zahlungsfreigabe sind getrennte Berechtigungen.',
    createUser:'Konto hinzufügen', role:'Rolle', enabled:'Aktiv', disabled:'Deaktiviert', enable:'Aktivieren', disable:'Deaktivieren', saveRole:'Rolle speichern',
    owner:'Eigentümer', bookkeeper:'Buchhaltung', viewer:'Lesender Zugriff', payment_approver:'Zahlungsfreigabe', reauth:'Bestätigen Sie Ihr Passwort vor der Kontoverwaltung.',
    lastOwner:'Mindestens ein aktiver Eigentümer muss bestehen bleiben.', usernameTaken:'Dieser Benutzername ist bereits vorhanden.', created:'Konto erstellt.', updated:'Konto aktualisiert; bisherige Sitzungen wurden widerrufen.',
    confirmUpdate:'Diese Kontoänderung anwenden und bestehende Sitzungen widerrufen?', signedIn:'Angemeldet als',
  },
} as const;
export function accountLabels(language: string) { return copy[language === 'de' ? 'de' : 'en']; }
const codeKeys = {
  LOGIN_FAILED:'loginFailed', REAUTHENTICATION_FAILED:'loginFailed', SETUP_AUTHORIZATION_REQUIRED:'setupFailed', SETUP_ALREADY_COMPLETED:'setupFailed',
  PASSWORD_LENGTH:'invalidPassword', PASSWORD_INVALID:'invalidPassword', PASSWORD_COMMON:'invalidPassword', USERNAME_INVALID:'invalidUsername',
  AUTHENTICATION_BUSY:'wait', AUTHENTICATION_RATE_LIMITED:'wait', AUTHENTICATION_REQUIRED:'sessionExpired', CSRF_TOKEN_REQUIRED:'csrf',
  PERMISSION_REQUIRED:'permission', REAUTHENTICATION_REQUIRED:'reauth', LAST_OWNER_REQUIRED:'lastOwner', USERNAME_UNAVAILABLE:'usernameTaken',
} as const;
export function accountError(language: string, error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  const key = codeKeys[code as keyof typeof codeKeys] ?? 'failed';
  return accountLabels(language)[key];
}
export async function accountJson<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const response = await communityFetch('/api/auth/' + path, { method, credentials:'same-origin',
    ...(body === undefined ? {} : { headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }) });
  const data = response.status === 204 ? null : await response.json().catch(() => ({code:'RESPONSE_INVALID'}));
  if (!response.ok) throw new Error(typeof data?.code === 'string' ? data.code : 'REQUEST_FAILED');
  return data as T;
}
const inputStyle: React.CSSProperties = {boxSizing:'border-box', width:'100%', padding:11, border:'1px solid #aab2bd', borderRadius:6, margin:'6px 0 14px'};
const buttonStyle: React.CSSProperties = {padding:'10px 16px', borderRadius:6, border:'1px solid #667', cursor:'pointer'};

export function CommunityAccountAccess({children}: {children:React.ReactNode}) {
  const {language,setLanguage} = useLanguage(); const t = accountLabels(language);
  const [status,setStatus] = useState<'checking'|'locked'|'open'|'unavailable'>('checking');
  const [session,setSession] = useState<AccountSession | null>(null);
  const [username,setUsername] = useState(''), [password,setPassword] = useState(''), [confirmation,setConfirmation] = useState(''), [setupCode,setSetupCode] = useState('');
  const [token,setToken] = useState(''), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const accept = useCallback((data: AccountSession) => {
    if (!alive.current) return;
    if (data.mode !== 'accounts' && data.mode !== 'synthetic-preview') throw new Error('RESPONSE_INVALID');
    if (data.mode === 'accounts') {
      setCommunityAccessToken('');
      if (data.authenticated) {
        if (!data.principal || !/^USR-[a-f0-9-]{36}$/.test(data.principal.subject) || !/^WS-[a-f0-9-]{36}$/.test(data.principal.workspace_id)
          || !Array.isArray(data.principal.permissions) || !/^[a-f0-9]{64}$/.test(data.csrf_token ?? '')) throw new Error('RESPONSE_INVALID');
        setCommunityCsrfToken(data.csrf_token!); setStatus('open');
      } else { setCommunityCsrfToken(''); setStatus('locked'); }
    } else { setCommunityCsrfToken(''); setStatus(data.authenticated ? 'open' : 'locked'); }
    setSession(data);
  },[]);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const data = await accountJson<AccountSession>('session');
      if (data.mode === 'synthetic-preview' && getCommunityAccessToken()) {
        const response = await communityFetch('/api/community/session');
        const preview = response.ok ? await response.json() : null;
        if (preview?.mode === 'synthetic-preview' && preview.banking_enabled === false) data.authenticated = true;
        else setCommunityAccessToken('');
      }
      if (current === generation.current) accept(data);
    } catch { if(alive.current && current === generation.current){setCommunityCsrfToken('');setStatus('unavailable');} }
  },[accept]);
  useEffect(() => {
    alive.current=true; void refresh();
    const expired=()=>{generation.current++;setCommunityCsrfToken('');setSession(current=>current?{...current,authenticated:false,principal:undefined}:null);setStatus('locked');setPassword('');setError('AUTHENTICATION_REQUIRED');};
    window.addEventListener('community-session-expired',expired);
    return ()=>{alive.current=false;generation.current++;window.removeEventListener('community-session-expired',expired);};
  },[refresh]);
  useEffect(()=>{
    if(status!=='open'||!session?.absolute_expires_at)return;
    const timeout=setTimeout(()=>void refresh(),Math.min(2_147_483_647,Math.max(0,session.absolute_expires_at-Date.now()+25)));
    return ()=>clearTimeout(timeout);
  },[status,session?.absolute_expires_at,refresh]);
  const signOut=async()=>{
    generation.current++;
    if(session?.mode==='accounts') await accountJson('logout','POST',{});
    setCommunityAccessToken('');setCommunityCsrfToken('');setUsername('');setPassword('');setConfirmation('');setSetupCode('');setSession(null);setStatus('checking');setError('');await refresh();
  };
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault(); if(busy)return; setError('');
    if(session?.mode==='accounts'&&session.setup_required&&password!==confirmation){setError('PASSWORD_MISMATCH');return;}
    generation.current++;setBusy(true);
    try {
      if(session?.mode==='synthetic-preview') {
        setCommunityAccessToken(token);
        const response=await communityFetch('/api/community/session'); const result=response.ok?await response.json():null;
        if(result?.mode!=='synthetic-preview'||result.banking_enabled!==false){setCommunityAccessToken('');throw new Error('DEMO_TOKEN_INVALID');}
        accept({mode:'synthetic-preview',authenticated:true});setToken('');
      } else {
        const setup=session?.setup_required;
        const data=await accountJson<AccountSession>(setup?'setup':'login','POST',{username,password,...(setup?{setup_code:setupCode}:{})});
        accept({...data,mode:'accounts',setup_required:false});setSetupCode('');
      }
    } catch(reason){setError(reason instanceof Error?reason.message:'REQUEST_FAILED');}
    finally{setBusy(false);setPassword('');setConfirmation('');}
  };
  if(status==='open') return <AccountContext.Provider value={{principal:session?.principal??null,demo:session?.mode==='synthetic-preview',refresh,signOut}}>{children}</AccountContext.Provider>;
  return <div style={{minHeight:'100vh',display:'grid',placeItems:'center',background:'#f4f6fa',fontFamily:'system-ui, sans-serif',padding:16,boxSizing:'border-box'}}>
    <section style={{background:'white',padding:28,width:'min(440px, 100%)',boxSizing:'border-box',borderRadius:12,boxShadow:'0 6px 28px #0002'}}>
      <h1 style={{fontSize:22}}>{t.title}</h1>
      <label htmlFor="access-language">{t.language}</label><select id="access-language" value={language} onChange={event=>setLanguage(event.target.value)} style={inputStyle}><option value="en">English</option><option value="de">Deutsch</option></select>
      {status==='checking'?<p role="status">{t.checking}</p>:status==='unavailable'?<><p role="alert">{t.unavailable}</p><button onClick={()=>{setStatus('checking');void refresh();}} style={buttonStyle}>{t.retry}</button></>:<form onSubmit={event=>void submit(event)}>
        <h2 style={{fontSize:19}}>{session?.mode==='synthetic-preview'?t.preview:session?.setup_required?t.setup:t.login}</h2>
        {session?.mode==='synthetic-preview'?<><p>{t.previewHelp}</p><label htmlFor="local-access-token">{t.token}</label><input id="local-access-token" type="password" autoComplete="off" value={token} onChange={event=>setToken(event.target.value)} minLength={32} required style={inputStyle}/></>:<>
          <label htmlFor="account-username">{t.username}</label><input id="account-username" autoComplete="username" value={username} onChange={event=>setUsername(event.target.value)} minLength={3} maxLength={64} required style={inputStyle}/>
          <label htmlFor="account-password">{t.password}</label><input id="account-password" type="password" autoComplete={session?.setup_required?'new-password':'current-password'} value={password} onChange={event=>setPassword(event.target.value)} minLength={session?.setup_required?15:1} maxLength={128} required style={inputStyle}/>
          {session?.setup_required&&<><p>{t.passwordHelp}</p><label htmlFor="account-confirm">{t.confirm}</label><input id="account-confirm" type="password" autoComplete="new-password" value={confirmation} onChange={event=>setConfirmation(event.target.value)} maxLength={128} required style={inputStyle}/>
            <label htmlFor="account-setup-code">{t.code}</label><input id="account-setup-code" type="password" autoComplete="off" value={setupCode} onChange={event=>setSetupCode(event.target.value)} required style={inputStyle}/><p>{session.setup_available?t.codeHelp:t.setupUnavailable}</p></>}
        </>}
        {error&&<p role="alert" style={{color:'#a11'}}>{error==='PASSWORD_MISMATCH'?t.mismatch:error==='DEMO_TOKEN_INVALID'?t.tokenFailed:accountError(language,new Error(error))}</p>}
        <button type="submit" disabled={busy||(session?.setup_required&&!session.setup_available)} style={buttonStyle}>{busy?t.busy:session?.mode==='synthetic-preview'?t.unlock:session?.setup_required?t.create:t.submit}</button>
      </form>}
    </section>
  </div>;
}
