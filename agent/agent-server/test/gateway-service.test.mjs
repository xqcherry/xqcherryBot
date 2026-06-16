import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createGatewayFromEnv } from '../src/index.mjs'
import {
  CHAT_PERSONA_PROMPT_KEY,
  PersonaTemplateStore,
  PromptTemplateStore,
} from '../../agent-runtime/src/index.mjs'

test('creates a configured gateway from environment values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gateway-'))
  const dbPath = join(dir, 'gateway.sqlite')

  const gateway = createGatewayFromEnv({
    AGENT_GATEWAY_HOST: '0.0.0.0',
    AGENT_GATEWAY_PORT: '9999',
    AGENT_GATEWAY_DB: dbPath,
    OPENAI_BASE_URL: 'http://localhost:11434/v1',
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'test-model',
  })

  assert.equal(gateway.host, '0.0.0.0')
  assert.equal(gateway.port, 9999)
  assert.ok(gateway.engine)
  assert.ok(gateway.protocol)
  assert.ok(gateway.sessionStore)
  assert.equal(gateway.health().ok, true)
  assert.equal(gateway.engine.tools.some(tool => tool.name === 'search_chat_history'), true)
  assert.equal(gateway.engine.tools.some(tool => tool.name === 'send_message'), true)
  assert.equal(gateway.engine.tools.find(tool => tool.name === 'send_message').requiresPermission, true)
  assert.ok(gateway.engine.contextEngine.promptManager)
  assert.ok(gateway.engine.contextEngine.personaProvider)
  assert.ok(gateway.remoteToolBridge)
  assert.equal(gateway.backupStatus().dbPath, dbPath)
  gateway.close()
})

test('gateway factory filters tools with AGENT_ALLOWED_TOOLS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gateway-'))
  const dbPath = join(dir, 'gateway.sqlite')

  const gateway = createGatewayFromEnv({
    AGENT_GATEWAY_DB: dbPath,
    OPENAI_BASE_URL: 'http://localhost:11434/v1',
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'test-model',
    AGENT_ALLOWED_TOOLS: 'get_recent_messages',
  })

  assert.deepEqual(gateway.engine.tools.map(tool => tool.name), ['get_recent_messages'])
  gateway.close()
})

test('gateway factory wires an OpenAI-compatible summarizer from environment values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gateway-'))
  const dbPath = join(dir, 'gateway.sqlite')
  const requests = []

  const gateway = createGatewayFromEnv(
    {
      AGENT_GATEWAY_DB: dbPath,
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'chat-model',
      AGENT_SUMMARY_MODEL: 'summary-model',
    },
    {
      fetchImpl: async (url, request) => {
        requests.push({ url, body: JSON.parse(request.body) })
        return {
          ok: true,
          body: [new TextEncoder().encode('data: {"choices":[{"delta":{"content":"summary"}}]}\n\n')],
        }
      },
    },
  )

  const summary = await gateway.engine.contextEngine.summarizer([
    {
      messageId: '1',
      senderId: 'alice',
      text: '需要压缩',
      timestamp: '2026-05-27T12:00:00.000Z',
    },
  ])

  assert.equal(summary, 'summary')
  assert.equal(requests[0].body.model, 'summary-model')
  gateway.close()
})

test('gateway factory accepts DEEPSEEK_API_KEY as an OpenAI-compatible API key alias', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gateway-'))
  const dbPath = join(dir, 'gateway.sqlite')
  const requests = []

  const gateway = createGatewayFromEnv(
    {
      AGENT_GATEWAY_DB: dbPath,
      OPENAI_BASE_URL: 'https://api.deepseek.com',
      DEEPSEEK_API_KEY: 'deepseek-key',
      OPENAI_MODEL: 'deepseek-v4-flash',
    },
    {
      fetchImpl: async (_url, request) => {
        requests.push(request)
        return {
          ok: true,
          body: [new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')],
        }
      },
    },
  )

  for await (const _event of gateway.engine.modelProvider.streamChat({
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    // Drain the stream.
  }

  assert.equal(requests[0].headers.authorization, 'Bearer deepseek-key')
  gateway.close()
})

test('gateway factory exposes the selected model provider in health metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gateway-'))
  const dbPath = join(dir, 'gateway.sqlite')

  const gateway = createGatewayFromEnv({
    AGENT_GATEWAY_DB: dbPath,
    AGENT_MODEL_PROVIDER: 'openai-compatible',
    OPENAI_BASE_URL: 'https://api.deepseek.com',
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'deepseek-v4-flash',
  })

  assert.equal(gateway.health().modelProvider, 'openai-compatible')
  assert.equal(gateway.health().compactionProvider, 'openai-compatible')
  assert.equal(gateway.health().summaryConfigured, true)
  assert.equal(gateway.health().prompt.chatPersona.promptKey, CHAT_PERSONA_PROMPT_KEY)
  assert.equal(gateway.health().prompt.chatPersona.fallback, true)
  gateway.close()
})

