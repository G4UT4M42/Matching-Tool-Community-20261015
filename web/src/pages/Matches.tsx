import React from 'react';
import { Link } from 'react-router-dom';
import { api, communityFetch } from '../api';
import { usePageSize, useWorkingYear } from '../components/shared';
import { useLanguage } from '../i18n/locale';

interface ReviewGroup {
  match_group_id: string; rule_id: string; status: string;
  amount_total_minor: number; currency_code: string;
  transaction_ids: string[]; document_ids: string[];
  transactions?: Array<{ transaction_id: string; description_raw?: string }>;
  documents?: Array<{ document_id: string; source_document_ref?: string }>;
}
interface ReviewPage { items: ReviewGroup[]; total: number; page: number; pages: number }
const cell: React.CSSProperties = { padding: 12, textAlign: 'left', verticalAlign: 'top', borderBottom: '1px solid #ddd' };
const button: React.CSSProperties = { padding: '8px 10px', border: '1px solid #aab2bd', borderRadius: 5, background: '#fff', cursor: 'pointer' };

export function Matches() {
  const { t, language } = useLanguage();
  const { pageSize } = usePageSize();
  const { workingYear, quarter } = useWorkingYear();
  const [data, setData] = React.useState<ReviewPage | null>(null);
  const [filter, setFilter] = React.useState('');
  const [ruleId, setRuleId] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [error, setError] = React.useState('');
  const [saved, setSaved] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [details, setDetails] = React.useState<Record<string, unknown> | null>(null);
  const generation = React.useRef(0);
  const load = React.useCallback(async () => {
    const current = ++generation.current;
    try {
      const response = await api.getMatches({
        page: String(page), limit: String(pageSize), year: String(workingYear),
        ...(quarter ? { quarter: String(quarter) } : {}), ...(filter ? { status: filter } : {}), ...(ruleId ? { rule_id: ruleId } : {}),
      }) as ReviewPage;
      if (current === generation.current) { setData(response); setError(''); }
    } catch {
      if (current === generation.current) setError('review.failed');
    }
  }, [page, pageSize, workingYear, quarter, filter, ruleId]);
  React.useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);

  const apply = async (group: ReviewGroup, status: 'accepted' | 'rejected' | 'proposed' | 'undo') => {
    if (busy || !window.confirm(t('review.confirm', { id: group.match_group_id }))) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const suffix = status === 'undo' ? '' : '/status';
      const response = await communityFetch(`/api/matches/${encodeURIComponent(group.match_group_id)}${suffix}`, {
        method: status === 'undo' ? 'DELETE' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(status === 'undo' ? {} : { status }), reason: note }),
      });
      if (!response.ok) throw new Error('review.actionFailed');
      setSaved(true); setDetails(null); setNote('');
      await load();
    } catch { setError('review.actionFailed'); }
    finally { setBusy(false); }
  };
  const showDetails = async (id: string) => {
    try { setDetails(await api.getMatch(id)); }
    catch { setError('review.failed'); }
  };
  const formatAmount = (group: ReviewGroup) => new Intl.NumberFormat(language, {
    style: 'currency', currency: group.currency_code,
  }).format(group.amount_total_minor / 100);

  return <section aria-labelledby="matching-review-title" data-testid="matching-review">
    <h1 id="matching-review-title">{t('review.title')}</h1>
    <p>{t('review.intro')}</p>
    <p><Link to="/manual-match">{t('review.manualCreate')}</Link></p>
    {error && <p role="alert">{t(error)}</p>}
    {saved && <p role="status">{t('review.saved')}</p>}
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'end', marginBottom: 16 }}>
      <label>{t('review.filter')}<br />
        <select aria-label={t('review.filter')} value={filter} disabled={busy} onChange={event => { setFilter(event.target.value); setPage(1); }} style={{ padding: 8 }}>
          <option value="">{t('review.all')}</option>
          {['proposed', 'accepted', 'confirmed', 'manual', 'rejected'].map(value => <option key={value} value={value}>{t('review.' + value)}</option>)}
        </select>
      </label>
      <label>{t('review.ruleFilter')}<br /><input aria-label={t('review.ruleFilter')} placeholder={t('review.rulePlaceholder')} value={ruleId} disabled={busy} onChange={event => { setRuleId(event.target.value); setPage(1); }} style={{ padding: 9 }} /></label>
      <label style={{ flex: 1, minWidth: 220 }}>{t('review.reason')}<br />
        <input data-testid="review-reason" value={note} onChange={event => setNote(event.target.value)} maxLength={2000}
          placeholder={t('review.reasonPlaceholder')} disabled={busy} style={{ width: '100%', boxSizing: 'border-box', padding: 9 }} />
      </label>
    </div>
    {!data && !error && <p role="status">{t('review.loading')}</p>}
    {data && <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
          <thead><tr>{['rule', 'records', 'amount', 'state', 'actions'].map(key => <th key={key} scope="col" style={cell}>{t('review.' + key)}</th>)}</tr></thead>
          <tbody>{data.items.map(group => <tr key={group.match_group_id} data-testid={`match-${group.match_group_id}`}>
            <td style={cell}><strong>{group.rule_id}</strong><br /><code style={{ overflowWrap: 'anywhere' }}>{group.match_group_id}</code></td>
            <td style={cell}>
              {group.transactions?.map(transaction => <div key={transaction.transaction_id}>{transaction.description_raw} <code>{transaction.transaction_id}</code></div>)}
              {group.documents?.length ? group.documents.map(document => <div key={document.document_id}><code>{document.source_document_ref || document.document_id}</code></div>) : <span>{t('review.noDocuments')}</span>}
            </td>
            <td style={{ ...cell, whiteSpace: 'nowrap' }}>{formatAmount(group)}</td>
            <td style={cell} data-testid="decision-state">{t('review.' + group.status)}</td>
            <td style={cell}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {group.status === 'proposed' && <>
                <button data-action="accept" style={button} disabled={busy} onClick={() => void apply(group, 'accepted')}>{t('review.accept')}</button>
                <button data-action="reject" style={button} disabled={busy} onClick={() => void apply(group, 'rejected')}>{t('review.reject')}</button>
              </>}
              {group.status !== 'proposed' && <button data-action="reopen" style={button} disabled={busy} onClick={() => void apply(group, 'proposed')}>{t('review.reopen')}</button>}
              {group.status !== 'rejected' && <button data-action="undo" style={button} disabled={busy} onClick={() => void apply(group, 'undo')}>{t('review.undo')}</button>}
              <button data-action="details" style={button} disabled={busy} onClick={() => void showDetails(group.match_group_id)}>{t('review.details')}</button>
            </div></td>
          </tr>)}</tbody>
        </table>
      </div>
      {!data.items.length && <p>{t('review.empty')}</p>}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 }}>
        <button style={button} disabled={page <= 1 || busy} onClick={() => setPage(value => value - 1)}>{t('review.previous')}</button>
        <span>{t('review.page', { page, pages: Math.max(1, data.pages) })}</span>
        <button style={button} disabled={page >= data.pages || busy} onClick={() => setPage(value => value + 1)}>{t('review.next')}</button>
      </div>
    </>}
    {details && <aside style={{ padding: 16, marginTop: 20, background: '#f5f7fa' }} aria-label={t('review.details')}>
      <button style={button} onClick={() => setDetails(null)}>{t('review.close')}</button>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(details, null, 2)}</pre>
    </aside>}
  </section>;
}
