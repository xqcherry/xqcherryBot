import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentProtocolServer } from '../src/index.mjs'
import {
  RemoteToolBridge,
  createRemoteQqTools,
} from '../src/remote-qq-tools.mjs'
import {
  AgentEngine,
  ContextEngine,
  InMemoryPermissionManager,
  InMemorySessionStore,
} from '../../agent-runtime/src/index.mjs'

class FakeEngine {
  constructor() {
    this.submitted = []
    this.permissionResponses = []
    this.interrupted = []
    this.deferred = []
  }

  async *submitUserMessage(input) {
    this.submitted.push(input)
    if (input.text === 'wait') {
      await new Promise(resolve => this.deferred.push(resolve))
    }
    if (input.text === 'throw') {
      throw new Error('model failed')
    }
    yield { type: 'turn_stage', sessionId: input.sessionId, stage: 'context_built' }
    yield { type: 'assistant_delta', sessionId: input.sessionId, delta: 'hi' }
    yield { type: 'final_result', sessionId: input.sessionId, result: 'hi' }
  }

  respondToPermission(response) {
    this.permissionResponses.push(response)
  }

  interrupt(sessionId) {
    this.interrupted.push(sessionId)
  }
}

class FakeMessageStore {
  constructor() {
    this.platformMessages = []
    this.agentTurns = []
    this.updatedTurns = []
  }

  async appendPlatformMessage(message) {
    this.platformMessages.push(message)
  }

  async appendAgentTurn(turn) {
    this.agentTurns.push(turn)
    return { id: `turn-${this.agentTurns.length}`, ...turn }
  }

  async updateAgentTurn(turnId, patch) {
    this.updatedTurns.push({ turnId, patch })
  }
}

function createClient() {
  return {
    sent: [],
    send(payload) {
      this.sent.push(payload)
    },
  }
}

function scriptedProvider(eventsByCall) {
  let calls = 0
  return {
    requests: [],
    async *streamChat(request) {
      this.requests.push(request)
      const events = eventsByCall[calls++] ?? []
      for (const event of events) {
        yield event
      }
    },
  }
}

