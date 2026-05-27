import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentProtocolServer } from '../src/index.mjs'
import {
  AgentEngine,
  ContextBuilder,
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
  assert.equal(messageStore.updatedTurns[0].patch.status, 'completed')
  assert.equal(messageStore.updatedTurns[0].patch.result, 'hi')
  assert.equal(client.sent.at(-1).replyToMessageId, '78')
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
    contextBuilder: new ContextBuilder({ sessionStore: store, recentMessageLimit: 10 }),
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
