-- V2__init_prd_system.sql
CREATE TABLE IF NOT EXISTS prd_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    create_time TEXT,
    finish INTEGER DEFAULT 0
);