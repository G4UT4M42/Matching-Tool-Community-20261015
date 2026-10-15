import React, { useCallback, useEffect, useState } from 'react';
import { accountError, accountJson, accountLabels, useCommunityAccount } from '../components/CommunityAccountAccess';
import { useLanguage } from '../i18n/locale';

type Role = 'owner' | 'bookkeeper' | 'viewer' | 'payment_approver';
interface User { user_id:string; username:string; role:Role; disabled:boolean }
const roles: Role[] = ['owner','bookkeeper','viewer','payment_approver'];
const field:React.CSSProperties = {display:'block',boxSizing:'border-box',width:'100%',padding:9,margin:'5px 0 12px',border:'1px solid #aab',borderRadius:5};
const button:React.CSSProperties = {padding:'9px 14px',borderRadius:5,border:'1px solid #778',cursor:'pointer'};

export function CommunityAccounts() {
  const {principal,demo,refresh} = useCommunityAccount(); const {language} = useLanguage(); const t=accountLabels(language);
  const canManage=Boolean(principal?.permissions.includes('accounts:manage'));
  const [users,setUsers]=useState<User[]>([]),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [currentPassword,setCurrentPassword]=useState(''),[newPassword,setNewPassword]=useState(''),[confirm,setConfirm]=useState('');
  const [username,setUsername]=useState(''),[initialPassword,setInitialPassword]=useState(''),[role,setRole]=useState<Role>('viewer');
  const load=useCallback(async()=>{
    if(!canManage)return;
    const result=await accountJson<{users:User[]}>('users');setUsers(result.users);
  },[canManage]);
  useEffect(()=>{void load().catch(reason=>setError(reason instanceof Error?reason.message:'REQUEST_FAILED'));},[load]);
  const run=async(operation:()=>Promise<void>)=>{
    if(busy)return;setBusy(true);setError('');setMessage('');
    try{await operation();}catch(reason){setError(reason instanceof Error?reason.message:'REQUEST_FAILED');}
    finally{setBusy(false);setCurrentPassword('');setNewPassword('');setConfirm('');setInitialPassword('');}
  };
  if(demo||!principal)return <section><h1>{t.account}</h1><p>{t.previewHelp}</p></section>;
  const reauthenticate=()=>run(async()=>{
    await accountJson('reauthenticate','POST',{password:currentPassword});await refresh();await load();setMessage(t.recentlyConfirmed);
  });
  const changePassword=()=>run(async()=>{
    if(newPassword!==confirm)throw new Error('PASSWORD_MISMATCH');
    await accountJson('password','PUT',{current_password:currentPassword,new_password:newPassword});await refresh();setMessage(t.passwordChanged);
  });
  const createUser=()=>run(async()=>{
    await accountJson('users','POST',{username,password:initialPassword,role});setUsername('');setRole('viewer');await load();setMessage(t.created);
  });
  const update=(user:User,change:Partial<Pick<User,'role'|'disabled'>>)=>{
    if(!window.confirm(t.confirmUpdate))return;
    void run(async()=>{await accountJson('users/'+user.user_id,'PATCH',change);if(user.user_id===principal.subject){await refresh();return;}await load();setMessage(t.updated);});
  };
  return <section style={{maxWidth:1000}}>
    <h1>{t.account}</h1><p>{t.signedIn}: <strong>{principal.username}</strong> · {t[principal.role as Role]??principal.role}</p>
    {error&&<p role="alert" style={{color:'#a11'}}>{error==='PASSWORD_MISMATCH'?t.mismatch:accountError(language,new Error(error))}</p>}
    {message&&<p role="status">{message}</p>}
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(250px,1fr))',gap:24}}>
      <form onSubmit={event=>{event.preventDefault();void reauthenticate();}} style={{maxWidth:400}}>
        <h2>{t.reauthenticate}</h2>
        <label htmlFor="account-current-password">{t.currentPassword}</label><input id="account-current-password" type="password" autoComplete="current-password" required value={currentPassword} onChange={event=>setCurrentPassword(event.target.value)} maxLength={128} style={field}/>
        <button type="submit" disabled={busy} style={button}>{busy?t.busy:t.reauthenticate}</button>
      </form>
      <form onSubmit={event=>{event.preventDefault();void changePassword();}} style={{maxWidth:400}}>
        <h2>{t.changePassword}</h2>
        <label htmlFor="password-old">{t.currentPassword}</label><input id="password-old" type="password" autoComplete="current-password" required value={currentPassword} onChange={event=>setCurrentPassword(event.target.value)} maxLength={128} style={field}/>
        <label htmlFor="password-new">{t.newPassword}</label><input id="password-new" type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={newPassword} onChange={event=>setNewPassword(event.target.value)} style={field}/>
        <label htmlFor="password-confirm">{t.confirm}</label><input id="password-confirm" type="password" autoComplete="new-password" required value={confirm} onChange={event=>setConfirm(event.target.value)} maxLength={128} style={field}/>
        <p>{t.passwordHelp}</p><button type="submit" disabled={busy} style={button}>{busy?t.busy:t.changePassword}</button>
      </form>
    </div>
    {canManage&&<section><h2>{t.management}</h2><p>{t.manageHelp}</p>
      <form onSubmit={event=>{event.preventDefault();void createUser();}} style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(190px,1fr))',gap:14,alignItems:'end'}}>
        <label>{t.username}<input id="new-account-username" autoComplete="off" required minLength={3} maxLength={64} value={username} onChange={event=>setUsername(event.target.value)} style={field}/></label>
        <label>{t.password}<input id="new-account-password" type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={initialPassword} onChange={event=>setInitialPassword(event.target.value)} style={field}/></label>
        <label>{t.role}<select id="new-account-role" value={role} onChange={event=>setRole(event.target.value as Role)} style={field}>{roles.map(value=><option key={value} value={value}>{t[value]}</option>)}</select></label>
        <button type="submit" disabled={busy} style={{...button,marginBottom:12}}>{busy?t.busy:t.createUser}</button>
      </form>
      <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr><th>{t.username}</th><th>{t.role}</th><th>{t.enabled}</th><th>{t.account}</th></tr></thead>
        <tbody>{users.map(user=><tr key={user.user_id} data-account={user.username}>
          <td>{user.username}</td><td><select aria-label={t.role+' '+user.username} value={user.role} disabled={busy} onChange={event=>setUsers(all=>all.map(value=>value.user_id===user.user_id?{...value,role:event.target.value as Role}:value))}>{roles.map(value=><option key={value} value={value}>{t[value]}</option>)}</select></td>
          <td>{user.disabled?t.disabled:t.enabled}</td><td style={{display:'flex',gap:8,padding:8}}>
            <button disabled={busy} onClick={()=>update(user,{role:user.role})} style={button}>{t.saveRole}</button>
            <button disabled={busy} onClick={()=>update(user,{disabled:!user.disabled})} style={button}>{user.disabled?t.enable:t.disable}</button>
          </td>
        </tr>)}</tbody>
      </table></div>
    </section>}
  </section>;
}
