import { en } from './catalog.en.mjs';

const catalogs = new Map([['en', en]]);
const safeLocale = x => typeof x === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(x);

export function registerLocale(locale, messages) {
  if (!safeLocale(locale) || !messages || typeof messages !== 'object' || Array.isArray(messages)) {
    throw new Error('Invalid language catalog');
  }
  if (locale === 'en') throw new Error('English fallback cannot be replaced dynamically');
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value !== 'string' || !(key in en)) throw new Error('Unknown translation key');
  }
  catalogs.set(locale, Object.freeze({ ...messages }));
}

export function createI18n(initial = 'en') {
  let current = catalogs.has(initial) ? initial : 'en';
  return {
    get locale() { return current; },
    setLocale(locale) { current = catalogs.has(locale) ? locale : 'en'; return current; },
    languages() { return [...catalogs.keys()]; },
    t(key, variables = {}) {
      const template = catalogs.get(current)?.[key] ?? en[key];
      if (typeof template !== 'string') return key; // never invent accounting semantics
      return template.replace(/\{([a-zA-Z][\w]*)\}/g, (_, name) => {
        const value = variables[name];
        return typeof value === 'string' || typeof value === 'number' ? String(value) : '{' + name + '}';
      });
    },
    formatAmount(amountMinor, currency = 'EUR') {
      if (!Number.isSafeInteger(amountMinor)) throw new Error('Amount must be signed integer minor units');
      return new Intl.NumberFormat(current, { style: 'currency', currency }).format(amountMinor / 100);
    },
    formatDate(isoDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error('Invalid ISO civil date');
      const [year, month, day] = isoDate.split('-').map(Number);
      const utc = new Date(Date.UTC(year, month - 1, day));
      if (utc.toISOString().slice(0, 10) !== isoDate) throw new Error('Invalid calendar day');
      return new Intl.DateTimeFormat(current, { dateStyle: 'medium', timeZone: 'UTC' }).format(utc);
    },
  };
}

export const defaultI18n = createI18n('en');
