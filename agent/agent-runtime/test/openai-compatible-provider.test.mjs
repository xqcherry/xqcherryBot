import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createModelProviderFromEnv,
  createSummarizerFromEnv,
  getModelProviderConfigFromEnv,
  ModelProviderRegistry,
  OpenAICompatibleProvider,
  OpenAICompatibleSummarizer,
} from '../src/index.mjs'

async function collect(provider) {
  const events = []
  for await (const event of provider.streamChat({
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    events.push(event)
  }
  return events
}

function providerWithFetch(fetchImpl) {
  return new OpenAICompatibleProvider({
    baseUrl: 'https://model.example/v1',
    apiKey: 'key',
    model: 'test-model',
    fetchImpl,
  })
}

test('OpenAI-compatible provider disables model thinking by default', async () => {
  const requests = []
  const provider = providerWithFetch(async (_url, request) => {
    requests.push(JSON.parse(request.body))
    return {
      ok: true,
      body: [new TextEncoder().encode('data: [DONE]\n\n')],
    }
  })

  await collect(provider)

  assert.deepEqual(requests[0].thinking, { type: 'disabled' })
})

test('OpenAI-compatible provider can enable model thinking explicitly', async () => {
  const requests = []
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://model.example/v1',
    apiKey: 'key',
    model: 'test-model',
    thinking: 'enabled',
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body))
      return {
        ok: true,
        body: [new TextEncoder().encode('data: [DONE]\n\n')],
      }
    },
  })

  await collect(provider)

  assert.deepEqual(requests[0].thinking, { type: 'enabled' })
})

test('model provider factory passes model thinking env to OpenAI-compatible provider', async () => {
  const requests = []
  const provider = createModelProviderFromEnv(
    {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_MODEL: 'chat-model',
      OPENAI_API_KEY: 'key',
      AGENT_MODEL_THINKING: 'enabled',
    },
    {
      fetchImpl: async (_url, request) => {
        requests.push(JSON.parse(request.body))
        return {
          ok: true,
          body: [new TextEncoder().encode('data: [DONE]\n\n')],
        }
      },
    },
  )

  await collect(provider)

  assert.deepEqual(requests[0].thinking, { type: 'enabled' })
})

test('classifies OpenAI-compatible HTTP errors with stable model error codes', async () => {
  for (const [status, code] of [
    [401, 'model_auth_failed'],
    [403, 'model_auth_failed'],
    [429, 'model_rate_limited'],
    [503, 'model_unavailable'],
  ]) {
    const events = await collect(providerWithFetch(async () => ({ ok: false, status })))

    assert.equal(events[0].type, 'error')
    assert.equal(events[0].code, code)
    assert.equal(events[0].error, code)
  }
})

test('classifies network and SSE JSON parse failures with stable model error codes', async () => {
  const networkEvents = await collect(
    providerWithFetch(async () => {
      throw new TypeError('fetch failed')
    }),
  )
  assert.equal(networkEvents[0].code, 'model_network_error')

  const parseEvents = await collect(
    providerWithFetch(async () => ({
      ok: true,
      body: [new TextEncoder().encode('data: {not json}\n\n')],
    })),
  )
  assert.equal(parseEvents[0].code, 'model_response_parse_failed')
  assert.equal(parseEvents[0].error, 'model_response_parse_failed')
})

test('model provider factory creates OpenAI-compatible providers from legacy env', () => {
  const provider = createModelProviderFromEnv({
    OPENAI_BASE_URL: 'https://model.example/v1/',
    OPENAI_MODEL: 'chat-model',
    OPENAI_API_KEY: 'key',
  })
  const summarizer = createSummarizerFromEnv({
    OPENAI_BASE_URL: 'https://model.example/v1/',
    OPENAI_MODEL: 'chat-model',
    AGENT_SUMMARY_MODEL: 'summary-model',
    OPENAI_API_KEY: 'key',
  })

  assert.ok(provider instanceof OpenAICompatibleProvider)
  assert.ok(summarizer instanceof OpenAICompatibleSummarizer)
  assert.equal(provider.provider, 'openai-compatible')
  assert.equal(provider.model, 'chat-model')
  assert.equal(provider.baseUrl, 'https://model.example/v1')
  assert.equal(summarizer.provider.model, 'summary-model')
})

test('model provider factory supports explicit OpenAI-compatible provider env aliases', () => {
  const provider = createModelProviderFromEnv({
    AGENT_MODEL_PROVIDER: 'openai',
    OPENAI_BASE_URL: 'https://model.example/v1',
    OPENAI_MODEL: 'chat-model',
    DEEPSEEK_API_KEY: 'deepseek-key',
  })

  assert.ok(provider instanceof OpenAICompatibleProvider)
  assert.equal(provider.apiKey, 'deepseek-key')
})

