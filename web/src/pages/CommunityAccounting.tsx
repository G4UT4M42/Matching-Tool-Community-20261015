import React, { useEffect, useState } from 'react';
import { communityAccountingText } from '../i18n/community-accounting';
import { communityFetch } from '../api';
import {problemMessage} from '../i18n/community-problems';

type Snapshot = { revision: number; transactions: Array<{ transaction_id: string; amount_minor: number; currency_code: string }>;
  exclusion_rules:Array<{exclusion_id:string;field:string;operator:string;value:string;source_system?:string;enabled:boolean;can_enable:boolean;ownership_known:boolean}>;
  documents: Array<{ document_id: string; total_amount_minor: number; currency_code: string }>;
  allocations: Array<{ allocation_id: string; transaction_id: string; document_id?: string; kind: string; status: string; transaction_amount_minor: number }>;
  match_groups: Array<{ match_group_id: string; status: string; transaction_ids: string[]; document_ids: string[]; amount_total_minor: number; currency_code: string; reason_codes: string[] }> };
type Report = { rows: Array<{ transaction_id: string; amount_minor: number; currency_code: string; category: string; remaining_minor: number }>;
  documents: Array<{ document_id: string; total_amount_minor: number; currency_code: string; reconciliation: string; remaining_minor: number; tax_category: string; vat_minor: number }>;
  totals_by_currency: Record<string, Record<string, number>>; vat_by_currency: Record<string, { output_minor: number; eligible_input_minor: number; unclassified_documents: number }> };

