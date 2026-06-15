import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentEngine,
  ContextEngine,
  InMemoryPermissionManager,
  InMemorySessionStore,
  OpenAICompatibleSummarizer,
  ToolPolicy,
  ToolRegistry,
  ToolSelector,
  createActiveMemoriesTool,
  createMemoryCandidateTool,
  createRecentMessagesTool,
  createSearchChatHistoryTool,
} from '../src/index.mjs'

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

test('aggregates streamed OpenAI tool call arguments and feeds tool result into the next model request', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_recent',
        name: 'get_recent_messages',
        argumentsDelta: '{"limit"',
      },
      { type: 'tool_call_delta', index: 0, argumentsDelta: ':2}' },
      { type: 'finish', reason: 'tool_calls' },
    ],
    [
      { type: 'assistant_delta', text: '最近两条是 hello 和 world' },
      { type: 'finish', reason: 'stop' },
    ],
  ])

  const tools = [
    {
      name: 'get_recent_messages',
      description: 'Read recent session messages',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number' } },
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async input => ({ messages: ['hello', 'world'], limit: input.limit }),
    },
  ]

  const engine = new AgentEngine({
    modelProvider: provider,
    tools,
    sessionStore: new InMemorySessionStore(),
    permissionManager: new InMemoryPermissionManager(),
  })

  const events = []
  for await (const event of engine.submitUserMessage({
    sessionId: 'session-alpha',
    text: '总结最近消息',
  })) {
    events.push(event)
  }

  assert.deepEqual(
    events.filter(event => event.type !== 'turn_stage').map(event => event.type),
    [
      'tool_call_started',
      'tool_call_finished',
      'assistant_delta',
      'final_result',
    ],
  )
  const finished = events.find(event => event.type === 'tool_call_finished')
  assert.equal(finished.toolCallId, 'call_recent')
  assert.equal(finished.result.messages[0], 'hello')
  assert.equal(provider.requests.length, 2)
  assert.deepEqual(provider.requests[1].messages.at(-1), {
    role: 'tool',
    tool_call_id: 'call_recent',
    name: 'get_recent_messages',
    content: JSON.stringify({ messages: ['hello', 'world'], limit: 2 }),
  })
})

test('uses the default base core prompt without adapter details', async () => {
  const provider = scriptedProvider([
    [{ type: 'assistant_delta', text: 'hi' }, { type: 'finish', reason: 'stop' }],
  ])
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: [],
    sessionStore: new InMemorySessionStore(),
    permissionManager: new InMemoryPermissionManager(),
  })

  for await (const _event of engine.submitUserMessage({
    sessionId: 'custom-session',
    text: 'hello',
  })) {
    // Drain the stream so the provider captures the request.
  }

  const systemPrompt = provider.requests[0].messages[0].content
  assert.doesNotMatch(systemPrompt, /NoneBot|NapCat/i)
  assert.match(systemPrompt, /agent/i)
  assert.match(systemPrompt, /current user message/i)
  assert.match(systemPrompt, /Do not invent tool results/i)
})

test('uses contextEngine output for model requests', async () => {
  const provider = scriptedProvider([
    [{ type: 'assistant_delta', text: 'ok' }, { type: 'finish', reason: 'stop' }],
  ])
  const contextEngine = {
    async build() {
      return {
        blocks: [],
        messages: [{ role: 'user', content: 'from-context-engine' }],
      }
    },
  }
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: [],
    sessionStore: new InMemorySessionStore(),
    permissionManager: new InMemoryPermissionManager(),
    contextEngine,
  })

  for await (const _event of engine.submitUserMessage({
    sessionId: 'context-engine-preferred',
    text: 'hello',
  })) {
    // Drain the stream so the provider captures the request.
  }

  assert.equal(provider.requests[0].messages[0].content, 'from-context-engine')
})

