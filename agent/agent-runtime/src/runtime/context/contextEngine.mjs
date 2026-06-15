import { CachePolicy } from './cachePolicy.mjs'
import { CompactionPolicy, ContextCompactionEngine } from './contextCompactionEngine.mjs'
import { contextBlocksToMessages, createContextBlock } from './contextBlocks.mjs'
import { MemorySelector, memoryBlock } from '../memory/memorySelector.mjs'
import {
  CHAT_PERSONA_PROMPT_KEY,
  fallbackChatPersona,
} from '../prompt/promptTemplateStore.mjs'
import { SkillProvider, skillToBlock } from '../skill/skillProvider.mjs'
import { TurnProfileBuilder } from './turnProfileBuilder.mjs'

export class ContextEngine {
  constructor({
    sessionStore = null,
    recentMessageLimit = 20,
    uncompactedMessageLimit = 80,
    senderContextLimit = 6,
    summarizer = defaultSummarizer,
    promptTemplateStore = null,
    promptManager = null,
    chatPromptKeys = ['CHAT_CONSTRAINTS', CHAT_PERSONA_PROMPT_KEY, 'CHAT_RESPONSE_POLICY'],
    promptVariables = {},
    personaProvider = null,
    skillProvider = new SkillProvider(),
    turnProfileBuilder = new TurnProfileBuilder(),
    statusBarBuilder = null,
    compactionEngine = null,
    memorySelector = null,
    cachePolicy = new CachePolicy(),
  }) {
    this.sessionStore = sessionStore
    this.recentMessageLimit = recentMessageLimit
    this.senderContextLimit = senderContextLimit
    this.summarizer = summarizer
    this.promptTemplateStore = promptTemplateStore
    this.promptManager = promptManager
    this.chatPromptKeys = chatPromptKeys
    this.promptVariables = promptVariables
    this.personaProvider = personaProvider
    this.skillProvider = skillProvider
    this.turnProfileBuilder = turnProfileBuilder
    this.statusBarBuilder = statusBarBuilder
    this.memorySelector = memorySelector ?? (sessionStore ? new MemorySelector({ sessionStore }) : null)
    this.compactionEngine = compactionEngine ?? (sessionStore
      ? new ContextCompactionEngine({
          sessionStore,
          policy: new CompactionPolicy({
            recentMessageLimit,
            uncompactedMessageLimit,
          }),
          summarizer,
        })
      : null)
    this.cachePolicy = cachePolicy
  }

  async build(input) {
    const rawBlocks = await this.buildBlocks(input)
    const blocks = this.cachePolicy ? this.cachePolicy.apply(rawBlocks) : rawBlocks
    return {
      blocks,
      messages: contextBlocksToMessages(blocks),
    }
  }

