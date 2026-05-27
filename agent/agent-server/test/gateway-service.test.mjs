import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createGatewayFromEnv } from '../src/index.mjs'

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

  const summary = await gateway.engine.contextBuilder.summarizer([
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
})
