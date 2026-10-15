import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Badge, colors } from '../components/shared';

type View = 'portals' | 'run-detail';

const STATUS_COLORS: Record<string, string> = {
  queued: colors.gray, running: colors.blue, waiting_for_login: colors.orange,
  downloading: colors.blue, importing: colors.blue,
  completed: colors.green, partial: colors.orange, failed: colors.red, cancelled: colors.gray,
};
const STATUS_LABELS: Record<string, string> = {
  queued: 'Warteschlange', running: 'Läuft', waiting_for_login: 'Login nötig',
  downloading: 'Download', importing: 'Import',
  completed: 'Fertig', partial: 'Teilweise', failed: 'Fehler', cancelled: 'Abgebrochen',
};

const IMPORT_COLORS: Record<string, string> = {
  pending: colors.gray, imported: colors.green, duplicate: colors.orange, failed: colors.red,
};

export function InvoiceBot() {
  const [view, setView] = useState<View>('portals');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  if (view === 'run-detail' && selectedRunId) {
    return <RunDetail runId={selectedRunId} onBack={() => { setView('portals'); setSelectedRunId(null); }} />;
  }
  return <PortalsAndRuns onViewRun={(id) => { setSelectedRunId(id); setView('run-detail'); }} />;
}

// ==================== PORTALS & RUNS ====================

