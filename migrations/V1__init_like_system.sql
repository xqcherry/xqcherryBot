-- V1__init_like_system.sql
CREATE TABLE IF NOT EXISTS like_subscribers (
    user_id TEXT PRIMARY KEY,
    nickname TEXT,
    follow INTEGER DEFAULT 0
);