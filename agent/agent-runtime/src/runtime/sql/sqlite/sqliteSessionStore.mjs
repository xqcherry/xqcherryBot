import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applySqlMigrations } from '../sqlMigrations.mjs'
import { SQLiteAdapter } from './sqliteAdapter.mjs'
import { sqliteDialect } from './sqliteDialect.mjs'
import { SqlSessionStore } from '../sqlSessionStore.mjs'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const sqliteMigrationsDir = join(moduleDir, '..', '..', 'migrations', 'sqlite')

export class SQLiteSessionStore extends SqlSessionStore {
  constructor(dbPath) {
    const adapter = new SQLiteAdapter(dbPath)
    applySqlMigrations(adapter, {
      dialect: sqliteDialect,
      migrationsDir: sqliteMigrationsDir,
    })
    super({ adapter, dialect: sqliteDialect })
    this.dbPath = dbPath
    this.db = adapter.db
  }
}
