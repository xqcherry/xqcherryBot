import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  CHAT_PERSONA_PROMPT_KEY,
  DEFAULT_CHAT_PERSONA_PROMPT,
  PromptTemplateStore,
  SQLiteSessionStore,
} from '../src/index.mjs'

test('prompt template store reads current CHAT_PERSONA version from SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-store-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = new SQLiteSessionStore(dbPath)
  const promptStore = new PromptTemplateStore({ adapter: store.adapter })

  const version = await promptStore.upsertPublishedPrompt({
    promptKey: CHAT_PERSONA_PROMPT_KEY,
    name: 'Chat Persona',
    description: 'Main chat prompt.',
    systemPrompt: 'database persona',
    userPrompt: 'user template',
    extraJson: { source: 'test' },
    sourceVersionNo: 7,
    sourcePublishedAt: '2026-04-17T16:49:24.198Z',
    importedAt: '2026-06-15T00:00:00.000Z',
  })

  const template = await promptStore.getCurrentPrompt(CHAT_PERSONA_PROMPT_KEY)

  assert.equal(template.promptKey, CHAT_PERSONA_PROMPT_KEY)
  assert.equal(template.systemPrompt, 'database persona')
  assert.equal(template.userPrompt, 'user template')
  assert.deepEqual(template.extraJson, { source: 'test' })
  assert.equal(template.sourceVersionNo, 7)
  assert.equal(template.versionId, version.versionId)
  store.close()
})

test('prompt template store returns fallback when CHAT_PERSONA is missing or empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-store-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = new SQLiteSessionStore(dbPath)
  const promptStore = new PromptTemplateStore({ adapter: store.adapter })

  assert.equal(
    (await promptStore.getChatPersonaPrompt()).systemPrompt,
    DEFAULT_CHAT_PERSONA_PROMPT,
  )

  await promptStore.upsertPublishedPrompt({
    promptKey: CHAT_PERSONA_PROMPT_KEY,
    name: 'Chat Persona',
    description: '',
    systemPrompt: '   ',
    userPrompt: '',
    extraJson: null,
    sourceVersionNo: 1,
    sourcePublishedAt: '2026-04-17T16:49:24.198Z',
  })

  assert.equal(
    (await promptStore.getChatPersonaPrompt()).systemPrompt,
    DEFAULT_CHAT_PERSONA_PROMPT,
  )
  store.close()
})

test('prompt template store reports CHAT_PERSONA database and fallback status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-store-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = new SQLiteSessionStore(dbPath)
  const promptStore = new PromptTemplateStore({ adapter: store.adapter })

  assert.deepEqual(await promptStore.getChatPersonaStatus(), {
    promptKey: CHAT_PERSONA_PROMPT_KEY,
    source: 'fallback',
    fallback: true,
    sourceVersionNo: null,
    sourcePublishedAt: null,
    importedAt: null,
    name: 'Fallback Chat Persona',
  })

  await promptStore.upsertPublishedPrompt({
    promptKey: CHAT_PERSONA_PROMPT_KEY,
    name: 'Chat Persona',
    description: 'Main prompt',
    systemPrompt: 'database persona',
    userPrompt: '',
    extraJson: null,
    sourceVersionNo: 12,
    sourcePublishedAt: '2026-06-15T01:00:00.000Z',
    importedAt: '2026-06-15T01:05:00.000Z',
  })

  assert.deepEqual(await promptStore.getChatPersonaStatus(), {
    promptKey: CHAT_PERSONA_PROMPT_KEY,
    source: 'database',
    fallback: false,
    sourceVersionNo: 12,
    sourcePublishedAt: '2026-06-15T01:00:00.000Z',
    importedAt: '2026-06-15T01:05:00.000Z',
    name: 'Chat Persona',
  })
  store.close()
})