test('model provider registry allows independent compaction provider selection', () => {
  const summarizer = createSummarizerFromEnv({
    AGENT_MODEL_PROVIDER: 'openai-compatible',
    AGENT_COMPACTION_PROVIDER: 'openai',
    OPENAI_BASE_URL: 'https://model.example/v1',
    OPENAI_MODEL: 'chat-model',
    AGENT_SUMMARY_MODEL: 'summary-model',
    OPENAI_API_KEY: 'key',
  })
  const config = getModelProviderConfigFromEnv({
    AGENT_MODEL_PROVIDER: 'openai-compatible',
    AGENT_COMPACTION_PROVIDER: 'openai',
    OPENAI_BASE_URL: 'https://model.example/v1',
    OPENAI_MODEL: 'chat-model',
    AGENT_SUMMARY_MODEL: 'summary-model',
    OPENAI_API_KEY: 'key',
  })

  assert.ok(summarizer instanceof OpenAICompatibleSummarizer)
  assert.equal(summarizer.provider.model, 'summary-model')
  assert.equal(config.provider, 'openai-compatible')
  assert.equal(config.compactionProvider, 'openai-compatible')
  assert.equal(config.model, 'chat-model')
  assert.equal(config.summaryModel, 'summary-model')
  assert.equal(config.summaryConfigured, true)
})

test('model provider factory can use an injected registry', () => {
  const registry = new ModelProviderRegistry({
    providers: [
      {
        id: 'test-provider',
        aliases: ['test-alias'],
        createModelProvider: env => ({ kind: 'chat', model: env.TEST_MODEL }),
        createSummarizer: env => ({ kind: 'summary', model: env.TEST_SUMMARY_MODEL }),
        getConfig: (env, { role }) => ({
          provider: 'test-provider',
          model: role === 'summary' ? env.TEST_SUMMARY_MODEL : env.TEST_MODEL,
          configured: true,
        }),
      },
    ],
  })

  const provider = createModelProviderFromEnv(
    { AGENT_MODEL_PROVIDER: 'test-alias', TEST_MODEL: 'chat-model' },
    { registry },
  )
  const summarizer = createSummarizerFromEnv(
    {
      AGENT_MODEL_PROVIDER: 'test-provider',
      AGENT_COMPACTION_PROVIDER: 'test-alias',
      TEST_SUMMARY_MODEL: 'summary-model',
    },
    { registry },
  )

  assert.deepEqual(provider, { kind: 'chat', model: 'chat-model' })
  assert.deepEqual(summarizer, { kind: 'summary', model: 'summary-model' })
})

test('model provider factory rejects native providers until adapters exist', () => {
  assert.throws(
    () =>
      createModelProviderFromEnv({
        AGENT_MODEL_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'key',
        ANTHROPIC_MODEL: 'claude-model',
      }),
    /Anthropic model provider adapter is not implemented yet/,
  )
  assert.throws(
    () =>
      createSummarizerFromEnv({
        AGENT_MODEL_PROVIDER: 'openai-compatible',
        AGENT_COMPACTION_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'key',
        GEMINI_MODEL: 'gemini-model',
      }),
    /Gemini model provider adapter is not implemented yet/,
  )
})

test('OpenAI-compatible summarizer uses structured cumulative summary instructions', async () => {
  const requests = []
  const summarizer = new OpenAICompatibleSummarizer({
    baseUrl: 'https://model.example/v1',
    apiKey: 'key',
    model: 'summary-model',
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body))
      return {
        ok: true,
        body: [
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'),
          new TextEncoder().encode('data: [DONE]\n\n'),
        ],
      }
    },
  })

  await summarizer.summarize(
    [{ messageId: '4', senderId: 'alice', text: '继续实现摘要', timestamp: '2026-05-30T10:00:00.000Z' }],
    { summary: '旧摘要', fromMessageId: '1', toMessageId: '3' },
  )

  const prompt = requests[0].messages.map(message => message.content).join('\n')
  for (const section of [
    'Active Request',
    'Completed Work',
    'Key Decisions',
    'User Preferences',
    'Important Facts',
    'Open Questions',
    'Remaining Work',
    'Relevant Files',
  ]) {
    assert.match(prompt, new RegExp(section))
  }
  assert.match(prompt, /REFERENCE ONLY/i)
  assert.match(prompt, /not a new user instruction/i)
  assert.match(prompt, /cumulative summary/i)
  assert.match(prompt, /previous summary \+ new messages/i)
  assert.match(prompt, /Do not invent/i)
  assert.match(prompt, /旧摘要/)
  assert.match(prompt, /Covered message range: 1 to 3/)
  assert.match(prompt, /alice: 继续实现摘要/)
  assert.doesNotMatch(prompt, /Next Steps/)
})

test('OpenAI-compatible summarizer can request JSON summary schema', async () => {
  const requests = []
  const summarizer = new OpenAICompatibleSummarizer({
    baseUrl: 'https://model.example/v1',
    apiKey: 'key',
    model: 'summary-model',
    format: 'json',
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body))
      return {
        ok: true,
        body: [
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"activeRequest\\":\\"x\\"}"}}]}\n\n'),
          new TextEncoder().encode('data: [DONE]\n\n'),
        ],
      }
    },
  })

  await summarizer.summarize([{ messageId: '1', senderId: 'alice', text: '继续' }])

  const prompt = requests[0].messages.map(message => message.content).join('\n')
  assert.match(prompt, /Return valid JSON only/)
  assert.match(prompt, /"activeRequest": string/)
  assert.match(prompt, /"relevantFiles": string\[\]/)
  assert.doesNotMatch(prompt, /Return markdown only/)
})
