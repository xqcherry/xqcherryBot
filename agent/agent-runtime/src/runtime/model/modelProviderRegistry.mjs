import {
  OpenAICompatibleProvider,
  OpenAICompatibleSummarizer,
} from './provider/OpenAIProvider.mjs'

export class ModelProviderRegistry {
  #providers = new Map()

  constructor({ providers = [] } = {}) {
    for (const provider of providers) {
      this.register(provider)
    }
  }

  register(provider) {
    const id = normalizeProvider(provider.id)
    if (!id) throw new Error('Model provider registry entry requires an id')
    const entry = { ...provider, id }
    this.#providers.set(id, entry)
    for (const alias of provider.aliases ?? []) {
      this.#providers.set(normalizeProvider(alias), entry)
    }
    return this
  }

  resolve(providerName) {
    const provider = normalizeProvider(providerName)
    const entry = this.#providers.get(provider)
    if (!entry) throwUnsupportedProvider(provider)
    return entry
  }

  createModelProviderFromEnv(env = process.env, options = {}) {
    const providerName = env.AGENT_MODEL_PROVIDER ?? 'openai-compatible'
    return this.resolve(providerName).createModelProvider(env, options)
  }

  createSummarizerFromEnv(env = process.env, options = {}) {
    const providerName =
      env.AGENT_COMPACTION_PROVIDER ??
      env.AGENT_SUMMARY_PROVIDER ??
      env.AGENT_MODEL_PROVIDER ??
      'openai-compatible'
    return this.resolve(providerName).createSummarizer(env, options)
  }

  getConfigFromEnv(env = process.env) {
    const modelProviderName = env.AGENT_MODEL_PROVIDER ?? 'openai-compatible'
    const compactionProviderName =
      env.AGENT_COMPACTION_PROVIDER ??
      env.AGENT_SUMMARY_PROVIDER ??
      modelProviderName
    const modelProvider = this.resolve(modelProviderName)
    const compactionProvider = this.resolve(compactionProviderName)
    const modelConfig = modelProvider.getConfig(env, { role: 'chat' })
    const summaryConfig = compactionProvider.getConfig(env, { role: 'summary' })
    return {
      ...modelConfig,
      provider: modelProvider.id,
      compactionProvider: compactionProvider.id,
      summaryModel: summaryConfig.model,
      summaryConfigured: summaryConfig.configured,
    }
  }
}

export function createDefaultModelProviderRegistry() {
  return new ModelProviderRegistry({
    providers: [openAICompatibleRegistryEntry],
  })
}

export const openAICompatibleRegistryEntry = {
  id: 'openai-compatible',
  aliases: ['openai'],

  createModelProvider(env, { fetchImpl = globalThis.fetch } = {}) {
    return new OpenAICompatibleProvider({
      baseUrl: requireEnv(env, 'OPENAI_BASE_URL'),
      apiKey: resolveOpenAICompatibleApiKey(env),
      model: requireEnv(env, 'OPENAI_MODEL'),
      thinking: env.AGENT_MODEL_THINKING ?? 'disabled',
      fetchImpl,
    })
  },

  createSummarizer(env, { fetchImpl = globalThis.fetch } = {}) {
    const model = env.AGENT_SUMMARY_MODEL ?? requireEnv(env, 'OPENAI_MODEL')
    return new OpenAICompatibleSummarizer({
      baseUrl: requireEnv(env, 'OPENAI_BASE_URL'),
      apiKey: resolveOpenAICompatibleApiKey(env),
      model,
      format: env.AGENT_COMPACTION_FORMAT ?? env.AGENT_SUMMARY_FORMAT ?? 'markdown',
      fetchImpl,
    })
  },

  getConfig(env, { role = 'chat' } = {}) {
    const baseUrl = requireEnv(env, 'OPENAI_BASE_URL')
    const model = role === 'summary'
      ? env.AGENT_SUMMARY_MODEL ?? requireEnv(env, 'OPENAI_MODEL')
      : requireEnv(env, 'OPENAI_MODEL')
    return {
      provider: 'openai-compatible',
      baseUrl,
      model,
      configured: Boolean(baseUrl && model && resolveOpenAICompatibleApiKey(env)),
    }
  },
}

export function normalizeProvider(value) {
  return String(value ?? '').trim().toLowerCase()
}

function resolveOpenAICompatibleApiKey(env) {
  return env.OPENAI_API_KEY ?? env.DEEPSEEK_API_KEY ?? ''
}

function requireEnv(env, name) {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function throwUnsupportedProvider(provider) {
  if (provider === 'anthropic') {
    throw new Error('Anthropic model provider adapter is not implemented yet')
  }
  if (provider === 'gemini' || provider === 'google') {
    throw new Error('Gemini model provider adapter is not implemented yet')
  }
  throw new Error(`Unsupported model provider value: ${provider}`)
}