function PortalsAndRuns({ onViewRun }: { onViewRun: (id: string) => void }) {
  const [portals, setPortals] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newPortal, setNewPortal] = useState({ name: '', baseUrl: '', portalType: 'browser_use', taskPrompt: '', requiresHumanLogin: false });
  const [runForm, setRunForm] = useState<{ portalId: string; start: string; end: string } | null>(null);
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);
  const [sessionStatus, setSessionStatus] = useState<Record<string, any>>({});
  const [checkingSession, setCheckingSession] = useState<string | null>(null);
  const [executorBusy, setExecutorBusy] = useState(false);
  const [editPortal, setEditPortal] = useState<any>(null);
  const [browserStatus, setBrowserStatus] = useState<any>(null);
  const [launching, setLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState<any>(null);

  const load = () => {
    api.botGetPortals().then(setPortals).catch(() => {});
    api.botGetRuns().then(r => setRuns(r.items ?? [])).catch(() => {});
    api.botGetExecutorStatus().then(s => setExecutorBusy(!!s.locked)).catch(() => {});
    api.botGetBrowserStatus().then(setBrowserStatus).catch(() => {});
  };
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const handleLaunchBrowser = async (portalId?: string) => {
    setLaunching(true);
    setLaunchResult(null);
    try {
      const result = await api.botLaunchProfile(portalId);
      setLaunchResult(result);
      setTimeout(() => api.botGetBrowserStatus().then(setBrowserStatus).catch(() => {}), 3000);
    } catch (err: any) {
      setLaunchResult({ status: 'launch_failed', message: err.message });
    } finally {
      setLaunching(false);
    }
  };

  const createPortal = async () => {
    if (!newPortal.name || !newPortal.baseUrl) return;
    try {
      await api.botCreatePortal(newPortal);
      setNewPortal({ name: '', baseUrl: '', portalType: 'browser_use', taskPrompt: '', requiresHumanLogin: false });
      setShowCreate(false);
      load();
    } catch (err: any) { setMessage({ text: err.message, color: colors.red }); }
  };

  const startRun = async () => {
    if (!runForm) return;
    try {
      const run = await api.botStartRun(runForm.portalId, runForm.start, runForm.end);
      setRunForm(null);
      setMessage({ text: 'Sammlung gestartet', color: colors.green });
      load();
      onViewRun(run.id);
    } catch (err: any) { setMessage({ text: err.message, color: colors.red }); }
  };

  const checkSession = async (portalId: string) => {
    setCheckingSession(portalId);
    try {
      const result = await api.botCheckSession(portalId);
      setSessionStatus(prev => ({ ...prev, [portalId]: result }));
    } catch (err: any) {
      setSessionStatus(prev => ({ ...prev, [portalId]: { message: err.message, browserReachable: false } }));
    } finally {
      setCheckingSession(null);
    }
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Invoice Bot</h1>
      {message && (
        <div style={{ color: message.color, marginBottom: 8, fontSize: 13, cursor: 'pointer' }}
          onClick={() => setMessage(null)}>
          {message.text}
        </div>
      )}

      {/* Browser control section */}
      <Card style={{
        marginBottom: 16,
        background: executorBusy ? '#fff3e0' : '#f8f9fa',
        border: executorBusy ? '1px solid #f39c12' : '1px solid #e0e0e0',
      }}>
        {executorBusy ? (
          <div style={{ fontSize: 12, color: '#e67e22', fontWeight: 600 }}>
            Browser wird gerade für eine Sammlung verwendet. Bitte nicht im Bot-Browser navigieren.
            Session-Prüfung und neue Sammlungen sind gesperrt.
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%', display: 'inline-block',
                  background: browserStatus?.running ? colors.green : '#ddd',
                }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {browserStatus?.running ? 'Bot-Browser läuft' : 'Bot-Browser nicht gestartet'}
                </span>
              </div>
              <button onClick={() => handleLaunchBrowser()} disabled={launching}
                style={{ ...btnStyle, fontSize: 12, padding: '4px 14px', background: colors.blue, color: '#fff', border: 'none' }}>
                {launching ? 'Wird gestartet...' : 'Bot-Browser starten'}
              </button>
            </div>

            {/* Launch result feedback */}
            {launchResult && (
              <div style={{
                fontSize: 12, padding: '4px 8px', borderRadius: 3, marginBottom: 6,
                background: launchResult.status === 'launched' || launchResult.status === 'already_running' ? '#e8f5e9' : '#fee',
                color: launchResult.status === 'launched' || launchResult.status === 'already_running' ? colors.green : colors.red,
              }}>
                {launchResult.message}
              </div>
            )}

            <div style={{ fontSize: 11, color: '#888', lineHeight: 1.6 }}>
              <b>Bot-Browser</b> = dediziertes Chrome-Profil für den Invoice Bot.{' '}
              Dort beim Portal einloggen und Zugangsdaten im Chrome-Passwortmanager speichern.{' '}
              Dies ist <b>kein</b> Session-Check — danach "Session prüfen" klicken.
              {browserStatus && !browserStatus.chromeFound && (
                <span style={{ color: colors.red, display: 'block', marginTop: 4 }}>
                  Chrome nicht gefunden. Pfad: {browserStatus.chromePath || '(nicht konfiguriert)'}
                </span>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* Portals */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Portale</h3>
          <button onClick={() => setShowCreate(!showCreate)} style={btnStyle}>
            {showCreate ? 'Abbrechen' : '+ Portal'}
          </button>
        </div>

        {showCreate && (
          <div style={{ marginBottom: 12, padding: 12, background: '#f8f9fa', borderRadius: 6 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input placeholder="Name (z.B. Lieferant X)" value={newPortal.name}
                onChange={e => setNewPortal({ ...newPortal, name: e.target.value })}
                style={inputStyle} />
              <input placeholder="URL (z.B. https://portal.example.com)" value={newPortal.baseUrl}
                onChange={e => setNewPortal({ ...newPortal, baseUrl: e.target.value })}
                style={{ ...inputStyle, flex: 2 }} />
              <select value={newPortal.portalType}
                onChange={e => setNewPortal({ ...newPortal, portalType: e.target.value })}
                style={inputStyle}>
                <option value="browser_use">Browser-Use (KI)</option>
                <option value="amazon">Amazon</option>
                <option value="generic">Generisch</option>
              </select>
            </div>
            {newPortal.portalType === 'browser_use' && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <textarea placeholder="Task-Prompt: z.B. 'Gehe zu Rechnungen, lade alle PDFs herunter'"
                  value={newPortal.taskPrompt}
                  onChange={e => setNewPortal({ ...newPortal, taskPrompt: e.target.value })}
                  style={{ ...inputStyle, flex: 1, minHeight: 40, resize: 'vertical' }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                  <input type="checkbox" checked={newPortal.requiresHumanLogin}
                    onChange={e => setNewPortal({ ...newPortal, requiresHumanLogin: e.target.checked })} />
                  Manueller Login nötig
                </label>
              </div>
            )}
            <button onClick={createPortal} style={{ ...btnStyle, background: colors.green, color: '#fff' }}>
              Erstellen
            </button>
          </div>
        )}

        {portals.length === 0 ? (
          <div style={{ color: '#999', fontSize: 13 }}>Keine Portale konfiguriert</div>
        ) : (
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>Typ</th>
                <th style={th}>Session</th>
                <th style={th}>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {portals.map(p => {
                const session = sessionStatus[p.id];
                return (
                  <tr key={p.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={td}>
                      <div>{p.name}</div>
                      <div style={{ fontSize: 10, color: '#999' }}>{p.baseUrl}</div>
                    </td>
                    <td style={td}><Badge text={p.adapterType === 'browser_use' ? 'Browser-Use' : p.portalType} color={p.adapterType === 'browser_use' ? '#8e24aa' : colors.blue} /></td>
                    <td style={td}>
                      {session ? (
                        <div>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            <SessionDot ok={session.browserReachable} label="Chrome" />
                            <SessionDot ok={session.portalReachable} label="Portal" />
                            <SessionDot ok={session.loggedIn} label="Login" />
                            <SessionDot ok={session.invoiceAreaAccessible} label="Rechnungen" />
                          </div>
                          <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>{session.message}</div>
                        </div>
                      ) : (
                        <span style={{ color: '#999', fontSize: 11 }}>Nicht geprüft</span>
                      )}
                    </td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button onClick={() => checkSession(p.id)}
                          disabled={checkingSession === p.id || executorBusy}
                          title={executorBusy ? 'Browser wird gerade verwendet' : 'Session-Status prüfen'}
                          style={{ ...btnStyle, fontSize: 11, padding: '2px 8px' }}>
                          {checkingSession === p.id ? '...' : 'Session'}
                        </button>
                        <button onClick={() => setRunForm({ portalId: p.id, start: '', end: '' })}
                          disabled={executorBusy}
                          title="Rechnungssammlung starten"
                          style={{
                            ...btnStyle, fontSize: 11, padding: '2px 8px',
                            background: !executorBusy ? colors.green : '#eee',
                            color: !executorBusy ? '#fff' : '#999',
                          }}>
                          Start
                        </button>
                        <button onClick={() => setEditPortal({ ...p })}
                          style={{ ...btnStyle, fontSize: 11, padding: '2px 8px', color: colors.orange, borderColor: colors.orange }}>
                          Edit
                        </button>
                        <button onClick={async () => {
                          if (!confirm(`Portal "${p.name}" und alle zugehörigen Runs wirklich löschen?`)) return;
                          try {
                            await api.botDeletePortal(p.id);
                            load();
                          } catch (err: any) { setMessage({ text: err.message, color: colors.red }); }
                        }}
                          style={{ ...btnStyle, fontSize: 11, padding: '2px 8px', color: colors.red, borderColor: colors.red }}>
                          X
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* Edit Portal Dialog */}
      {editPortal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }} onClick={() => setEditPortal(null)}>
          <div style={{
            background: '#fff', borderRadius: 12, padding: 24, maxWidth: 540, width: '90%',
            boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>Portal bearbeiten</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={{ fontSize: 12, fontWeight: 600 }}>Name
                <input value={editPortal.name} onChange={e => setEditPortal({ ...editPortal, name: e.target.value })}
                  style={{ ...inputStyle, width: '100%', display: 'block', marginTop: 4 }} />
              </label>
              <label style={{ fontSize: 12, fontWeight: 600 }}>URL
                <input value={editPortal.baseUrl} onChange={e => setEditPortal({ ...editPortal, baseUrl: e.target.value })}
                  style={{ ...inputStyle, width: '100%', display: 'block', marginTop: 4 }} />
              </label>
              <label style={{ fontSize: 12, fontWeight: 600 }}>Task-Prompt
                <textarea value={editPortal.taskPrompt ?? ''} onChange={e => setEditPortal({ ...editPortal, taskPrompt: e.target.value })}
                  style={{ ...inputStyle, width: '100%', display: 'block', marginTop: 4, minHeight: 60, resize: 'vertical' }} />
              </label>
              <div style={{ display: 'flex', gap: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>Adapter
                  <select value={editPortal.adapterType ?? 'amazon'}
                    onChange={e => setEditPortal({ ...editPortal, adapterType: e.target.value, portalType: e.target.value })}
                    style={{ ...inputStyle, width: '100%', display: 'block', marginTop: 4 }}>
                    <option value="browser_use">Browser-Use (KI)</option>
                    <option value="amazon">Amazon</option>
                    <option value="manual">Manuell</option>
                  </select>
                </label>
                <label style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>Login
                  <select value={editPortal.loginStrategy ?? 'existing_session'}
                    onChange={e => setEditPortal({ ...editPortal, loginStrategy: e.target.value })}
                    style={{ ...inputStyle, width: '100%', display: 'block', marginTop: 4 }}>
                    <option value="existing_session">Bestehende Session</option>
                    <option value="manual">Manuell</option>
                    <option value="credentials">Credentials</option>
                  </select>
                </label>
                <label style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>Review
                  <select value={editPortal.reviewPolicy ?? 'review_if_uncertain'}
                    onChange={e => setEditPortal({ ...editPortal, reviewPolicy: e.target.value })}
                    style={{ ...inputStyle, width: '100%', display: 'block', marginTop: 4 }}>
                    <option value="auto_import">Auto-Import</option>
                    <option value="review_if_uncertain">Review wenn unsicher</option>
                    <option value="always_review">Immer Review</option>
                  </select>
                </label>
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!editPortal.requiresHumanLogin}
                    onChange={e => setEditPortal({ ...editPortal, requiresHumanLogin: e.target.checked })} />
                  Manueller Login nötig
                </label>
                <label style={{ fontSize: 12, fontWeight: 600 }}>Max. Kosten/Run (USD)
                  <input type="number" step="0.5" value={editPortal.maxCostPerRun ?? ''}
                    onChange={e => setEditPortal({ ...editPortal, maxCostPerRun: e.target.value ? parseFloat(e.target.value) : null })}
                    style={{ ...inputStyle, width: 80, marginLeft: 6 }} />
                </label>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditPortal(null)}
                style={{ ...btnStyle, padding: '8px 16px' }}>Abbrechen</button>
              <button onClick={async () => {
                try {
                  await api.botUpdatePortal(editPortal.id, editPortal);
                  setEditPortal(null);
                  load();
                } catch (err: any) { setMessage({ text: err.message, color: colors.red }); }
              }}
                style={{ ...btnStyle, padding: '8px 16px', background: colors.green, color: '#fff' }}>Speichern</button>
            </div>
          </div>
        </div>
      )}

      {/* Cost Monitor + AI Settings */}
      <CostMonitor />
      <BotAiSettings />

      {/* Run creation form */}
      {runForm && (
        <Card style={{ marginBottom: 16, background: '#f0f7ff', border: '1px solid #b3d4fc' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Rechnungssammlung starten</h3>

          {/* Quick date range presets */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {datePresets.map(p => (
              <button key={p.label} onClick={() => setRunForm({ ...runForm, start: p.start, end: p.end })}
                style={{
                  ...btnStyle, fontSize: 11, padding: '3px 10px',
                  background: runForm.start === p.start && runForm.end === p.end ? '#2980b9' : '#ecf0f1',
                  color: runForm.start === p.start && runForm.end === p.end ? '#fff' : '#333',
                }}>
                {p.label}
              </button>
            ))}
          </div>

          {/* Manual date range */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ fontSize: 12 }}>Von:</label>
            <input type="date" value={runForm.start}
              onChange={e => setRunForm({ ...runForm, start: e.target.value })} style={inputStyle} />
            <label style={{ fontSize: 12 }}>Bis:</label>
            <input type="date" value={runForm.end}
              onChange={e => setRunForm({ ...runForm, end: e.target.value })} style={inputStyle} />
            <button onClick={startRun}
              disabled={!runForm.start || !runForm.end}
              style={{ ...btnStyle, background: colors.green, color: '#fff' }}>
              Starten
            </button>
            <button onClick={() => setRunForm(null)} style={btnStyle}>Abbrechen</button>
          </div>
        </Card>
      )}

      {/* Recent Runs */}
      <Card>
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Letzte Sammlungen</h3>
        {runs.length === 0 ? (
          <div style={{ color: '#999', fontSize: 13 }}>Keine Sammlungen</div>
        ) : (
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Portal</th>
                <th style={th}>Zeitraum</th>
                <th style={th}>Status</th>
                <th style={th}>Dateien</th>
                <th style={th}>Erstellt</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {runs.map(r => {
                const portal = portals.find(p => p.id === r.portalId);
                const s = r.stats ?? {};
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }}
                    onClick={() => onViewRun(r.id)}>
                    <td style={td}>{portal?.name ?? '?'}</td>
                    <td style={{ ...td, fontSize: 11 }}>{fmtDate(r.requestedStart)} — {fmtDate(r.requestedEnd)}</td>
                    <td style={td}>
                      <Badge text={STATUS_LABELS[r.status] ?? r.status}
                        color={STATUS_COLORS[r.status] ?? colors.gray} />
                    </td>
                    <td style={{ ...td, fontSize: 11 }}>
                      {s.found > 0 && <span>{s.downloaded}/{s.found} </span>}
                      {s.imported > 0 && <span style={{ color: colors.green }}>({s.imported} imp.) </span>}
                      {s.failed > 0 && <span style={{ color: colors.red }}>({s.failed} err)</span>}
                    </td>
                    <td style={{ ...td, fontSize: 11, color: '#888' }}>{fmtDateTime(r.createdAt)}</td>
                    <td style={td} onClick={e => e.stopPropagation()}>
                      {(r.status === 'failed' || r.status === 'waiting_for_login') && (
                        <button onClick={async () => { await api.botRetryRun(r.id); load(); }}
                          style={{ ...btnStyle, fontSize: 10, padding: '1px 6px' }}>Retry</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ==================== RUN DETAIL ====================

function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [run, setRun] = useState<any>(null);
  const [files, setFiles] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);

  const load = () => {
    api.botGetRun(runId).then(setRun).catch(() => {});
    api.botGetRunFiles(runId).then(setFiles).catch(() => {});
    api.botGetRunEvents(runId).then(setEvents).catch(() => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [runId]);

  if (!run) return <div>Laden...</div>;

  const isTerminal = ['completed', 'partial', 'failed', 'cancelled'].includes(run.status);

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <button onClick={onBack} style={btnStyle}>Zurück</button>
        <h1 style={{ fontSize: 18, margin: 0 }}>Sammlung</h1>
        <Badge text={STATUS_LABELS[run.status] ?? run.status}
          color={STATUS_COLORS[run.status] ?? colors.gray} />
        {run.isActive && <span style={{ fontSize: 11, color: colors.blue }}>wird ausgeführt...</span>}
      </div>

      {run.errorMessage && (
        <div style={{ background: '#fee', border: '1px solid #e74c3c', borderRadius: 4,
          padding: 8, marginBottom: 12, fontSize: 13, color: colors.red }}>
          {run.errorMessage}
        </div>
      )}

      {/* Zero-result message (not an error) */}
      {run.status === 'completed' && run.stats?.found === 0 && (
        <div style={{ background: '#f0f7ff', border: '1px solid #b3d4fc', borderRadius: 4,
          padding: 8, marginBottom: 12, fontSize: 13, color: colors.blue }}>
          Keine Rechnungen im gewählten Zeitraum gefunden. Das ist kein Fehler — es gibt einfach keine passenden Belege.
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <StatBox label="Gefunden" value={run.stats?.found ?? 0} />
        <StatBox label="Download" value={run.stats?.downloaded ?? 0} />
        <StatBox label="Importiert" value={run.stats?.imported ?? 0} color={colors.green} />
        <StatBox label="Duplikate" value={run.stats?.duplicates ?? 0} color={colors.orange} />
        <StatBox label="Fehler" value={run.stats?.failed ?? 0}
          color={run.stats?.failed > 0 ? colors.red : undefined} />
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(run.status === 'failed' || run.status === 'waiting_for_login') && (
          <button onClick={async () => { await api.botRetryRun(runId); load(); }}
            style={{ ...btnStyle, background: colors.blue, color: '#fff' }}>Erneut versuchen</button>
        )}
        {!isTerminal && (
          <button onClick={async () => { await api.botCancelRun(runId); load(); }}
            style={{ ...btnStyle, background: colors.red, color: '#fff' }}>Abbrechen</button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* Files */}
        <Card style={{ flex: 1 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Dateien ({files.length})</h3>
          {files.length === 0 ? (
            <div style={{ color: '#999', fontSize: 13 }}>Keine Dateien</div>
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Datei</th>
                  <th style={th}>Datum</th>
                  <th style={th}>Import</th>
                  <th style={th}>ID</th>
                </tr>
              </thead>
              <tbody>
                {files.map(f => (
                  <tr key={f.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ ...td, maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={f.originalFilename}>
                      <a href={`/api/invoice-bot/files/${f.id}/open`} target="_blank" rel="noreferrer"
                        style={{ color: colors.blue, textDecoration: 'none', borderBottom: '1px dashed #2980b9' }}>
                        {f.originalFilename}
                      </a>
                    </td>
                    <td style={td}>{f.invoiceDate ?? '—'}</td>
                    <td style={td}>
                      <Badge text={f.importStatus}
                        color={IMPORT_COLORS[f.importStatus] ?? colors.gray} />
                    </td>
                    <td style={{ ...td, fontSize: 10, fontFamily: 'monospace', color: '#888' }}>
                      {f.documentId ? f.documentId.slice(0, 16) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* Events */}
        <Card style={{ flex: 1, maxHeight: 400, overflow: 'auto' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Log ({events.length})</h3>
          {events.length === 0 ? (
            <div style={{ color: '#999', fontSize: 13 }}>Keine Ereignisse</div>
          ) : (
            events.map(e => (
              <div key={e.id} style={{
                padding: '3px 8px', borderBottom: '1px solid #f5f5f5', fontSize: 11,
                borderLeft: `3px solid ${e.level === 'error' ? colors.red : e.level === 'warn' ? colors.orange : '#ddd'}`,
              }}>
                <span style={{ color: '#aaa', marginRight: 6, fontSize: 9 }}>
                  {e.createdAt?.slice(11, 19)}
                </span>
                <span style={{ fontWeight: e.level === 'error' ? 700 : 400 }}>
                  {e.message}
                </span>
              </div>
            ))
          )}
        </Card>
      </div>
    </div>
  );
}

// ==================== COMPONENTS ====================

// ==================== COST MONITOR ====================

function CostMonitor() {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(true);
  const [limitInput, setLimitInput] = useState('');
  const [editingLimit, setEditingLimit] = useState(false);

  const loadSnapshot = () => { api.botGetCostSnapshot().then(setSnapshot).catch(() => {}); };
  const loadHistory = () => { api.botGetCostHistory(20).then(setHistory).catch(() => {}); };
  useEffect(() => {
    loadSnapshot(); loadHistory();
    const t = setInterval(() => { loadSnapshot(); if (showHistory) loadHistory(); }, 3000);
    return () => clearInterval(t);
  }, []);

  const saveLimit = async () => {
    const val = parseFloat(limitInput.replace(',', '.'));
    await api.botSetCostLimit(isNaN(val) || val <= 0 ? null : val);
    setEditingLimit(false);
    loadSnapshot();
  };

  const handleContinue = async () => {
    await api.botApproveContinuation();
    loadSnapshot();
  };

  if (!snapshot) return null;

  const s = snapshot.session;
  const hasSession = !!s;
  const pct = snapshot.limitUsd && s ? Math.min((s.totalCostUsd / snapshot.limitUsd) * 100, 100) : 0;

  return (
    <Card style={{
      marginBottom: 16,
      background: snapshot.paused ? '#fff3e0' : '#f8f9fa',
      border: snapshot.paused ? '2px solid #e74c3c' : '1px solid #e0e0e0',
    }}>
      {/* Paused banner */}
      {snapshot.paused && (
        <div style={{ background: '#fee', borderRadius: 4, padding: 8, marginBottom: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ color: colors.red, fontWeight: 700, fontSize: 13 }}>
            Kostenlimit erreicht (${snapshot.limitUsd?.toFixed(2)})
          </span>
          <button onClick={handleContinue}
            style={{ ...btnStyle, background: colors.green, color: '#fff', fontSize: 12 }}>
            Weiter arbeiten
          </button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>KI-Kosten</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Today's total */}
          <span style={{ fontSize: 12, color: '#666', fontFamily: 'monospace' }}>
            Heute: ${fmtCost(snapshot.todayTotalUsd)} ({snapshot.todayTotalTokens.toLocaleString('de-DE')} Tok)
          </span>
          <button onClick={() => { setShowHistory(!showHistory); if (!showHistory) loadHistory(); }}
            style={{ ...btnStyle, fontSize: 10, padding: '2px 6px' }}>
            {showHistory ? 'Schliessen' : 'Verlauf'}
          </button>
        </div>
      </div>

      {/* Live session */}
      {hasSession && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 16, fontSize: 12, alignItems: 'center' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.status === 'active' ? colors.green : s.status === 'limit_reached' ? colors.red : colors.gray, display: 'inline-block' }} />
              Session
            </span>
            <span style={{ fontFamily: 'monospace' }}>{s.callCount} Aufrufe</span>
            <span style={{ fontFamily: 'monospace' }}>{s.totalTokens.toLocaleString('de-DE')} Tokens</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>${fmtCost(s.totalCostUsd)}</span>
          </div>

          {/* Cost limit bar */}
          {snapshot.limitUsd != null && (
            <div style={{ marginTop: 6 }}>
              <div style={{ width: '100%', height: 6, background: '#e0e0e0', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  width: `${pct}%`, height: '100%', borderRadius: 3,
                  background: pct >= 100 ? colors.red : pct >= 80 ? colors.orange : colors.green,
                  transition: 'width 0.3s',
                }} />
              </div>
              <div style={{ fontSize: 10, color: '#999', marginTop: 2 }}>
                ${fmtCost(s.totalCostUsd)} / ${snapshot.limitUsd.toFixed(2)} ({pct.toFixed(0)}%)
              </div>
            </div>
          )}
        </div>
      )}

      {/* Limit setting */}
      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
        <span style={{ color: '#666' }}>Limit:</span>
        {editingLimit ? (
          <>
            <input value={limitInput} onChange={e => setLimitInput(e.target.value)}
              placeholder="z.B. 0.50" style={{ width: 70, padding: '2px 6px', borderRadius: 3, border: '1px solid #ddd', fontSize: 12 }} />
            <span style={{ color: '#999' }}>USD</span>
            <button onClick={saveLimit} style={{ ...btnStyle, fontSize: 10, padding: '1px 6px' }}>OK</button>
            <button onClick={() => setEditingLimit(false)} style={{ ...btnStyle, fontSize: 10, padding: '1px 6px' }}>X</button>
          </>
        ) : (
          <>
            <span style={{ fontFamily: 'monospace' }}>
              {snapshot.limitUsd != null ? `$${snapshot.limitUsd.toFixed(2)}` : 'Kein Limit'}
            </span>
            <button onClick={() => { setLimitInput(snapshot.limitUsd?.toString() ?? ''); setEditingLimit(true); }}
              style={{ ...btnStyle, fontSize: 10, padding: '1px 6px' }}>Ändern</button>
            {snapshot.limitUsd != null && (
              <button onClick={async () => { await api.botSetCostLimit(null); loadSnapshot(); }}
                style={{ ...btnStyle, fontSize: 10, padding: '1px 6px', color: colors.red }}>Entfernen</button>
            )}
          </>
        )}
      </div>

      {/* History */}
      {showHistory && (
        <CostHistory history={history} onRefresh={loadHistory} />
      )}
    </Card>
  );
}

// ==================== COST HISTORY ====================

const STATUS_LABELS_COST: Record<string, string> = {
  active: 'Aktiv', completed: 'Beendet', limit_reached: 'Limit', continued: 'Fortgesetzt',
};

function CostHistory({ history, onRefresh }: { history: any[]; onRefresh: () => void }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<any[]>([]);

  const toggleExpand = async (sessionId: string) => {
    if (expandedId === sessionId) {
      setExpandedId(null);
      return;
    }
    try {
      const data = await api.botGetSessionEntries(sessionId);
      setEntries(data);
      setExpandedId(sessionId);
    } catch { setEntries([]); }
  };

  // Aggregate totals across all history
  const totalCost = history.reduce((s, h) => s + (h.totalCostUsd ?? 0), 0);
  const totalTokens = history.reduce((s, h) => s + (h.totalTokens ?? 0), 0);
  const totalCalls = history.reduce((s, h) => s + (h.callCount ?? 0), 0);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#444' }}>Kostenverlauf</div>
        <button onClick={onRefresh} style={{ ...btnStyle, fontSize: 10, padding: '1px 6px' }}>Aktualisieren</button>
      </div>

      {/* Totals bar */}
      {history.length > 0 && (
        <div style={{ display: 'flex', gap: 16, fontSize: 11, padding: '6px 8px', background: '#f0f0f0', borderRadius: 4, marginBottom: 6 }}>
          <span><b>{history.length}</b> Sessions</span>
          <span><b>{totalCalls}</b> Aufrufe</span>
          <span style={{ fontFamily: 'monospace' }}><b>{totalTokens.toLocaleString('de-DE')}</b> Tokens</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>Gesamt: ${fmtCost(totalCost)}</span>
        </div>
      )}

      {history.length === 0 ? (
        <div style={{ fontSize: 11, color: '#999' }}>Keine Sessions vorhanden</div>
      ) : (
        <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 20 }}></th>
              <th style={th}>Start</th>
              <th style={th}>Ende</th>
              <th style={th}>Aufrufe</th>
              <th style={{ ...th, textAlign: 'right' }}>Prompt</th>
              <th style={{ ...th, textAlign: 'right' }}>Completion</th>
              <th style={{ ...th, textAlign: 'right' }}>Tokens</th>
              <th style={{ ...th, textAlign: 'right' }}>Kosten</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {history.map(h => (
              <React.Fragment key={h.id}>
                <tr style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer', background: expandedId === h.id ? '#f0f7ff' : 'transparent' }}
                  onClick={() => toggleExpand(h.id)}>
                  <td style={td}>{expandedId === h.id ? 'v' : '>'}</td>
                  <td style={td}>{h.startedAt?.slice(0, 16).replace('T', ' ')}</td>
                  <td style={td}>{h.endedAt ? h.endedAt.slice(11, 19) : '—'}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{h.callCount}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{(h.promptTokens ?? 0).toLocaleString('de-DE')}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{(h.completionTokens ?? 0).toLocaleString('de-DE')}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{h.totalTokens.toLocaleString('de-DE')}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>${fmtCost(h.totalCostUsd)}</td>
                  <td style={td}>
                    <span style={{
                      fontSize: 9, padding: '1px 4px', borderRadius: 3,
                      background: h.status === 'active' ? '#e8f5e9' : h.status === 'limit_reached' ? '#fee' : '#f0f0f0',
                      color: h.status === 'active' ? colors.green : h.status === 'limit_reached' ? colors.red : '#666',
                    }}>
                      {STATUS_LABELS_COST[h.status] ?? h.status}
                    </span>
                  </td>
                </tr>
                {/* Expanded: per-call entries */}
                {expandedId === h.id && (
                  <tr>
                    <td colSpan={9} style={{ padding: 0 }}>
                      <div style={{ background: '#fafafa', padding: '6px 12px 6px 28px', borderBottom: '2px solid #ddd' }}>
                        {entries.length === 0 ? (
                          <div style={{ fontSize: 10, color: '#999' }}>Keine Einträge</div>
                        ) : (
                          <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                <th style={{ ...th, fontSize: 9 }}>Zeit</th>
                                <th style={{ ...th, fontSize: 9 }}>Modell</th>
                                <th style={{ ...th, fontSize: 9 }}>Quelle</th>
                                <th style={{ ...th, fontSize: 9, textAlign: 'right' }}>Prompt</th>
                                <th style={{ ...th, fontSize: 9, textAlign: 'right' }}>Completion</th>
                                <th style={{ ...th, fontSize: 9, textAlign: 'right' }}>Tokens</th>
                                <th style={{ ...th, fontSize: 9, textAlign: 'right' }}>Kosten</th>
                              </tr>
                            </thead>
                            <tbody>
                              {entries.map((e, i) => (
                                <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
                                  <td style={td}>{e.createdAt?.slice(11, 19)}</td>
                                  <td style={{ ...td, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                    title={e.model}>{e.model?.split('/')[1] ?? e.model}</td>
                                  <td style={td}>{e.source}</td>
                                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{e.promptTokens?.toLocaleString('de-DE')}</td>
                                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{e.completionTokens?.toLocaleString('de-DE')}</td>
                                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{e.totalTokens?.toLocaleString('de-DE')}</td>
                                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>${fmtCost(e.costUsd ?? 0)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function fmtCost(usd: number): string {
  if (usd === 0) return '0.00';
  if (usd < 0.001) return usd.toFixed(6);
  if (usd < 0.01) return usd.toFixed(4);
  return usd.toFixed(2);
}

// ==================== BOT AI SETTINGS ====================

function BotAiSettings() {
  const [config, setConfig] = useState<any>(null);
  const [expanded, setExpanded] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState({ simple: '', standard: '', advanced: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; color: string } | null>(null);

  const loadConfig = () => {
    api.botGetAiConfig().then(c => {
      setConfig(c);
      setModels({ simple: c.models.simple, standard: c.models.standard, advanced: c.models.advanced });
    }).catch(() => {});
  };
  useEffect(() => { loadConfig(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.botSaveAiConfig({
        api_key: apiKey || undefined,
        simple: models.simple || undefined,
        standard: models.standard || undefined,
        advanced: models.advanced || undefined,
      });
      if (apiKey) setApiKey('');
      loadConfig();
      setMsg({ text: 'Gespeichert', color: colors.green });
    } catch (err: any) { setMsg({ text: err.message, color: colors.red }); }
    finally { setSaving(false); }
  };

  const deleteKey = async () => {
    await api.botDeleteAiKey();
    loadConfig();
    setMsg({ text: 'Bot-API-Key entfernt (Fallback auf Belegerkennung-Key)', color: colors.orange });
  };

  if (!config) return null;

  return (
    <Card style={{ marginBottom: 16, background: '#f8f9fa' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>
          KI-Modelle
          {config.enabled ? (
            <span style={{ fontSize: 11, color: colors.green, marginLeft: 8, fontWeight: 400 }}>
              {config.dedicatedKey ? 'Eigener Key' : 'Belegerkennung-Key'}
            </span>
          ) : (
            <span style={{ fontSize: 11, color: '#999', marginLeft: 8, fontWeight: 400 }}>Nicht konfiguriert</span>
          )}
        </h3>
        <button onClick={() => setExpanded(!expanded)}
          style={{ ...btnStyle, fontSize: 11, padding: '2px 8px', background: expanded ? '#2c3e50' : '#ecf0f1', color: expanded ? '#fff' : '#333' }}>
          {expanded ? 'Schliessen' : 'Einstellungen'}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {msg && <div style={{ fontSize: 12, color: msg.color }}>{msg.text}</div>}

          {/* API Key */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={aiLbl}>API-Key:</label>
            {config.maskedKey && !apiKey && (
              <span style={{ fontSize: 11, color: '#666' }}>
                {config.maskedKey}
                {config.dedicatedKey && (
                  <button onClick={deleteKey}
                    style={{ marginLeft: 6, fontSize: 10, color: colors.red, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                    entfernen
                  </button>
                )}
              </span>
            )}
            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
              placeholder={config.maskedKey ? 'Neuen Key eingeben' : 'sk-or-v1-...'}
              style={{ flex: 1, padding: '3px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 12 }} />
          </div>

          {/* Model tiers */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={aiLbl} title="Schnell + günstig: Klassifikation, OCR-Qualitäts-Check, Ja/Nein-Entscheidungen">
              Einfach:
            </label>
            <input value={models.simple} onChange={e => setModels({ ...models, simple: e.target.value })}
              placeholder="google/gemini-2.0-flash-001"
              style={{ flex: 1, padding: '3px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 12 }} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={aiLbl} title="Ausgewogen: Rechnungserkennung, Feld-Extraktion, normale Aufgaben">
              Standard:
            </label>
            <input value={models.standard} onChange={e => setModels({ ...models, standard: e.target.value })}
              placeholder="anthropic/claude-sonnet-4"
              style={{ flex: 1, padding: '3px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 12 }} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={aiLbl} title="Leistungsstark: Supervision, komplexe Layouts, wenn Standard versagt">
              Erweitert:
            </label>
            <input value={models.advanced} onChange={e => setModels({ ...models, advanced: e.target.value })}
              placeholder="anthropic/claude-opus-4"
              style={{ flex: 1, padding: '3px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 12 }} />
          </div>

          <button onClick={save} disabled={saving}
            style={{ ...btnStyle, alignSelf: 'flex-start', background: '#2c3e50', color: '#fff' }}>
            {saving ? '...' : 'Speichern'}
          </button>

          <div style={{ fontSize: 10, color: '#999', lineHeight: 1.5 }}>
            <b>Einfach</b> = schnell + günstig für Klassifikation und einfache Prüfungen.{' '}
            <b>Standard</b> = ausgewogen für reguläre Rechnungserkennung.{' '}
            <b>Erweitert</b> = leistungsstark für komplexe Fälle und wenn Standard versagt.{' '}
            Eigener API-Key ist optional — ohne wird der Belegerkennung-Key verwendet.
          </div>
        </div>
      )}
    </Card>
  );
}

const aiLbl: React.CSSProperties = { width: 70, fontSize: 12, fontWeight: 600, flexShrink: 0 };

function SessionDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
        background: ok ? colors.green : '#ddd',
      }} />
      {label}
    </span>
  );
}

function StatBox({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ background: '#f8f9fa', borderRadius: 6, padding: '8px 16px', textAlign: 'center', minWidth: 70 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: color ?? '#2c3e50' }}>{value}</div>
      <div style={{ fontSize: 10, color: '#888' }}>{label}</div>
    </div>
  );
}

// ==================== HELPERS ====================

// Date range presets for run creation
function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }

const datePresets = (() => {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  const startOfMonth = new Date(y, m, 1);
  const lastMonth = new Date(y, m - 1, 1);
  const endOfLastMonth = new Date(y, m, 0);
  const threeMonthsAgo = new Date(y, m - 3, 1);
  const sixMonthsAgo = new Date(y, m - 6, 1);
  const startOfYear = new Date(y, 0, 1);
  const lastYearStart = new Date(y - 1, 0, 1);
  const lastYearEnd = new Date(y - 1, 11, 31);

  return [
    { label: 'Dieser Monat', start: isoDate(startOfMonth), end: isoDate(now) },
    { label: 'Letzter Monat', start: isoDate(lastMonth), end: isoDate(endOfLastMonth) },
    { label: 'Letzte 3 Monate', start: isoDate(threeMonthsAgo), end: isoDate(now) },
    { label: 'Letzte 6 Monate', start: isoDate(sixMonthsAgo), end: isoDate(now) },
    { label: `${y}`, start: isoDate(startOfYear), end: isoDate(now) },
    { label: `${y - 1}`, start: isoDate(lastYearStart), end: isoDate(lastYearEnd) },
  ];
})();

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ');
}

const th: React.CSSProperties = { textAlign: 'left', padding: '4px 6px', borderBottom: '2px solid #ddd', color: '#666', fontSize: 11 };
const td: React.CSSProperties = { padding: '4px 6px' };
const btnStyle: React.CSSProperties = {
  padding: '4px 12px', borderRadius: 4, border: '1px solid #ddd',
  cursor: 'pointer', fontSize: 12, background: '#ecf0f1',
};
const inputStyle: React.CSSProperties = {
  padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13, flex: 1,
};
