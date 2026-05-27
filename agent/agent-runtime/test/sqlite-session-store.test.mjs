import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { SQLiteSessionStore } from '../src/index.mjs'

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
