import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHAT_PERSONA_PROMPT_KEY,
  PromptTemplateStore,
  SQLiteSessionStore,
  normalizePromptExport,
} from '../agent-runtime/src/index.mjs'

const modulePath = fileURLToPath(import.meta.url)
const moduleDir = dirname(modulePath)
const projectRoot = resolve(moduleDir, '..')

export async function applyPromptsFromFile({
  dbPath = resolveDatabasePath(process.env),
  filePath = resolve(projectRoot, 'config', 'prompts', 'current.json'),
  requireChatPersona = true,
} = {}) {
  const payload = JSON.parse(await readFile(filePath, 'utf8'))
  const prompts = validatePromptExportFile(payload)
  if (
    requireChatPersona &&
    !prompts.some(prompt => prompt.promptKey === CHAT_PERSONA_PROMPT_KEY)
  ) {
    throw new Error(`Prompt export must include ${CHAT_PERSONA_PROMPT_KEY}`)
  }

  if (dbPath !== ':memory:') {
    await mkdir(dirname(dbPath), { recursive: true })
  }
  const sessionStore = new SQLiteSessionStore(dbPath)
  try {
    const promptStore = new PromptTemplateStore({ adapter: sessionStore.adapter })
    const imported = []
    for (const prompt of prompts) {
      imported.push(await promptStore.upsertPublishedPrompt(prompt))
    }
    return {
      imported: imported.length,
      promptKeys: imported.map(item => item.promptKey),
      prompts: imported.map(item => ({
        promptKey: item.promptKey,
        sourceVersionNo: item.sourceVersionNo,
        sourcePublishedAt: prompts.find(prompt => prompt.promptKey === item.promptKey)?.sourcePublishedAt ?? null,
        current: true,
      })),
    }
  } finally {
    sessionStore.close()
  }
}

export function validatePromptExportFile(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Prompt export must be an object')
  }
  if (typeof payload.exportedAt !== 'string' || payload.exportedAt.trim().length === 0) {
    throw new Error('Prompt export exportedAt is required')
  }
  if (!Array.isArray(payload.prompts)) {
    throw new Error('Prompt export prompts must be an array')
  }
  const seen = new Set()
  const prompts = payload.prompts.map(prompt => normalizePromptExport(prompt))
  for (const prompt of prompts) {
    if (seen.has(prompt.promptKey)) {
      throw new Error(`Prompt export contains duplicate promptKey: ${prompt.promptKey}`)
    }
    seen.add(prompt.promptKey)
    if (!isValidIsoDate(prompt.sourcePublishedAt)) {
      throw new Error(`Prompt "${prompt.promptKey}" sourcePublishedAt must be a valid timestamp`)
    }
    if (
      prompt.promptKey === CHAT_PERSONA_PROMPT_KEY &&
      prompt.systemPrompt.trim().length === 0
    ) {
      throw new Error(`${CHAT_PERSONA_PROMPT_KEY} systemPrompt is required`)
    }
  }
  return prompts
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  const time = Date.parse(value)
  return Number.isFinite(time)
}

function resolveDatabasePath(env) {
  if (env.AGENT_DATABASE_URL?.startsWith('sqlite:')) {
    return env.AGENT_DATABASE_URL.slice('sqlite:'.length)
  }
  return env.AGENT_GATEWAY_DB ?? resolve(projectRoot, 'data', 'agent-gateway.sqlite')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = await applyPromptsFromFile({
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
