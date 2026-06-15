export const sqliteDialect = {
  name: 'sqlite',
  insertSessionIgnoreSql: `
    INSERT OR IGNORE INTO sessions (id, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `,
  migrationsTableSql: `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `,
}
