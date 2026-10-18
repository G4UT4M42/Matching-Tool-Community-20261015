import React, { createContext, useContext, useState } from 'react';
import {useOptionalLanguage} from '../i18n/locale';
import {useLegacyText} from '../i18n/legacy';
const sharedEnglish={
 'Suche zurücksetzen':'Clear search','Öffnen: {filename}':'Open: {filename}',
 'Zeilen pro Seite':'Rows per page','Alle':'All','Tooltips ein/ausschalten':'Toggle tooltips',
 'Auswahl':'Selection',
 'Klicken zum Kopieren: {value}':'Click to copy: {value}','Kopiert!':'Copied!',
};

// --- Style constants ---
export const colors = {
  green: '#27ae60', red: '#e74c3c', blue: '#2980b9', orange: '#f39c12',
  gray: '#95a5a6', lightGray: '#ecf0f1', darkGray: '#7f8c8d',
  bg: '#fff', border: '#ddd',
};

// --- Shared components ---

export function Card({ title, children, style }: { title?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: '#fff', borderRadius: 8, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', ...style }}>
      {title && <h3 style={{ margin: '0 0 12px', fontSize: 16, color: '#333' }}>{title}</h3>}
      {children}
    </div>
  );
}

export function StatCard({ label, value, color, sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <div style={{ background: '#fff', borderRadius: 8, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center', minWidth: 140 }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: color ?? '#333' }}>{value}</div>
      <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11,
      fontWeight: 600, color: '#fff', background: color,
    }}>
      {text}
    </span>
  );
}

export function StatusBadge({ matched }: { matched: boolean }) {
  const de=(useOptionalLanguage()?.language??'de')==='de';
  return matched
    ? <Badge text={de?'Zugeordnet':'Matched'} color={colors.green} />
    : <Badge text={de?'Nicht zugeordnet':'Unmatched'} color={colors.orange} />;
}

export function SourceBadge({ source }: { source: string }) {
  const c: Record<string, string> = {
    sparkasse: '#e74c3c', visa: '#2980b9', paypal: '#3498db',
    stripe: '#9b59b6', enablebanking: '#e74c3c', income: '#27ae60', invoice_file: '#f39c12',
    extracted_invoice: '#e67e22', invoice_scan: '#8e44ad',
  };
  return <Badge text={source} color={c[source] ?? colors.gray} />;
}

export function Amount({ value, currency }: { value: number; currency?: string }) {
  const language=useOptionalLanguage()?.language;
  const formatted = new Intl.NumberFormat(language==='en'?'en-GB':'de-DE', {
    style: 'currency', currency: currency ?? 'EUR',
  }).format(value);
  return <span style={{ color: value < 0 ? colors.red : colors.green, fontWeight: 600, fontFamily: 'monospace' }}>{formatted}</span>;
}

export function Table({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '2px solid #ddd', color: '#666', fontWeight: 600 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
              {cells.map((cell, j) => (
                <td key={j} style={{ padding: '8px 12px', verticalAlign: 'top' }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  const de=(useOptionalLanguage()?.language??'de')==='de';
  if (pages <= 1) return null;
  return (
    <div style={{ display: 'flex', gap: 4, justifyContent: 'center', marginTop: 12 }}>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)} style={btnStyle}>{de?'Zurück':'Prev'}</button>
      <span style={{ padding: '6px 12px', fontSize: 13 }}>{de?'Seite':'Page'} {page} {de?'von':'of'} {pages}</span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)} style={btnStyle}>{de?'Weiter':'Next'}</button>
    </div>
  );
}

export function Button({ children, onClick, color, disabled, style: s }: {
  children: React.ReactNode; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>; color?: string; disabled?: boolean; style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '8px 16px', borderRadius: 6, border: 'none', cursor: disabled ? 'default' : 'pointer',
        background: disabled ? '#ccc' : (color ?? colors.blue), color: '#fff', fontWeight: 600, fontSize: 13,
        opacity: disabled ? 0.6 : 1, ...s,
      }}
    >
      {children}
    </button>
  );
}