async function waitForSent(client, type) {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    const event = client.sent.find(item => item.type === type)
    if (event) return event
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${type}`)
}

test('requires explicit sessionId and forwards metadata unchanged', async () => {
  const engine = new FakeEngine()
  const server = new AgentProtocolServer({ engine })
  const client = createClient()
  const metadata = {
    platform: 'qq',
    adapter: 'nonebot-napcat',
    messageType: 'group',
    groupId: '1000',
    userId: 'alice',
    messageId: '77',
    nested: { untouched: true },
  }

  await server.receive(client, {
    type: 'user_message',
    sessionId: 'qq-group:1000',
    text: '群消息',
    metadata,
  })

  assert.deepEqual(engine.submitted, [
    { sessionId: 'qq-group:1000', text: '群消息', metadata },
  ])
  assert.equal(client.sent.some(event => event.type === 'assistant_delta'), false)
  assert.equal(client.sent.filter(event => event.type === 'final_result').length, 1)
})

test('buffers assistant_delta events by default and only sends the final result', async () => {
  const engine = new FakeEngine()
  const server = new AgentProtocolServer({ engine })
  const client = createClient()

  await server.receive(client, {
    type: 'user_message',
    sessionId: 'qq-user:42',
    messageId: '1',
    text: 'hello',
  })

  assert.deepEqual(
    client.sent.map(event => event.type),
    ['final_result'],
  )
  assert.equal(client.sent[0].result, 'hi')
  assert.equal(client.sent[0].replyToMessageId, '1')
})

test('observed_message is stored but does not invoke the agent', async () => {
  const engine = new FakeEngine()
  const messageStore = new FakeMessageStore()
  const server = new AgentProtocolServer({ engine, messageStore })
  const client = createClient()

  await server.receive(client, {
    type: 'observed_message',
    sessionId: 'qq-group:1000',
    messageId: '77',
    senderId: '42',
    text: '今天晚上几点开黑？',
    timestamp: '2026-05-27T12:00:00.000Z',
    metadata: { platform: 'qq', messageType: 'group' },
  })

  assert.deepEqual(engine.submitted, [])
  assert.equal(messageStore.platformMessages.length, 1)
  assert.equal(messageStore.platformMessages[0].text, '今天晚上几点开黑？')
  assert.deepEqual(client.sent, [])
})

test('user_message stores raw text, strips #agent prefix, and records the turn', async () => {
  const engine = new FakeEngine()
  const messageStore = new FakeMessageStore()
  const server = new AgentProtocolServer({ engine, messageStore })
  const client = createClient()

  await server.receive(client, {
    type: 'user_message',
    sessionId: 'qq-group:1000',
    messageId: '78',
    senderId: '42',
    rawText: '#agent 总结一下刚刚讨论的安排',
    timestamp: '2026-05-27T12:01:00.000Z',
    metadata: { platform: 'qq', messageType: 'group' },
  })

  assert.equal(messageStore.platformMessages[0].text, '#agent 总结一下刚刚讨论的安排')
  assert.deepEqual(engine.submitted, [
    {
      sessionId: 'qq-group:1000',
      text: '总结一下刚刚讨论的安排',
      senderId: '42',
      messageId: '78',
      metadata: { platform: 'qq', messageType: 'group' },
    },
  ])
  assert.equal(messageStore.agentTurns[0].rawText, '#agent 总结一下刚刚讨论的安排')
  assert.equal(messageStore.agentTurns[0].text, '总结一下刚刚讨论的安排')
  assert.equal(
    messageStore.updatedTurns.some(update => update.patch.status === 'completed'),
    true,
  )
  assert.equal(
    messageStore.updatedTurns.some(update => update.patch.stage === 'context_built'),
    true,
  )
  assert.equal(
    messageStore.updatedTurns.find(update => update.patch.status === 'completed').patch.result,
    'hi',
  )
  assert.equal(client.sent.at(-1).replyToMessageId, '78')
})

test('memory management messages list, activate, and delete candidates', async () => {
  const store = new InMemorySessionStore()
  const candidate = await store.appendMemoryCandidate({
    sessionId: 'qq-group:1000',
    scope: 'session',
    subjectId: 'qq-group:1000',
    summary: '本群九点开黑',
    evidenceMessageIds: ['m1'],
    confidence: 0.9,
  })
  const server = new AgentProtocolServer({ engine: new FakeEngine(), messageStore: store })
  const client = createClient()

  await server.receive(client, {
    type: 'list_memory_candidates',
    sessionId: 'qq-group:1000',
    scope: 'session',
    subjectId: 'qq-group:1000',
    requestId: 'req1',
  })
  await server.receive(client, {
    type: 'activate_memory_candidate',
    sessionId: 'qq-group:1000',
    memoryId: candidate.id,
    responderId: '42',
    requestId: 'req2',
  })
  await server.receive(client, {
    type: 'delete_memory_candidate',
    sessionId: 'qq-group:1000',
    memoryId: candidate.id,
    requestId: 'req3',
  })

  assert.equal(client.sent[0].type, 'memory_candidates_result')
  assert.equal(client.sent[0].candidates[0].summary, '本群九点开黑')
  assert.equal(client.sent[1].type, 'memory_candidate_updated')
  assert.equal(client.sent[1].ok, true)
  assert.equal(client.sent[1].memory.approvedBy, '42')
  assert.equal(client.sent[2].action, 'delete')
  assert.equal((await store.listMemoryCandidates({ subjectId: 'qq-group:1000' }))[0].status, 'deleted')
})

test('session management messages report status and clear summary/context', async () => {
  const store = new InMemorySessionStore()
  await store.appendMessages('qq-group:1000', [{ role: 'user', content: 'hello' }])
  await store.appendPlatformMessage({
    sessionId: 'qq-group:1000',
    messageId: 'm1',
    senderId: '42',
    text: 'raw',
  })
  await store.appendConversationSummary('qq-group:1000', {
    summary: 'old summary',
    fromMessageId: 'm1',
    toMessageId: 'm1',
  })
  const memory = await store.appendMemoryCandidate({
    sessionId: 'qq-group:1000',
    scope: 'session',
    subjectId: 'qq-group:1000',
    summary: 'active memory',
    evidenceMessageIds: ['m1'],
    confidence: 0.9,
  })
  await store.activateMemoryCandidate(memory.id)
  const server = new AgentProtocolServer({ engine: new FakeEngine(), messageStore: store })
  const client = createClient()

  await server.receive(client, {
    type: 'get_session_status',
    sessionId: 'qq-group:1000',
    requestId: 's1',
  })
  await server.receive(client, {
    type: 'clear_session_summary',
    sessionId: 'qq-group:1000',
    requestId: 's2',
  })
  await store.appendConversationSummary('qq-group:1000', {
    summary: 'new summary',
    fromMessageId: 'm1',
    toMessageId: 'm1',
  })
  await server.receive(client, {
    type: 'clear_session_context',
    sessionId: 'qq-group:1000',
    requestId: 's3',
  })

  assert.equal(client.sent[0].type, 'session_status_result')
  assert.equal(client.sent[0].status.messageCount, 1)
  assert.equal(client.sent[0].status.activeMemoryCount, 1)
  assert.equal(client.sent[1].type, 'session_reset_result')
  assert.equal(client.sent[1].action, 'clear_summary')
  assert.equal(client.sent[2].action, 'clear_context')
  const status = await store.getSessionStatus('qq-group:1000')
  assert.equal(status.messageCount, 0)
  assert.equal(status.modelMessageCount, 0)
  assert.equal(status.summaryCount, 0)
  assert.equal(status.activeMemoryCount, 1)
})

test('session status and diagnostics expose compaction status', async () => {
  const engine = new FakeEngine()
  engine.tools = []
  engine.contextEngine = {
    compactionEngine: {
      getStatus(sessionId) {
        return {
          status: 'skipped',
          reason: sessionId === 'qq-group:1000' ? 'low_savings_ratio' : null,
          failureCount: 0,
          lastError: null,
          inputTokenEstimate: 100,
          outputTokenEstimate: 90,
          compressionRatio: 0.9,
          fromMessageId: 'm1',
          toMessageId: 'm3',
          provider: 'openai-compatible',
          model: 'summary-model',
          updatedAt: '2026-05-29T00:00:00.000Z',
        }
      },
    },
  }
  const store = new InMemorySessionStore()
  const server = new AgentProtocolServer({
    engine,
    messageStore: store,
    healthCheck: () => ({ ok: true, model: 'chat-model' }),
  })
  const client = createClient()

  await server.receive(client, {
    type: 'get_session_status',
    sessionId: 'qq-group:1000',
    requestId: 'status-compaction',
  })
  await server.receive(client, {
    type: 'get_agent_diag',
    sessionId: 'qq-group:1000',
    requestId: 'diag-compaction',
  })

  assert.equal(client.sent[0].status.compactionStatus.reason, 'low_savings_ratio')
  assert.equal(client.sent[0].status.compactionStatus.compressionRatio, 0.9)
  assert.equal(client.sent[1].compactionStatus.model, 'summary-model')
})

test('diagnostic and backup status messages return gateway metadata', async () => {
  const engine = new FakeEngine()
  engine.tools = [{ name: 'get_recent_messages' }, { name: 'search_chat_history' }]
  const store = new InMemorySessionStore()
  const turn = await store.appendAgentTurn({
    sessionId: 'qq-group:1000',
    status: 'completed',
    text: 'hi',
  })
  await store.updateAgentTurn(turn.id, { status: 'completed', stage: 'completed' })
  const server = new AgentProtocolServer({
    engine,
    messageStore: store,
    healthCheck: () => ({
      ok: true,
      model: 'deepseek-test',
      prompt: {
        chatPersona: {
          promptKey: 'CHAT_PERSONA',
          source: 'database',
          fallback: false,
          sourceVersionNo: 3,
        },
      },
    }),
    backupStatus: () => ({
      dbPath: 'F:\\agent\\gateway.sqlite',
      sizeBytes: 123,
      modifiedAt: '2026-05-27T12:00:00.000Z',
    }),
  })
  const client = createClient()

  await server.receive(client, {
    type: 'get_agent_diag',
    requestId: 'diag-1',
    sessionId: 'qq-group:1000',
  })
  await server.receive(client, {
    type: 'get_backup_status',
    requestId: 'backup-1',
    sessionId: 'qq-group:1000',
  })

  assert.equal(client.sent[0].type, 'agent_diag_result')
  assert.equal(client.sent[0].health.ok, true)
  assert.equal(client.sent[0].health.prompt.chatPersona.sourceVersionNo, 3)
  assert.equal(client.sent[0].model, 'deepseek-test')
  assert.equal(client.sent[0].toolNames.includes('search_chat_history'), true)
  assert.equal(client.sent[0].latestTurn.id, turn.id)
  assert.equal(client.sent[1].type, 'backup_status_result')
  assert.equal(client.sent[1].status.dbPath, 'F:\\agent\\gateway.sqlite')
  assert.equal(client.sent[1].status.sizeBytes, 123)
})

test('rejects legacy chat-only user messages instead of deriving sessions', async () => {
  const engine = new FakeEngine()
  const server = new AgentProtocolServer({ engine })
  const client = createClient()

  await server.receive(client, {
    type: 'user_message',
    chat: { type: 'group', groupId: '1000', userId: 'alice' },
    text: '群消息',
  })

  assert.deepEqual(engine.submitted, [])
  assert.equal(client.sent[0].type, 'error')
  assert.match(client.sent[0].error, /user_message requires sessionId/)
})

test('forwards permission responses and interrupts to the engine', async () => {
  const engine = new FakeEngine()
  const server = new AgentProtocolServer({ engine })
  const client = createClient()

  await server.receive(client, {
    type: 'permission_response',
    sessionId: 'session-alpha',
    toolCallId: 'call_send',
    decision: 'allow',
    responderId: 'admin',
  })
  await server.receive(client, {
    type: 'interrupt',
    sessionId: 'session-alpha',
  })

  assert.deepEqual(engine.permissionResponses, [
    {
      sessionId: 'session-alpha',
      toolCallId: 'call_send',
      decision: 'allow',
      reason: undefined,
      responderId: 'admin',
    },
  ])
  assert.deepEqual(engine.interrupted, ['session-alpha'])
})

test('remote QQ tools request execution from the bridge after permission is allowed', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_send',
        name: 'send_message',
        argumentsDelta: '{"text":"收到"}',
      },
      { type: 'finish', reason: 'tool_calls' },
    ],
    [
      { type: 'assistant_delta', text: '已发送' },
      { type: 'finish', reason: 'stop' },
    ],
  ])
  const store = new InMemorySessionStore()
  const bridge = new RemoteToolBridge({
    createRequestId: () => 'tool-request-1',
    timeoutMs: 1000,
  })
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: createRemoteQqTools({ bridge }),
    sessionStore: store,
    permissionManager: new InMemoryPermissionManager(),
  })
  const server = new AgentProtocolServer({ engine, messageStore: store, remoteToolBridge: bridge })
  const client = createClient()

  const turn = server.receive(client, {
    type: 'user_message',
    sessionId: 'qq-group:1000',
    messageId: 'm1',
    senderId: '42',
    text: '发一句收到',
    metadata: {
      platform: 'qq',
      messageType: 'group',
      groupId: '1000',
      userId: '42',
      messageId: 'm1',
    },
  })

  await waitForSent(client, 'permission_request')
  assert.equal(client.sent.at(-1).toolName, 'send_message')

  await server.receive(client, {
    type: 'permission_response',
    sessionId: 'qq-group:1000',
    toolCallId: 'call_send',
    decision: 'allow',
    responderId: 'admin',
  })

  const request = await waitForSent(client, 'tool_request')
  assert.deepEqual(request, {
    type: 'tool_request',
    requestId: 'tool-request-1',
    sessionId: 'qq-group:1000',
    toolCallId: 'call_send',
    toolName: 'send_message',
    input: { text: '收到' },
    context: {
      sessionId: 'qq-group:1000',
      toolCallId: 'call_send',
      senderId: '42',
      messageId: 'm1',
      metadata: {
        platform: 'qq',
        messageType: 'group',
        groupId: '1000',
        userId: '42',
        messageId: 'm1',
      },
    },
  })

  await server.receive(client, {
    type: 'tool_result',
    requestId: 'tool-request-1',
    sessionId: 'qq-group:1000',
    toolCallId: 'call_send',
    ok: true,
    result: { message_id: 'qq-99' },
  })
  await turn

  assert.equal(client.sent.at(-1).type, 'final_result')
  assert.equal(client.sent.at(-1).result, '已发送')
  assert.equal(provider.requests.length, 2)
  assert.deepEqual(JSON.parse(provider.requests[1].messages.at(-1).content), {
    message_id: 'qq-99',
  })
})

test('remote QQ tool failures are returned to the model as tool errors', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_reply',
        name: 'reply_message',
        argumentsDelta: '{"text":"ok"}',
      },
      { type: 'finish', reason: 'tool_calls' },
    ],
    [
      { type: 'assistant_delta', text: '回复失败：缺少消息 ID' },
      { type: 'finish', reason: 'stop' },
    ],
  ])
  const store = new InMemorySessionStore()
  const bridge = new RemoteToolBridge({
    createRequestId: () => 'tool-request-error',
    timeoutMs: 1000,
  })
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: createRemoteQqTools({ bridge }),
    sessionStore: store,
    permissionManager: new InMemoryPermissionManager(),
  })
  const server = new AgentProtocolServer({ engine, messageStore: store, remoteToolBridge: bridge })
  const client = createClient()

  const turn = server.receive(client, {
    type: 'user_message',
    sessionId: 'qq-user:42',
    messageId: 'm1',
    senderId: '42',
    text: '引用回复',
    metadata: { platform: 'qq', messageType: 'private', userId: '42', messageId: 'm1' },
  })

  await waitForSent(client, 'permission_request')
  await server.receive(client, {
    type: 'permission_response',
    sessionId: 'qq-user:42',
    toolCallId: 'call_reply',
    decision: 'allow',
    responderId: 'admin',
  })
  await waitForSent(client, 'tool_request')
  await server.receive(client, {
    type: 'tool_result',
    requestId: 'tool-request-error',
    sessionId: 'qq-user:42',
    toolCallId: 'call_reply',
    ok: false,
    error: 'messageId is required',
  })
  await turn

  assert.deepEqual(JSON.parse(provider.requests[1].messages.at(-1).content), {
    error: 'messageId is required',
  })
  assert.equal(client.sent.at(-1).result, '回复失败：缺少消息 ID')
})

test('sends protocol error for invalid inbound messages', async () => {
  const server = new AgentProtocolServer({ engine: new FakeEngine() })
  const client = createClient()

  await server.receive(client, { type: 'unknown' })

  assert.equal(client.sent[0].type, 'error')
  assert.match(client.sent[0].error, /Unsupported inbound message/)
})

test('serializes user messages for the same session', async () => {
  const engine = new FakeEngine()
  const server = new AgentProtocolServer({ engine })
  const firstClient = createClient()
  const secondClient = createClient()

  const first = server.receive(firstClient, {
    type: 'user_message',
    sessionId: 'same-session',
    messageId: '1',
    senderId: '42',
    text: 'wait',
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  const second = server.receive(secondClient, {
    type: 'user_message',
    sessionId: 'same-session',
    messageId: '2',
    senderId: '42',
    text: 'next',
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.deepEqual(engine.submitted.map(item => item.text), ['wait'])
  engine.deferred[0]()
  await Promise.all([first, second])

  assert.deepEqual(engine.submitted.map(item => item.text), ['wait', 'next'])
  assert.equal(firstClient.sent.at(-1).replyToMessageId, '1')
  assert.equal(secondClient.sent.at(-1).replyToMessageId, '2')
})

test('keeps group and private sessions isolated through protocol storage and runtime context', async () => {
  const provider = {
    requests: [],
    async *streamChat(request) {
      this.requests.push(request)
      yield { type: 'assistant_delta', text: `reply ${request.sessionId}` }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const store = new InMemorySessionStore()
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: [],
    sessionStore: store,
    permissionManager: new InMemoryPermissionManager(),
    contextEngine: new ContextEngine({ sessionStore: store, recentMessageLimit: 10 }),
  })
  const server = new AgentProtocolServer({ engine, messageStore: store })
  const groupClient = createClient()
  const privateClient = createClient()

  await server.receive(groupClient, {
    type: 'observed_message',
    sessionId: 'qq-group:1000',
    messageId: 'g1',
    senderId: '42',
    text: '群聊历史',
  })
  await server.receive(privateClient, {
    type: 'observed_message',
    sessionId: 'qq-user:42',
    messageId: 'p1',
    senderId: '42',
    text: '私聊历史',
  })
  await server.receive(groupClient, {
    type: 'user_message',
    sessionId: 'qq-group:1000',
    messageId: 'g2',
    senderId: '42',
    text: '#agent 群聊问题',
  })
  await server.receive(privateClient, {
    type: 'user_message',
    sessionId: 'qq-user:42',
    messageId: 'p2',
    senderId: '42',
    text: '#agent 私聊问题',
  })

  const groupSession = await store.getOrCreateSession('qq-group:1000')
  const privateSession = await store.getOrCreateSession('qq-user:42')
  assert.equal(groupSession.platformMessages.length, 2)
  assert.equal(privateSession.platformMessages.length, 2)
  assert.equal(groupSession.agentTurns.length, 1)
  assert.equal(privateSession.agentTurns.length, 1)
  const groupRequestText = provider.requests[0].messages.map(message => message.content).join('\n')
  const privateRequestText = provider.requests[1].messages.map(message => message.content).join('\n')
  assert.match(groupRequestText, /群聊历史/)
  assert.doesNotMatch(groupRequestText, /私聊历史/)
  assert.match(privateRequestText, /私聊历史/)
  assert.doesNotMatch(privateRequestText, /群聊历史/)
})

test('records failed agent turns and sends an error event', async () => {
  const engine = new FakeEngine()
  const messageStore = new FakeMessageStore()
  const server = new AgentProtocolServer({ engine, messageStore })
  const client = createClient()

  await server.receive(client, {
    type: 'user_message',
    sessionId: 'qq-user:42',
    messageId: '99',
    senderId: '42',
    text: 'throw',
  })

  assert.equal(client.sent.at(-1).type, 'error')
  assert.match(client.sent.at(-1).error, /model failed/)
  assert.equal(messageStore.updatedTurns.at(-1).patch.status, 'error')
  assert.match(messageStore.updatedTurns.at(-1).patch.error, /model failed/)
})
