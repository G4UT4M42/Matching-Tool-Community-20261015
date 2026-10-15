import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Table, Button, Select, colors, formatDateTime } from '../components/shared';

export function Exclusions() {
  const [rules, setRules] = useState<any[]>([]);
  const [field, setField] = useState('counterparty_name');
  const [operator, setOperator] = useState('contains');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState('');

  const load = () => api.getExclusions().then(setRules);
  useEffect(() => { load(); }, []);

  const addRule = async () => {
    if (!value.trim()) return;
    try {
      const result = await api.createExclusion(field, operator, value, description || undefined);
      setMessage(`Exclusion created: ${result.excluded_count} transactions excluded`);
      setValue('');
      setDescription('');
      load();
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    }
  };

  const deleteRule = async (id: string) => {
    if (!confirm('Remove this exclusion rule?')) return;
    await api.deleteExclusion(id);
    setMessage('Exclusion removed');
    load();
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Exclusion Rules</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
        Exclude transactions from matching. Excluded transactions won't appear in the review queue.
      </p>

      {message && (
        <div style={{
          padding: 12, marginBottom: 16, borderRadius: 6, fontSize: 13,
          background: message.startsWith('Error') ? '#fce4ec' : '#e8f5e9',
        }}>
          {message}
        </div>
      )}

      {/* Add new rule */}
      <Card title="Add Exclusion Rule" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Select value={field} onChange={setField} options={[
            { value: 'counterparty_name', label: 'Counterparty Name' },
            { value: 'description_raw', label: 'Description' },
            { value: 'source_system', label: 'Source System' },
          ]} />
          <Select value={operator} onChange={setOperator} options={[
            { value: 'contains', label: 'contains' },
            { value: 'equals', label: 'equals' },
            { value: 'starts_with', label: 'starts with' },
            { value: 'regex', label: 'regex' },
          ]} />
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Value..."
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, width: 200 }}
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, width: 200 }}
          />
          <Button onClick={addRule} color={colors.blue}>Add Rule</Button>
        </div>
      </Card>

      {/* Existing rules */}
      <Card title={`Active Rules (${rules.length})`}>
        {rules.length === 0 ? (
          <p style={{ color: '#999', fontSize: 13 }}>No exclusion rules defined.</p>
        ) : (
          <Table
            headers={['Field', 'Operator', 'Value', 'Description', 'Created', 'Actions']}
            rows={rules.map((r: any) => [
              <code>{r.field}</code>,
              r.operator,
              <code>{r.value}</code>,
              r.description ?? '-',
              formatDateTime(r.created_at),
              <button onClick={() => deleteRule(r.exclusion_id)} style={{
                padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', background: '#fff',
                cursor: 'pointer', fontSize: 11, color: colors.red,
              }}>Delete</button>,
            ])}
          />
        )}
      </Card>
    </div>
  );
}