test('passes opaque message metadata to tool context without interpreting it', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_echo',
        name: 'echo_context',
        argumentsDelta: '{"value":1}',
      },
      { type: 'finish', reason: 'tool_calls' },
    ],
    [{ type: 'assistant_delta', text: 'done' }, { type: 'finish', reason: 'stop' }],
  ])
  const observedContexts = []
  const metadata = {
    platform: 'qq',
    adapter: 'nonebot-napcat',
    nested: { value: true },
  }
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: [
      {
        name: 'echo_context',
        description: 'Echo context',
        inputSchema: { type: 'object', properties: { value: { type: 'number' } } },
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        call: async (_input, context) => {
          observedContexts.push(context)
          return { ok: true }
        },
      },
    ],
    sessionStore: new InMemorySessionStore(),
    permissionManager: new InMemoryPermissionManager(),
  })

  for await (const _event of engine.submitUserMessage({
    sessionId: 'opaque-session',
    text: 'run tool',
    senderId: 'sender-42',
    messageId: 'message-77',
    metadata,
  })) {
    // Drain the stream.
  }

  assert.deepEqual(observedContexts, [
    {
      sessionId: 'opaque-session',
      toolCallId: 'call_echo',
      senderId: 'sender-42',
      messageId: 'message-77',
      metadata,
    },
  ])
})

test('exposes only selected tools to the model provider', async () => {
  const provider = scriptedProvider([
    [{ type: 'assistant_delta', text: 'ok' }, { type: 'finish', reason: 'stop' }],
  ])
  const call = async () => ({ ok: true })
  const registry = new ToolRegistry([
    {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      group: 'files',
      call,
    },
    {
      name: 'send_message',
      description: 'Send message',
      inputSchema: { type: 'object', properties: {} },
      group: 'qq',
      activationRule: input => input.metadata?.platform === 'qq',
      call,
    },
  ])
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: registry.list(),
    toolSelector: new ToolSelector({ registry, groups: ['qq'] }),
    sessionStore: new InMemorySessionStore(),
    permissionManager: new InMemoryPermissionManager(),
  })

  for await (const _event of engine.submitUserMessage({
    sessionId: 'tool-select-session',
    text: 'hello',
    metadata: { platform: 'qq' },
  })) {
    // Drain the stream.
  }

  assert.deepEqual(
    provider.requests[0].tools.map(definition => definition.function.name),
    ['send_message'],
  )
})

test('rejects model calls to tools that were not exposed this turn', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_send',
        name: 'send_message',
        argumentsDelta: '{}',
      },
      { type: 'finish', reason: 'tool_calls' },
    ],
    [{ type: 'assistant_delta', text: 'refused' }, { type: 'finish', reason: 'stop' }],
  ])
  let sent = 0
  const call = async () => {
    sent += 1
    return { sent: true }
  }
  const registry = new ToolRegistry([
    {
      name: 'send_message',
      description: 'Send message',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      group: 'qq',
      call,
    },
  ])
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: registry.list(),
    toolSelector: new ToolSelector({
      registry,
      policy: new ToolPolicy({ denyToolNames: ['send_message'] }),
    }),
    sessionStore: new InMemorySessionStore(),
    permissionManager: new InMemoryPermissionManager(),
  })

  const events = []
  for await (const event of engine.submitUserMessage({
    sessionId: 'unexposed-tool-session',
    text: 'send it',
  })) {
    events.push(event)
  }

  assert.equal(sent, 0)
  assert.deepEqual(provider.requests[0].tools, [])
  assert.deepEqual(JSON.parse(provider.requests[1].messages.at(-1).content), {
    error: 'Tool not exposed this turn: send_message',
  })
  assert.equal(events.findLast(event => event.type !== 'turn_stage').type, 'final_result')
})

