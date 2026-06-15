import { SessionStore } from '../session/sessionStoreBase.mjs'

export class SqlSessionStore extends SessionStore {
  constructor({ adapter, dialect }) {
    super()
    this.adapter = adapter
    this.dialect = dialect
  }

  async getOrCreateSession(sessionId, metadata = {}) {
    const now = new Date().toISOString()
    this.adapter.run(this.dialect.insertSessionIgnoreSql, [
      sessionId,
      JSON.stringify(metadata),
      now,
      now,
    ])

    const row = this.adapter.get('SELECT * FROM sessions WHERE id = ?', [sessionId])

    return {
      id: row.id,
      metadata: JSON.parse(row.metadata_json || '{}'),
      messages: this.#readJsonRows('messages', sessionId, 'message_json'),
      platformMessages: this.#readJsonRows(
        'platform_messages',
        sessionId,
        'message_json',
      ),
      toolCalls: this.#readJsonRows('tool_calls', sessionId, 'tool_call_json'),
      permissionAudit: this.#readJsonRows(
        'permission_audit',
        sessionId,
        'audit_json',
      ),
      conversationSummaries: this.#readConversationSummaries(sessionId),
      agentTurns: this.#readJsonRows('agent_turns', sessionId, 'turn_json'),
      memoryCandidates: this.#readJsonRows(
        'memory_candidates',
        sessionId,
        'candidate_json',
      ),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async appendMessages(sessionId, messages) {
    await this.getOrCreateSession(sessionId)
    const now = new Date().toISOString()
    for (const message of messages) {
      this.adapter.run(
        'INSERT INTO messages (session_id, message_json, created_at) VALUES (?, ?, ?)',
        [sessionId, JSON.stringify(message), now],
      )
    }
    this.#touch(sessionId, now)
  }

  async appendPlatformMessage(message) {
    await this.getOrCreateSession(message.sessionId)
    const now = new Date().toISOString()
    const existing =
      message.messageId == null
        ? null
        : this.adapter.get(
            'SELECT message_json AS payload FROM platform_messages WHERE session_id = ? AND message_id = ?',
            [message.sessionId, message.messageId],
          )
    if (existing) return JSON.parse(existing.payload)

    this.adapter.run(
      `INSERT INTO platform_messages
       (session_id, message_id, sender_id, text, timestamp, message_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        message.sessionId,
        message.messageId ?? null,
        message.senderId ?? null,
        message.text ?? '',
        message.timestamp ?? now,
        JSON.stringify(message),
        now,
      ],
    )
    this.#touch(message.sessionId, now)
    return message
  }

  async getPlatformMessages(sessionId) {
    await this.getOrCreateSession(sessionId)
    return this.#readJsonRows('platform_messages', sessionId, 'message_json')
  }

  async getRecentPlatformMessages(sessionId, limit) {
    const messages = await this.getPlatformMessages(sessionId)
    return messages.slice(Math.max(0, messages.length - limit))
  }

  async searchPlatformMessages(sessionId, { query, limit = 20, senderId } = {}) {
    await this.getOrCreateSession(sessionId)
    const normalizedQuery = String(query ?? '').trim()
    if (!normalizedQuery) return []
    const clauses = ['session_id = ?', "text LIKE ? ESCAPE '\\'"]
    const params = [sessionId, `%${escapeLike(normalizedQuery)}%`]
    if (senderId) {
      clauses.push('sender_id = ?')
      params.push(senderId)
    }
    const boundedLimit = Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 20))
    params.push(boundedLimit)
    return this.adapter
      .all(
        `SELECT message_json AS payload
         FROM platform_messages
         WHERE ${clauses.join(' AND ')}
         ORDER BY id DESC
         LIMIT ?`,
        params,
      )
      .reverse()
      .map(row => JSON.parse(row.payload))
  }

  async appendToolCall(sessionId, toolCall) {
    await this.getOrCreateSession(sessionId)
    const now = new Date().toISOString()
    this.adapter.run(
      'INSERT INTO tool_calls (session_id, tool_call_json, created_at) VALUES (?, ?, ?)',
      [sessionId, JSON.stringify(toolCall), now],
    )
    this.#touch(sessionId, now)
  }

  async appendPermissionAudit(sessionId, auditEntry) {
    await this.getOrCreateSession(sessionId)
    const now = new Date().toISOString()
    this.adapter.run(
      'INSERT INTO permission_audit (session_id, audit_json, created_at) VALUES (?, ?, ?)',
      [sessionId, JSON.stringify(auditEntry), now],
    )
    this.#touch(sessionId, now)
  }

  async appendConversationSummary(sessionId, summary) {
    await this.getOrCreateSession(sessionId)
    const now = new Date().toISOString()
    this.adapter.run(
      `INSERT INTO conversation_summaries
       (session_id, summary_json, version, status, provider, model, prompt_version,
        from_message_id, to_message_id, input_token_estimate, output_token_estimate,
        compression_ratio, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        JSON.stringify(summary),
        summary.version ?? null,
        summary.status ?? null,
        summary.provider ?? null,
        summary.model ?? null,
        summary.promptVersion ?? null,
        summary.fromMessageId ?? null,
        summary.toMessageId ?? null,
        summary.inputTokenEstimate ?? null,
        summary.outputTokenEstimate ?? null,
        summary.compressionRatio ?? null,
        now,
      ],
    )
    this.#touch(sessionId, now)
  }

  async appendAgentTurn(turn) {
    await this.getOrCreateSession(turn.sessionId)
    const now = new Date().toISOString()
    const stored = {
      status: 'running',
      createdAt: now,
      ...turn,
    }
    const result = this.adapter.run(
      'INSERT INTO agent_turns (session_id, turn_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [turn.sessionId, JSON.stringify(stored), now, now],
    )
    stored.id = stored.id ?? `turn-${result.lastInsertId}`
    this.adapter.run('UPDATE agent_turns SET turn_json = ? WHERE id = ?', [
      JSON.stringify(stored),
      result.lastInsertId,
    ])
    this.#touch(turn.sessionId, now)
    return stored
  }

  async updateAgentTurn(turnId, patch) {
    const rows = this.adapter.all(
      'SELECT id, session_id, turn_json FROM agent_turns ORDER BY id ASC',
    )
    const now = new Date().toISOString()
    for (const row of rows) {
      const turn = JSON.parse(row.turn_json)
      if (turn.id === turnId) {
        const updated = { ...turn, ...patch, updatedAt: now }
        this.adapter.run('UPDATE agent_turns SET turn_json = ?, updated_at = ? WHERE id = ?', [
          JSON.stringify(updated),
          now,
          row.id,
        ])
        this.#touch(row.session_id, now)
        return updated
      }
    }
    return null
  }

  async appendMemoryCandidate(candidate) {
    await this.getOrCreateSession(candidate.sessionId)
    const now = new Date().toISOString()
    const stored = {
      status: 'candidate',
      createdAt: now,
      ...candidate,
    }
    const result = this.adapter.run(
      `INSERT INTO memory_candidates
       (session_id, scope, subject_id, status, candidate_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        candidate.sessionId,
        candidate.scope,
        candidate.subjectId,
        stored.status,
        JSON.stringify(stored),
        now,
        now,
      ],
    )
    stored.id = stored.id ?? `memory-${result.lastInsertId}`
    this.adapter.run('UPDATE memory_candidates SET candidate_json = ? WHERE id = ?', [
      JSON.stringify(stored),
      result.lastInsertId,
    ])
    this.#touch(candidate.sessionId, now)
    return stored
  }

  async activateMemoryCandidate(candidateId, metadata = {}) {
    const rows = this.adapter.all(
      'SELECT id, session_id, candidate_json FROM memory_candidates ORDER BY id ASC',
    )
    const now = new Date().toISOString()
    for (const row of rows) {
      const candidate = JSON.parse(row.candidate_json)
      if (candidate.id === candidateId) {
        const updated = {
          ...candidate,
          status: 'active',
          approvedBy: metadata.approvedBy ?? candidate.approvedBy ?? null,
          approvedAt: metadata.approvedAt ?? now,
          updatedAt: now,
        }
        this.adapter.run(
          'UPDATE memory_candidates SET status = ?, candidate_json = ?, updated_at = ? WHERE id = ?',
          ['active', JSON.stringify(updated), now, row.id],
        )
        this.#touch(row.session_id, now)
        return updated
      }
    }
    return null
  }

  async listMemoryCandidates({ scope, subjectId } = {}) {
    let sql = 'SELECT candidate_json AS payload FROM memory_candidates'
    const clauses = []
    const params = []
    if (scope) {
      clauses.push('scope = ?')
      params.push(scope)
    }
    if (subjectId) {
      clauses.push('subject_id = ?')
      params.push(subjectId)
    }
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`
    sql += ' ORDER BY id ASC'
    return this.adapter.all(sql, params).map(row => JSON.parse(row.payload))
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
    await this.getOrCreateSession(sessionId)
    const count = this.adapter.get(
      'SELECT COUNT(*) AS count FROM conversation_summaries WHERE session_id = ?',
      [sessionId],
    ).count
    this.adapter.run('DELETE FROM conversation_summaries WHERE session_id = ?', [sessionId])
    this.#touch(sessionId, new Date().toISOString())
    return { sessionId, cleared: count }
  }

  async clearSessionContext(sessionId) {
    await this.getOrCreateSession(sessionId)
    const counts = {
      platformMessages: this.adapter.get(
        'SELECT COUNT(*) AS count FROM platform_messages WHERE session_id = ?',
        [sessionId],
      ).count,
      modelMessages: this.adapter.get(
        'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?',
        [sessionId],
      ).count,
      summaries: this.adapter.get(
        'SELECT COUNT(*) AS count FROM conversation_summaries WHERE session_id = ?',
        [sessionId],
      ).count,
    }
    this.adapter.run('DELETE FROM platform_messages WHERE session_id = ?', [sessionId])
    this.adapter.run('DELETE FROM messages WHERE session_id = ?', [sessionId])
    this.adapter.run('DELETE FROM conversation_summaries WHERE session_id = ?', [sessionId])
    this.#touch(sessionId, new Date().toISOString())
    return { sessionId, cleared: counts }
  }

  async deleteMemoryCandidate(candidateId) {
    const rows = this.adapter.all(
      'SELECT id, session_id, candidate_json FROM memory_candidates ORDER BY id ASC',
    )
    const now = new Date().toISOString()
    for (const row of rows) {
      const candidate = JSON.parse(row.candidate_json)
      if (candidate.id === candidateId) {
        const updated = { ...candidate, status: 'deleted', deletedAt: now, updatedAt: now }
        this.adapter.run(
          'UPDATE memory_candidates SET status = ?, candidate_json = ?, updated_at = ? WHERE id = ?',
          ['deleted', JSON.stringify(updated), now, row.id],
        )
        this.#touch(row.session_id, now)
        return updated
      }
    }
    return null
  }

  close() {
    this.adapter.close()
  }

  #readJsonRows(tableName, sessionId, columnName) {
    return this.adapter
      .all(
        `SELECT ${columnName} AS payload FROM ${tableName} WHERE session_id = ? ORDER BY id ASC`,
        [sessionId],
      )
      .map(row => JSON.parse(row.payload))
  }

  #readConversationSummaries(sessionId) {
    return this.adapter
      .all(
        `SELECT summary_json AS payload, version, status, provider, model, prompt_version,
                from_message_id, to_message_id, input_token_estimate,
                output_token_estimate, compression_ratio
         FROM conversation_summaries
         WHERE session_id = ?
         ORDER BY id ASC`,
        [sessionId],
      )
      .map(row => mergeSummaryColumns(JSON.parse(row.payload), row))
  }

  #touch(sessionId, timestamp) {
    this.adapter.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [timestamp, sessionId])
  }
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

function mergeSummaryColumns(summary, row) {
  return {
    ...summary,
    version: row.version ?? summary.version,
    status: row.status ?? summary.status,
    provider: row.provider ?? summary.provider,
    model: row.model ?? summary.model,
    promptVersion: row.prompt_version ?? summary.promptVersion,
    fromMessageId: row.from_message_id ?? summary.fromMessageId,
    toMessageId: row.to_message_id ?? summary.toMessageId,
    inputTokenEstimate: row.input_token_estimate ?? summary.inputTokenEstimate,
    outputTokenEstimate: row.output_token_estimate ?? summary.outputTokenEstimate,
    compressionRatio: row.compression_ratio ?? summary.compressionRatio,
  }
}