test('gateway health exposes database CHAT_PERSONA prompt status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gateway-'))
  const dbPath = join(dir, 'gateway.sqlite')

  const gateway = createGatewayFromEnv({
    AGENT_GATEWAY_DB: dbPath,
    AGENT_MODEL_PROVIDER: 'openai-compatible',
    OPENAI_BASE_URL: 'https://api.deepseek.com',
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'deepseek-v4-flash',
  })
  const promptStore = new PromptTemplateStore({ adapter: gateway.sessionStore.adapter })
  await promptStore.upsertPublishedPrompt({
    promptKey: CHAT_PERSONA_PROMPT_KEY,
    name: 'Chat Persona',
    description: 'Main prompt',
    systemPrompt: 'database persona',
    userPrompt: '',
    extraJson: null,
    sourceVersionNo: 5,
    sourcePublishedAt: '2026-06-15T01:00:00.000Z',
    importedAt: '2026-06-15T01:05:00.000Z',
  })

  assert.deepEqual(gateway.health().prompt.chatPersona, {
    promptKey: CHAT_PERSONA_PROMPT_KEY,
    source: 'database',
    fallback: false,
    sourceVersionNo: 5,
    sourcePublishedAt: '2026-06-15T01:00:00.000Z',
    importedAt: '2026-06-15T01:05:00.000Z',
    name: 'Chat Persona',
  })
  gateway.close()
})

test('gateway factory reads personas from SQLite before file fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gateway-'))
  const dbPath = join(dir, 'gateway.sqlite')

  const gateway = createGatewayFromEnv({
    AGENT_GATEWAY_DB: dbPath,
    AGENT_MODEL_PROVIDER: 'openai-compatible',
    OPENAI_BASE_URL: 'https://api.deepseek.com',
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'deepseek-v4-flash',
  })
  const personaStore = new PersonaTemplateStore({ adapter: gateway.sessionStore.adapter })
  await personaStore.upsertPublishedPersonaConfig({
    exportedAt: '2026-06-15T00:00:00.000Z',
    defaultPersonaKey: 'database_friend',
    personas: [
      {
        personaKey: 'database_friend',
        name: 'Database Friend',
        description: '',
        content: 'database persona',
        sourceVersionNo: 1,
        sourcePublishedAt: '2026-06-15T00:00:00.000Z',
      },
    ],
    bindings: [],
  })

  const persona = await gateway.engine.contextEngine.personaProvider.resolve({})

  assert.equal(persona.source, 'default_persona')
  assert.equal(persona.personaKey, 'database_friend')
  assert.equal(persona.content, 'database persona')
  gateway.close()
})

test('gateway factory can fail fast when CHAT_PERSONA would fall back', () => {
  assert.throws(
    () =>
      createGatewayFromEnv({
        AGENT_GATEWAY_DB: ':memory:',
        AGENT_PROMPT_FALLBACK_MODE: 'fail',
        AGENT_MODEL_PROVIDER: 'openai-compatible',
        OPENAI_BASE_URL: 'https://api.deepseek.com',
        OPENAI_API_KEY: 'test-key',
        OPENAI_MODEL: 'deepseek-v4-flash',
      }),
    /CHAT_PERSONA/,
  )
})

test('gateway factory logs a warning when CHAT_PERSONA falls back in warn mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gateway-'))
  const dbPath = join(dir, 'gateway.sqlite')
  const logs = []

  const gateway = createGatewayFromEnv(
    {
      AGENT_GATEWAY_DB: dbPath,
      AGENT_PROMPT_FALLBACK_MODE: 'warn',
      AGENT_MODEL_PROVIDER: 'openai-compatible',
      OPENAI_BASE_URL: 'https://api.deepseek.com',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'deepseek-v4-flash',
    },
    { logger: event => logs.push(event) },
  )

  assert.deepEqual(logs, [
    {
      type: 'prompt_fallback',
      promptKey: CHAT_PERSONA_PROMPT_KEY,
      mode: 'warn',
    },
  ])
  gateway.close()
})

