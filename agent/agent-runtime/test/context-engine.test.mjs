import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentStatusBarBuilder,
  ContextEngine,
  InMemorySessionStore,
  createContextBlock,
  contextBlocksToMessages,
} from '../src/index.mjs'

test('context blocks convert to model messages without losing metadata boundaries', () => {
  const blocks = [
    {
      id: 'stable-system-block',
      type: 'prompt',
      stability: 'stable',
      role: 'system',
      content: 'system',
    },
    {
      id: 'current-user-message',
      type: 'current_user_message',
      stability: 'dynamic',
      role: 'user',
      content: 'hello',
      metadata: { messageId: 'm1' },
    },
  ]

  assert.deepEqual(contextBlocksToMessages(blocks), [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ])
  assert.equal(blocks[1].metadata.messageId, 'm1')
})

test('context block helper validates required schema fields', () => {
  assert.deepEqual(
    createContextBlock({
      id: 'valid-block',
      type: 'prompt',
      stability: 'stable',
      role: 'system',
      content: 'ok',
      metadata: { source: 'test' },
    }),
    {
      id: 'valid-block',
      type: 'prompt',
      stability: 'stable',
      role: 'system',
      content: 'ok',
      metadata: { source: 'test' },
    },
  )
  assert.throws(
    () => createContextBlock({
      id: 'missing-role',
      type: 'prompt',
      stability: 'stable',
      content: 'bad',
    }),
    /role/,
  )
})

test('context block conversion rejects invalid blocks with clear errors', () => {
  assert.throws(
    () => contextBlocksToMessages([
      {
        id: 'invalid-stability',
        type: 'prompt',
        stability: 'warm',
        role: 'system',
        content: 'bad',
      },
    ]),
    /stability/,
  )
  assert.throws(
    () => contextBlocksToMessages([
      {
        id: 'invalid-metadata',
        type: 'prompt',
        stability: 'stable',
        role: 'system',
        content: 'bad',
        metadata: 'not-object',
      },
    ]),
    /metadata/,
  )
})

test('context engine exposes cache-friendly blocks and messages', async () => {
  const store = new InMemorySessionStore()
  await store.appendConversationSummary('session-alpha', {
    summary: '之前讨论了部署。',
    fromMessageId: '1',
    toMessageId: '2',
  })
  await store.appendPlatformMessage({
    sessionId: 'session-alpha',
    messageId: '3',
    senderId: 'alice',
    text: '日志已经看过',
    timestamp: '2026-05-29T10:00:00.000Z',
  })

  const contextEngine = new ContextEngine({ sessionStore: store, recentMessageLimit: 1, cachePolicy: null })
  const input = {
    sessionId: 'session-alpha',
    systemPrompt: 'base prompt',
    text: '继续',
    senderId: 'alice',
    messageId: '4',
  }

  const blocks = await contextEngine.buildBlocks(input)
  assert.deepEqual(
    blocks.map(block => [block.id, block.type, block.stability, block.role]),
    [
      ['chat-persona', 'prompt', 'stable', 'system'],
      ['turn-context', 'turn_context', 'dynamic', 'system'],
      ['short-term-summary', 'summary', 'semi-stable', 'system'],
      ['recent-raw-context', 'recent_raw_context', 'dynamic', 'system'],
      ['current-user-message', 'current_user_message', 'dynamic', 'user'],
    ],
  )

  const { messages } = await contextEngine.build(input)
  assert.deepEqual(messages, contextBlocksToMessages(blocks))
  assert.equal(messages.at(-1).content, '继续')
})

test('context engine can compose prompt status memory summary and raw context directly', async () => {
  const store = new InMemorySessionStore()
  const memory = await store.appendMemoryCandidate({
    sessionId: 'session-gamma',
    scope: 'session',
    subjectId: 'session-gamma',
    summary: '项目偏好：先写测试',
  })
  await store.activateMemoryCandidate(memory.id)
  await store.appendConversationSummary('session-gamma', {
    summary: '之前讨论了上下文编排。',
    fromMessageId: '1',
    toMessageId: '2',
  })
  await store.appendPlatformMessage({
    sessionId: 'session-gamma',
    messageId: '3',
    senderId: 'alice',
    text: '继续实现',
  })
  let compactInput = null
  const contextEngine = new ContextEngine({
    sessionStore: store,
    recentMessageLimit: 1,
    statusBarBuilder: new AgentStatusBarBuilder(),
    compactionEngine: {
      async compact(sessionId, options) {
        compactInput = { sessionId, options }
        return { status: 'skipped', reason: 'below_message_threshold' }
      },
    },
  })

  const result = await contextEngine.build({
    sessionId: 'session-gamma',
    systemPrompt: 'system',
    text: '现在继续',
    senderId: 'alice',
    messageId: '4',
    currentPhase: 'implementing',
  })

  assert.deepEqual(compactInput, {
    sessionId: 'session-gamma',
    options: { currentMessageId: '4' },
  })
  assert.deepEqual(
    result.blocks.map(block => block.id),
    [
      'chat-persona',
      'turn-context',
      'agent-status-bar',
      'long-term-memory',
      'short-term-summary',
      'recent-raw-context',
      'current-user-message',
    ],
  )
  const text = result.messages.map(message => message.content).join('\n')
  assert.match(text, /项目偏好：先写测试/)
  assert.match(text, /之前讨论了上下文编排/)
  assert.match(text, /alice: 继续实现/)
  assert.equal(result.messages.at(-1).content, '现在继续')
})