test('builds model context from summary, recent raw chat, and current question', async () => {
  const provider = scriptedProvider([
    [{ type: 'assistant_delta', text: '安排如下' }, { type: 'finish', reason: 'stop' }],
  ])
  const store = new InMemorySessionStore()
  await store.appendConversationSummary('qq-group:1000', {
    summary: '大家先讨论了晚饭，后来改为开黑。',
    fromMessageId: '1',
    toMessageId: '2',
  })
  await store.appendPlatformMessage({
    sessionId: 'qq-group:1000',
    messageId: '3',
    senderId: 'alice',
    text: '八点可以',
    timestamp: '2026-05-27T12:00:00.000Z',
    metadata: { platform: 'qq' },
  })
  await store.appendPlatformMessage({
    sessionId: 'qq-group:1000',
    messageId: '4',
    senderId: 'bob',
    text: '我九点到',
    timestamp: '2026-05-27T12:01:00.000Z',
    metadata: { platform: 'qq' },
  })
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: [],
    sessionStore: store,
    permissionManager: new InMemoryPermissionManager(),
    contextEngine: new ContextEngine({ sessionStore: store, recentMessageLimit: 2 }),
  })

  for await (const _event of engine.submitUserMessage({
    sessionId: 'qq-group:1000',
    text: '总结一下安排',
    messageId: '5',
    senderId: 'alice',
  })) {
    // Drain the stream.
  }

  const requestText = provider.requests[0].messages.map(message => message.content).join('\n')
  assert.match(requestText, /大家先讨论了晚饭/)
  assert.match(requestText, /alice: 八点可以/)
  assert.match(requestText, /bob: 我九点到/)
  assert.match(requestText, /总结一下安排/)
})

test('context compaction summarizes older messages and keeps recent raw messages', async () => {
  const provider = scriptedProvider([
    [{ type: 'assistant_delta', text: 'ok' }, { type: 'finish', reason: 'stop' }],
  ])
  const store = new InMemorySessionStore()
  for (let i = 1; i <= 5; i += 1) {
    await store.appendPlatformMessage({
      sessionId: 'compact-session',
      messageId: String(i),
      senderId: 'u',
      text: `消息 ${i}`,
      timestamp: `2026-05-27T12:0${i}:00.000Z`,
      metadata: {},
    })
  }
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: [],
    sessionStore: store,
    permissionManager: new InMemoryPermissionManager(),
    contextEngine: new ContextEngine({
      sessionStore: store,
      recentMessageLimit: 2,
      uncompactedMessageLimit: 3,
      summarizer: async messages => `压缩:${messages.map(message => message.messageId).join(',')}`,
    }),
  })

  for await (const _event of engine.submitUserMessage({
    sessionId: 'compact-session',
    text: '现在呢',
  })) {
    // Drain the stream.
  }

  const session = await store.getOrCreateSession('compact-session')
  assert.equal(session.conversationSummaries.at(-1).summary, '压缩:1,2,3')
  const requestText = provider.requests[0].messages.map(message => message.content).join('\n')
  assert.match(requestText, /压缩:1,2,3/)
  assert.doesNotMatch(requestText, /消息 1\n/)
  assert.match(requestText, /消息 4/)
  assert.match(requestText, /消息 5/)
})

