import { createDefaultModelProviderRegistry } from './modelProviderRegistry.mjs'

const defaultRegistry = createDefaultModelProviderRegistry()

export function createModelProviderFromEnv(
  env = process.env,
  { fetchImpl = globalThis.fetch, registry = defaultRegistry } = {},
) {
  return registry.createModelProviderFromEnv(env, { fetchImpl })
}

export function createSummarizerFromEnv(
  env = process.env,
  { fetchImpl = globalThis.fetch, registry = defaultRegistry } = {},
) {
  return registry.createSummarizerFromEnv(env, { fetchImpl })
}

export function getModelProviderConfigFromEnv(
  env = process.env,
  { registry = defaultRegistry } = {},
) {
  return registry.getConfigFromEnv(env)
}
