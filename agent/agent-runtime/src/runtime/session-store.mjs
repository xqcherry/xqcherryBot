import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export class InMemorySessionStore {
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

  async activateMemoryCandidate(candidateId) {
    for (const session of this.#sessions.values()) {
      const candidate = session.memoryCandidates.find(item => item.id === candidateId)
      if (candidate) {
        candidate.status = 'active'
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

  async listActiveMemories(filter = {}) {
    const candidates = await this.listMemoryCandidates(filter)
    return candidates.filter(candidate => candidate.status === 'active')
  }
}

export class SQLiteSessionStore {
  constructor(dbPath) {
    const DatabaseSync = loadDatabaseSync()
    this.db = new DatabaseSync(dbPath)
    this.#initialize()
  }

  async getOrCreateSession(sessionId, metadata = {}) {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, JSON.stringify(metadata), now, now)

    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId)

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
      conversationSummaries: this.#readJsonRows(
        'conversation_summaries',
        sessionId,
        'summary_json',
      ),
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
    const insert = this.db.prepare(
      'INSERT INTO messages (session_id, message_json, created_at) VALUES (?, ?, ?)',
    )
    const now = new Date().toISOString()
    for (const message of messages) {
      insert.run(sessionId, JSON.stringify(message), now)
    }
    this.#touch(sessionId, now)
  }

  async appendPlatformMessage(message) {
    await this.getOrCreateSession(message.sessionId)
    const now = new Date().toISOString()
    const existing =
      message.messageId == null
        ? null
        : this.db
            .prepare(
              'SELECT message_json AS payload FROM platform_messages WHERE session_id = ? AND message_id = ?',
            )
            .get(message.sessionId, message.messageId)
    if (existing) return JSON.parse(existing.payload)

    this.db
      .prepare(
        `INSERT INTO platform_messages
         (session_id, message_id, sender_id, text, timestamp, message_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.sessionId,
        message.messageId ?? null,
        message.senderId ?? null,
        message.text ?? '',
        message.timestamp ?? now,
        JSON.stringify(message),
        now,
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

  async appendToolCall(sessionId, toolCall) {
    await this.getOrCreateSession(sessionId)
    const now = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO tool_calls (session_id, tool_call_json, created_at) VALUES (?, ?, ?)',
      )
      .run(sessionId, JSON.stringify(toolCall), now)
    this.#touch(sessionId, now)
  }

  async appendPermissionAudit(sessionId, auditEntry) {
    await this.getOrCreateSession(sessionId)
    const now = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO permission_audit (session_id, audit_json, created_at) VALUES (?, ?, ?)',
      )
      .run(sessionId, JSON.stringify(auditEntry), now)
    this.#touch(sessionId, now)
  }

  async appendConversationSummary(sessionId, summary) {
    await this.getOrCreateSession(sessionId)
    const now = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO conversation_summaries (session_id, summary_json, created_at) VALUES (?, ?, ?)',
      )
      .run(sessionId, JSON.stringify(summary), now)
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
    const result = this.db
      .prepare(
        'INSERT INTO agent_turns (session_id, turn_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(turn.sessionId, JSON.stringify(stored), now, now)
    stored.id = stored.id ?? `turn-${result.lastInsertRowid}`
    this.db
      .prepare('UPDATE agent_turns SET turn_json = ? WHERE rowid = ?')
      .run(JSON.stringify(stored), result.lastInsertRowid)
    this.#touch(turn.sessionId, now)
    return stored
  }

  async updateAgentTurn(turnId, patch) {
    const rows = this.db
      .prepare('SELECT rowid AS row_id, session_id, turn_json FROM agent_turns ORDER BY rowid ASC')
      .all()
    const now = new Date().toISOString()
    for (const row of rows) {
      const turn = JSON.parse(row.turn_json)
      if (turn.id === turnId) {
        const updated = { ...turn, ...patch, updatedAt: now }
        this.db
          .prepare('UPDATE agent_turns SET turn_json = ?, updated_at = ? WHERE rowid = ?')
          .run(JSON.stringify(updated), now, row.row_id)
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
    const result = this.db
      .prepare(
        `INSERT INTO memory_candidates
         (session_id, scope, subject_id, status, candidate_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.sessionId,
        candidate.scope,
        candidate.subjectId,
        stored.status,
        JSON.stringify(stored),
        now,
        now,
      )
    stored.id = stored.id ?? `memory-${result.lastInsertRowid}`
    this.db
      .prepare('UPDATE memory_candidates SET candidate_json = ? WHERE rowid = ?')
      .run(JSON.stringify(stored), result.lastInsertRowid)
    this.#touch(candidate.sessionId, now)
    return stored
  }

  async activateMemoryCandidate(candidateId) {
    const rows = this.db
      .prepare(
        'SELECT rowid AS row_id, session_id, candidate_json FROM memory_candidates ORDER BY rowid ASC',
      )
      .all()
    const now = new Date().toISOString()
    for (const row of rows) {
      const candidate = JSON.parse(row.candidate_json)
      if (candidate.id === candidateId) {
        const updated = { ...candidate, status: 'active', updatedAt: now }
        this.db
          .prepare(
            'UPDATE memory_candidates SET status = ?, candidate_json = ?, updated_at = ? WHERE rowid = ?',
          )
          .run('active', JSON.stringify(updated), now, row.row_id)
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
    sql += ' ORDER BY rowid ASC'
    return this.db
      .prepare(sql)
      .all(...params)
      .map(row => JSON.parse(row.payload))
  }

  async listActiveMemories(filter = {}) {
    const candidates = await this.listMemoryCandidates(filter)
    return candidates.filter(candidate => candidate.status === 'active')
  }

  close() {
    this.db.close()
  }

  #initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platform_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_id TEXT,
        sender_id TEXT,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_call_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS permission_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        audit_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        status TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
        VALUES (1, datetime('now'));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_messages_session_message
        ON platform_messages (session_id, message_id)
        WHERE message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_platform_messages_session
        ON platform_messages (session_id);
      CREATE INDEX IF NOT EXISTS idx_platform_messages_sender
        ON platform_messages (sender_id);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_lookup
        ON memory_candidates (scope, subject_id, status);
      CREATE INDEX IF NOT EXISTS idx_agent_turns_session
        ON agent_turns (session_id);
    `)
  }

  #readJsonRows(tableName, sessionId, columnName) {
    return this.db
      .prepare(
        `SELECT ${columnName} AS payload FROM ${tableName} WHERE session_id = ? ORDER BY id ASC`,
      )
      .all(sessionId)
      .map(row => JSON.parse(row.payload))
  }

  #touch(sessionId, timestamp) {
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(timestamp, sessionId)
  }
}

function loadDatabaseSync() {
  try {
    return require('node:sqlite').DatabaseSync
  } catch (error) {
    throw new Error(
      `SQLiteSessionStore requires a Node.js runtime with node:sqlite support: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