test('context compaction keeps summary coverage continuous across repeated compactions', async () => {
  const provider = scriptedProvider([
    [{ type: 'assistant_delta', text: 'ok 1' }, { type: 'finish', reason: 'stop' }],
    [{ type: 'assistant_delta', text: 'ok 2' }, { type: 'finish', reason: 'stop' }],
  ])
  const store = new InMemorySessionStore()
  for (let i = 1; i <= 7; i += 1) {
    await store.appendPlatformMessage({
      sessionId: 'continuous-compact',
      messageId: String(i),
      senderId: 'u',
      text: `消息 ${i}`,
      timestamp: `2026-05-27T12:${String(i).padStart(2, '0')}:00.000Z`,
      metadata: {},
    })
  }
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: [],
    sessionStore: store,
    permissionManager: new InMemoryPermissionManager(),
    contextEngine: new ContextEngine({
      sessionStore: store,
      recentMessageLimit: 2,
      uncompactedMessageLimit: 3,
      summarizer: async (messages, previousSummary) =>
        `${previousSummary?.toMessageId ?? 'start'}:${messages
          .map(message => message.messageId)
          .join(',')}`,
    }),
  })

  for await (const _event of engine.submitUserMessage({
    sessionId: 'continuous-compact',
    text: '第一次',
  })) {
    // Drain the stream.
  }
  for (let i = 8; i <= 9; i += 1) {
    await store.appendPlatformMessage({
      sessionId: 'continuous-compact',
      messageId: String(i),
      senderId: 'u',
      text: `消息 ${i}`,
      timestamp: `2026-05-27T12:${String(i).padStart(2, '0')}:00.000Z`,
      metadata: {},
    })
  }
  for await (const _event of engine.submitUserMessage({
    sessionId: 'continuous-compact',
    text: '第二次',
  })) {
    // Drain the stream.
  }

  const summaries = (await store.getOrCreateSession('continuous-compact')).conversationSummaries
  assert.deepEqual(
    summaries.map(summary => [summary.fromMessageId, summary.toMessageId]),
    [
      ['1', '5'],
      ['6', '7'],
    ],
  )
  assert.equal(summaries[1].summary, '5:6,7')
})

test('context compaction resumes after an existing summary without recovering covered messages', async () => {
  const provider = scriptedProvider([
    [{ type: 'assistant_delta', text: 'ok' }, { type: 'finish', reason: 'stop' }],
  ])
  const store = new InMemorySessionStore()
  for (let i = 1; i <= 7; i += 1) {
    await store.appendPlatformMessage({
      sessionId: 'existing-summary',
      messageId: String(i),
      senderId: 'u',
      text: `消息 ${i}`,
      timestamp: `2026-05-27T12:${String(i).padStart(2, '0')}:00.000Z`,
      metadata: {},
    })
  }
  await store.appendConversationSummary('existing-summary', {
    summary: 'covered 1-3',
    fromMessageId: '1',
    toMessageId: '3',
  })
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: [],
    sessionStore: store,
    permissionManager: new InMemoryPermissionManager(),
    contextEngine: new ContextEngine({
      sessionStore: store,
      recentMessageLimit: 2,
      uncompactedMessageLimit: 3,
      summarizer: async messages => messages.map(message => message.messageId).join(','),
    }),
  })

  for await (const _event of engine.submitUserMessage({
    sessionId: 'existing-summary',
    text: '继续',
  })) {
    // Drain the stream.
  }

  const summaries = (await store.getOrCreateSession('existing-summary')).conversationSummaries
  assert.deepEqual(
    summaries.map(summary => [summary.fromMessageId, summary.toMessageId, summary.summary]),
    [
      ['1', '3', 'covered 1-3'],
      ['4', '5', '4,5'],
    ],
  )
})

test('OpenAI-compatible summarizer generates summary text with previous coverage context', async () => {
  const requests = []
  const summarizer = new OpenAICompatibleSummarizer({
    baseUrl: 'http://model.local/v1',
    apiKey: 'test-key',
    model: 'summary-model',
    fetchImpl: async (url, request) => {
      requests.push({ url, body: JSON.parse(request.body), headers: request.headers })
      return {
        ok: true,
        body: [
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"short "}}]}\n\n'),
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"summary"}}]}\n\n'),
          new TextEncoder().encode('data: [DONE]\n\n'),
        ],
      }
    },
  })

  const summary = await summarizer.summarize(
    [
      {
        messageId: '4',
        senderId: 'alice',
        text: '新消息',
        timestamp: '2026-05-27T12:04:00.000Z',
      },
    ],
    { summary: '旧摘要', fromMessageId: '1', toMessageId: '3' },
  )

  assert.equal(summary, 'short summary')
  assert.equal(requests[0].url, 'http://model.local/v1/chat/completions')
  assert.equal(requests[0].body.model, 'summary-model')
  assert.equal(requests[0].body.stream, true)
  assert.match(requests[0].body.messages.map(message => message.content).join('\n'), /旧摘要/)
  assert.match(requests[0].body.messages.map(message => message.content).join('\n'), /alice: 新消息/)
  assert.equal(requests[0].headers.authorization, 'Bearer test-key')
})

