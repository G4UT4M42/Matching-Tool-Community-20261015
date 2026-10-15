-- Cost monitor: tracks AI token usage and costs per session

CREATE TABLE IF NOT EXISTS ai_cost_sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  source TEXT NOT NULL DEFAULT 'invoicerec',
  total_tokens INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_acs_status ON ai_cost_sessions(status);
CREATE INDEX IF NOT EXISTS idx_acs_started ON ai_cost_sessions(started_at);

CREATE TABLE IF NOT EXISTS ai_cost_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'invoicerec',
  context TEXT,
  FOREIGN KEY (session_id) REFERENCES ai_cost_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ace_session ON ai_cost_entries(session_id);
