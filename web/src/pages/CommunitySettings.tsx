import React from 'react';
import {Link} from 'react-router-dom';
import {useCommunityAccount} from '../components/CommunityAccountAccess';
import {useLanguage} from '../i18n/locale';
export function CommunitySettings(){
 const{principal}=useCommunityAccount(),{language,setLanguage}=useLanguage(),de=language==='de',can=(permission:string)=>principal?.permissions.includes(permission)??false;
 return<section><h1>{de?'Einstellungen':'Settings'}</h1><p>{principal?.username} · {principal?.role}</p><label htmlFor="settings-language">{de?'Sprache':'Language'} </label><select id="settings-language" value={language} onChange={event=>setLanguage(event.target.value)}><option value="en">English</option><option value="de">Deutsch</option></select>
 <ul><li><Link to="/accounts">{de?'Konto, Passwort und Benutzerrollen':'Account, password and user roles'}</Link></li>{can('integrations:read')&&<><li><Link to="/integrations">PayPal / Stripe</Link></li><li><Link to="/banking">{de?'Bankverbindung':'Bank connection'}</Link></li><li><Link to="/invoice-bot">{de?'Rechnungsportale':'Invoice portals'}</Link></li></>}{can('data:backup')&&<li><Link to="/data">{de?'Sicherung, Wiederherstellung und Migration':'Backup, restore and migration'}</Link></li>}<li><Link to="/audit">{de?'Änderungshistorie':'Audit history'}</Link></li></ul>
 <p>{de?'Kontoinformationen, SEPA-Vorbereitung, lokale Zahlungssimulation und Anbieter-Sandbox sind getrennte Funktionen. Die lokale Simulation kontaktiert keine Bank. Die Anbieter-Sandbox verwendet Testzahlungen; Produktionszahlungen sind gesperrt.':'Account information, SEPA preparation, local payment simulation and provider sandbox are separate capabilities. Local simulation contacts no bank. The provider sandbox uses test payments; production payments are disabled.'}</p>
 </section>;
}
