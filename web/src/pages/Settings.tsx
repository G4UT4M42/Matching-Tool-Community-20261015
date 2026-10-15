import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Button, Badge, colors } from '../components/shared';

export function Settings() {
  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 20 }}>Einstellungen</h1>
      <VendorDirectory />
      <BackupSection />
      <TrashSection />
    </div>
  );
}

// ==================== VENDOR DIRECTORY ====================

function VendorDirectory() {
  const [vendors, setVendors] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editData, setEditData] = useState<{ name: string; country: string; address: string; vat_id: string; email: string; is_reverse_charge: boolean; tax_category_kz: string }>({ name: '', country: '', address: '', vat_id: '', email: '', is_reverse_charge: false, tax_category_kz: '' });
  const [saving, setSaving] = useState(false);

  const load = () => { api.getVendors().then(setVendors).catch(() => {}); };
  useEffect(() => { load(); }, []);

  const startEdit = (v: any) => {
    setEditKey(v.name);
    setEditData({ name: v.name ?? '', country: v.country ?? '', address: v.address ?? '', vat_id: v.vat_id ?? '', email: v.email ?? '', is_reverse_charge: !!v.is_reverse_charge, tax_category_kz: v.tax_category_kz ?? '' });
  };

  const saveEdit = async () => {
    if (!editKey) return;
    setSaving(true);
    try {
      await api.updateVendor(editKey, editData);
      setEditKey(null);
      load();
    } catch (e: any) { alert('Fehler beim Speichern: ' + (e.message || 'Unbekannter Fehler')); }
    finally { setSaving(false); }
  };

  const filtered = search
    ? vendors.filter(v =>
        v.name.toLowerCase().includes(search.toLowerCase()) ||
        (v.email ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (v.vat_id ?? '').toLowerCase().includes(search.toLowerCase())
      )
    : vendors;

  const cellInput: React.CSSProperties = {
    padding: '3px 6px', borderRadius: 3, border: '1px solid #bbb', fontSize: 12, width: '100%', boxSizing: 'border-box',
  };

  return (
    <Card style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Lieferanten ({vendors.length})</h2>
        <input
          type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Suche..."
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, width: 220 }}
        />
      </div>

      {filtered.length === 0 ? (
        <div style={{ color: '#999', fontSize: 13 }}>
          {vendors.length === 0 ? 'Keine Lieferanten aus Belegscans erkannt' : 'Keine Treffer'}
        </div>
      ) : (
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Name</th>
              <th style={th}>Land</th>
              <th style={th}>Adresse</th>
              <th style={th}>RC</th>
              <th style={th}>KZ</th>
              <th style={th}>USt-ID</th>
              <th style={th}>E-Mail</th>
              <th style={{ ...th, textAlign: 'right' }}>Belege</th>
              <th style={{ ...th, width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((v: any) => {
              const isEditing = editKey === v.name;
              return (
                <tr key={v.name} style={{ borderBottom: '1px solid #f0f0f0', background: isEditing ? '#fffde7' : v.has_override ? '#f0faf0' : 'transparent' }}>
                  {isEditing ? (<>
                    <td style={td}><input style={cellInput} value={editData.name} onChange={e => setEditData({ ...editData, name: e.target.value })} /></td>
                    <td style={td}><input style={{ ...cellInput, width: 40 }} value={editData.country} onChange={e => setEditData({ ...editData, country: e.target.value })} /></td>
                    <td style={td}><input style={cellInput} value={editData.address} onChange={e => setEditData({ ...editData, address: e.target.value })} /></td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <input type="checkbox" checked={editData.is_reverse_charge}
                        onChange={e => setEditData({ ...editData, is_reverse_charge: e.target.checked })}
                        title="Reverse Charge Vendor (nicht-EU Dienstleistungen)" />
                    </td>
                    <td style={td}>
                      <select style={{ ...cellInput, width: 60 }} value={editData.tax_category_kz}
                        onChange={e => setEditData({ ...editData, tax_category_kz: e.target.value })}>
                        <option value="">—</option>
                        <option value="9100">9100</option>
                        <option value="9110">9110</option>
                        <option value="9130">9130</option>
                        <option value="9180">9180</option>
                        <option value="9190">9190</option>
                        <option value="9225">9225</option>
                        <option value="9230">9230</option>
                        <option value="9275">9275</option>
                      </select>
                    </td>
                    <td style={td}><input style={cellInput} value={editData.vat_id} onChange={e => setEditData({ ...editData, vat_id: e.target.value })} /></td>
                    <td style={td}><input style={cellInput} value={editData.email} onChange={e => setEditData({ ...editData, email: e.target.value })} /></td>
                    <td style={{ ...td, textAlign: 'right' }}>{v.invoice_count}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 3 }}>
                        <button onClick={saveEdit} disabled={saving}
                          style={{ ...btnSmall, color: colors.green, borderColor: colors.green }}>OK</button>
                        <button onClick={() => setEditKey(null)}
                          style={{ ...btnSmall, color: '#888', borderColor: '#ccc' }}>X</button>
                      </div>
                    </td>
                  </>) : (<>
                    <td style={{ ...td, fontWeight: 500 }}>{v.name}</td>
                    <td style={td}>{v.country ?? '—'}</td>
                    <td style={td}>{v.address ?? '—'}</td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      {v.is_reverse_charge ? <Badge text="RC" color="#9b59b6" /> : <span style={{ color: '#ddd' }}>—</span>}
                    </td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>
                      {v.tax_category_kz ? <Badge text={v.tax_category_kz} color="#2c3e50" /> : <span style={{ color: '#ddd' }}>—</span>}
                    </td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>{v.vat_id ?? '—'}</td>
                    <td style={td}>
                      {v.email
                        ? <a href={`mailto:${v.email}`} style={{ color: colors.blue, textDecoration: 'none' }}>{v.email}</a>
                        : <span style={{ color: '#ccc' }}>—</span>
                      }
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{v.invoice_count}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 3 }}>
                        <button onClick={() => startEdit(v)}
                          style={{ ...btnSmall, color: '#666', borderColor: '#ccc' }}>Edit</button>
                        <button onClick={() => {
                          const to = v.email ?? '';
                          const subject = `Anfrage: Fehlende Rechnungen – ${v.name}`;
                          const body = `Sehr geehrte Damen und Herren,\n\nfür einige Buchungen konnten wir in unserer Ablage keine Rechnung zuordnen. Wir bitten Sie höflich, uns die entsprechenden Belege zukommen zu lassen.\n\nVielen Dank im Voraus.\n\nMit freundlichen Grüßen`;
                          api.composeEmail(to, subject, body);
                        }}
                          style={{ ...btnSmall, color: '#e67e22', borderColor: '#e67e22' }}
                          title="Rechnungen per E-Mail anfordern">Mail</button>
                      </div>
                    </td>
                  </>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div style={{ fontSize: 11, color: '#999', marginTop: 8 }}>
        Automatisch aus Belegscans aggregiert. Bei Konflikten wird der häufigste Wert verwendet. Manuell korrigierte Einträge sind grün hinterlegt.
      </div>
    </Card>
  );
}

// ==================== BACKUP ====================

function BackupSection() {
  const [backups, setBackups] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);

  const load = () => { api.getBackups().then(setBackups).catch(() => {}); };
  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    setCreating(true);
    setMessage(null);
    try {
      const res = await api.createBackup();
      setMessage({ text: `Backup erstellt: ${res.backup.name}`, color: colors.green });
      load();
    } catch (err: any) {
      setMessage({ text: err.message, color: colors.red });
    } finally { setCreating(false); }
  };


  return (
    <Card style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Backups</h2>
        <Button onClick={handleCreate} disabled={creating} color="#2c3e50">
          {creating ? '...' : 'Backup erstellen'}
        </Button>
      </div>

      {message && <div style={{ color: message.color, fontSize: 13, marginBottom: 12 }}>{message.text}</div>}

      {backups.length === 0 ? (
        <div style={{ color: '#999', fontSize: 13 }}>Keine Backups vorhanden</div>
      ) : (
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Name</th>
              <th style={th}>Erstellt</th>
              <th style={th}>Dateien</th>
              <th style={th}>Aktionen</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b: any) => (
              <tr key={b.name} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={td}><code style={{ fontSize: 11 }}>{b.name}</code></td>
                <td style={td}>{b.created_at}</td>
                <td style={td}>{fmtSize(b.size_bytes)}</td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 4 }}>
<span style={{ color: colors.gray, fontSize: 11 }} title="Wiederherstellung erfordert den sicheren Offline-Wartungsmodus.">Nur Offline-Wiederherstellung</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ fontSize: 11, color: '#999', marginTop: 8 }}>
        Neue Backups enthalten eine WAL-sichere SQLite-Kopie, state.json und Prüfsummen. Die Wiederherstellung und das Löschen im laufenden Betrieb sind aus Sicherheitsgründen deaktiviert. Der Offline-Migrations- und Wiederherstellungsprozess muss vor einem produktiven Restore separat geprüft werden.
      </div>
    </Card>
  );
}