export function SearchInput({ value, onChange, onSearch, placeholder }: { value: string; onChange: (v: string) => void; onSearch?: () => void; placeholder?: string }) {
  const text=useLegacyText(sharedEnglish),de=(useOptionalLanguage()?.language??'de')==='de';
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && onSearch) { event.preventDefault(); onSearch(); } }}
        aria-label={placeholder ?? (de?'Suche':'Search')}
        placeholder={placeholder ?? (de?'Suche...':'Search...')}
        style={{ padding: '8px 28px 8px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, width: 260 }}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          style={{
            position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
            border: 'none', background: 'none', cursor: 'pointer',
            color: '#999', fontSize: 16, lineHeight: 1, padding: 2,
          }}
          aria-label={text('Suche zurücksetzen')}
          title={text('Suche zurücksetzen')}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function Select({ value, onChange, options, accessibleName }: { accessibleName?: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const text=useLegacyText(sharedEnglish);
  return (
    <select aria-label={accessibleName ?? options[0]?.label ?? text("Auswahl")} value={value} onChange={(e) => onChange(e.target.value)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Clickable file link — opens the file in a new tab via the backend */
export function FileLink({ filename, children }: { filename: string | null | undefined; children?: React.ReactNode }) {
  const text=useLegacyText(sharedEnglish);
  if (!filename) return <span style={{ color: '#999' }}>—</span>;
  const label = children ?? filename;
  const isPlaceholder = filename === 'NO FILENAME' || filename === '-';
  if (isPlaceholder) {
    return <span style={{ color: '#999', fontSize: 12 }}>{label}</span>;
  }

  // Amazon order numbers → open the folder via Amazon-Rechnungen/{orderNumber}
  const isOrderNumber = /^\d{3}-\d{7}-\d{7}(#\d+)?$/.test(filename);
  const effectiveFilename = isOrderNumber
    ? `Amazon-Rechnungen/${filename.replace(/#\d+$/, '')}`
    : filename;

  const url = `/api/files/open/${encodeURIComponent(effectiveFilename)}`;

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    // Peek at the response content-type to decide behavior
    try {
      const res = await fetch(url, { method: 'HEAD' });
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/html')) {
        // Folder — just fetch to trigger Explorer open, don't navigate
        await fetch(url);
      } else {
        // File — open in new tab
        window.open(url, '_blank');
      }
    } catch {
      // Fallback: open in new tab
      window.open(url, '_blank');
    }
  };

  return (
    <a
      href={url}
      onClick={handleClick}
      style={{
        color: colors.blue,
        textDecoration: 'none',
        cursor: 'pointer',
        borderBottom: '1px dashed #2980b9',
      }}
      title={text('Öffnen: {filename}',{filename})}
      onMouseOver={e => (e.currentTarget.style.color = '#1a5276')}
      onMouseOut={e => (e.currentTarget.style.color = colors.blue)}
    >
      {label}
    </a>
  );
}

/** Format ISO date string to DD/MM/YY */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = iso.slice(0, 10); // YYYY-MM-DD
  const [y, m, dd] = d.split('-');
  if (!y || !m || !dd) return d;
  return `${dd}/${m}/${y.slice(2)}`;
}

/** Format ISO datetime string to DD/MM/YY HH:mm */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = formatDate(iso);
  const time = iso.slice(11, 16); // HH:mm
  return time ? `${date} ${time}` : date;
}

// --- Page size (rows per page) ---

const PAGE_SIZE_OPTIONS = [
  { value: '100', label: '100' },
  { value: '500', label: '500' },
  { value: '1000', label: '1000' },
  { value: '99999', label: 'Alle' },
];

const PageSizeContext = createContext<{ pageSize: number; setPageSize: (n: number) => void }>({
  pageSize: 100,
  setPageSize: () => {},
});

export function PageSizeProvider({ children }: { children: React.ReactNode }) {
  const [pageSize, setPageSize] = useState(() => {
    const saved = localStorage.getItem('pageSize');
    return saved ? Number(saved) : 100;
  });
  const set = (n: number) => {
    setPageSize(n);
    localStorage.setItem('pageSize', String(n));
  };
  return <PageSizeContext.Provider value={{ pageSize, setPageSize: set }}>{children}</PageSizeContext.Provider>;
}

export function usePageSize() {
  return useContext(PageSizeContext);
}

export function PageSizeSelect() {
  const id=React.useId();
  const text=useLegacyText(sharedEnglish);
  const { pageSize, setPageSize } = usePageSize();
  return (
    <div style={{ padding: '12px 16px', fontSize: 12, color: '#aaa' }}>
      <label htmlFor={id} style={{ display: 'block', marginBottom: 4 }}>{text('Zeilen pro Seite')}</label>
      <select id={id}
        value={String(pageSize)}
        onChange={e => setPageSize(Number(e.target.value))}
        style={{ width: '100%', padding: '4px 8px', borderRadius: 4, border: '1px solid #444', background: '#16213e', color: '#eee', fontSize: 12 }}
      >
        {PAGE_SIZE_OPTIONS.map(o => <option key={o.value} value={o.value}>{text(o.label)}</option>)}
      </select>
    </div>
  );
}

// --- Working period (Arbeitszeitraum) for percentage calculation ---

const currentYear = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: currentYear - 2022 }, (_, i) => currentYear - i);

