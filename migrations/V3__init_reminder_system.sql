-- V3__init_reminder_system.sql
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_user_id TEXT NOT NULL,
    chat_type TEXT NOT NULL,
    group_id TEXT,
    content TEXT NOT NULL,
    remind_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_reminders_due
ON reminders (status, remind_at);

CREATE INDEX IF NOT EXISTS idx_reminders_scope
ON reminders (creator_user_id, chat_type, group_id, status);
