import { SessionStore } from './sessionStoreBase.mjs'

export class InMemorySessionStore extends SessionStore {
  #sessions = new Map()
  #agentTurnSeq = 0
  #memoryCandidateSeq = 0

  async getOrCreateSession(sessionId, metadata = {}) {
    const existing = this.#sessions.get(sessionId)
    if (existing) return existing

    const session = {
      id: sessionId,
      metadata,
      messages: [],
      platformMessages: [],
      toolCalls: [],
      permissionAudit: [],
      conversationSummaries: [],
      agentTurns: [],
      memoryCandidates: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.#sessions.set(sessionId, session)
    return session
  }

  async appendMessages(sessionId, messages) {
    const session = await this.getOrCreateSession(sessionId)
    session.messages.push(...messages)
    session.updatedAt = new Date().toISOString()
  }

  async appendPlatformMessage(message) {
    const session = await this.getOrCreateSession(message.sessionId)
    if (
      message.messageId &&
      session.platformMessages.some(item => item.messageId === message.messageId)
    ) {
      return session.platformMessages.find(item => item.messageId === message.messageId)
    }
    session.platformMessages.push({ ...message })
    session.updatedAt = new Date().toISOString()
    return message
  }

  async getPlatformMessages(sessionId) {
    const session = await this.getOrCreateSession(sessionId)
    return [...session.platformMessages]
  }

  async getRecentPlatformMessages(sessionId, limit) {
    const messages = await this.getPlatformMessages(sessionId)
    return messages.slice(Math.max(0, messages.length - limit))
  }

  async searchPlatformMessages(sessionId, { query, limit = 20, senderId } = {}) {
    const normalizedQuery = String(query ?? '').toLowerCase()
    if (!normalizedQuery) return []
    const messages = await this.getPlatformMessages(sessionId)
    return messages
      .filter(message => {
        if (senderId && message.senderId !== senderId) return false
        return String(message.text ?? '').toLowerCase().includes(normalizedQuery)
      })
      .slice(-limit)
  }

  async appendToolCall(sessionId, toolCall) {
    const session = await this.getOrCreateSession(sessionId)
    session.toolCalls.push(toolCall)
    session.updatedAt = new Date().toISOString()
  }

  async appendPermissionAudit(sessionId, auditEntry) {
    const session = await this.getOrCreateSession(sessionId)
    session.permissionAudit.push(auditEntry)
    session.updatedAt = new Date().toISOString()
  }

  async appendConversationSummary(sessionId, summary) {
    const session = await this.getOrCreateSession(sessionId)
    session.conversationSummaries.push(summary)
    session.updatedAt = new Date().toISOString()
  }

  async appendAgentTurn(turn) {
    const session = await this.getOrCreateSession(turn.sessionId)
    const stored = {
      id: turn.id ?? `turn-${++this.#agentTurnSeq}`,
      status: 'running',
      createdAt: new Date().toISOString(),
      ...turn,
    }
    session.agentTurns.push(stored)
    session.updatedAt = new Date().toISOString()
    return stored
  }

  async updateAgentTurn(turnId, patch) {
    for (const session of this.#sessions.values()) {
      const turn = session.agentTurns.find(item => item.id === turnId)
      if (turn) {
        Object.assign(turn, patch, { updatedAt: new Date().toISOString() })
        session.updatedAt = new Date().toISOString()
        return turn
      }
    }
    return null
  }

  async appendMemoryCandidate(candidate) {
    const session = await this.getOrCreateSession(candidate.sessionId)
    const stored = {
      id: candidate.id ?? `memory-${++this.#memoryCandidateSeq}`,
      status: 'candidate',
      createdAt: new Date().toISOString(),
      ...candidate,
    }
    session.memoryCandidates.push(stored)
    session.updatedAt = new Date().toISOString()
    return stored
  }

  async activateMemoryCandidate(candidateId, metadata = {}) {
    for (const session of this.#sessions.values()) {
      const candidate = session.memoryCandidates.find(item => item.id === candidateId)
      if (candidate) {
        candidate.status = 'active'
        if (metadata.approvedBy) candidate.approvedBy = metadata.approvedBy
        candidate.approvedAt = metadata.approvedAt ?? new Date().toISOString()
        candidate.updatedAt = new Date().toISOString()
        session.updatedAt = new Date().toISOString()
        return candidate
      }
    }
    return null
  }

  async listMemoryCandidates({ scope, subjectId } = {}) {
    const candidates = []
    for (const session of this.#sessions.values()) {
      candidates.push(...session.memoryCandidates)
    }
    return candidates.filter(candidate => {
      if (scope && candidate.scope !== scope) return false
      if (subjectId && candidate.subjectId !== subjectId) return false
      return true
    })
  }

  async getSessionStatus(sessionId) {
    const session = await this.getOrCreateSession(sessionId)
    return {
      sessionId,
      messageCount: session.platformMessages.length,
      modelMessageCount: session.messages.length,
      summaryCount: session.conversationSummaries.length,
      activeMemoryCount: session.memoryCandidates.filter(item => item.status === 'active').length,
      latestTurn: session.agentTurns.at(-1) ?? null,
      updatedAt: session.updatedAt,
    }
  }

  async clearSessionSummary(sessionId) {
    const session = await this.getOrCreateSession(sessionId)
    const cleared = session.conversationSummaries.length
    session.conversationSummaries = []
    session.updatedAt = new Date().toISOString()
    return { sessionId, cleared }
  }

  async clearSessionContext(sessionId) {
    const session = await this.getOrCreateSession(sessionId)
    const cleared = {
      platformMessages: session.platformMessages.length,
      modelMessages: session.messages.length,
      summaries: session.conversationSummaries.length,
    }
    session.platformMessages = []
    session.messages = []
    session.conversationSummaries = []
    session.updatedAt = new Date().toISOString()
    return { sessionId, cleared }
  }

  async deleteMemoryCandidate(candidateId) {
    for (const session of this.#sessions.values()) {
      const candidate = session.memoryCandidates.find(item => item.id === candidateId)
      if (candidate) {
        candidate.status = 'deleted'
        candidate.deletedAt = new Date().toISOString()
        candidate.updatedAt = new Date().toISOString()
        session.updatedAt = new Date().toISOString()
        return candidate
      }
    }
    return null
  }
}
