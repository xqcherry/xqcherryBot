import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { createSessionStoreFromEnv, SQLiteSessionStore } from '../src/index.mjs'

test('persists sessions, messages, tool calls, permission audit, and summaries in SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-runtime-'))
  const dbPath = join(dir, 'sessions.sqlite')

  const store = new SQLiteSessionStore(dbPath)
  await store.getOrCreateSession('session-alpha', { scope: 'generic' })
  await store.appendMessages('session-alpha', [{ role: 'user', content: 'hello' }])
  await store.appendPlatformMessage({
    sessionId: 'session-alpha',
    messageId: 'platform-1',
    senderId: 'sender-1',
    text: 'raw platform message',
    timestamp: '2026-05-27T12:00:00.000Z',
    metadata: { platform: 'qq' },
  })
  await store.appendToolCall('session-alpha', {
    id: 'call_1',
    name: 'get_recent_messages',
    input: { limit: 1 },
    result: { messages: ['hello'] },
  })
  await store.appendPermissionAudit('session-alpha', {
    toolCallId: 'call_send',
    decision: 'deny',
  })
  await store.appendConversationSummary('session-alpha', {
    summary: 'short summary',
    messageCount: 1,
  })
  const turn = await store.appendAgentTurn({
    sessionId: 'session-alpha',
    messageId: 'platform-1',
    senderId: 'sender-1',
    rawText: '#agent hello',
    text: 'hello',
  })
  await store.updateAgentTurn(turn.id, {
    status: 'completed',
    result: 'hi',
  })
  await store.appendMemoryCandidate({
    sessionId: 'session-alpha',
    scope: 'user',
    subjectId: 'sender-1',
    summary: 'prefers concise answers',
    evidenceMessageIds: ['platform-1'],
    confidence: 0.7,
  })
  store.close()

  const reopened = new SQLiteSessionStore(dbPath)
  const session = await reopened.getOrCreateSession('session-alpha')

  assert.equal(session.messages[0].content, 'hello')
  assert.equal(session.platformMessages[0].text, 'raw platform message')
  assert.equal(session.toolCalls[0].name, 'get_recent_messages')
  assert.equal(session.permissionAudit[0].decision, 'deny')
  assert.equal(session.conversationSummaries[0].summary, 'short summary')
  assert.equal(session.agentTurns[0].status, 'completed')
  assert.equal(session.memoryCandidates[0].status, 'candidate')
  assert.deepEqual(
    await reopened.listActiveMemories({ scope: 'user', subjectId: 'sender-1' }),
    [],
  )
  reopened.close()
})

test('SQLite store deduplicates platform messages and can activate memory candidates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-runtime-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = new SQLiteSessionStore(dbPath)
  const message = {
    sessionId: 'session-alpha',
    messageId: 'same-message',
    senderId: 'sender-1',
    text: 'raw platform message',
    timestamp: '2026-05-27T12:00:00.000Z',
    metadata: {},
  }

  await store.appendPlatformMessage(message)
  await store.appendPlatformMessage({ ...message, text: 'duplicate should be ignored' })
  const candidate = await store.appendMemoryCandidate({
    sessionId: 'session-alpha',
    scope: 'session',
    subjectId: 'session-alpha',
    summary: 'active summary',
    evidenceMessageIds: ['same-message'],
    confidence: 0.9,
  })
  await store.activateMemoryCandidate(candidate.id)

  const session = await store.getOrCreateSession('session-alpha')
  assert.equal(session.platformMessages.length, 1)
  assert.equal(session.platformMessages[0].text, 'raw platform message')
  assert.equal(session.memoryCandidates[0].status, 'active')
  assert.equal(
    (await store.listActiveMemories({ scope: 'session', subjectId: 'session-alpha' })).length,
    1,
  )
  store.close()
})

test('session status and reset operations preserve active memories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-store-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = new SQLiteSessionStore(dbPath)
  await store.appendMessages('session-alpha', [{ role: 'user', content: 'hello' }])
  await store.appendPlatformMessage({
    sessionId: 'session-alpha',
    messageId: 'm1',
    senderId: '42',
    text: 'raw',
  })
  await store.appendConversationSummary('session-alpha', {
    summary: 'summary',
    fromMessageId: 'm1',
    toMessageId: 'm1',
  })
  const memory = await store.appendMemoryCandidate({
    sessionId: 'session-alpha',
    scope: 'session',
    subjectId: 'session-alpha',
    summary: 'active memory',
    evidenceMessageIds: ['m1'],
    confidence: 0.9,
  })
  await store.activateMemoryCandidate(memory.id, { approvedBy: 'admin' })

  const before = await store.getSessionStatus('session-alpha')
  const summaryReset = await store.clearSessionSummary('session-alpha')
  await store.appendConversationSummary('session-alpha', {
    summary: 'summary 2',
    fromMessageId: 'm1',
    toMessageId: 'm1',
  })
  const contextReset = await store.clearSessionContext('session-alpha')
  const after = await store.getSessionStatus('session-alpha')

  assert.equal(before.messageCount, 1)
  assert.equal(before.modelMessageCount, 1)
  assert.equal(before.summaryCount, 1)
  assert.equal(before.activeMemoryCount, 1)
  assert.equal(summaryReset.cleared, 1)
  assert.deepEqual(contextReset.cleared, {
    platformMessages: 1,
    modelMessages: 1,
    summaries: 1,
  })
  assert.equal(after.messageCount, 0)
  assert.equal(after.modelMessageCount, 0)
  assert.equal(after.summaryCount, 0)
  assert.equal(after.activeMemoryCount, 1)
})