export interface WorkingPeriod {
  year: number;
  quarter: number | null; // null = full year, 1-4 = Q1-Q4
}

const WorkingPeriodContext = createContext<{
  period: WorkingPeriod;
  setPeriod: (p: WorkingPeriod) => void;
}>({
  period: { year: currentYear, quarter: null },
  setPeriod: () => {},
});

export function WorkingYearProvider({ children }: { children: React.ReactNode }) {
  const [period, setPeriod] = useState<WorkingPeriod>(() => {
    const savedYear = localStorage.getItem('workingYear');
    const savedQ = localStorage.getItem('workingQuarter');
    return {
      year: savedYear ? Number(savedYear) : currentYear,
      quarter: savedQ ? Number(savedQ) : null,
    };
  });
  const set = (p: WorkingPeriod) => {
    setPeriod(p);
    localStorage.setItem('workingYear', String(p.year));
    if (p.quarter) localStorage.setItem('workingQuarter', String(p.quarter));
    else localStorage.removeItem('workingQuarter');
  };
  return <WorkingPeriodContext.Provider value={{ period, setPeriod: set }}>{children}</WorkingPeriodContext.Provider>;
}

export function useWorkingYear() {
  const { period, setPeriod } = useContext(WorkingPeriodContext);
  // Backward compat: workingYear still available, plus new period + quarter
  return {
    workingYear: period.year,
    quarter: period.quarter,
    period,
    setWorkingYear: (y: number) => setPeriod({ ...period, year: y }),
    setQuarter: (q: number | null) => setPeriod({ ...period, quarter: q }),
    setPeriod,
  };
}

export function workingPeriodDates(year: number, quarter: number | null) {
  const startMonth = quarter ? (quarter - 1) * 3 + 1 : 1;
  const endMonth = quarter ? quarter * 3 : 12;
  const endDay = new Date(year, endMonth, 0).getDate();
  return {
    start: `${year}-${String(startMonth).padStart(2, '0')}-01`,
    end: `${year}-${String(endMonth).padStart(2, '0')}-${endDay}`,
  };
}

export function WorkingYearSelect({locale='en'}:{locale?:'en'|'de'}={}) {
  const de=locale==='de';
  const { period, setPeriod } = useContext(WorkingPeriodContext);
  const [localYear, setLocalYear] = useState(period.year);
  const [localQ, setLocalQ] = useState<number | null>(period.quarter);

  // Sync when context changes externally
  React.useEffect(() => { setLocalYear(period.year); setLocalQ(period.quarter); }, [period]);

  const apply = () => setPeriod({ year: localYear, quarter: localQ });
  const changed = localYear !== period.year || localQ !== period.quarter;
  const label = period.quarter ? `Q${period.quarter} ${period.year}` : `${period.year}`;

  const selStyle: React.CSSProperties = { width: '100%', padding: '4px 8px', borderRadius: 4, border: '1px solid #444', background: '#16213e', color: '#eee', fontSize: 12 };

  return (
    <div style={{ padding: '12px 16px', fontSize: 12, color: '#aaa' }}>
      <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, color: '#ccc' }}>{de?'Arbeitszeitraum':'Working period'}: {label}</label>
      <select aria-label={de?'Arbeitsjahr':'Working year'} value={String(localYear)} onChange={e => setLocalYear(Number(e.target.value))} style={{ ...selStyle, marginBottom: 6 }}>
        {YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
      <select aria-label={de?'Quartal':'Quarter'} value={localQ === null ? '' : String(localQ)} onChange={e => setLocalQ(e.target.value ? Number(e.target.value) : null)} style={{ ...selStyle, marginBottom: 8 }}>
        <option value="">{de?'Ganzes Jahr':'Whole year'}</option>
        <option value="1">{de?"Q1 (Jan–Mär)":"Q1 (Jan–Mar)"}</option>
        <option value="2">Q2 (Apr–Jun)</option>
        <option value="3">Q3 (Jul–Sep)</option>
        <option value="4">{de?'Q4 (Okt–Dez)':'Q4 (Oct–Dec)'}</option>
      </select>
      <button
        onClick={apply}
        disabled={!changed}
        style={{
          width: '100%', padding: '6px 0', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: changed ? 'pointer' : 'default',
          border: 'none', background: changed ? '#4db8ff' : '#333', color: changed ? '#fff' : '#666',
          transition: 'all 0.15s',
        }}
      >
        {de?'Anwenden':'Apply'}
      </button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 4, border: '1px solid #ddd', background: '#fff',
  cursor: 'pointer', fontSize: 12,
};