// ==================== TRASH / PAPIERKORB ====================

function TrashSection() {
  const [items, setItems] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);

  const load = () => { api.getTrash(filter || undefined).then(setItems).catch(() => setItems([])); };
  useEffect(() => { load(); }, [filter]);

  const handleRestore = async (trashId: string) => {
    try {
      const res = await api.restoreTrash(trashId);
      setMessage({ text: `Wiederhergestellt: ${res.entity_id}`, color: colors.green });
      load();
    } catch (err: any) {
      setMessage({ text: err.message, color: colors.red });
    }
  };

  const handleDeletePermanent = async (trashId: string) => {
    if (!confirm('Endgültig löschen?')) return;
    try {
      await api.deleteTrashItem(trashId);
      load();
    } catch {}
  };

  const handleEmpty = async () => {
    if (!confirm('Papierkorb komplett leeren? Diese Aktion kann nicht rückgängig gemacht werden.')) return;
    try {
      const res = await api.emptyTrash(filter || undefined);
      setMessage({ text: `${res.deleted} Einträge gelöscht`, color: colors.orange });
      load();
    } catch (err: any) {
      setMessage({ text: err.message, color: colors.red });
    }
  };

  const TYPE_LABELS: Record<string, string> = {
    document: 'Dokument',
    invoice_scan: 'Beleg-Scan',
    match_group: 'Match-Gruppe',
  };

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Papierkorb ({items.length})</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {['', 'document', 'invoice_scan', 'match_group'].map(t => (
              <button key={t} onClick={() => setFilter(t)}
                style={{
                  ...btnSmall,
                  background: filter === t ? '#2c3e50' : '#ecf0f1',
                  color: filter === t ? '#fff' : '#333',
                  borderColor: filter === t ? '#2c3e50' : '#ddd',
                }}>
                {t ? TYPE_LABELS[t] ?? t : 'Alle'}
              </button>
            ))}
          </div>
          {items.length > 0 && (
            <Button onClick={handleEmpty} color={colors.red}>Papierkorb leeren</Button>
          )}
        </div>
      </div>

      {message && <div style={{ color: message.color, fontSize: 13, marginBottom: 8 }}>{message.text}</div>}

      {items.length === 0 ? (
        <div style={{ color: '#999', fontSize: 13 }}>Papierkorb ist leer</div>
      ) : (
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Typ</th>
              <th style={th}>Bezeichnung</th>
              <th style={th}>Gelöscht am</th>
              <th style={th}>Notiz</th>
              <th style={th}>Aktionen</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item: any) => (
              <tr key={item.trash_id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={td}>
                  <Badge text={TYPE_LABELS[item.entity_type] ?? item.entity_type}
                    color={item.entity_type === 'document' ? colors.blue : item.entity_type === 'invoice_scan' ? '#8e44ad' : colors.gray} />
                </td>
                <td style={td}>
                  <div>{describeTrashItem(item)}</div>
                  <code style={{ fontSize: 10, color: '#999' }}>{item.entity_id}</code>
                </td>
                <td style={td}>{fmtDateTime(item.deleted_at)}</td>
                <td style={td}>{item.note ?? '—'}</td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => handleRestore(item.trash_id)}
                      style={{ ...btnSmall, color: colors.green, borderColor: colors.green }}>
                      Wiederherstellen
                    </button>
                    <button onClick={() => handleDeletePermanent(item.trash_id)}
                      style={{ ...btnSmall, color: colors.red, borderColor: colors.red }}>
                      X
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function describeTrashItem(item: any): string {
  const d = item.entity_data;
  if (item.entity_type === 'document') {
    return `${d.supplier_name ?? 'Unbekannt'} — ${d.filename ?? d.source_document_ref ?? ''}`;
  }
  if (item.entity_type === 'invoice_scan') {
    return d.original_filename ?? d.scan_id;
  }
  if (item.entity_type === 'match_group') {
    return `${d.rule_id} (${d.transaction_ids?.length ?? 0} Txn, ${d.document_ids?.length ?? 0} Dok)`;
  }
  return item.entity_id;
}

// ==================== HELPERS ====================

const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #ddd', color: '#666', fontSize: 12 };
const td: React.CSSProperties = { padding: '6px 8px' };
const btnSmall: React.CSSProperties = {
  padding: '3px 8px', borderRadius: 4, border: '1px solid #ddd',
  cursor: 'pointer', fontSize: 11, fontWeight: 600, background: 'transparent',
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('de-DE');
  } catch {
    return iso;
  }
}
