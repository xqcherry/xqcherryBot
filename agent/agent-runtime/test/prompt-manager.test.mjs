import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  PromptManager,
  PromptTemplateStore,
  SQLiteSessionStore,
} from '../src/index.mjs'

test('prompt manager renders prompt templates with explicit variables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-manager-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = new SQLiteSessionStore(dbPath)
  const promptStore = new PromptTemplateStore({ adapter: store.adapter })
  await promptStore.upsertPublishedPrompt({
    promptKey: 'CHAT_RESPONSE_POLICY',
    name: 'Response Policy',
    description: 'Controls response shape.',
    systemPrompt: 'Default language: {{language}}\nMax sentences: {{maxSentences}}',
    userPrompt: 'User tone: {{tone}}',
    extraJson: null,
    sourceVersionNo: 1,
    sourcePublishedAt: '2026-06-15T00:00:00.000Z',
  })
  const manager = new PromptManager({ promptStore })

  const rendered = await manager.renderPrompt('CHAT_RESPONSE_POLICY', {
    language: 'Chinese',
    maxSentences: 4,
    tone: 'casual',
  })

  assert.equal(rendered.promptKey, 'CHAT_RESPONSE_POLICY')
  assert.equal(rendered.systemPrompt, 'Default language: Chinese\nMax sentences: 4')
  assert.equal(rendered.userPrompt, 'User tone: casual')
  store.close()
})

test('prompt manager rejects missing template variables', async () => {
  const manager = new PromptManager({
    fallbackPrompts: {
      CHAT_CONSTRAINTS: {
        promptKey: 'CHAT_CONSTRAINTS',
        name: 'Constraints',
        description: '',
        systemPrompt: 'Reply in {{language}}.',
        userPrompt: '',
        extraJson: null,
        sourceVersionNo: null,
        sourcePublishedAt: null,
        fallback: true,
      },
    },
  })

  await assert.rejects(
    () => manager.renderPrompt('CHAT_CONSTRAINTS', {}),
    /Missing prompt variable "language"/,
  )
})

test('prompt manager uses fallbacks and refreshes cache when current version changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-manager-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = new SQLiteSessionStore(dbPath)
  const promptStore = new PromptTemplateStore({ adapter: store.adapter })
  const manager = new PromptManager({
    promptStore,
    fallbackPrompts: {
      CHAT_PERSONA: {
        promptKey: 'CHAT_PERSONA',
        name: 'Fallback Persona',
        description: '',
        systemPrompt: 'fallback persona',
        userPrompt: '',
        extraJson: null,
        sourceVersionNo: null,
        sourcePublishedAt: null,
        fallback: true,
      },
    },
  })

  assert.equal((await manager.getPrompt('CHAT_PERSONA')).systemPrompt, 'fallback persona')

  await promptStore.upsertPublishedPrompt({
    promptKey: 'CHAT_PERSONA',
    name: 'Persona',
    description: '',
    systemPrompt: 'database persona v1',
    userPrompt: '',
    extraJson: null,
    sourceVersionNo: 1,
    sourcePublishedAt: '2026-06-15T00:00:00.000Z',
  })
  assert.equal((await manager.getPrompt('CHAT_PERSONA')).systemPrompt, 'database persona v1')

  await promptStore.upsertPublishedPrompt({
    promptKey: 'CHAT_PERSONA',
    name: 'Persona',
    description: '',
    systemPrompt: 'database persona v2',
    userPrompt: '',
    extraJson: null,
    sourceVersionNo: 2,
    sourcePublishedAt: '2026-06-15T01:00:00.000Z',
  })

  assert.equal((await manager.getPrompt('CHAT_PERSONA')).systemPrompt, 'database persona v2')
  store.close()
})
