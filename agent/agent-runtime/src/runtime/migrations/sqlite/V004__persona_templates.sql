CREATE TABLE IF NOT EXISTS persona_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  current_version_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  source_version_no INTEGER NOT NULL,
  source_published_at TEXT,
  imported_at TEXT NOT NULL,
  UNIQUE (template_id, source_version_no)
);

CREATE TABLE IF NOT EXISTS persona_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_persona_key TEXT,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  persona_key TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (scope, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_persona_templates_key
  ON persona_templates (persona_key);

CREATE INDEX IF NOT EXISTS idx_persona_template_versions_template
  ON persona_template_versions (template_id);

CREATE INDEX IF NOT EXISTS idx_persona_bindings_scope_subject
  ON persona_bindings (scope, subject_id);
