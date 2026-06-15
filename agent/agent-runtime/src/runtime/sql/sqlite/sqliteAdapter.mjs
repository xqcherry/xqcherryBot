import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export class SQLiteAdapter {
  constructor(dbPath) {
    const DatabaseSync = loadDatabaseSync()
    this.db = new DatabaseSync(dbPath)
  }

  run(sql, params = []) {
    const result = this.db.prepare(sql).run(...params)
    return {
      changes: result.changes,
      lastInsertId: Number(result.lastInsertRowid),
    }
  }

  get(sql, params = []) {
    return normalizeRow(this.db.prepare(sql).get(...params))
  }

  all(sql, params = []) {
    return this.db.prepare(sql).all(...params).map(normalizeRow)
  }

  exec(sql) {
    this.db.exec(sql)
  }

  close() {
    this.db.close()
  }
}

function normalizeRow(row) {
  if (row == null) return row
  return { ...row }
}

function loadDatabaseSync() {
  try {
    return require('node:sqlite').DatabaseSync
  } catch (error) {
    throw new Error(
      `SQLiteSessionStore requires a Node.js runtime with node:sqlite support: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
