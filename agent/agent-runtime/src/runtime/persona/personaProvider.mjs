import { readFile } from 'node:fs/promises'

export class FilePersonaProvider {
  constructor({
    filePath = null,
    promptManager = null,
  } = {}) {
    this.filePath = filePath
    this.promptManager = promptManager
    this.cachedConfig = null
  }

  async resolve({ sessionId = null, senderId = null } = {}) {
    const config = await this.#loadConfig()
    const personas = new Map((config.personas ?? []).map(persona => [persona.personaKey, persona]))
    const bindings = config.bindings ?? []

    const userBinding = senderId
      ? bindings.find(binding => binding.scope === 'user' && binding.subjectId === senderId)
      : null
    const userPersona = resolveBoundPersona(userBinding, personas, 'user_binding')
    if (userPersona) return userPersona

    const sessionBinding = sessionId
      ? bindings.find(binding => binding.scope === 'session' && binding.subjectId === sessionId)
      : null
    const sessionPersona = resolveBoundPersona(sessionBinding, personas, 'session_binding')
    if (sessionPersona) return sessionPersona

    const defaultPersona = config.defaultPersonaKey
      ? personaToResult(personas.get(config.defaultPersonaKey), 'default_persona')
      : null
    if (defaultPersona) return defaultPersona

    const chatPersona = await this.promptManager?.getPrompt?.('CHAT_PERSONA')
    if (chatPersona?.systemPrompt?.trim()) {
      return {
        source: 'chat_persona',
        personaKey: 'CHAT_PERSONA',
        name: chatPersona.name ?? 'Chat Persona',
        content: chatPersona.systemPrompt,
        description: chatPersona.description ?? '',
      }
    }

    return {
      source: 'fallback',
      personaKey: 'CHAT_PERSONA',
      name: 'Chat Persona',
      content: '',
      description: '',
    }
  }

  async #loadConfig() {
    if (this.cachedConfig) return this.cachedConfig
    if (!this.filePath) {
      this.cachedConfig = emptyConfig()
      return this.cachedConfig
    }
    try {
      const payload = JSON.parse(await readFile(this.filePath, 'utf8'))
      this.cachedConfig = normalizeConfig(payload)
      return this.cachedConfig
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.cachedConfig = emptyConfig()
        return this.cachedConfig
      }
      throw error
    }
  }
}

export class DatabasePersonaProvider {
  constructor({
    personaStore = null,
    fallbackProvider = null,
    promptManager = null,
  } = {}) {
    this.personaStore = personaStore
    this.fallbackProvider = fallbackProvider
    this.promptManager = promptManager
  }

  async resolve({ sessionId = null, senderId = null, metadata = {} } = {}) {
    const config = this.personaStore?.getCurrentPersonaConfig?.()
    const persona = resolveFromConfig(config, { sessionId, senderId })
    if (persona) return persona
    if (this.fallbackProvider?.resolve) {
      const fallback = await this.fallbackProvider.resolve({ sessionId, senderId, metadata })
      if (fallback?.content?.trim()) return fallback
    }

    const chatPersona = await this.promptManager?.getPrompt?.('CHAT_PERSONA')
    if (chatPersona?.systemPrompt?.trim()) {
      return {
        source: 'chat_persona',
        personaKey: 'CHAT_PERSONA',
        name: chatPersona.name ?? 'Chat Persona',
        content: chatPersona.systemPrompt,
        description: chatPersona.description ?? '',
      }
    }

    return {
      source: 'fallback',
      personaKey: 'CHAT_PERSONA',
      name: 'Chat Persona',
      content: '',
      description: '',
    }
  }
}

function resolveBoundPersona(binding, personas, source) {
  if (!binding) return null
  return personaToResult(personas.get(binding.personaKey), source)
}

function resolveFromConfig(config, { sessionId, senderId } = {}) {
  if (!config) return null
  const personas = new Map((config.personas ?? []).map(persona => [persona.personaKey, persona]))
  const bindings = config.bindings ?? []

  const userBinding = senderId
    ? bindings.find(binding => binding.scope === 'user' && binding.subjectId === senderId)
    : null
  const userPersona = resolveBoundPersona(userBinding, personas, 'user_binding')
  if (userPersona) return userPersona

  const sessionBinding = sessionId
    ? bindings.find(binding => binding.scope === 'session' && binding.subjectId === sessionId)
    : null
  const sessionPersona = resolveBoundPersona(sessionBinding, personas, 'session_binding')
  if (sessionPersona) return sessionPersona

  return config.defaultPersonaKey
    ? personaToResult(personas.get(config.defaultPersonaKey), 'default_persona')
    : null
}

function personaToResult(persona, source) {
  if (!persona) return null
  return {
    source,
    personaKey: persona.personaKey,
    name: persona.name,
    content: persona.content,
    description: persona.description ?? '',
  }
}

function normalizeConfig(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return emptyConfig()
  }
  return {
    defaultPersonaKey:
      typeof payload.defaultPersonaKey === 'string' && payload.defaultPersonaKey.length > 0
        ? payload.defaultPersonaKey
        : null,
    personas: Array.isArray(payload.personas)
      ? payload.personas
          .map(normalizePersona)
          .filter(Boolean)
      : [],
    bindings: Array.isArray(payload.bindings)
      ? payload.bindings
          .map(normalizeBinding)
          .filter(Boolean)
      : [],
  }
}

function normalizePersona(persona) {
  if (!persona || typeof persona !== 'object' || Array.isArray(persona)) return null
  if (typeof persona.personaKey !== 'string' || persona.personaKey.length === 0) return null
  if (typeof persona.content !== 'string' || persona.content.length === 0) return null
  return {
    personaKey: persona.personaKey,
    name: typeof persona.name === 'string' && persona.name.length > 0 ? persona.name : persona.personaKey,
    description: typeof persona.description === 'string' ? persona.description : '',
    content: persona.content,
  }
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null
  if (!['user', 'session'].includes(binding.scope)) return null
  if (typeof binding.subjectId !== 'string' || binding.subjectId.length === 0) return null
  if (typeof binding.personaKey !== 'string' || binding.personaKey.length === 0) return null
  return {
    scope: binding.scope,
    subjectId: binding.subjectId,
    personaKey: binding.personaKey,
  }
}

function emptyConfig() {
  return {
    defaultPersonaKey: null,
    personas: [],
    bindings: [],
  }
}