  async buildBlocks(input) {
    if (!this.sessionStore) {
      throw new Error('ContextEngine requires sessionStore')
    }

    const {
      sessionId,
      systemPrompt,
      text,
      senderId,
      messageId,
      currentPhase,
      contextPressure,
      failureState,
      toolState,
      latestToolFailure,
      permissionState,
      runtimeState,
      blocked,
      waitingForUser,
      metadata,
      selectedTools,
    } = input
    const compactionResult = this.compactionEngine
      ? await this.compactionEngine.compact(sessionId, { currentMessageId: messageId })
      : { status: 'skipped', reason: 'compaction_disabled' }

    const session = await this.sessionStore.getOrCreateSession(sessionId)
    const runtimeDiagnostics = buildRuntimeDiagnostics(session, {
      toolState,
      latestToolFailure,
      permissionState,
      runtimeState,
      blocked,
      waitingForUser,
    })
    const latestSummary = session.conversationSummaries.at(-1)
    const allMessages = await this.sessionStore.getPlatformMessages(sessionId)
    const recentMessages = selectRecentMessages(allMessages, {
      limit: this.recentMessageLimit,
      senderId,
      senderContextLimit: this.senderContextLimit,
      currentMessageId: messageId,
    })

    const turnProfile = this.turnProfileBuilder.build({
      sessionId,
      senderId,
      messageId,
      text,
      metadata,
      selectedTools,
      latestToolFailure: runtimeDiagnostics.latestToolFailure,
    })
    const contextBlocks = []
    contextBlocks.push(...(await this.#resolvePromptBlocks({ sessionId, senderId, metadata })))
    contextBlocks.push(turnContextBlock(turnProfile))
    contextBlocks.push(...(await this.#resolveSkillBlocks(turnProfile, runtimeDiagnostics)))
    const activeMemories = this.memorySelector
      ? await this.memorySelector.select({ sessionId, senderId })
      : []
    if (this.statusBarBuilder) {
      contextBlocks.push(this.statusBarBuilder.build({
        text,
        currentPhase,
        contextPressure,
        latestSummary,
        activeMemories,
        failureState,
        compactionResult,
        ...runtimeDiagnostics,
      }))
    }
    if (activeMemories.length > 0) {
      contextBlocks.push(memoryBlock(activeMemories))
    }
    if (latestSummary?.summary) {
      contextBlocks.push(summaryBlock(latestSummary))
    }
    if (recentMessages.length > 0) {
      contextBlocks.push(recentRawContextBlock(recentMessages))
    }
    contextBlocks.push(currentUserMessageBlock(turnProfile))
    return contextBlocks
  }

  async #resolveChatPersona() {
    if (!this.promptTemplateStore?.getChatPersonaPrompt) {
      return fallbackChatPersona()
    }
    try {
      const prompt = await this.promptTemplateStore.getChatPersonaPrompt()
      return prompt?.systemPrompt?.trim() ? prompt : fallbackChatPersona()
    } catch {
      return fallbackChatPersona()
    }
  }

  async #resolvePromptBlocks({ sessionId, senderId, metadata } = {}) {
    if (this.promptManager) {
      const blocks = await this.#resolveManagedPromptBlocks({ sessionId, senderId, metadata })
      if (blocks.length > 0) return blocks
    }
    return [chatPersonaBlock(await this.#resolveChatPersona())]
  }

  async #resolveManagedPromptBlocks({ sessionId, senderId, metadata } = {}) {
    const blocks = []
    const promptKeys = this.chatPromptKeys?.length
      ? this.chatPromptKeys
      : ['CHAT_CONSTRAINTS', CHAT_PERSONA_PROMPT_KEY, 'CHAT_RESPONSE_POLICY']

    for (const promptKey of promptKeys) {
      if (promptKey === CHAT_PERSONA_PROMPT_KEY) {
        const persona = await this.#resolveActivePersona({ sessionId, senderId, metadata })
        if (persona?.content?.trim()) {
          blocks.push(activePersonaBlock(persona))
        }
        continue
      }
      const prompt = await this.promptManager.renderPrompt(promptKey, this.promptVariables)
      if (!prompt?.systemPrompt?.trim()) continue
      blocks.push(promptBlock(prompt))
    }

    if (!promptKeys.includes(CHAT_PERSONA_PROMPT_KEY)) {
      const persona = await this.#resolveActivePersona({ sessionId, senderId, metadata })
      if (persona?.content?.trim()) {
        const insertAt = Math.min(1, blocks.length)
        blocks.splice(insertAt, 0, activePersonaBlock(persona))
      }
    }
    return blocks
  }

  async #resolveActivePersona({ sessionId, senderId, metadata } = {}) {
    if (this.personaProvider?.resolve) {
      const persona = await this.personaProvider.resolve({ sessionId, senderId, metadata })
      if (persona?.content?.trim()) return persona
    }
    const prompt = await this.promptManager.renderPrompt(CHAT_PERSONA_PROMPT_KEY, this.promptVariables)
    if (!prompt?.systemPrompt?.trim()) return null
    return {
      source: prompt.fallback ? 'chat_persona_fallback' : 'chat_persona',
      personaKey: prompt.promptKey ?? CHAT_PERSONA_PROMPT_KEY,
      name: prompt.name ?? 'Chat Persona',
      description: prompt.description ?? '',
      content: prompt.systemPrompt,
      sourceVersionNo: prompt.sourceVersionNo ?? null,
      fallback: Boolean(prompt.fallback),
    }
  }

  async #resolveSkillBlocks(turnProfile, runtimeDiagnostics) {
    if (!this.skillProvider?.resolve) return []
    const skills = await this.skillProvider.resolve(turnProfile, runtimeDiagnostics)
    return (skills ?? []).map(skillToBlock)
  }
}

function promptBlock(prompt) {
  return createContextBlock({
    id: `prompt:${prompt.promptKey}`,
    type: 'prompt',
    stability: 'stable',
    role: 'system',
    content: prompt.systemPrompt,
    metadata: {
      promptKey: prompt.promptKey,
      sourceVersionNo: prompt.sourceVersionNo ?? null,
      fallback: Boolean(prompt.fallback),
    },
  })
}

function activePersonaBlock(persona) {
  return createContextBlock({
    id: 'active-persona',
    type: 'persona',
    stability: 'stable',
    role: 'system',
    content: persona.content,
    metadata: {
      source: persona.source ?? null,
      personaKey: persona.personaKey ?? CHAT_PERSONA_PROMPT_KEY,
      name: persona.name ?? null,
      sourceVersionNo: persona.sourceVersionNo ?? null,
      fallback: Boolean(persona.fallback),
    },
  })
}

function chatPersonaBlock(prompt) {
  return createContextBlock({
    id: 'chat-persona',
    type: 'prompt',
    stability: 'stable',
    role: 'system',
    content: prompt.systemPrompt,
    metadata: {
      promptKey: prompt.promptKey ?? CHAT_PERSONA_PROMPT_KEY,
      sourceVersionNo: prompt.sourceVersionNo ?? null,
      fallback: Boolean(prompt.fallback),
    },
  })
}

function turnContextBlock(profile) {
  return createContextBlock({
    id: 'turn-context',
    type: 'turn_context',
    stability: 'dynamic',
    role: 'system',
    content: [
      'Current turn context:',
      `- platform: ${profile.platform ?? 'unknown'}`,
      `- chatType: ${profile.chatType ?? 'unknown'}`,
      `- addressedToAgent: ${profile.addressedToAgent ? 'true' : 'false'}`,
      `- sessionId: ${profile.sessionId ?? 'unknown'}`,
      `- senderId: ${profile.senderId ?? 'unknown'}`,
      `- messageId: ${profile.messageId ?? 'unknown'}`,
    ].join('\n'),
    metadata: {
      platform: profile.platform ?? null,
      chatType: profile.chatType ?? null,
      addressedToAgent: Boolean(profile.addressedToAgent),
      sessionId: profile.sessionId ?? null,
      senderId: profile.senderId ?? null,
      messageId: profile.messageId ?? null,
    },
  })
}

function currentUserMessageBlock(profile) {
  return createContextBlock({
    id: 'current-user-message',
    type: 'current_user_message',
    stability: 'dynamic',
    role: 'user',
    content: profile.text ?? '',
    metadata: {
      messageId: profile.messageId ?? null,
      senderId: profile.senderId ?? null,
    },
  })
}

function buildRuntimeDiagnostics(
  session,
  {
    toolState,
    latestToolFailure,
    permissionState,
    runtimeState,
    blocked,
    waitingForUser,
  } = {},
) {
  const derivedPermissionState = permissionState ?? derivePermissionState(session.permissionAudit)
  return {
    toolState: toolState ?? deriveToolState(session.toolCalls),
    latestToolFailure: latestToolFailure ?? deriveLatestToolFailure(session.toolCalls),
    permissionState: derivedPermissionState,
    runtimeState:
      runtimeState ??
      deriveRuntimeState({
        blocked,
        waitingForUser,
        permissionState: derivedPermissionState,
      }),
  }
}

function deriveToolState(toolCalls = []) {
  const latest = toolCalls.at(-1)
  if (!latest) return 'available'
  const failure = formatToolFailure(latest)
  if (failure !== 'none') return `last tool ${latest.name ?? latest.id ?? 'unknown'} failed`
  return `last tool ${latest.name ?? latest.id ?? 'unknown'} completed`
}

function deriveLatestToolFailure(toolCalls = []) {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const failure = formatToolFailure(toolCalls[index])
    if (failure !== 'none') return failure
  }
  return 'none'
}