// ==================== TOOLTIP SYSTEM ====================

const TooltipContext = createContext<{ enabled: boolean; toggle: () => void }>({ enabled: false, toggle: () => {} });

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem('tooltips_enabled') === 'true');
  const toggle = () => setEnabled(prev => { const v = !prev; localStorage.setItem('tooltips_enabled', String(v)); return v; });
  return <TooltipContext.Provider value={{ enabled, toggle }}>{children}</TooltipContext.Provider>;
}

export function useTooltips() { return useContext(TooltipContext); }

/** Tooltip toggle button (? icon + switch) for the top-right corner */
export function TooltipToggle() {
  const text=useLegacyText(sharedEnglish);
  const { enabled, toggle } = useTooltips();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{
        width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: enabled ? '#2980b9' : '#ddd', color: enabled ? '#fff' : '#888',
        fontSize: 13, fontWeight: 700, cursor: 'pointer', transition: 'all 0.2s',
      }} onClick={toggle} title={text('Tooltips ein/ausschalten')}>
        ?
      </div>
      <div onClick={toggle} style={{
        width: 34, height: 18, borderRadius: 9, cursor: 'pointer', position: 'relative',
        background: enabled ? '#2980b9' : '#ccc', transition: 'background 0.2s',
      }}>
        <div style={{
          width: 14, height: 14, borderRadius: '50%', background: '#fff', position: 'absolute',
          top: 2, left: enabled ? 18 : 2, transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }} />
      </div>
    </div>
  );
}

/** Tooltip wrapper — shows tooltip on hover when tooltips are enabled */
export function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  const { enabled } = useTooltips();
  const [show, setShow] = useState(false);

  if (!enabled) return <>{children}</>;

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <span style={{
          position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          marginBottom: 6, padding: '5px 10px', borderRadius: 5,
          background: 'rgba(0,0,0,0.85)', color: '#fff', fontSize: 11, lineHeight: 1.3,
          whiteSpace: 'nowrap', zIndex: 9999, pointerEvents: 'none',
          maxWidth: 280, wordBreak: 'break-word',
        }}>
          {text}
        </span>
      )}
    </span>
  );
}

/** Clickable value — copies the raw number to clipboard on click */
export function CopyValue({ minor, label, style: s }: { minor: number; label?: string; style?: React.CSSProperties }) {
  const text=useLegacyText(sharedEnglish),language=useOptionalLanguage()?.language;
  const [copied, setCopied] = useState(false);
  const formatted = new Intl.NumberFormat(language==='en'?'en-GB':'de-DE', { style: 'currency', currency: 'EUR' }).format(minor / 100);
  const raw = (Math.abs(minor) / 100).toFixed(2).replace('.', ',');

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(raw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <span onClick={handleClick} title={text('Klicken zum Kopieren: {value}',{value:raw})}
      style={{
        cursor: 'pointer', position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6,
        border: '1px solid #bbb', borderRadius: 5, padding: '4px 10px', background: copied ? '#e8f5e9' : '#f8f9fa',
        transition: 'background 0.2s', ...s,
      }}>
      <span style={{ fontSize: 14, color: copied ? '#27ae60' : '#888', lineHeight: 1 }}>&#x2398;</span>
      {label && <span style={{ fontWeight: 400, fontSize: '0.75em', color: '#888' }}>{label}</span>}
      <b>{formatted}</b>
      {copied && (
        <span style={{
          position: 'absolute', top: -22, left: '50%', transform: 'translateX(-50%)',
          background: '#27ae60', color: '#fff', fontSize: 10, padding: '2px 8px', borderRadius: 3, whiteSpace: 'nowrap',
        }}>
          {text('Kopiert!')}
        </span>
      )}
    </span>
  );
}