test('SQLite store searches platform messages within a session with limit and sender filters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-store-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = new SQLiteSessionStore(dbPath)

  await store.appendPlatformMessage({
    sessionId: 'qq-group:1000',
    messageId: 'm1',
    senderId: '42',
    text: '今晚八点开黑',
    timestamp: '2026-05-27T12:00:00.000Z',
  })
  await store.appendPlatformMessage({
    sessionId: 'qq-group:1000',
    messageId: 'm2',
    senderId: '7',
    text: '今晚八点吃饭',
    timestamp: '2026-05-27T12:01:00.000Z',
  })
  await store.appendPlatformMessage({
    sessionId: 'qq-group:2000',
    messageId: 'm3',
    senderId: '42',
    text: '今晚八点开会',
    timestamp: '2026-05-27T12:02:00.000Z',
  })

  const results = await store.searchPlatformMessages('qq-group:1000', {
    query: '八点',
    senderId: '42',
    limit: 20,
  })

  assert.deepEqual(
    results.map(message => message.messageId),
    ['m1'],
  )
  store.close()
})

test('SQLite store records file-based schema migrations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-store-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = new SQLiteSessionStore(dbPath)

  const migrations = store.db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC')
    .all()
    .map(row => ({ ...row }))

  assert.deepEqual(migrations, [
    {
      version: 1,
      name: 'V001__initial_schema.sql',
    },
    {
      version: 2,
      name: 'V002__summary_metadata_columns.sql',
    },
    {
      version: 3,
      name: 'V003__prompt_templates.sql',
    },
  ])
  store.close()
})

test('SQLite store writes queryable summary metadata columns and reads legacy JSON metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-store-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = new SQLiteSessionStore(dbPath)

  await store.appendConversationSummary('session-alpha', {
    version: 2,
    status: 'success',
    provider: 'openai-compatible',
    model: 'summary-model',
    promptVersion: 'structured-summary-v1',
    format: 'markdown',
    summary: 'summary text',
    fromMessageId: 'm1',
    toMessageId: 'm3',
    messageCount: 3,
    inputTokenEstimate: 100,
    outputTokenEstimate: 20,
    compressionRatio: 0.2,
  })

  const row = store.db
    .prepare(`
      SELECT
        version,
        status,
        provider,
        model,
        prompt_version,
        from_message_id,
        to_message_id,
        input_token_estimate,
        output_token_estimate,
        compression_ratio
      FROM conversation_summaries
      WHERE session_id = ?
      ORDER BY id ASC
      LIMIT 1
    `)
    .get('session-alpha')

  assert.deepEqual({ ...row }, {
    version: 2,
    status: 'success',
    provider: 'openai-compatible',
    model: 'summary-model',
    prompt_version: 'structured-summary-v1',
    from_message_id: 'm1',
    to_message_id: 'm3',
    input_token_estimate: 100,
    output_token_estimate: 20,
    compression_ratio: 0.2,
  })

  store.db
    .prepare(`
      INSERT INTO conversation_summaries (session_id, summary_json, created_at)
      VALUES (?, ?, ?)
    `)
    .run(
      'session-alpha',
      JSON.stringify({
        version: 2,
        status: 'success',
        provider: 'legacy-provider',
        model: 'legacy-model',
        promptVersion: 'legacy-summary-v1',
        summary: 'legacy json summary',
        fromMessageId: 'legacy-1',
        toMessageId: 'legacy-2',
        inputTokenEstimate: 7,
        outputTokenEstimate: 3,
        compressionRatio: 0.4286,
      }),
      '2026-05-29T00:00:00.000Z',
    )

  const summaries = (await store.getOrCreateSession('session-alpha')).conversationSummaries
  assert.equal(summaries.length, 2)
  assert.equal(summaries[0].promptVersion, 'structured-summary-v1')
  assert.equal(summaries[0].fromMessageId, 'm1')
  assert.equal(summaries[1].promptVersion, 'legacy-summary-v1')
  assert.equal(summaries[1].fromMessageId, 'legacy-1')
  assert.equal(summaries[1].toMessageId, 'legacy-2')
  assert.equal(summaries[1].provider, 'legacy-provider')
  assert.equal(summaries[1].compressionRatio, 0.4286)

  store.close()
})

test('session store factory keeps SQLite as the default env-backed store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-store-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = createSessionStoreFromEnv({
    AGENT_GATEWAY_DB: dbPath,
  })

  assert.ok(store instanceof SQLiteSessionStore)
  await store.appendPlatformMessage({
    sessionId: 'factory-session',
    messageId: 'm1',
    senderId: '42',
    text: 'created through factory',
  })
  assert.equal(
    (await store.getPlatformMessages('factory-session'))[0].text,
    'created through factory',
  )
  store.close()
})

test('session store factory rejects SQL providers that do not have an adapter yet', () => {
  assert.throws(
    () =>
      createSessionStoreFromEnv({
        AGENT_SESSION_STORE: 'postgres',
        AGENT_DATABASE_URL: 'postgres://user:pass@example.invalid/db',
      }),
    /PostgreSQL session store adapter is not implemented yet/,
  )
})
