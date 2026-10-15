import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { Transactions } from './pages/Transactions';
import { Matches } from './pages/Matches';
import { ReviewQueue } from './pages/ReviewQueue';
import { ManualMatch } from './pages/ManualMatch';
import { Exclusions } from './pages/Exclusions';
import { AuditTrail } from './pages/AuditTrail';
import { Rechnungen } from './pages/Rechnungen';
import { Einkuenfte } from './pages/Einkuenfte';
import { Reports } from './pages/Reports';
import { VatReport } from './pages/VatReport';
import { IncomeTaxReport } from './pages/IncomeTaxReport';
import { InvoiceRecognition } from './pages/InvoiceRecognition';
import { Settings } from './pages/Settings';
import { InvoiceBot } from './pages/InvoiceBot';
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
import { LanguageProvider, useLanguage } from './i18n/locale';

function App() {
  const { t, language, languages, setLanguage } = useLanguage();
  const account = useCommunityAccount(); const access = accountLabels(language);
  const [accessError, setAccessError] = React.useState('');
  return (
    <PageSizeProvider>
    <WorkingYearProvider>
    <TooltipProvider>
    <BrowserRouter>
      <div style={{ display: 'flex', minHeight: '100vh' }}>
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
              ...(account.principal?.permissions.includes('payments:prepare') ? [{ to: '/payments', label: language === 'de' ? 'Zahlungssimulation' : 'Payment simulation', tip: language === 'de' ? 'SEPA-Entwürfe und lokale simulierte Übermittlung' : 'SEPA drafts and local simulated submission' }] : []),
            ] : []),
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
            <WorkingYearSelect />
          </div>
        </nav>
        <main style={{ flex: 1, padding: 24, overflow: 'auto', position: 'relative' }}>
          <div style={{ position: 'absolute', top: 12, right: 16, zIndex: 50 }}>
            <TooltipToggle />
          </div>
          <Routes>
            <Route path="/" element={<Transactions />} />
            <Route path="/accounts" element={<CommunityAccounts />} />
            <Route path="/documents" element={!account.demo ? <CommunityDocuments /> : <p>{access.previewHelp}</p>} />
            <Route path="/accounting" element={!account.demo ? <CommunityAccounting locale={language === 'de' ? 'de' : 'en'} /> : <p>{access.previewHelp}</p>} />
            <Route path="/data" element={!account.demo && account.principal?.permissions.includes('data:backup') ? <CommunityDataManagement /> : <p role="alert">{access.permission}</p>} />
            <Route path="/integrations" element={!account.demo && account.principal?.permissions.includes('integrations:read') ? <CommunityIntegrations /> : <p role="alert">{access.permission}</p>} />
            <Route path="/payments" element={!account.demo && account.principal?.permissions.includes('payments:prepare') ? <CommunityPayments /> : <p role="alert">{access.permission}</p>} />
            <Route path="/import" element={!account.demo && account.principal?.permissions.includes('finance:import') ? <CommunityStatementReview locale={language === 'de' ? 'de' : 'en'} request={communityFetch} /> : <p role="alert">{access.permission}</p>} />
            <Route path="/rechnungen" element={account.demo ? <Rechnungen /> : <CommunityDocuments />} />
            <Route path="/einkuenfte" element={account.demo ? <Einkuenfte /> : <CommunityDocuments />} />
            <Route path="/matching" element={account.demo ? <Matching /> : <CommunityAccounting locale={language === "de" ? "de" : "en"} />} />
            <Route path="/belegerkennung" element={account.demo ? <InvoiceRecognition /> : <CommunityDocuments />} />
            <Route path="/invoice-bot" element={account.demo ? <InvoiceBot /> : account.principal?.permissions.includes('integrations:read') ? <CommunityInvoiceBot /> : <p role="alert">{access.permission}</p>} />
            <Route path="/reports" element={account.demo ? <Reports /> : <CommunityAccounting locale={language === "de" ? "de" : "en"} />} />
            <Route path="/vat-report" element={account.demo ? <VatReport /> : <CommunityAccounting locale={language === "de" ? "de" : "en"} />} />
            <Route path="/einkommensteuer" element={account.demo ? <IncomeTaxReport /> : <CommunityAccounting locale={language === "de" ? "de" : "en"} />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/matches" element={<Matches />} />
            <Route path="/review" element={<ReviewQueue />} />
            <Route path="/manual-match" element={<ManualMatch />} />
            <Route path="/exclusions" element={account.demo ? <Exclusions /> : <CommunityAccounting locale={language === "de" ? "de" : "en"} />} />
            <Route path="/audit" element={<AuditTrail />} />
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
