import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentEngine,
  InMemoryPermissionManager,
  InMemorySessionStore,
} from '../../agent-runtime/src/index.mjs'
import { AgentProtocolServer } from '../src/index.mjs'
import { createWebSocketAgentServer } from '../src/index.mjs'

function scriptedProvider(eventsByCall) {
  let calls = 0
  return {
    async *streamChat() {
      for (const event of eventsByCall[calls++] ?? []) {
        yield event
      }
    },
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

async function waitForEvent(client, type) {
  for (let i = 0; i < 100; i += 1) {
    const event = client.sent.find(item => item.type === type)
    if (event) return event
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${type}`)
}

test('smoke: recent messages -> permission request -> send message -> final result', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_recent',
        name: 'get_recent_messages',
        argumentsDelta: '{"limit":2}',
      },
      { type: 'finish', reason: 'tool_calls' },
    ],
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
  const sentMessages = []
  const engine = new AgentEngine({
    modelProvider: provider,
    sessionStore: new InMemorySessionStore(),
    permissionManager: new InMemoryPermissionManager(),
    tools: [
      {
        name: 'get_recent_messages',
        description: 'Read recent messages',
        inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        call: async input => ({ messages: ['hello', 'world'].slice(0, input.limit) }),
      },
      {
        name: 'send_message',
        description: 'Send a message',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        isReadOnly: () => false,
        isConcurrencySafe: () => false,
        call: async (input, context) => {
          sentMessages.push({
            text: input.text,
            sessionId: context.sessionId,
            metadata: context.metadata,
          })
          return { sent: true }
        },
      },
    ],
  })
  const server = new AgentProtocolServer({ engine })
  const client = createClient()

  const running = server.receive(client, {
    type: 'user_message',
    sessionId: 'qq-group:1000',
    text: '读取最近消息然后回复',
    metadata: {
      platform: 'qq',
      adapter: 'nonebot-napcat',
      messageType: 'group',
      groupId: '1000',
      userId: '42',
      messageId: '77',
    },
  })

  const permissionRequest = await waitForEvent(client, 'permission_request')
  await server.receive(client, {
    type: 'permission_response',
    sessionId: permissionRequest.sessionId,
    toolCallId: permissionRequest.toolCallId,
    decision: 'allow',
    responderId: '42',
  })
  await running

  assert.deepEqual(sentMessages, [
    {
      text: '收到',
      sessionId: 'qq-group:1000',
      metadata: {
        platform: 'qq',
        adapter: 'nonebot-napcat',
        messageType: 'group',
        groupId: '1000',
        userId: '42',
        messageId: '77',
      },
    },
  ])
  assert.equal(client.sent.at(-1).type, 'final_result')
  assert.equal(client.sent.at(-1).result, '已发送')
})

test('websocket server stores observed messages and returns final results', async () => {
  const provider = scriptedProvider([
    [{ type: 'assistant_delta', text: '收到' }, { type: 'finish', reason: 'stop' }],
  ])
  const sessionStore = new InMemorySessionStore()
  const logs = []
  const engine = new AgentEngine({
    modelProvider: provider,
    sessionStore,
    permissionManager: new InMemoryPermissionManager(),
    tools: [],
  })
  const server = await createWebSocketAgentServer({
    engine,
    port: 0,
    logger: event => logs.push(event),
  })
  const address = server.address()
  const { WebSocket } = await import('ws')
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`)
  const received = []
  socket.on('message', data => received.push(JSON.parse(String(data))))
  await new Promise(resolve => socket.once('open', resolve))

  socket.send(
    JSON.stringify({
      type: 'observed_message',
      sessionId: 'qq-group:1000',
      messageId: '1',
      senderId: '42',
      text: '普通消息',
      timestamp: '2026-05-27T12:00:00.000Z',
      metadata: { platform: 'qq' },
    }),
  )
  socket.send(
    JSON.stringify({
      type: 'user_message',
      sessionId: 'qq-group:1000',
      messageId: '2',
      senderId: '42',
      rawText: '#agent 回复',
      metadata: { platform: 'qq' },
    }),
  )

  for (let i = 0; i < 100 && !received.some(event => event.type === 'final_result'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  assert.equal(received.at(-1).type, 'final_result')
  assert.equal(received.at(-1).replyToMessageId, '2')
  const session = await sessionStore.getOrCreateSession('qq-group:1000')
  assert.equal(session.platformMessages.length, 2)
  assert.ok(logs.some(event => event.type === 'connection_opened'))
  assert.ok(logs.some(event => event.type === 'message_received' && event.messageType === 'user_message'))

  socket.terminate()
  for (const client of server.clients) {
    client.terminate()
  }
  server.close()
})
