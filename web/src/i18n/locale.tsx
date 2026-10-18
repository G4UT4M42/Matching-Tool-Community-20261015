import React from 'react';
import { matchReviewEn, matchReviewDe } from './match-review';

const en: Record<string, string> = Object.freeze({
  ...matchReviewEn,
  'app.title': 'Matching Tool Community',
  'navigation.transactions': 'Transactions',
  'navigation.transactionsHelp': 'View and filter workspace bank and card transactions',
  'navigation.invoices': 'Invoices',
  'navigation.invoicesHelp': 'Review invoice evidence, documents and linked transactions',
  'navigation.income': 'Income',
  'navigation.incomeHelp': 'Review income records and associated evidence',
  'navigation.matching': 'Matching',
  'navigation.matchingHelp': 'Match transactions with invoices and reconcile evidence',
  'navigation.recognition': 'Document recognition',
  'navigation.recognitionHelp': 'Review invoice fields extracted by local OCR',
  'navigation.invoicebot': 'Invoice bot',
  'navigation.invoicebotHelp': 'Collect invoices through a fresh user-controlled browser session',
  'navigation.vat': 'VAT report',
  'navigation.vatHelp': 'Review entered VAT classifications and supporting evidence',
  'navigation.incomeTax': 'Income tax',
  'navigation.incomeTaxHelp': 'Review entered income and expense classifications',
  'navigation.settings': 'Settings',
  'navigation.settingsHelp': 'Local preferences, safe backups and configuration',
  'settings.language': 'Language',
  'status.demo': 'Synthetic developer preview — real banking is disabled',
});

const de: Partial<typeof en> = Object.freeze({
  ...matchReviewDe,
  'app.title': 'Matching Tool Community',
  'navigation.transactions': 'Buchungen',
  'navigation.transactionsHelp': 'Bank- und Kartenbuchungen des Arbeitsbereichs prüfen',
  'navigation.invoices': 'Rechnungen',
  'navigation.invoicesHelp': 'Rechnungen und Belege prüfen',
  'navigation.income': 'Einnahmen',
  'navigation.incomeHelp': 'Einnahmen und zugehörige Belege prüfen',
  'navigation.matching': 'Zuordnung',
  'navigation.matchingHelp': 'Buchungen und Rechnungen zuordnen',
  'navigation.recognition': 'Belegerkennung',
  'navigation.recognitionHelp': 'Lokal erkannte Rechnungsfelder prüfen',
  'navigation.invoicebot': 'Rechnungsbot',
  'navigation.invoicebotHelp': 'Belege über eine neue selbst gesteuerte Browsersitzung sammeln',
  'navigation.vat': 'Umsatzsteuerbericht',
  'navigation.vatHelp': 'Erfasste Steuerklassifikationen und Nachweise prüfen',
  'navigation.incomeTax': 'Einkommensteuer',
  'navigation.incomeTaxHelp': 'Einkommens- und Ausgabenkategorien prüfen',
  'navigation.settings': 'Einstellungen',
  'navigation.settingsHelp': 'Lokale Einstellungen und Sicherungen',
  'settings.language': 'Sprache',
  'status.demo': 'Synthetische Entwicklervorschau – reale Bankfunktionen deaktiviert',
});

export type LocaleCode = string;
type LocaleContextValue = {
  language: LocaleCode;
  languages: LocaleCode[];
  setLanguage: (value: LocaleCode) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};
const catalogs = new Map<string, Partial<Record<string, string>>>([['en', en], ['de', de]]);
export function registerLocale(code: string, entries: Record<string, string>) {
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(code) || code === 'en') throw new Error('Invalid language code');
  for (const [key, value] of Object.entries(entries)) {
    if (!(key in en) || typeof value !== 'string') throw new Error('Unknown language key');
  }
  catalogs.set(code, Object.freeze({ ...entries }));
}
const Context = React.createContext<LocaleContextValue | null>(null);
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setState] = React.useState<LocaleCode>(() => {
    const initial = typeof window !== 'undefined' ? window.localStorage.getItem('matching-community-locale') : null;
    return initial && catalogs.has(initial) ? initial : 'en';
  });
  React.useEffect(()=>{document.documentElement.lang=language;},[language]);
  const setLanguage = React.useCallback((value: string) => {
    const safe = catalogs.has(value) ? value : 'en';
    setState(safe);
    window.localStorage.setItem('matching-community-locale', safe);
  }, []);
  const t = React.useCallback((key: string, vars: Record<string, string | number> = {}) => {
    const template = catalogs.get(language)?.[key] ?? en[key] ?? key;
    return template.replace(/\{([a-zA-Z]\w*)\}/g, (_match, name: string) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : '{' + name + '}');
  }, [language]);
  const value = React.useMemo(() => ({ language, languages: [...catalogs.keys()], setLanguage, t }), [language, setLanguage, t]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useLanguage(): LocaleContextValue {
  const context = React.useContext(Context);
  if (!context) throw new Error('LanguageProvider is missing');
  return context;
}
/** Legacy component embeddings may omit the application provider. */
export function useOptionalLanguage(): LocaleContextValue | null {
  return React.useContext(Context);
}
