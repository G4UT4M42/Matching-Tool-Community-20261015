import { useLegacyText } from '../i18n/legacy';
import { legacyAccountingEnglish, accountingNoticeText, accountingEnumText, type AccountingNotice } from '../i18n/legacy-accounting';
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Table, Button, Select, colors, formatDateTime } from '../components/shared';

export function Exclusions() {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  const [rules, setRules] = useState<any[]>([]);
  const [field, setField] = useState('counterparty_name');
  const [operator, setOperator] = useState('contains');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState<AccountingNotice | null>(null);

  const load = () => api.getExclusions().then(setRules);
  useEffect(() => { load(); }, []);

  const addRule = async () => {
    if (!value.trim()) return;
    try {
      const result = await api.createExclusion(field, operator, value, description || undefined);
      setMessage({ key: "Ausschluss erstellt: {p0} Transaktionen ausgeschlossen", values: { p0: result.excluded_count } });
      setValue('');
      setDescription('');
      load();
    } catch (err: any) {
      setMessage({ key: "Fehler: {p0}", values: { p0: err.message }, error: true });
    }
  };

  const deleteRule = async (id: string) => {
    if (!confirm(text("Diese Ausschlussregel entfernen?"))) return;
    await api.deleteExclusion(id);
    setMessage({ key: "Ausschluss entfernt" });
    load();
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>{text("Ausschlussregeln")}</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
        {text("Transaktionen von der Zuordnung ausschließen. Ausgeschlossene Transaktionen erscheinen nicht in der Prüfliste.")}
      </p>

      {message && (
        <div style={{
          padding: 12, marginBottom: 16, borderRadius: 6, fontSize: 13,
          background: message.error ? '#fce4ec' : '#e8f5e9',
        }}>
          {accountingNoticeText(text, message)}
        </div>
      )}

      {/* Add new rule */}
      <Card title={text("Ausschlussregel hinzufügen")} style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Select accessibleName={text("Feld")} value={field} onChange={setField} options={[
            { value: 'counterparty_name', label: text("Name der Gegenpartei") },
            { value: 'description_raw', label: text("Beschreibung") },
            { value: 'source_system', label: text("Quellsystem") },
          ]} />
          <Select accessibleName={text("Operator")} value={operator} onChange={setOperator} options={[
            { value: 'contains', label: text("enthält") },
            { value: 'equals', label: text("ist gleich") },
            { value: 'starts_with', label: text("beginnt mit") },
            { value: 'regex', label: text("Regulärer Ausdruck") },
          ]} />
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={text("Wert...")}
            placeholder={text("Wert...")}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, width: 200 }}
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-label={text("Beschreibung (optional)")}
            placeholder={text("Beschreibung (optional)")}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, width: 200 }}
          />
          <Button onClick={addRule} color={colors.blue}>{text("Regel hinzufügen")}</Button>
        </div>
      </Card>

      {/* Existing rules */}
      <Card title={text("Aktive Regeln ({p0})", { p0: rules.length })}>
        {rules.length === 0 ? (
          <p style={{ color: '#999', fontSize: 13 }}>{text("Keine Ausschlussregeln definiert.")}</p>
        ) : (
          <Table
            headers={[text("Feld"), text("Operator"), text("Wert"), text("Beschreibung"), text("Erstellt"), text("Aktionen")]}
            rows={rules.map((r: any) => [
              <code>{accountingEnumText(text, r.field)}</code>,
              accountingEnumText(text, r.operator),
              <code>{r.value}</code>,
              r.description ?? '-',
              formatDateTime(r.created_at),
              <button onClick={() => deleteRule(r.exclusion_id)} style={{
                padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', background: '#fff',
                cursor: 'pointer', fontSize: 11, color: colors.red,
              }}>{text("Löschen")}</button>,
            ])}
          />
        )}
      </Card>
    </div>
  );
}
