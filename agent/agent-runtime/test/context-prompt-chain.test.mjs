import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ContextEngine,
  DEFAULT_CHAT_PERSONA_PROMPT,
  FilePersonaProvider,
  InMemorySessionStore,
  PromptManager,
} from '../src/index.mjs'

test('context engine assembles CHAT_PERSONA, turn context, skills, memory, summary, recent context, and current message', async () => {
  const sessionStore = new InMemorySessionStore()
  await sessionStore.appendPlatformMessage({
    sessionId: 'qq-group:1000',
    messageId: 'm1',
    senderId: 'alice',
    text: '之前的信息',
    timestamp: '2026-06-15T00:00:00.000Z',
  })
  await sessionStore.appendConversationSummary('qq-group:1000', {
    summary: '早期摘要',
    fromMessageId: 'm0',
    toMessageId: 'm0',
  })
  const memory = await sessionStore.appendMemoryCandidate({
    sessionId: 'qq-group:1000',
    scope: 'user',
    subjectId: 'alice',
    summary: 'prefers concise answers',
    evidenceMessageIds: ['m1'],
    confidence: 0.9,
  })
  await sessionStore.activateMemoryCandidate(memory.id)

  const engine = new ContextEngine({
    sessionStore,
    promptTemplateStore: {
      getChatPersonaPrompt: async () => ({
        promptKey: 'CHAT_PERSONA',
        systemPrompt: 'database chat persona',
        sourceVersionNo: 3,
      }),
    },
    skillProvider: {
      resolve: async () => [
        {
          skillKey: 'group-reply',
          content: 'skill instructions',
          stability: 'stable',
        },
      ],
    },
    compactionEngine: { compact: async () => ({ status: 'skipped' }) },
  })

  const { blocks } = await engine.build({
    sessionId: 'qq-group:1000',
    text: '现在回答',
    senderId: 'alice',
    messageId: 'm2',
    metadata: { platform: 'qq', chatType: 'group', addressedToAgent: true },
    selectedTools: [],
  })

  assert.deepEqual(
    blocks.map(block => block.id),
    [
      'chat-persona',
      'turn-context',
      'skill:group-reply',
      'long-term-memory',
      'short-term-summary',
      'recent-raw-context',
      'current-user-message',
    ],
  )
  assert.equal(blocks[0].content, 'database chat persona')
  assert.equal(blocks[0].metadata.promptKey, 'CHAT_PERSONA')
  assert.equal(blocks[2].content, 'skill instructions')
  assert.match(blocks[3].content, /prefers concise answers/)
  assert.equal(blocks.at(-1).role, 'user')
})

test('context engine uses fallback CHAT_PERSONA and empty skill provider by default', async () => {
  const sessionStore = new InMemorySessionStore()
  const engine = new ContextEngine({
    sessionStore,
    compactionEngine: { compact: async () => ({ status: 'skipped' }) },
  })

  const { blocks } = await engine.build({
    sessionId: 'qq-private:alice',
    text: '你好',
    senderId: 'alice',
    messageId: 'm1',
    metadata: { platform: 'qq', chatType: 'private' },
    selectedTools: [],
  })

  assert.deepEqual(
    blocks.map(block => block.id),
    ['chat-persona', 'turn-context', 'current-user-message'],
  )
  assert.equal(blocks[0].content, DEFAULT_CHAT_PERSONA_PROMPT)
  assert.match(blocks[1].content, /chatType: private/)
})