/** Mount under an authenticated workspace; the server supplies all identity and permission checks. */
export function CommunityAccounting({ apiBase = '/api', locale = 'en', permissions }: { apiBase?: string; locale?: 'en' | 'de'; permissions?: readonly string[] }) {
  const t = communityAccountingText[locale];
  const labels:Record<string,string>={"payment": "Zahlung", "refund": "Erstattung", "credit_note": "Gutschrift", "fee": "Gebühr", "transfer": "Umbuchung", "income": "Einnahme", "expense": "Ausgabe", "private": "Privat", "unclassified": "Nicht klassifiziert", "output": "Umsatzsteuer", "input": "Vorsteuer", "exempt": "Steuerfrei", "outside_scope": "Nicht steuerbar", "excluded": "Ausgeschlossen", "restore": "Wiederherstellen", "proposed": "Vorgeschlagen", "accepted": "Angenommen", "confirmed": "Bestätigt", "manual": "Manuell", "rejected": "Abgelehnt", "fully_matched": "Vollständig abgeglichen", "partially_matched": "Teilweise abgeglichen", "unmatched": "Nicht abgeglichen", "description_raw": "Beschreibung", "counterparty_name": "Gegenpartei", "booking_reference": "Buchungsreferenz", "payment_reference": "Zahlungsreferenz", "contains": "Enthält", "equals": "Entspricht", "starts_with": "Beginnt mit"};
  const valueLabel=(value:string)=>locale==='de'?(value==='cancelled'?'Storniert':labels[value]??value):value;
  const mayMatch=permissions===undefined||permissions.includes('finance:match'),mayAnnotate=permissions===undefined||permissions.includes('finance:annotate');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [transactionId, setTransactionId] = useState(''); const [documentId, setDocumentId] = useState('');
  const [kind, setKind] = useState('payment'); const [amount, setAmount] = useState(''); const [documentAmount, setDocumentAmount] = useState('');
  const [draftLegs, setDraftLegs] = useState<object[]>([]);
  const [evidence, setEvidence] = useState(''); const [fxNumerator, setFxNumerator] = useState(''); const [fxDenominator, setFxDenominator] = useState(''); const [fxSource, setFxSource] = useState('');
  const [category, setCategory] = useState('unclassified'); const [taxCategory, setTaxCategory] = useState('unclassified');
  const [vat, setVat] = useState('0'); const [rateNumerator, setRateNumerator] = useState('0'); const [rateDenominator, setRateDenominator] = useState('1');
  const [eligible, setEligible] = useState(false); const [disposition, setDisposition] = useState('private');
  const [exclusionField, setExclusionField] = useState('description_raw'); const [exclusionOperator, setExclusionOperator] = useState('contains'); const [exclusionValue, setExclusionValue] = useState('');
  const [start, setStart] = useState(() => `${new Date().getFullYear()}-01-01`); const [end, setEnd] = useState(() => `${new Date().getFullYear()}-12-31`);
  const request = async (path: string, init?: RequestInit) => {
    const response = await communityFetch(`${apiBase}${path}`, { credentials: 'same-origin', ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers } });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(problemMessage(body,locale,`${t.error}: ${response.status}`)); }
    return response.json();
  };
  const refresh = async () => setSnapshot(await request('/accounting'));
  const loadReport = async () => setReport(await request(`/accounting/reports?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`));
  const action = async (path: string, body: unknown, method = 'POST') => {
    try { setError(''); await request(path, { method, body: JSON.stringify(body) }); await refresh(); await loadReport(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t.error); }
  };
  useEffect(() => { void refresh().catch(cause => setError(String(cause))); }, [apiBase]);
  const currentLeg = () => {
    const tx = snapshot?.transactions.find(item => item.transaction_id === transactionId);
    const doc = snapshot?.documents.find(item => item.document_id === documentId);
    const conversion = tx && doc && tx.currency_code !== doc.currency_code ? { numerator: Number(fxNumerator), denominator: Number(fxDenominator), source: fxSource, evidence_ref: evidence } : undefined;
    return { kind, transaction_id: transactionId, transaction_amount_minor: Number(amount),
      ...(['fee', 'transfer'].includes(kind) ? {} : { document_id: documentId, document_amount_minor: Number(documentAmount), ...(conversion ? { conversion } : {}) }) };
  };
  const submitAllocation = () => { void action('/accounting/allocations', { revision: snapshot?.revision, evidence_ref: evidence, allocations: [...draftLegs, currentLeg()] }); setDraftLegs([]); };
  const exportFile = async (format: 'csv' | 'json') => {
    try {
      setError(''); const response = await communityFetch(`${apiBase}/accounting/reports/export.${format}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`${t.error}: ${response.status}`);
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `community-accounting.${format}`; link.click(); URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.error); }
  };
  return <section style={{ maxWidth: 1100, margin: 'auto', padding: 20, fontFamily: 'system-ui' }}>
    <h1>{t.title}</h1>{error && <p role="alert" style={{ color: '#a00' }}>{error}</p>}
    <button onClick={() => void refresh()}>{t.refresh}</button>{' '}
    {mayMatch&&<button onClick={() => void action('/accounting/proposals', {})}>{t.proposals}</button>}
    <section><h2>{t.matches}</h2><ul>{snapshot?.match_groups.map(group => <li key={group.match_group_id} data-match-id={group.match_group_id}>
      {group.match_group_id}: {valueLabel(group.status)} · {group.transaction_ids.join(', ')} → {group.document_ids.join(', ')} · {group.amount_total_minor} {group.currency_code} · {group.reason_codes.join(', ')}{' '}
      {mayMatch && group.status === 'proposed' && <><button onClick={() => void action(`/accounting/matches/${encodeURIComponent(group.match_group_id)}/status`, { revision: snapshot.revision, status: 'accepted', reason: evidence }, 'PATCH')}>{t.accept}</button>{' '}
        <button onClick={() => void action(`/accounting/matches/${encodeURIComponent(group.match_group_id)}/status`, { revision: snapshot.revision, status: 'rejected', reason: evidence }, 'PATCH')}>{t.reject}</button></>}
      {mayMatch && group.status === 'rejected' && <button onClick={() => void action(`/accounting/matches/${encodeURIComponent(group.match_group_id)}/status`, { revision: snapshot.revision, status: 'proposed', reason: evidence }, 'PATCH')}>{t.reopen}</button>}
      {mayMatch && ['accepted', 'confirmed', 'manual'].includes(group.status) && <button onClick={() => void action(`/accounting/matches/${encodeURIComponent(group.match_group_id)}`, { revision: snapshot.revision, reason: evidence }, 'DELETE')}>{t.undo}</button>}
    </li>)}</ul></section>
    {mayMatch&&<section><h2>{t.allocation}</h2>
      <label>{t.transaction} <select id="accounting-transactionId" value={transactionId} onChange={e => setTransactionId(e.target.value)}><option value="">—</option>{snapshot?.transactions.map(item => <option key={item.transaction_id} value={item.transaction_id}>{item.transaction_id} · {item.amount_minor} {item.currency_code}</option>)}</select></label>{' '}
      <label>{t.document} <select id="accounting-documentId" value={documentId} onChange={e => setDocumentId(e.target.value)}><option value="">—</option>{snapshot?.documents.map(item => <option key={item.document_id} value={item.document_id}>{item.document_id} · {item.total_amount_minor} {item.currency_code}</option>)}</select></label>{' '}
      <label>{t.kind} <select id="accounting-kind" value={kind} onChange={e => setKind(e.target.value)}>{['payment', 'refund', 'credit_note', 'fee', 'transfer'].map(item => <option key={item} value={item}>{valueLabel(item)}</option>)}</select></label><br />
      <label>{t.transactionAmount} <input id="accounting-amount" aria-label={t.transactionAmount} type="number" step="1" value={amount} onChange={e => setAmount(e.target.value)} /></label>{' '}
      <label>{t.documentAmount} <input id="accounting-documentAmount" aria-label={t.documentAmount} type="number" step="1" value={documentAmount} onChange={e => setDocumentAmount(e.target.value)} /></label>{' '}
      <label>{t.evidence} <input id="accounting-evidence" aria-label={t.evidence} value={evidence} onChange={e => setEvidence(e.target.value)} /></label><br />
      <details><summary>{t.conversion}</summary><label>{t.numerator} <input id="accounting-fx-numerator" type="number" value={fxNumerator} onChange={e => setFxNumerator(e.target.value)} /></label><label>{t.denominator} <input id="accounting-fx-denominator" type="number" value={fxDenominator} onChange={e => setFxDenominator(e.target.value)} /></label><label>{t.source} <input id="accounting-fx-source" value={fxSource} onChange={e => setFxSource(e.target.value)} /></label></details>
      <button onClick={() => setDraftLegs(items => [...items, currentLeg()])}>{t.addLeg}</button>{' '}
      <button onClick={submitAllocation}>{t.save} {t.allocation}</button>
      {draftLegs.length > 0 && <p>{draftLegs.length} {t.pendingLegs} <button onClick={() => setDraftLegs([])}>{t.clear}</button></p>}
      <ul>{snapshot?.allocations.filter(a => a.status === 'accepted').map(a => <li key={a.allocation_id} data-allocation-id={a.allocation_id}>{valueLabel(a.kind)}: {a.transaction_id} → {a.document_id ?? '—'} · {a.transaction_amount_minor} <button onClick={() => void action(`/accounting/allocations/${encodeURIComponent(a.allocation_id)}`, { revision: snapshot.revision }, 'DELETE')}>{t.undo}</button></li>)}</ul>
    </section>}
    {mayAnnotate&&<section><h2>{t.classification}</h2><label>{t.category} <select id="accounting-category" value={category} onChange={e => setCategory(e.target.value)}>{['income', 'expense', 'fee', 'refund', 'transfer', 'private', 'unclassified'].map(item => <option key={item} value={item}>{valueLabel(item)}</option>)}</select></label>{' '}
      <button onClick={() => void action('/accounting/classifications', { revision: snapshot?.revision, transaction_id: transactionId, category, evidence_ref: evidence })}>{t.save} {t.classification}</button>
      <h2>{t.disposition}</h2><label>{t.disposition} <select id="accounting-disposition" value={disposition} onChange={e => setDisposition(e.target.value)}>{['private', 'excluded', 'restore'].map(item => <option key={item} value={item}>{valueLabel(item)}</option>)}</select></label>{' '}
      <button onClick={() => void action('/accounting/dispositions', { revision: snapshot?.revision, transaction_id: transactionId, disposition, evidence_ref: evidence })}>{t.save} {t.disposition}</button>
      <h2>{t.exclusionRule}</h2><label>{t.field} <select id="accounting-exclusionField" value={exclusionField} onChange={e => setExclusionField(e.target.value)}>{['description_raw', 'counterparty_name', 'booking_reference', 'payment_reference'].map(item => <option key={item} value={item}>{valueLabel(item)}</option>)}</select></label>{' '}
      <label>{t.operator} <select id="accounting-exclusionOperator" value={exclusionOperator} onChange={e => setExclusionOperator(e.target.value)}>{['contains', 'equals', 'starts_with'].map(item => <option key={item} value={item}>{valueLabel(item)}</option>)}</select></label>{' '}
      <label>{t.value} <input id="accounting-exclusionValue" value={exclusionValue} onChange={e => setExclusionValue(e.target.value)} /></label>{' '}
      <button onClick={() => void action('/accounting/exclusions', { revision: snapshot?.revision, field: exclusionField, operator: exclusionOperator, value: exclusionValue })}>{t.save} {t.exclusionRule}</button>
    </section>}
    <section><h2>{t.rules}</h2>
      {!snapshot?.exclusion_rules?.length&&<p>{t.noRules}</p>}
      <ul>{snapshot?.exclusion_rules?.map(rule=><li key={rule.exclusion_id} data-exclusion-id={rule.exclusion_id}>
        {valueLabel(rule.field)} {valueLabel(rule.operator)} “{rule.value}”{rule.source_system?` · ${rule.source_system}`:''} · {rule.enabled?t.enabled:t.disabled}{' '}
        {mayAnnotate&&<button disabled={!rule.enabled&&!rule.can_enable} onClick={()=>void action(`/accounting/exclusions/${encodeURIComponent(rule.exclusion_id)}`,{revision:snapshot.revision,enabled:!rule.enabled},'PATCH')}>{rule.enabled?t.disable:t.enable}</button>}
        {!rule.ownership_known&&<p>{t.legacyRule}</p>}{!rule.can_enable&&<p>{t.unsupportedRule}</p>}
      </li>)}</ul>
    </section>
    {mayAnnotate&&<section><h2>{t.tax}</h2><label>{t.category} <select id="accounting-taxCategory" value={taxCategory} onChange={e => setTaxCategory(e.target.value)}>{['output', 'input', 'exempt', 'outside_scope', 'unclassified'].map(item => <option key={item} value={item}>{valueLabel(item)}</option>)}</select></label>{' '}
      <label>{t.vat} <input id="accounting-vat" type="number" value={vat} onChange={e => setVat(e.target.value)} /></label>{' '}
      <label>{t.rateNumerator} <input id="accounting-rateNumerator" type="number" value={rateNumerator} onChange={e => setRateNumerator(e.target.value)} /></label>{' '}
      <label>{t.rateDenominator} <input id="accounting-rateDenominator" type="number" value={rateDenominator} onChange={e => setRateDenominator(e.target.value)} /></label>{' '}
      <label>{t.eligible} <input id="accounting-eligible" type="checkbox" checked={eligible} onChange={e => setEligible(e.target.checked)} /></label>{' '}
      <button onClick={() => void action('/accounting/taxes', { revision: snapshot?.revision, document_id: documentId, tax_category: taxCategory, vat_minor: Number(vat), rate_numerator: Number(rateNumerator), rate_denominator: Number(rateDenominator), input_tax_eligible: eligible, evidence_ref: evidence })}>{t.save} {t.tax}</button>
    </section>}
    <section><h2>{t.report}</h2><label>{t.start} <input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>{' '}
      <label>{t.end} <input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label>{' '}
      <button onClick={() => void loadReport().catch(cause => setError(String(cause)))}>{t.load}</button>{' '}
      <button onClick={() => void exportFile('csv')}>{t.csv}</button>{' '}
      <button onClick={() => void exportFile('json')}>{t.json}</button>
      {report && <><h3>{t.totals}</h3>{Object.entries(report.totals_by_currency).map(([currency,totals])=><section key={currency} data-report-totals-currency={currency}><h4>{currency}</h4><dl>{Object.entries(totals).map(([category,total])=><React.Fragment key={category}><dt>{valueLabel(category)}</dt><dd data-report-total={category}>{total}</dd></React.Fragment>)}</dl></section>)}
        <h3>{t.vatShort} {t.totals}</h3>{Object.entries(report.vat_by_currency).map(([currency,totals])=><section key={currency} data-report-vat-currency={currency}><h4>{currency}</h4><dl><dt>{t.outputVat}</dt><dd>{totals.output_minor}</dd><dt>{t.inputVat}</dt><dd>{totals.eligible_input_minor}</dd><dt>{t.unclassifiedDocuments}</dt><dd>{totals.unclassified_documents}</dd></dl></section>)}
        {!report.rows.length && <p>{t.empty}</p>}
        <table><thead><tr><th>{t.transaction}</th><th>{t.category}</th><th>{t.currency}</th><th>{t.transactionAmount}</th><th>{t.balances}</th></tr></thead><tbody>{report.rows.map(row => <tr key={row.transaction_id} data-report-transaction={row.transaction_id}><td>{row.transaction_id}</td><td>{valueLabel(row.category)}</td><td>{row.currency_code}</td><td>{row.amount_minor}</td><td>{row.remaining_minor}</td></tr>)}</tbody></table>
        <table><thead><tr><th>{t.document}</th><th>{t.status}</th><th>{t.currency}</th><th>{t.documentAmount}</th><th>{t.balances}</th><th>{t.vat}</th></tr></thead><tbody>{report.documents.map(row => <tr key={row.document_id} data-report-document={row.document_id}><td>{row.document_id}</td><td>{valueLabel(row.reconciliation)}</td><td>{row.currency_code}</td><td>{row.total_amount_minor}</td><td>{row.remaining_minor}</td><td>{row.vat_minor}</td></tr>)}</tbody></table>
      </>}
    </section>
  </section>;
}
