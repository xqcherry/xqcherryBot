export class PromptManager {
  constructor({
    promptStore = null,
    fallbackPrompts = {},
  } = {}) {
    this.promptStore = promptStore
    this.fallbackPrompts = new Map(
      Object.entries(fallbackPrompts).map(([key, prompt]) => [key, normalizePrompt(prompt)]),
    )
    this.cache = new Map()
  }

  async getPrompt(promptKey) {
    requirePromptKey(promptKey)
    const current = await this.promptStore?.getCurrentPrompt?.(promptKey)
    if (current?.systemPrompt?.trim() || current?.userPrompt?.trim()) {
      const cached = this.cache.get(promptKey)
      if (cached?.versionId === current.versionId) return cached.prompt
      const prompt = normalizePrompt(current)
      this.cache.set(promptKey, { versionId: current.versionId, prompt })
      return prompt
    }
    const fallback = this.fallbackPrompts.get(promptKey)
    if (fallback) return fallback
    return null
  }

  async renderPrompt(promptKey, variables = {}) {
    const prompt = await this.getPrompt(promptKey)
    if (!prompt) return null
    return {
      ...prompt,
      systemPrompt: renderTemplate(prompt.systemPrompt, variables, promptKey),
      userPrompt: renderTemplate(prompt.userPrompt, variables, promptKey),
    }
  }
}

function normalizePrompt(prompt) {
  return {
    promptKey: prompt.promptKey,
    name: prompt.name ?? '',
    description: prompt.description ?? '',
    systemPrompt: prompt.systemPrompt ?? '',
    userPrompt: prompt.userPrompt ?? '',
    extraJson: prompt.extraJson ?? null,
    sourceVersionNo: prompt.sourceVersionNo ?? null,
    sourcePublishedAt: prompt.sourcePublishedAt ?? null,
    importedAt: prompt.importedAt ?? null,
    versionId: prompt.versionId ?? null,
    fallback: Boolean(prompt.fallback),
  }
}

function renderTemplate(template, variables, promptKey) {
  if (!template) return ''
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, name) => {
    if (!(name in variables)) {
      throw new Error(`Missing prompt variable "${name}" for ${promptKey}`)
    }
    const value = variables[name]
    if (value == null) return ''
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  })
}

function requirePromptKey(promptKey) {
  if (typeof promptKey !== 'string' || promptKey.trim().length === 0) {
    throw new Error('promptKey is required')
  }
}
