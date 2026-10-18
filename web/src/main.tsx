import {CommunityDemoViews} from './pages/CommunityDemoViews';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { Transactions } from './pages/Transactions';
import { Matches } from './pages/Matches';
import { ReviewQueue } from './pages/ReviewQueue';
import { ManualMatch } from './pages/ManualMatch';
import { Exclusions } from './pages/Exclusions';
import { AuditTrail } from './pages/AuditTrail';
import { Matching } from './pages/Matching';
import { PageSizeProvider, WorkingYearProvider, WorkingYearSelect, TooltipProvider, TooltipToggle, Tip } from './components/shared';
import { communityFetch } from './api';
import { CommunityAccountAccess, accountLabels, useCommunityAccount } from './components/CommunityAccountAccess';
import { CommunityAccounts } from './pages/CommunityAccounts';
import { CommunityStatementReview } from './pages/CommunityStatementReview';
import { CommunityDocuments } from './pages/CommunityDocuments';
import { CommunityAccounting } from './pages/CommunityAccounting';
import { CommunityDataManagement } from './pages/CommunityDataManagement';
import { CommunityIntegrations } from './pages/CommunityIntegrations';
import { CommunityPayments } from './pages/CommunityPayments';
import { CommunityInvoiceBot } from './pages/CommunityInvoiceBot';
import { CommunityHome } from './pages/CommunityHome';
import { CommunitySettings } from './pages/CommunitySettings';
import { CommunityAudit } from './pages/CommunityAudit';
import { CommunityBanking } from './pages/CommunityBanking';
import { LanguageProvider, useLanguage } from './i18n/locale';