test('summary failures fall back to recent raw context without blocking the answer', async () => {
  const provider = scriptedProvider([
    [{ type: 'assistant_delta', text: 'ok' }, { type: 'finish', reason: 'stop' }],
  ])
  const store = new InMemorySessionStore()
  for (let i = 1; i <= 4; i += 1) {
    await store.appendPlatformMessage({
      sessionId: 'summary-failure',
      messageId: String(i),
      senderId: 'u',
      text: `raw ${i}`,
      timestamp: `2026-05-27T12:0${i}:00.000Z`,
      metadata: {},
    })
  }
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: [],
    sessionStore: store,
    permissionManager: new InMemoryPermissionManager(),
    contextEngine: new ContextEngine({
      sessionStore: store,
      recentMessageLimit: 2,
      uncompactedMessageLimit: 3,
      summarizer: async () => {
        throw new Error('summary model unavailable')
      },
    }),
  })

  const events = []
  for await (const event of engine.submitUserMessage({
    sessionId: 'summary-failure',
    text: 'continue',
  })) {
    events.push(event)
  }

  assert.equal(events.findLast(event => event.type !== 'turn_stage').type, 'final_result')
  const session = await store.getOrCreateSession('summary-failure')
  assert.equal(session.conversationSummaries.length, 0)
  const requestText = provider.requests[0].messages.map(message => message.content).join('\n')
  assert.match(requestText, /raw 3/)
  assert.match(requestText, /raw 4/)
})

test('memory candidate tool writes candidates without activating them', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_memory',
        name: 'propose_memory_candidate',
        argumentsDelta: JSON.stringify({
          scope: 'user',
          subjectId: '42',
          summary: '用户喜欢简洁回答',
          evidenceMessageIds: ['77'],
          confidence: 0.8,
        }),
      },
      { type: 'finish', reason: 'tool_calls' },
    ],
    [{ type: 'assistant_delta', text: '记下候选' }, { type: 'finish', reason: 'stop' }],
  ])
  const store = new InMemorySessionStore()
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: [createMemoryCandidateTool({ sessionStore: store })],
    sessionStore: store,
    permissionManager: new InMemoryPermissionManager(),
  })

  for await (const _event of engine.submitUserMessage({
    sessionId: 'qq-group:1000',
    text: '以后简洁点',
    senderId: '42',
    messageId: '77',
    metadata: { platform: 'qq' },
  })) {
    // Drain the stream.
  }

  const candidates = await store.listMemoryCandidates({ scope: 'user', subjectId: '42' })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].status, 'candidate')
  assert.equal(candidates[0].summary, '用户喜欢简洁回答')
  assert.equal(candidates[0].sessionId, 'qq-group:1000')
  assert.equal(candidates[0].createdByMessageId, '77')
  assert.equal(candidates[0].metadata.sourceSessionId, 'qq-group:1000')
  assert.equal(candidates[0].metadata.sourceSenderId, '42')
  assert.deepEqual(candidates[0].metadata.evidenceMessageIds, ['77'])
  assert.equal(candidates[0].metadata.confidence, 0.8)
  assert.deepEqual(await store.listActiveMemories({ scope: 'user', subjectId: '42' }), [])
})

