CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id TEXT,
  sender_id TEXT,
  text TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  message_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_call_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permission_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  audit_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_messages_session_message
  ON platform_messages (session_id, message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_platform_messages_session
  ON platform_messages (session_id);

CREATE INDEX IF NOT EXISTS idx_platform_messages_sender
  ON platform_messages (sender_id);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_lookup
  ON memory_candidates (scope, subject_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_turns_session
  ON agent_turns (session_id);