function App() {
  const { t, language, languages, setLanguage } = useLanguage();
  const account = useCommunityAccount(); const access = accountLabels(language);
  const permissions=account.principal?.permissions??[];
  const mayPayments=['payments:prepare','payments:approve','payments:submit'].some(permission=>permissions.includes(permission));
  const [accessError, setAccessError] = React.useState('');
  return (
    <PageSizeProvider>
    <WorkingYearProvider>
    <TooltipProvider>
    <BrowserRouter>
      <div className="community-shell" style={{ display: 'flex', minHeight: '100vh' }}>
        <style>{`*{box-sizing:border-box} .community-shell>main{min-width:0} button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #0879c9;outline-offset:3px} @media(max-width:760px){.community-shell{flex-direction:column}.community-shell>nav{width:100%!important;height:auto!important;position:relative!important;max-height:40vh}.community-shell>main{padding:12px!important}.community-shell input,.community-shell select,.community-shell textarea{max-width:100%}.community-shell table{display:block;overflow-x:auto;max-width:100%}}`}</style>
        <nav style={{
          width: 220, background: '#1a1a2e', color: '#eee', padding: '20px 0',
          display: 'flex', flexDirection: 'column', flexShrink: 0,
          position: 'sticky', top: 0, height: '100vh', overflowY: 'auto',
        }}>
          <h2 style={{ padding: '0 16px 16px', borderBottom: '1px solid #333', fontSize: 16 }}>
            {t('app.title')}
          </h2>
          {[
            { to: '/', label: t('navigation.transactions'), tip: t('navigation.transactionsHelp') },
            ...(!account.demo && account.principal?.permissions.includes('finance:import') ? [{ to: '/import', label: language === 'de' ? 'Kontoauszug importieren' : 'Import bank statement', tip: language === 'de' ? 'Datei prüfen und Import bestätigen' : 'Preview the file and confirm its import' }] : []),
            ...(!account.demo ? [{ to: '/accounts', label: access.account, tip: access.management },
              {to:'/documents',label:language==='de'?'Belege und Erkennung':'Documents and recognition',tip:language==='de'?'Belege hochladen, prüfen und verwalten':'Upload, review and manage source documents'},
              {to:'/accounting',label:language==='de'?'Abstimmung und Berichte':'Reconciliation and reports',tip:language==='de'?'Teilzahlungen und exakte Berichte':'Partial payments and exact reports'},
              ...(account.principal?.permissions.includes('data:backup')?[{to:'/data',label:language==='de'?'Sicherung und Migration':'Backup and migration',tip:language==='de'?'Geprüfte Sicherung und Wiederherstellung':'Verified backups and restoration'}]:[]),
              ...(account.principal?.permissions.includes('integrations:read') ? [{ to: '/integrations', label: language === 'de' ? 'Integrationen' : 'Integrations', tip: language === 'de' ? 'Eigene PayPal- und Stripe-Verbindungen verwalten' : 'Manage your PayPal and Stripe connections' }] : []),
              ...(mayPayments ? [{ to: '/payments', label: language === 'de' ? 'Zahlungen' : 'Payments', tip: language === 'de' ? 'SEPA-Entwürfe, lokale Simulation und Sandbox-Autorisierung' : 'SEPA drafts, local simulation and sandbox authorization' }] : []),
              ...(account.principal?.permissions.includes('integrations:read') ? [{to:'/banking',label:language==='de'?'Bankverbindung':'Bank connection',tip:language==='de'?'Autorisierte Kontoinformationen lesen':'Read authorized account information'}] : []),
            ] : []),
            ...(account.demo ? [{to:'/integrations',label:language==='de'?'Anbieterbeispiele':'Provider samples',tip:language==='de'?'Lokale Beispieldaten ohne Anbieterverbindung':'Local samples without provider connections'},{to:'/reports',label:language==='de'?'Kanonische Berichte':'Canonical reports',tip:language==='de'?'Exakte gespeicherte Klassifikationen':'Exact recorded classifications'},{to:'/payments',label:language==='de'?'Lokaler Zahlungsentwurf':'Local payment draft',tip:language==='de'?'Nicht übermittelter Simulatorentwurf':'Unsubmitted simulator draft'}] : []),
            { to: '/rechnungen', label: t('navigation.invoices'), tip: t('navigation.invoicesHelp') },
            { to: '/einkuenfte', label: t('navigation.income'), tip: t('navigation.incomeHelp') },
            { to: '/matching', label: t('navigation.matching'), tip: t('navigation.matchingHelp') },
            { to: '/matches', label: t('navigation.review'), tip: t('navigation.reviewHelp') },
            { to: '/belegerkennung', label: t('navigation.recognition'), tip: t('navigation.recognitionHelp') },
            ...(account.demo || account.principal?.permissions.includes('integrations:read') ? [{ to: '/invoice-bot', label: t('navigation.invoicebot'), tip: t('navigation.invoicebotHelp') }] : []),
            { to: '/vat-report', label: t('navigation.vat'), tip: t('navigation.vatHelp') },
            { to: '/einkommensteuer', label: t('navigation.incomeTax'), tip: t('navigation.incomeTaxHelp') },
            { to: '/settings', label: t('navigation.settings'), tip: t('navigation.settingsHelp') },
          ].map(({ to, label, tip }) => (
            <Tip text={tip} key={to}>
              <NavLink
                to={to}
                style={({ isActive }) => ({
                  display: 'block', padding: '10px 16px', color: isActive ? '#fff' : '#aaa',
                  background: isActive ? '#16213e' : 'transparent', textDecoration: 'none',
                  borderLeft: isActive ? '3px solid #4db8ff' : '3px solid transparent',
                  width: '100%',
                })}
              >
                {label}
              </NavLink>
            </Tip>
          ))}
          <div style={{ marginTop: 'auto', borderTop: '1px solid #333', padding: '14px' }}>
            <label htmlFor="community-language" style={{ display: 'block', fontSize: 12, color: '#ccc', marginBottom: 6 }}>
              {t('settings.language')}
            </label>
            <select id="community-language" value={language} onChange={event => setLanguage(event.target.value)}
              style={{ width: '100%', padding: '8px', borderRadius: 5 }}>
              {languages.map(code => <option key={code} value={code}>{code === 'en' ? 'English' : code === 'de' ? 'Deutsch' : code}</option>)}
            </select>
            <p style={{ color: '#ccc', fontSize: 11, lineHeight: 1.3 }}>{account.demo ? t('status.demo') : access.signedIn + ': ' + account.principal?.username}</p>
            <button onClick={() => { setAccessError(''); void account.signOut().catch(() => setAccessError(access.failed)); }} style={{padding:'8px 12px',cursor:'pointer'}}>{access.signOut}</button>
            {accessError && <p role="alert">{accessError}</p>}
            <WorkingYearSelect locale={language==='de'?'de':'en'} />
          </div>
        </nav>
        <main style={{ flex: 1, padding: 24, overflow: 'auto', position: 'relative' }}>
          <div style={{ position: 'absolute', top: 12, right: 16, zIndex: 50 }}>
            <TooltipToggle />
          </div>
          <Routes>
            <Route path="/" element={account.demo ? <Transactions allowImport={false} allowAnnotations={false} /> : <CommunityHome />} />
            <Route path="/accounts" element={account.demo ? <CommunityDemoViews view="settings" /> : <CommunityAccounts />} />
            <Route path="/documents" element={account.demo ? <CommunityDemoViews view="invoices" /> : <CommunityDocuments permissions={permissions} />} />
            <Route path="/accounting" element={account.demo ? <CommunityDemoViews view="reports" /> : <CommunityAccounting permissions={permissions} locale={language === 'de' ? 'de' : 'en'} />} />
            <Route path="/data" element={!account.demo && account.principal?.permissions.includes('data:backup') ? <CommunityDataManagement permissions={permissions} owner={account.principal?.role==='owner'} /> : <p role="alert">{access.permission}</p>} />
            <Route path="/integrations" element={account.demo ? <CommunityDemoViews view="providers" /> : !account.demo && account.principal?.permissions.includes('integrations:read') ? <CommunityIntegrations permissions={permissions} /> : <p role="alert">{access.permission}</p>} />
            <Route path="/banking" element={account.demo ? <CommunityDemoViews view="providers" /> : !account.demo && account.principal?.permissions.includes('integrations:read') ? <CommunityBanking permissions={permissions} /> : <p role="alert">{access.permission}</p>} />
            <Route path="/payments" element={account.demo ? <CommunityDemoViews view="payments" /> : !account.demo && mayPayments ? <CommunityPayments permissions={permissions} /> : <p role="alert">{access.permission}</p>} />
            <Route path="/import" element={account.demo ? <CommunityDemoViews view="import" /> : !account.demo && account.principal?.permissions.includes('finance:import') ? <CommunityStatementReview locale={language === 'de' ? 'de' : 'en'} request={communityFetch} /> : <p role="alert">{access.permission}</p>} />
            <Route path="/rechnungen" element={account.demo ? <CommunityDemoViews view="invoices" /> : <CommunityDocuments permissions={permissions} />} />
            <Route path="/einkuenfte" element={account.demo ? <CommunityDemoViews view="income" /> : <CommunityDocuments permissions={permissions} />} />
            <Route path="/matching" element={account.demo ? <Matching allowAutomation={false} /> : <CommunityAccounting permissions={permissions} locale={language === "de" ? "de" : "en"} />} />
            <Route path="/belegerkennung" element={account.demo ? <CommunityDemoViews view="recognition" /> : <CommunityDocuments permissions={permissions} />} />
            <Route path="/invoice-bot" element={account.demo ? <CommunityDemoViews view="providers" /> : account.principal?.permissions.includes('integrations:read') ? <CommunityInvoiceBot permissions={permissions} /> : <p role="alert">{access.permission}</p>} />
            <Route path="/reports" element={account.demo ? <CommunityDemoViews view="reports" /> : <CommunityAccounting permissions={permissions} locale={language === "de" ? "de" : "en"} />} />
            <Route path="/vat-report" element={account.demo ? <CommunityDemoViews view="vat" /> : <CommunityAccounting permissions={permissions} locale={language === "de" ? "de" : "en"} />} />
            <Route path="/einkommensteuer" element={account.demo ? <CommunityDemoViews view="income-tax" /> : <CommunityAccounting permissions={permissions} locale={language === "de" ? "de" : "en"} />} />
            <Route path="/settings" element={account.demo ? <CommunityDemoViews view="settings" /> : <CommunitySettings />} />
            <Route path="/matches" element={account.demo ? <Matches /> : <CommunityAccounting permissions={permissions} locale={language === "de" ? "de" : "en"} />} />
            <Route path="/review" element={account.demo ? <ReviewQueue /> : <CommunityAccounting permissions={permissions} locale={language === "de" ? "de" : "en"} />} />
            <Route path="/manual-match" element={account.demo ? <ManualMatch allowOriginalFiles={false} /> : <CommunityAccounting permissions={permissions} locale={language === "de" ? "de" : "en"} />} />
            <Route path="/exclusions" element={account.demo ? <Exclusions /> : <CommunityAccounting permissions={permissions} locale={language === "de" ? "de" : "en"} />} />
            <Route path="/audit" element={account.demo ? <AuditTrail /> : <CommunityAudit />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
    </TooltipProvider>
    </WorkingYearProvider>
    </PageSizeProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LanguageProvider><CommunityAccountAccess><App /></CommunityAccountAccess></LanguageProvider>
  </React.StrictMode>,
);
