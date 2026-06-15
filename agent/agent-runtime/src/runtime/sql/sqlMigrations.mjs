import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const MIGRATION_PATTERN = /^V(\d+)__.+\.sql$/

export function applySqlMigrations(adapter, { dialect, migrationsDir }) {
  adapter.exec(dialect.migrationsTableSql)
  upgradeLegacyMigrationTable(adapter, dialect)

  const applied = new Set(
    adapter
      .all('SELECT version FROM schema_migrations')
      .map(row => Number(row.version)),
  )
  for (const migration of listMigrations(migrationsDir)) {
    if (applied.has(migration.version)) continue
    adapter.exec(migration.sql)
    adapter.run(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      [migration.version, migration.name, new Date().toISOString()],
    )
  }
}

function listMigrations(migrationsDir) {
  return readdirSync(migrationsDir)
    .filter(fileName => MIGRATION_PATTERN.test(fileName))
    .map(fileName => {
      const [, version] = fileName.match(MIGRATION_PATTERN)
      return {
        version: Number(version),
        name: basename(fileName),
        sql: readFileSync(join(migrationsDir, fileName), 'utf8'),
      }
    })
    .sort((left, right) => left.version - right.version)
}

function upgradeLegacyMigrationTable(adapter, dialect) {
  if (dialect.name !== 'sqlite') return
  const columns = adapter.all('PRAGMA table_info(schema_migrations)')
  if (columns.some(column => column.name === 'name')) return
  adapter.exec('ALTER TABLE schema_migrations ADD COLUMN name TEXT')
  adapter.run(
    "UPDATE schema_migrations SET name = 'V001__initial_schema.sql' WHERE version = 1 AND name IS NULL",
  )
}