function formatToolFailure(toolCall) {
  const result = toolCall?.result
  if (!result || typeof result !== 'object') return 'none'
  if (result.error) {
    return `${toolCall.name ?? toolCall.id ?? 'tool'}: ${String(result.error)}`
  }
  if (result.ok === false) {
    return `${toolCall.name ?? toolCall.id ?? 'tool'}: result ok=false`
  }
  return 'none'
}

function derivePermissionState(permissionAudit = []) {
  const latest = permissionAudit.at(-1)
  if (!latest) return 'default'
  if (latest.type === 'permission_request') {
    return `pending: ${latest.toolName ?? latest.toolCallId ?? 'tool'}`
  }
  if (latest.decision === 'deny') {
    const reason = latest.reason ? `: ${latest.reason}` : ''
    return `denied${reason}`
  }
  if (latest.decision === 'allow') return 'allowed recently'
  return 'default'
}

function deriveRuntimeState({ blocked, waitingForUser, permissionState }) {
  if (blocked) return 'blocked'
  if (waitingForUser || permissionState?.startsWith('pending:')) return 'waiting_for_user'
  return 'active'
}

function summaryBlock(latestSummary) {
  return createContextBlock({
    id: 'short-term-summary',
    type: 'summary',
    stability: 'semi-stable',
    role: 'system',
    content: `Short-term summary of earlier chat:\n${latestSummary.summary}`,
    metadata: {
      fromMessageId: latestSummary.fromMessageId ?? null,
      toMessageId: latestSummary.toMessageId ?? null,
    },
  })
}

