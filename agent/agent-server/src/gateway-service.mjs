import {
  AgentEngine,
  ContextBuilder,
  InMemoryPermissionManager,
  OpenAICompatibleProvider,
  OpenAICompatibleSummarizer,
  SQLiteSessionStore,
  createMemoryCandidateTool,
} from '../../agent-runtime/src/index.mjs'

import { AgentProtocolServer } from './protocol-server.mjs'
import { createWebSocketAgentServer } from './websocket-server.mjs'

export function createGatewayFromEnv(
  env = process.env,
  { logger = () => {}, fetchImpl = globalThis.fetch } = {},
) {
  const baseUrl = requireEnv(env, 'OPENAI_BASE_URL')
  const model = requireEnv(env, 'OPENAI_MODEL')
  const summaryModel = env.AGENT_SUMMARY_MODEL ?? model
  const apiKey = env.OPENAI_API_KEY ?? env.DEEPSEEK_API_KEY ?? ''
  const host = env.AGENT_GATEWAY_HOST ?? '127.0.0.1'
  const port = Number.parseInt(env.AGENT_GATEWAY_PORT ?? '8787', 10)
  const dbPath = env.AGENT_GATEWAY_DB ?? ':memory:'

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('AGENT_GATEWAY_PORT must be a positive integer')
  }

  const sessionStore = new SQLiteSessionStore(dbPath)
  const provider = new OpenAICompatibleProvider({
    baseUrl,
    apiKey,
    model,
    fetchImpl,
  })
  const summarizer = new OpenAICompatibleSummarizer({
    baseUrl,
    apiKey,
    model: summaryModel,
    fetchImpl,
  })
  const engine = new AgentEngine({
    modelProvider: provider,
    sessionStore,
    permissionManager: new InMemoryPermissionManager(),
    contextBuilder: new ContextBuilder({
      sessionStore,
      summarizer: (messages, previousSummary) =>
        summarizer.summarize(messages, previousSummary),
    }),
    tools: [createMemoryCandidateTool({ sessionStore })],
  })
  const protocol = new AgentProtocolServer({ engine, messageStore: sessionStore })

  return {
    host,
    port,
    sessionStore,
    engine,
    protocol,
    logger,
    async start() {
      this.server = await createWebSocketAgentServer({
        engine,
        protocol,
        host,
        port,
        logger,
      })
      return this.server
    },
    close() {
      this.server?.close()
      sessionStore.close()
    },
  }
}

function requireEnv(env, name) {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
