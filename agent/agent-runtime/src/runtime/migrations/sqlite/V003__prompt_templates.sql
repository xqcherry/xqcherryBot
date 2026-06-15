CREATE TABLE IF NOT EXISTS prompt_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  current_version_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  user_prompt TEXT NOT NULL DEFAULT '',
  extra_json TEXT,
  source_version_no INTEGER NOT NULL,
  source_published_at TEXT,
  imported_at TEXT NOT NULL,
  UNIQUE (template_id, source_version_no)
);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_key
  ON prompt_templates (prompt_key);

CREATE INDEX IF NOT EXISTS idx_prompt_template_versions_template
  ON prompt_template_versions (template_id);