function recentRawContextBlock(messages) {
  return createContextBlock({
    id: 'recent-raw-context',
    type: 'recent_raw_context',
    stability: 'dynamic',
    role: 'system',
    content: `Recent raw chat messages:\n${formatRecentMessages(messages)}`,
    metadata: {
      messageIds: messages.map(message => message.messageId).filter(Boolean),
    },
  })
}

function selectRecentMessages(
  messages,
  { limit, senderId, senderContextLimit, currentMessageId } = {},
) {
  const current = currentMessageId
    ? messages.find(message => message.messageId === currentMessageId)
    : null
  const nonCurrent = current
    ? messages.filter(message => message.messageId !== currentMessageId)
    : messages
  const recent = nonCurrent.slice(Math.max(0, nonCurrent.length - limit))
  const senderMessages = senderId
    ? nonCurrent
        .filter(message => message.senderId === senderId)
        .slice(Math.max(0, nonCurrent.filter(message => message.senderId === senderId).length - senderContextLimit))
    : []
  const selected = new Map()
  for (const message of [...senderMessages, ...recent]) {
    selected.set(message.messageId ?? `${message.timestamp}:${message.senderId}:${message.text}`, message)
  }
  const ordered = messages.filter(message =>
    selected.has(message.messageId ?? `${message.timestamp}:${message.senderId}:${message.text}`),
  )
  if (current) ordered.push(current)
  return ordered
}

function formatRecentMessages(messages) {
  return messages
    .map(message => {
      const sender = message.senderId ?? 'unknown'
      const timestamp = message.timestamp ? `[${message.timestamp}] ` : ''
      return `${timestamp}${sender}: ${message.text ?? ''}`
    })
    .join('\n')
}

export async function defaultSummarizer(messages, previousSummary) {
  const previous = previousSummary?.summary
    ? `Previous summary:\n${previousSummary.summary}\n\n`
    : ''
  return `${previous}Compacted chat messages:\n${formatRecentMessages(messages)}`
}
