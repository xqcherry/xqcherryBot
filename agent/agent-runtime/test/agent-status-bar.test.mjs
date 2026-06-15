import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentStatusBarBuilder,
  ContextEngine,
  InMemorySessionStore,
} from '../src/index.mjs'

test('agent status bar builder renders explicit runtime state as a dynamic block', () => {
  const builder = new AgentStatusBarBuilder()
  const block = builder.build({
    text: '实现状态栏',
    currentPhase: 'implementing',
    contextPressure: '42%',
    latestSummary: { toMessageId: 'm10' },
    activeMemories: [{ id: 'memory-1' }, { id: 'memory-2' }],
    failureState: 'none',
  })

  assert.equal(block.id, 'agent-status-bar')
  assert.equal(block.type, 'agent_status')
  assert.equal(block.stability, 'dynamic')
  assert.equal(block.role, 'system')
  assert.match(block.content, /## Agent Status/)
  assert.match(block.content, /Current task: 实现状态栏/)
  assert.match(block.content, /Current phase: implementing/)
  assert.match(block.content, /Context pressure: 42%/)
  assert.match(block.content, /Compression status: summary covers up to m10/)
  assert.match(block.content, /Memory status: 2 active memories selected/)
  assert.match(block.content, /Tool state: available/)
  assert.match(block.content, /Latest tool failure: none/)
  assert.match(block.content, /Permission state: default/)
  assert.match(block.content, /Runtime state: active/)
  assert.match(block.content, /Failure state: none/)
})

test('context engine injects agent status bar before memory summary and recent context', async () => {
  const store = new InMemorySessionStore()
  const memory = await store.appendMemoryCandidate({
    sessionId: 'session-alpha',
    scope: 'session',
    subjectId: 'session-alpha',
    summary: '用户正在重构上下文',
    evidenceMessageIds: ['m1'],
    confidence: 0.9,
  })
  await store.activateMemoryCandidate(memory.id)
  await store.appendConversationSummary('session-alpha', {
    summary: '之前讨论了 context blocks。',
    fromMessageId: 'm1',
    toMessageId: 'm2',
  })
  await store.appendPlatformMessage({
    sessionId: 'session-alpha',
    messageId: 'm3',
    senderId: 'alice',
    text: '最近原文',
  })

  const contextEngine = new ContextEngine({
    sessionStore: store,
    statusBarBuilder: new AgentStatusBarBuilder(),
    recentMessageLimit: 1,
  })

  const blocks = await contextEngine.buildBlocks({
    sessionId: 'session-alpha',
    systemPrompt: 'system',
    text: '继续做状态栏',
    senderId: 'alice',
    currentPhase: 'implementing',
    contextPressure: 'low',
  })

  assert.deepEqual(
    blocks.map(block => block.id),
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
  const status = blocks.find(block => block.id === 'agent-status-bar')
  assert.match(status.content, /Current task: 继续做状态栏/)
  assert.match(status.content, /Current phase: implementing/)
  assert.match(status.content, /Memory status: 1 active memories selected/)
  assert.match(status.content, /Compression status: summary covers up to m2/)
})

test('context engine passes compaction failure state into agent status bar', async () => {
  const store = new InMemorySessionStore()
  const contextEngine = new ContextEngine({
    sessionStore: store,
    statusBarBuilder: new AgentStatusBarBuilder(),
    compactionEngine: {
      async compact() {
        return {
          status: 'failed',
          reason: 'summarizer_failed',
          error: new Error('summary unavailable'),
        }
      },
    },
  })

  const blocks = await contextEngine.buildBlocks({
    sessionId: 'session-failed-status',
    systemPrompt: 'system',
    text: '继续',
  })

  const status = blocks.find(block => block.id === 'agent-status-bar')
  assert.match(status.content, /Compression status: failed: summarizer_failed/)
  assert.match(status.content, /Failure state: summary unavailable/)
})

test('agent status bar shows summary validation failures', async () => {
  const store = new InMemorySessionStore()
  const contextEngine = new ContextEngine({
    sessionStore: store,
    statusBarBuilder: new AgentStatusBarBuilder(),
    compactionEngine: {
      async compact() {
        return {
          status: 'failed',
          reason: 'summary_validation_failed',
          error: new Error('Missing summary sections: Active Request'),
        }
      },
    },
  })

  const blocks = await contextEngine.buildBlocks({
    sessionId: 'session-validation-status',
    systemPrompt: 'system',
    text: '继续',
  })

  const status = blocks.find(block => block.id === 'agent-status-bar')
  assert.match(status.content, /Compression status: failed: summary_validation_failed/)
  assert.match(status.content, /Failure state: Missing summary sections: Active Request/)
})

test('agent status bar shows low savings compaction skips', async () => {
  const builder = new AgentStatusBarBuilder()
  const block = builder.build({
    text: '继续',
    compactionResult: {
      status: 'skipped',
      reason: 'low_savings_ratio',
      inputTokenEstimate: 100,
      outputTokenEstimate: 90,
      compressionRatio: 0.9,
    },
  })

  assert.match(block.content, /Compression status: skipped: low_savings_ratio/)
  assert.match(block.metadata.compressionStatus, /low_savings_ratio/)
})

test('context engine derives tool permission and runtime state for agent status bar', async () => {
  const store = new InMemorySessionStore()
  await store.appendToolCall('session-runtime-status', {
    id: 'call_search',
    name: 'search_chat_history',
    input: { query: 'x' },
    result: { error: 'Search backend unavailable' },
  })
  await store.appendPermissionAudit('session-runtime-status', {
    type: 'permission_request',
    toolCallId: 'call_send',
    toolName: 'send_message',
    input: { text: 'hello' },
    riskSummary: 'send_message may perform a side effect in this session.',
  })

  const contextEngine = new ContextEngine({
    sessionStore: store,
    statusBarBuilder: new AgentStatusBarBuilder(),
  })

  const blocks = await contextEngine.buildBlocks({
    sessionId: 'session-runtime-status',
    systemPrompt: 'system',
    text: '继续',
  })
  const status = blocks.find(block => block.id === 'agent-status-bar')

  assert.match(status.content, /Tool state: last tool search_chat_history failed/)
  assert.match(status.content, /Latest tool failure: search_chat_history: Search backend unavailable/)
  assert.match(status.content, /Permission state: pending: send_message/)
  assert.match(status.content, /Runtime state: waiting_for_user/)
  assert.equal(status.metadata.toolState, 'last tool search_chat_history failed')
  assert.equal(status.metadata.permissionState, 'pending: send_message')
  assert.equal(status.metadata.runtimeState, 'waiting_for_user')
})

test('agent status bar accepts explicit blocked runtime state', () => {
  const builder = new AgentStatusBarBuilder()
  const block = builder.build({
    text: '继续',
    toolState: 'running: send_message',
    latestToolFailure: 'send_message: rate limited',
    permissionState: 'denied: unsafe target',
    runtimeState: 'blocked',
  })

  assert.match(block.content, /Tool state: running: send_message/)
  assert.match(block.content, /Latest tool failure: send_message: rate limited/)
  assert.match(block.content, /Permission state: denied: unsafe target/)
  assert.match(block.content, /Runtime state: blocked/)
})