test('search chat history tool searches only the current session by default', async () => {
  const store = new InMemorySessionStore()
  await store.appendPlatformMessage({
    sessionId: 'qq-group:1000',
    messageId: 'm1',
    senderId: '42',
    text: '今晚八点开黑',
    timestamp: '2026-05-27T12:00:00.000Z',
  })
  await store.appendPlatformMessage({
    sessionId: 'qq-group:2000',
    messageId: 'm2',
    senderId: '99',
    text: '今晚八点开会',
    timestamp: '2026-05-27T12:01:00.000Z',
  })

  const tool = createSearchChatHistoryTool({ sessionStore: store })
  const result = await tool.call({ query: '八点' }, { sessionId: 'qq-group:1000' })

  assert.equal(tool.name, 'search_chat_history')
  assert.equal(tool.requiresPermission, false)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].messageId, 'm1')
})

test('search chat history tool supports limit and senderId filters', async () => {
  const store = new InMemorySessionStore()
  for (const [messageId, senderId, text] of [
    ['m1', '42', '部署检查完成'],
    ['m2', '7', '部署还在跑'],
    ['m3', '42', '部署可以验收'],
  ]) {
    await store.appendPlatformMessage({
      sessionId: 'qq-group:1000',
      messageId,
      senderId,
      text,
    })
  }

  const tool = createSearchChatHistoryTool({ sessionStore: store })
  const result = await tool.call(
    { query: '部署', senderId: '42', limit: 1 },
    { sessionId: 'qq-group:1000' },
  )

  assert.deepEqual(
    result.messages.map(message => message.messageId),
    ['m3'],
  )
})

test('context engine injects only active memories for matching session and user scopes', async () => {
  const store = new InMemorySessionStore()
  const sessionCandidate = await store.appendMemoryCandidate({
    sessionId: 'qq-group:1000',
    scope: 'session',
    subjectId: 'qq-group:1000',
    summary: '本群固定九点开黑',
    evidenceMessageIds: ['1'],
    confidence: 0.9,
  })
  const userCandidate = await store.appendMemoryCandidate({
    sessionId: 'qq-user:42',
    scope: 'user',
    subjectId: '42',
    summary: '用户喜欢简洁回答',
    evidenceMessageIds: ['2'],
    confidence: 0.8,
  })
  await store.appendMemoryCandidate({
    sessionId: 'qq-user:7',
    scope: 'user',
    subjectId: '7',
    summary: '其他用户的记忆',
    evidenceMessageIds: ['3'],
    confidence: 0.8,
  })
  await store.activateMemoryCandidate(sessionCandidate.id)
  await store.activateMemoryCandidate(userCandidate.id)
  const provider = scriptedProvider([
    [{ type: 'assistant_delta', text: 'ok' }, { type: 'finish', reason: 'stop' }],
  ])
  const engine = new AgentEngine({
    modelProvider: provider,
    tools: [],
    sessionStore: store,
    permissionManager: new InMemoryPermissionManager(),
    contextEngine: new ContextEngine({ sessionStore: store }),
  })

  for await (const _event of engine.submitUserMessage({
    sessionId: 'qq-group:1000',
    senderId: '42',
    text: '总结',
  })) {
    // Drain the stream.
  }

  const requestText = provider.requests[0].messages.map(message => message.content).join('\n')
  assert.match(requestText, /本群固定九点开黑/)
  assert.match(requestText, /用户喜欢简洁回答/)
  assert.doesNotMatch(requestText, /其他用户的记忆/)
})

