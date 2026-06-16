import { readFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PersonaTemplateStore,
  SQLiteSessionStore,
  normalizePersonaExport,
} from '../agent-runtime/src/index.mjs'

const modulePath = fileURLToPath(import.meta.url)
const moduleDir = dirname(modulePath)
const projectRoot = resolve(moduleDir, '..')

export async function applyPersonasFromFile({
  dbPath = resolveDatabasePath(process.env),
  filePath = resolve(projectRoot, 'config', 'personas', 'current.json'),
} = {}) {
  const payload = JSON.parse(await readFile(filePath, 'utf8'))
  const config = validatePersonaExportFile(payload)

  if (dbPath !== ':memory:') {
    await mkdir(dirname(dbPath), { recursive: true })
  }
  const sessionStore = new SQLiteSessionStore(dbPath)
  try {
    const personaStore = new PersonaTemplateStore({ adapter: sessionStore.adapter })
    const imported = await personaStore.upsertPublishedPersonaConfig(config)
    return {
      imported: imported.personas.length,
      personaKeys: imported.personas.map(item => item.personaKey),
      defaultPersonaKey: imported.defaultPersonaKey,
      bindings: imported.bindings,
      personas: imported.personas.map(item => ({
        personaKey: item.personaKey,
        sourceVersionNo: item.sourceVersionNo,
        sourcePublishedAt: item.sourcePublishedAt,
        current: true,
      })),
    }
  } finally {
    sessionStore.close()
  }
}

export function validatePersonaExportFile(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Persona export must be an object')
  }
  if (typeof payload.exportedAt !== 'string' || payload.exportedAt.trim().length === 0) {
    throw new Error('Persona export exportedAt is required')
  }
  return normalizePersonaExport(payload)
}

function resolveDatabasePath(env) {
  if (env.AGENT_DATABASE_URL?.startsWith('sqlite:')) {
    return env.AGENT_DATABASE_URL.slice('sqlite:'.length)
  }
  return env.AGENT_GATEWAY_DB ?? resolve(projectRoot, 'data', 'agent-gateway.sqlite')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = await applyPersonasFromFile({
    dbPath: args.dbPath,
    filePath: args.filePath,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function parseArgs(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--db') {
      parsed.dbPath = args[++index]
    } else if (arg === '--file') {
      parsed.filePath = args[++index]
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return parsed
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