test('context engine can assemble managed chat prompts before turn context', async () => {
  const sessionStore = new InMemorySessionStore()
  const promptManager = new PromptManager({
    fallbackPrompts: {
      CHAT_CONSTRAINTS: {
        promptKey: 'CHAT_CONSTRAINTS',
        name: 'Constraints',
        description: '',
        systemPrompt: 'Use {{languagePolicy}}.',
        userPrompt: '',
        extraJson: null,
        fallback: true,
      },
      CHAT_PERSONA: {
        promptKey: 'CHAT_PERSONA',
        name: 'Persona',
        description: '',
        systemPrompt: 'Casual group friend.',
        userPrompt: '',
        extraJson: null,
        fallback: true,
      },
      CHAT_RESPONSE_POLICY: {
        promptKey: 'CHAT_RESPONSE_POLICY',
        name: 'Response Policy',
        description: '',
        systemPrompt: 'Usually answer in {{sentenceRange}} sentences.',
        userPrompt: '',
        extraJson: null,
        fallback: true,
      },
    },
  })
  const engine = new ContextEngine({
    sessionStore,
    promptManager,
    promptVariables: {
      languagePolicy: 'Chinese by default',
      sentenceRange: '1-4',
    },
    compactionEngine: { compact: async () => ({ status: 'skipped' }) },
  })

  const { blocks } = await engine.build({
    sessionId: 'qq-group:1000',
    text: '随便聊聊',
    senderId: 'alice',
    messageId: 'm1',
    metadata: { platform: 'qq', chatType: 'group' },
    selectedTools: [],
  })

  assert.deepEqual(
    blocks.map(block => block.id).slice(0, 4),
    [
      'prompt:CHAT_CONSTRAINTS',
      'active-persona',
      'prompt:CHAT_RESPONSE_POLICY',
      'turn-context',
    ],
  )
  assert.equal(blocks[0].content, 'Use Chinese by default.')
  assert.equal(blocks[1].content, 'Casual group friend.')
  assert.equal(blocks[1].metadata.personaKey, 'CHAT_PERSONA')
  assert.equal(blocks[2].content, 'Usually answer in 1-4 sentences.')
})

test('context engine uses selected persona instead of CHAT_PERSONA when persona provider resolves one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-context-'))
  const personaPath = join(dir, 'personas.json')
  await writeFile(
    personaPath,
    JSON.stringify({
      personas: [
        {
          personaKey: 'STYLE_WARM_SHORT',
          name: 'Warm Short',
          content: 'Speak warmly and keep it short.',
        },
      ],
      bindings: [
        {
          scope: 'user',
          subjectId: 'alice',
          personaKey: 'STYLE_WARM_SHORT',
        },
      ],
    }),
  )
  const sessionStore = new InMemorySessionStore()
  const promptManager = new PromptManager({
    fallbackPrompts: {
      CHAT_CONSTRAINTS: {
        promptKey: 'CHAT_CONSTRAINTS',
        name: 'Constraints',
        description: '',
        systemPrompt: 'Hard constraints.',
        userPrompt: '',
        extraJson: null,
        fallback: true,
      },
      CHAT_PERSONA: {
        promptKey: 'CHAT_PERSONA',
        name: 'Fallback Persona',
        description: '',
        systemPrompt: 'Fallback persona should not be injected.',
        userPrompt: '',
        extraJson: null,
        fallback: true,
      },
      CHAT_RESPONSE_POLICY: {
        promptKey: 'CHAT_RESPONSE_POLICY',
        name: 'Response Policy',
        description: '',
        systemPrompt: 'Short replies.',
        userPrompt: '',
        extraJson: null,
        fallback: true,
      },
    },
  })
  const engine = new ContextEngine({
    sessionStore,
    promptManager,
    personaProvider: new FilePersonaProvider({
      filePath: personaPath,
      promptManager,
    }),
    compactionEngine: { compact: async () => ({ status: 'skipped' }) },
  })

  const { blocks } = await engine.build({
    sessionId: 'qq-group:1000',
    text: '随便聊聊',
    senderId: 'alice',
    messageId: 'm1',
    metadata: { platform: 'qq', chatType: 'group' },
    selectedTools: [],
  })

  assert.deepEqual(
    blocks.map(block => block.id).slice(0, 4),
    [
      'prompt:CHAT_CONSTRAINTS',
      'active-persona',
      'prompt:CHAT_RESPONSE_POLICY',
      'turn-context',
    ],
  )
  assert.equal(blocks[1].content, 'Speak warmly and keep it short.')
  assert.equal(blocks[1].metadata.personaKey, 'STYLE_WARM_SHORT')
  assert.equal(blocks.some(block => block.id === 'prompt:CHAT_PERSONA'), false)
  assert.equal(blocks.some(block => block.content.includes('Fallback persona should not be injected')), false)
})
