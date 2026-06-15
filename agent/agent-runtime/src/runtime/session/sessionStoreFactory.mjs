import { InMemorySessionStore } from './inMemorySessionStore.mjs'
import { SQLiteSessionStore } from '../sql/sqlite/sqliteSessionStore.mjs'

export function createSessionStoreFromEnv(env = process.env) {
  const provider = normalizeProvider(env.AGENT_SESSION_STORE ?? env.AGENT_DB_PROVIDER ?? 'sqlite')
  if (provider === 'memory' || provider === 'in-memory') {
    return new InMemorySessionStore()
  }
  if (provider === 'sqlite') {
    return new SQLiteSessionStore(resolveSqlitePath(env))
  }
  if (provider === 'mysql') {
    throw new Error('MySQL session store adapter is not implemented yet')
  }
  if (provider === 'postgres' || provider === 'postgresql') {
    throw new Error('PostgreSQL session store adapter is not implemented yet')
  }
  throw new Error(`Unsupported AGENT_SESSION_STORE value: ${provider}`)
}

function normalizeProvider(value) {
  return String(value ?? '').trim().toLowerCase()
}

function resolveSqlitePath(env) {
  const databaseUrl = env.AGENT_DATABASE_URL
  if (databaseUrl?.startsWith('sqlite:')) {
    return databaseUrl.slice('sqlite:'.length)
  }
  return env.AGENT_GATEWAY_DB ?? ':memory:'
}
