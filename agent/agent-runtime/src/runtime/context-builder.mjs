const DEFAULT_RECENT_MESSAGE_LIMIT = 20
const DEFAULT_UNCOMPACTED_MESSAGE_LIMIT = 80

export class ContextBuilder {
  constructor({
    sessionStore,
    recentMessageLimit = DEFAULT_RECENT_MESSAGE_LIMIT,
    uncompactedMessageLimit = DEFAULT_UNCOMPACTED_MESSAGE_LIMIT,
    summarizer = defaultSummarizer,
  }) {
    this.sessionStore = sessionStore
    this.recentMessageLimit = recentMessageLimit
    this.uncompactedMessageLimit = uncompactedMessageLimit
    this.summarizer = summarizer
  }

  async build({ sessionId, systemPrompt, text, senderId }) {
    await this.#autoCompact(sessionId)

    const session = await this.sessionStore.getOrCreateSession(sessionId)
    const latestSummary = session.conversationSummaries.at(-1)
    const recentMessages = await this.sessionStore.getRecentPlatformMessages(
      sessionId,
      this.recentMessageLimit,
    )

    const messages = [{ role: 'system', content: systemPrompt }]
    if (latestSummary?.summary) {
      messages.push({
        role: 'system',
        content: `Short-term summary of earlier chat:\n${latestSummary.summary}`,
      })
    }
    if (recentMessages.length > 0) {
      messages.push({
        role: 'system',
        content: `Recent raw chat messages:\n${formatRecentMessages(recentMessages)}`,
      })
    }
    const activeMemories = await this.#activeMemories({ sessionId, senderId })
    if (activeMemories.length > 0) {
      messages.push({
        role: 'system',
        content: `Active long-term memories:\n${activeMemories
          .map(memory => `- (${memory.scope}:${memory.subjectId}) ${memory.summary}`)
          .join('\n')}`,
      })
    }
    messages.push({ role: 'user', content: text })
    return messages
  }

  async #activeMemories({ sessionId, senderId }) {
    if (!this.sessionStore.listActiveMemories) return []
    const sessionMemories = await this.sessionStore.listActiveMemories({
      scope: 'session',
      subjectId: sessionId,
    })
    const userMemories = senderId
      ? await this.sessionStore.listActiveMemories({
          scope: 'user',
          subjectId: senderId,
        })
      : []
    return [...sessionMemories, ...userMemories]
  }

  async #autoCompact(sessionId) {
    const messages = await this.sessionStore.getPlatformMessages(sessionId)
    if (messages.length <= this.uncompactedMessageLimit) return

    const session = await this.sessionStore.getOrCreateSession(sessionId)
    const latestSummary = session.conversationSummaries.at(-1)
    const firstUncoveredIndex = latestSummary?.toMessageId
      ? messages.findIndex(message => message.messageId === latestSummary.toMessageId) + 1
      : 0
    const safeFirstUncoveredIndex = Math.max(0, firstUncoveredIndex)
    const compactUntil = Math.max(
      safeFirstUncoveredIndex,
      messages.length - this.recentMessageLimit,
    )
    const compactable = messages.slice(safeFirstUncoveredIndex, compactUntil)
    if (compactable.length === 0) return

    try {
      const summary = await this.summarizer(compactable, latestSummary)
      await this.sessionStore.appendConversationSummary(sessionId, {
        summary,
        fromMessageId: compactable[0].messageId,
        toMessageId: compactable.at(-1).messageId,
        messageCount: compactable.length,
        createdAt: new Date().toISOString(),
      })
    } catch (_error) {
      // Summary generation is an optimization. The current turn can proceed
      // with recent raw context if the summary model or callback is unavailable.
    }
  }
}

export function microCompact(messages, { maxContentLength = 4000 } = {}) {
  return messages.map(message => {
    if (typeof message.content !== 'string') return message
    if (message.content.length <= maxContentLength) return message
    return {
      ...message,
      content: `${message.content.slice(0, maxContentLength)}\n[truncated]`,
    }
  })
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

async function defaultSummarizer(messages, previousSummary) {
  const previous = previousSummary?.summary
    ? `Previous summary:\n${previousSummary.summary}\n\n`
    : ''
  return `${previous}Compacted chat messages:\n${formatRecentMessages(messages)}`
}