test('pauses side-effect tools until permission is allowed', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_send',
        name: 'send_message',
        argumentsDelta: '{"text":"ok"}',
      },
      { type: 'finish', reason: 'tool_calls' },
    ],
    [{ type: 'assistant_delta', text: '已发送' }, { type: 'finish', reason: 'stop' }],
  ])

  let sent = 0
  const permissionManager = new InMemoryPermissionManager({
    now: () => new Date('2026-05-25T00:00:00.000Z'),
  })
  const engine = new AgentEngine({
    modelProvider: provider,
    sessionStore: new InMemorySessionStore(),
    permissionManager,
    tools: [
      {
        name: 'send_message',
        description: 'Send a message',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        isReadOnly: () => false,
        isConcurrencySafe: () => false,
        call: async input => {
          sent += 1
          return { sent: true, text: input.text }
        },
      },
    ],
  })

  const iterator = engine.submitUserMessage({
    sessionId: 'session-alpha',
    text: '回复 ok',
  })

  let first = await iterator.next()
  while (first.value?.type === 'turn_stage') first = await iterator.next()
  assert.equal(first.value.type, 'permission_request')
  assert.equal(first.value.toolName, 'send_message')
  assert.equal(sent, 0)

  permissionManager.respond({
    toolCallId: 'call_send',
    decision: 'allow',
    responderId: 'admin',
  })

  const rest = []
  for await (const event of iterator) {
    rest.push(event)
  }

  assert.equal(sent, 1)
  assert.deepEqual(
    rest.filter(event => event.type !== 'turn_stage').map(event => event.type),
    ['tool_call_started', 'tool_call_finished', 'assistant_delta', 'final_result'],
  )
})

test('denied side-effect tools are not executed and the model receives a tool error result', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_send',
        name: 'send_message',
        argumentsDelta: '{"text":"blocked"}',
      },
      { type: 'finish', reason: 'tool_calls' },
    ],
    [
      { type: 'assistant_delta', text: '发送被拒绝' },
      { type: 'finish', reason: 'stop' },
    ],
  ])

  let sent = 0
  const permissionManager = new InMemoryPermissionManager()
  const engine = new AgentEngine({
    modelProvider: provider,
    sessionStore: new InMemorySessionStore(),
    permissionManager,
    tools: [
      {
        name: 'send_message',
        description: 'Send a message',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        isReadOnly: () => false,
        isConcurrencySafe: () => false,
        call: async () => {
          sent += 1
          return { sent: true }
        },
      },
    ],
  })

  const iterator = engine.submitUserMessage({
    sessionId: 'session-beta',
    text: '发出去',
  })

  let first = await iterator.next()
  while (first.value?.type === 'turn_stage') first = await iterator.next()
  assert.equal(first.value.type, 'permission_request')
  permissionManager.respond({
    toolCallId: 'call_send',
    decision: 'deny',
    reason: 'not authorized',
    responderId: 'admin',
  })

  const rest = []
  for await (const event of iterator) {
    rest.push(event)
  }

  assert.equal(sent, 0)
  assert.equal(provider.requests.length, 2)
  assert.deepEqual(JSON.parse(provider.requests[1].messages.at(-1).content), {
    error: 'Permission denied',
    reason: 'not authorized',
  })
  assert.equal(rest.findLast(event => event.type !== 'turn_stage').type, 'final_result')
})

test('permission requests time out with a deny decision', async () => {
  const manager = new InMemoryPermissionManager()
  const { response } = manager.createRequest({
    sessionId: 'session-alpha',
    toolCallId: 'call_timeout',
    toolName: 'send_message',
    input: {},
    ttlMs: 5,
  })

  const decision = await response

  assert.equal(decision.toolCallId, 'call_timeout')
  assert.equal(decision.decision, 'deny')
  assert.equal(decision.reason, 'Permission request timed out')
})

test('returns an error when model tool calls exceed maxTurns', async () => {
  const provider = {
    requests: [],
    async *streamChat(request) {
      this.requests.push(request)
      yield {
        type: 'tool_call_delta',
        index: 0,
        id: `call_${this.requests.length}`,
        name: 'missing_tool',
        argumentsDelta: '{}',
      }
      yield { type: 'finish', reason: 'tool_calls' }
    },
  }
  const engine = new AgentEngine({
    modelProvider: provider,
    sessionStore: new InMemorySessionStore(),
    permissionManager: new InMemoryPermissionManager(),
    tools: [],
    maxTurns: 2,
  })

  const events = []
  for await (const event of engine.submitUserMessage({
    sessionId: 'loop-session',
    text: 'loop',
  })) {
    events.push(event)
  }

  const last = events.findLast(event => event.type !== 'turn_stage')
  assert.equal(last.type, 'error')
  assert.match(last.error, /Reached maximum number of turns/)
  assert.equal(provider.requests.length, 2)
})