test('gateway factory wires token compaction policy from environment values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gateway-'))
  const dbPath = join(dir, 'gateway.sqlite')

  const gateway = createGatewayFromEnv({
    AGENT_GATEWAY_DB: dbPath,
    AGENT_MODEL_PROVIDER: 'openai-compatible',
    OPENAI_BASE_URL: 'https://api.deepseek.com',
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'deepseek-v4-flash',
    AGENT_MODEL_CONTEXT_WINDOW_OPENAI_COMPATIBLE_DEEPSEEK_V4_FLASH: '131072',
    AGENT_COMPACTION_THRESHOLD_RATIO: '0.5',
    AGENT_COMPACTION_SAFETY_RATIO: '0.8',
    AGENT_COMPACTION_RESERVED_OUTPUT_TOKENS: '4096',
    AGENT_COMPACTION_RECENT_TAIL_TOKEN_BUDGET: '12000',
  })

  const policy = gateway.engine.contextEngine.compactionEngine.policy
  assert.equal(policy.contextWindowTokens, 131072)
  assert.equal(policy.thresholdRatio, 0.5)
  assert.equal(policy.safetyRatio, 0.8)
  assert.equal(policy.reservedOutputTokens, 4096)
  assert.equal(policy.recentTailTokenBudget, 12000)
  assert.deepEqual(gateway.health().compaction, {
    contextWindowTokens: 131072,
    thresholdRatio: 0.5,
    safetyRatio: 0.8,
    reservedOutputTokens: 4096,
    recentTailTokenBudget: 12000,
    format: 'markdown',
  })
  gateway.close()
})

test('gateway factory can enable summary quality checking from environment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gateway-'))
  const dbPath = join(dir, 'gateway.sqlite')

  const gateway = createGatewayFromEnv({
    AGENT_GATEWAY_DB: dbPath,
    OPENAI_BASE_URL: 'https://api.deepseek.com',
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'deepseek-v4-flash',
    AGENT_COMPACTION_QUALITY_CHECK: 'true',
  })

  assert.ok(gateway.engine.contextEngine.compactionEngine.summaryQualityChecker)
  gateway.close()
})

test('gateway factory can configure JSON compaction summaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gateway-'))
  const dbPath = join(dir, 'gateway.sqlite')

  const gateway = createGatewayFromEnv({
    AGENT_GATEWAY_DB: dbPath,
    OPENAI_BASE_URL: 'https://api.deepseek.com',
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'deepseek-v4-flash',
    AGENT_COMPACTION_FORMAT: 'json',
  })

  assert.equal(gateway.engine.contextEngine.compactionEngine.format, 'json')
  assert.equal(gateway.engine.contextEngine.compactionEngine.summaryValidator.format, 'json')
  assert.equal(gateway.health().compaction.format, 'json')
  gateway.close()
})

test('gateway factory rejects native model providers until adapters exist', () => {
  assert.throws(
    () =>
      createGatewayFromEnv({
        AGENT_MODEL_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'key',
        GEMINI_MODEL: 'gemini-model',
      }),
    /Gemini model provider adapter is not implemented yet/,
  )
})

test('OPENAI_API_KEY takes precedence over DEEPSEEK_API_KEY when both are set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-gateway-'))
  const dbPath = join(dir, 'gateway.sqlite')
  const requests = []

  const gateway = createGatewayFromEnv(
    {
      AGENT_GATEWAY_DB: dbPath,
      OPENAI_BASE_URL: 'https://api.deepseek.com',
      OPENAI_API_KEY: 'openai-compatible-key',
      DEEPSEEK_API_KEY: 'deepseek-key',
      OPENAI_MODEL: 'deepseek-v4-flash',
    },
    {
      fetchImpl: async (_url, request) => {
        requests.push(request)
        return {
          ok: true,
          body: [new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')],
        }
      },
    },
  )

  for await (const _event of gateway.engine.modelProvider.streamChat({
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    // Drain the stream.
  }

  assert.equal(requests[0].headers.authorization, 'Bearer openai-compatible-key')
  gateway.close()
})

test('gateway factory requires an OpenAI-compatible model endpoint and model', () => {
  assert.throws(
    () => createGatewayFromEnv({ OPENAI_BASE_URL: 'http://localhost:11434/v1' }),
    /OPENAI_MODEL/,
  )
  assert.throws(
    () => createGatewayFromEnv({ OPENAI_MODEL: 'test-model' }),
    /OPENAI_BASE_URL/,
  )
  assert.throws(
    () =>
      createGatewayFromEnv({
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
        OPENAI_MODEL: 'test-model',
      }),
    /OPENAI_API_KEY or DEEPSEEK_API_KEY/,
  )
})