test('returns an error when a turn times out', async () => {
  const provider = {
    async *streamChat(request) {
      await new Promise(resolve => {
        request.signal.addEventListener('abort', resolve, { once: true })
      })
      yield { type: 'assistant_delta', text: 'late' }
    },
  }
  const engine = new AgentEngine({
    modelProvider: provider,
    sessionStore: new InMemorySessionStore(),
    permissionManager: new InMemoryPermissionManager(),
    tools: [],
    turnTimeoutMs: 5,
  })

  const events = []
  for await (const event of engine.submitUserMessage({
    sessionId: 'timeout-session',
    text: 'slow',
  })) {
    events.push(event)
  }

  const last = events.findLast(event => event.type !== 'turn_stage')
  assert.equal(last.type, 'error')
  assert.equal(last.error, 'Agent turn timed out')
})

test('built-in chat tools read recent messages and active memories without permission', async () => {
  const store = new InMemorySessionStore()
  await store.appendPlatformMessage({
    sessionId: 'qq-group:1000',
    messageId: 'm1',
    senderId: '42',
    text: '第一条',
    timestamp: '2026-05-27T12:00:00.000Z',
    metadata: {},
  })
  const memory = await store.appendMemoryCandidate({
    sessionId: 'qq-group:1000',
    scope: 'session',
    subjectId: 'qq-group:1000',
    summary: '本群喜欢晚上九点开黑',
    evidenceMessageIds: ['m1'],
    confidence: 0.9,
  })
  await store.activateMemoryCandidate(memory.id)
  const recentTool = createRecentMessagesTool({ sessionStore: store })
  const memoryTool = createActiveMemoriesTool({ sessionStore: store })

  const recent = await recentTool.call({ limit: 3 }, { sessionId: 'qq-group:1000' })
  const memories = await memoryTool.call({}, { sessionId: 'qq-group:1000', senderId: '42' })

  assert.equal(recent.messages[0].text, '第一条')
  assert.equal(memories.memories[0].summary, '本群喜欢晚上九点开黑')
  assert.equal(recentTool.readOnly, true)
  assert.equal(memoryTool.requiresPermission, false)
})

test('context engine prioritizes sender messages and keeps the current trigger at the end', async () => {
  const store = new InMemorySessionStore()
  for (let i = 1; i <= 8; i += 1) {
    await store.appendPlatformMessage({
      sessionId: 'qq-group:1000',
      messageId: `m${i}`,
      senderId: i === 1 ? '42' : `u${i}`,
      text: `消息 ${i}`,
      timestamp: `2026-05-27T12:0${i}:00.000Z`,
      metadata: {},
    })
  }
  await store.appendPlatformMessage({
    sessionId: 'qq-group:1000',
    messageId: 'm9',
    senderId: '42',
    text: '#agent 现在总结',
    timestamp: '2026-05-27T12:09:00.000Z',
    metadata: {},
  })
  const contextEngine = new ContextEngine({
    sessionStore: store,
    recentMessageLimit: 3,
    senderContextLimit: 2,
  })

  const { messages } = await contextEngine.build({
    sessionId: 'qq-group:1000',
    systemPrompt: 'system',
    text: '现在总结',
    senderId: '42',
    messageId: 'm9',
  })
  const raw = messages.find(message => message.content.startsWith('Recent raw chat messages'))

  assert.match(raw.content, /消息 1/)
  assert.match(raw.content, /消息 7/)
  assert.match(raw.content, /消息 8/)
  assert.match(raw.content, /#agent 现在总结/)
  assert.ok(raw.content.lastIndexOf('#agent 现在总结') > raw.content.lastIndexOf('消息 8'))
  assert.equal(messages.at(-1).content, '现在总结')
})
