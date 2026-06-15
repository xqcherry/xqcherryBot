import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CompactionPolicy,
  ContextEngine,
  ContextCompactionEngine,
  InMemorySessionStore,
  MessagePruner,
  SummaryQualityChecker,
  SummaryValidator,
  TokenEstimator,
} from '../src/index.mjs'

async function seedMessages(store, sessionId, count) {
  for (let index = 1; index <= count; index += 1) {
    await store.appendPlatformMessage({
      sessionId,
      messageId: String(index),
      senderId: 'user',
      text: `message ${index}`,
      timestamp: `2026-05-29T10:${String(index).padStart(2, '0')}:00.000Z`,
    })
  }
}

test('compaction policy selects only uncovered middle messages and protects recent tail', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-alpha', 7)
  await store.appendConversationSummary('session-alpha', {
    summary: 'covered',
    fromMessageId: '1',
    toMessageId: '3',
  })
  const session = await store.getOrCreateSession('session-alpha')
  const messages = await store.getPlatformMessages('session-alpha')
  const policy = new CompactionPolicy({
    recentMessageLimit: 2,
    uncompactedMessageLimit: 3,
  })

  const plan = policy.plan({ messages, latestSummary: session.conversationSummaries.at(-1) })

  assert.equal(plan.shouldCompact, true)
  assert.deepEqual(plan.compactable.map(message => message.messageId), ['4', '5'])
  assert.equal(plan.reason, 'message_threshold_exceeded')
})

test('compaction policy excludes the current message from compactable history', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-current-protection', 7)
  const messages = await store.getPlatformMessages('session-current-protection')
  const policy = new CompactionPolicy({
    recentMessageLimit: 2,
    uncompactedMessageLimit: 3,
  })

  const plan = policy.plan({ messages, currentMessageId: '2' })

  assert.equal(plan.shouldCompact, true)
  assert.deepEqual(plan.compactable.map(message => message.messageId), ['1', '3', '4', '5'])
})

test('context compaction engine writes summary metadata on success', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-beta', 5)
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 2,
      uncompactedMessageLimit: 3,
      contextWindowTokens: 10,
    }),
    summarizer: async messages => `summary:${messages.map(message => message.messageId).join(',')}`,
    now: () => '2026-05-29T00:00:00.000Z',
    provider: 'openai-compatible',
    model: 'summary-model',
    promptVersion: 'structured-summary-v1',
  })

  const result = await engine.compact('session-beta')

  assert.equal(result.status, 'success')
  assert.deepEqual(result.compactedMessageIds, ['1', '2', '3'])
  const summary = (await store.getOrCreateSession('session-beta')).conversationSummaries.at(-1)
  assert.equal(summary.version, 2)
  assert.equal(summary.promptVersion, 'structured-summary-v1')
  assert.equal(summary.format, 'markdown')
  assert.equal(summary.summary, 'summary:1,2,3')
  assert.equal(summary.fromMessageId, '1')
  assert.equal(summary.toMessageId, '3')
  assert.equal(summary.messageCount, 3)
  assert.equal(summary.provider, 'openai-compatible')
  assert.equal(summary.model, 'summary-model')
  assert.equal(summary.status, 'success')
  assert.equal(summary.createdAt, '2026-05-29T00:00:00.000Z')
  assert.equal(typeof summary.inputTokenEstimate, 'number')
  assert.equal(typeof summary.outputTokenEstimate, 'number')
  assert.equal(typeof summary.postCompactionTokenEstimate, 'number')
  assert.equal(typeof summary.compressionRatio, 'number')
  assert.deepEqual(engine.getStatus('session-beta'), {
    status: 'success',
    reason: 'token_safety_threshold_exceeded',
    failureCount: 0,
    lastError: null,
    inputTokenEstimate: summary.inputTokenEstimate,
    outputTokenEstimate: summary.outputTokenEstimate,
    postCompactionTokenEstimate: summary.postCompactionTokenEstimate,
    prunedInputTokenEstimate: null,
    compressionRatio: summary.compressionRatio,
    fromMessageId: '1',
    toMessageId: '3',
    provider: 'openai-compatible',
    model: 'summary-model',
    updatedAt: '2026-05-29T00:00:00.000Z',
  })
})

test('context compaction engine skips persistence when compression savings are too low', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-low-savings', 4)
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 1,
      uncompactedMessageLimit: 3,
      tokenEstimator: new TokenEstimator({ charsPerToken: 1, messageOverheadTokens: 0 }),
    }),
    tokenEstimator: new TokenEstimator({ charsPerToken: 1, messageOverheadTokens: 0 }),
    minSavingsRatio: 0.8,
    summarizer: async () => 'x'.repeat(20),
    now: () => '2026-05-29T00:01:00.000Z',
    provider: 'openai-compatible',
    model: 'summary-model',
  })

  const result = await engine.compact('session-low-savings')

  assert.equal(result.status, 'skipped')
  assert.equal(result.reason, 'low_savings_ratio')
  assert.equal((await store.getOrCreateSession('session-low-savings')).conversationSummaries.length, 0)
  const status = engine.getStatus('session-low-savings')
  assert.equal(status.status, 'skipped')
  assert.equal(status.reason, 'low_savings_ratio')
  assert.equal(status.fromMessageId, '1')
  assert.equal(status.toMessageId, '3')
  assert.equal(status.provider, 'openai-compatible')
  assert.equal(status.model, 'summary-model')
  assert.equal(status.updatedAt, '2026-05-29T00:01:00.000Z')
  assert.equal(typeof status.inputTokenEstimate, 'number')
  assert.equal(typeof status.outputTokenEstimate, 'number')
  assert.equal(typeof status.postCompactionTokenEstimate, 'number')
  assert.equal(typeof status.compressionRatio, 'number')
})

test('context compaction engine emits diagnostic events for compaction outcomes', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-diagnostic-event', 4)
  const events = []
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 1,
      uncompactedMessageLimit: 3,
    }),
    summarizer: async () => 'diagnostic summary',
    now: () => '2026-05-29T00:02:00.000Z',
    provider: 'openai-compatible',
    model: 'summary-model',
    onDiagnostic: event => events.push(event),
  })

  const result = await engine.compact('session-diagnostic-event')

  assert.equal(result.status, 'success')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'compaction_diagnostic')
  assert.equal(events[0].sessionId, 'session-diagnostic-event')
  assert.equal(events[0].status.status, 'success')
  assert.equal(events[0].status.provider, 'openai-compatible')
  assert.equal(events[0].status.model, 'summary-model')
  assert.equal(events[0].status.updatedAt, '2026-05-29T00:02:00.000Z')
})

test('context compaction engine emits diagnostic events when circuit opens', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-circuit-diagnostic', 4)
  const events = []
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 1,
      uncompactedMessageLimit: 3,
    }),
    maxFailures: 1,
    summarizer: async () => {
      throw new Error('summary unavailable')
    },
    onDiagnostic: event => events.push(event),
  })

  const result = await engine.compact('session-circuit-diagnostic')

  assert.equal(result.status, 'failed')
  assert.equal(events.at(-1).type, 'compaction_diagnostic')
  assert.equal(events.at(-1).status.status, 'circuit_open')
  assert.equal(events.at(-1).status.reason, 'circuit_open')
  assert.equal(events.at(-1).status.failureCount, 1)
})

test('context compaction engine passes current message protection into policy', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-engine-current-protection', 7)
  let compactedIds = []
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 2,
      uncompactedMessageLimit: 3,
    }),
    summarizer: async messages => {
      compactedIds = messages.map(message => message.messageId)
      return 'protected summary'
    },
  })

  const result = await engine.compact('session-engine-current-protection', {
    currentMessageId: '2',
  })

  assert.equal(result.status, 'success')
  assert.deepEqual(compactedIds, ['1', '3', '4', '5'])
})

test('context compaction engine prunes compactable messages before summarizing', async () => {
  const store = new InMemorySessionStore()
  await store.appendPlatformMessage({
    sessionId: 'session-pruning',
    messageId: '1',
    senderId: 'user',
    text: 'x'.repeat(50),
  })
  await store.appendPlatformMessage({
    sessionId: 'session-pruning',
    messageId: '2',
    senderId: 'user',
    text: 'tail',
  })
  let summarizerMessages = []
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 1,
      uncompactedMessageLimit: 1,
    }),
    messagePruner: new MessagePruner({ maxTextLength: 10 }),
    summarizer: async messages => {
      summarizerMessages = messages
      return 'pruned summary'
    },
  })

  const result = await engine.compact('session-pruning')

  assert.equal(result.status, 'success')
  assert.equal(summarizerMessages.length, 1)
  assert.match(summarizerMessages[0].text, /pruned 40 chars/)
  const summary = (await store.getOrCreateSession('session-pruning')).conversationSummaries.at(-1)
  assert.deepEqual(summary.pruning, {
    originalCount: 1,
    prunedCount: 1,
    prunedInputTokenEstimate: 11,
  })
  assert.equal(engine.getStatus('session-pruning').prunedInputTokenEstimate, 11)
})

test('context compaction engine treats summary failures as skipped persistence', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-gamma', 4)
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 2,
      uncompactedMessageLimit: 3,
    }),
    summarizer: async () => {
      throw new Error('summary unavailable')
    },
  })

  const result = await engine.compact('session-gamma')

  assert.equal(result.status, 'failed')
  assert.equal(result.error.message, 'summary unavailable')
  assert.equal((await store.getOrCreateSession('session-gamma')).conversationSummaries.length, 0)
})

test('context compaction engine rejects empty summaries without persistence', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-empty-summary', 4)
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 2,
      uncompactedMessageLimit: 3,
    }),
    summarizer: async () => '   ',
  })

  const result = await engine.compact('session-empty-summary')

  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'summary_validation_failed')
  assert.match(result.error.message, /empty/)
  assert.equal((await store.getOrCreateSession('session-empty-summary')).conversationSummaries.length, 0)
  assert.equal(engine.getStatus('session-empty-summary').lastError, result.error.message)
})

test('context compaction engine rejects structured summaries missing required sections', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-invalid-structured-summary', 4)
  await store.appendConversationSummary('session-invalid-structured-summary', {
    summary: 'previous valid summary',
    fromMessageId: '0',
    toMessageId: '0',
  })
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 2,
      uncompactedMessageLimit: 3,
    }),
    summaryValidator: new SummaryValidator({ requireStructuredSections: true }),
    summarizer: async () => '## Active Request\n继续',
  })

  const result = await engine.compact('session-invalid-structured-summary')

  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'summary_validation_failed')
  assert.match(result.error.message, /Missing summary sections/)
  const summaries = (await store.getOrCreateSession('session-invalid-structured-summary')).conversationSummaries
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].summary, 'previous valid summary')
})

test('context compaction engine rejects summaries shorter than validator minimum', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-short-summary', 4)
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 2,
      uncompactedMessageLimit: 3,
    }),
    summaryValidator: new SummaryValidator({ minLength: 10 }),
    summarizer: async () => 'short',
  })

  const result = await engine.compact('session-short-summary')

  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'summary_validation_failed')
  assert.match(result.error.message, /too short/)
  assert.equal((await store.getOrCreateSession('session-short-summary')).conversationSummaries.length, 0)
})

test('context compaction engine rejects summaries that drop critical quality sections', async () => {
  const store = new InMemorySessionStore()
  await store.appendPlatformMessage({
    sessionId: 'session-quality-check',
    messageId: '1',
    senderId: 'user',
    text: '我希望分步骤完成，这个怎么做？',
  })
  await store.appendPlatformMessage({
    sessionId: 'session-quality-check',
    messageId: '2',
    senderId: 'user',
    text: 'tail',
  })
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 1,
      uncompactedMessageLimit: 1,
    }),
    summaryQualityChecker: new SummaryQualityChecker(),
    summarizer: async () => [
      '## Active Request',
      'none',
      '## User Preferences',
      'none',
      '## Open Questions',
      'none',
    ].join('\n'),
  })

  const result = await engine.compact('session-quality-check')

  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'summary_quality_failed')
  assert.match(result.error.message, /missing_active_request/)
  assert.equal((await store.getOrCreateSession('session-quality-check')).conversationSummaries.length, 0)
  assert.equal(engine.getStatus('session-quality-check').reason, 'summary_quality_failed')
})

test('context compaction engine can validate JSON summary schema', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-json-summary', 4)
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 1,
      uncompactedMessageLimit: 3,
    }),
    format: 'json',
    summaryValidator: new SummaryValidator({ format: 'json' }),
    summarizer: async () => JSON.stringify({
      activeRequest: '继续实现 JSON schema。',
      completedWork: ['已接入 validator。'],
      keyDecisions: ['保留 markdown 兼容。'],
      userPreferences: [],
      importantFacts: ['summary format is json.'],
      openQuestions: [],
      remainingWork: ['补文档。'],
      relevantFiles: ['packages/agent-runtime/src/runtime/summary-validator.mjs'],
    }),
  })

  const result = await engine.compact('session-json-summary')

  assert.equal(result.status, 'success')
  const summary = (await store.getOrCreateSession('session-json-summary')).conversationSummaries.at(-1)
  assert.equal(summary.format, 'json')
  assert.match(summary.summary, /activeRequest/)
})

test('context compaction engine rejects invalid JSON summary schema', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-invalid-json-summary', 4)
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 1,
      uncompactedMessageLimit: 3,
    }),
    format: 'json',
    summaryValidator: new SummaryValidator({ format: 'json' }),
    summarizer: async () => JSON.stringify({ activeRequest: 'missing fields' }),
  })

  const result = await engine.compact('session-invalid-json-summary')

  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'summary_validation_failed')
  assert.match(result.error.message, /Missing JSON summary fields/)
  assert.equal((await store.getOrCreateSession('session-invalid-json-summary')).conversationSummaries.length, 0)
})

test('context compaction engine opens circuit breaker after repeated failures', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-circuit', 5)
  let attempts = 0
  const engine = new ContextCompactionEngine({
    sessionStore: store,
    policy: new CompactionPolicy({
      recentMessageLimit: 2,
      uncompactedMessageLimit: 3,
    }),
    maxFailures: 2,
    summarizer: async () => {
      attempts += 1
      throw new Error(`summary unavailable ${attempts}`)
    },
  })

  assert.equal((await engine.compact('session-circuit')).status, 'failed')
  assert.equal((await engine.compact('session-circuit')).status, 'failed')
  const blocked = await engine.compact('session-circuit')

  assert.equal(blocked.status, 'skipped')
  assert.equal(blocked.reason, 'circuit_open')
  assert.equal(attempts, 2)
  const status = engine.getStatus('session-circuit')
  assert.equal(status.status, 'circuit_open')
  assert.equal(status.reason, 'circuit_open')
  assert.equal(status.failureCount, 2)
  assert.equal(status.lastError, 'summary unavailable 2')
  assert.equal(typeof status.updatedAt, 'string')
})

test('context engine delegates compaction to injected compaction engine', async () => {
  const store = new InMemorySessionStore()
  let calls = 0
  const contextEngine = new ContextEngine({
    sessionStore: store,
    compactionEngine: {
      async compact(sessionId) {
        calls += 1
        assert.equal(sessionId, 'session-delta')
        return { status: 'skipped' }
      },
    },
  })

  await contextEngine.build({
    sessionId: 'session-delta',
    systemPrompt: 'system',
    text: 'hello',
  })

  assert.equal(calls, 1)
})

test('context engine keeps current reply context when summary validation fails', async () => {
  const store = new InMemorySessionStore()
  await seedMessages(store, 'session-validation-fallback', 4)
  const contextEngine = new ContextEngine({
    sessionStore: store,
    recentMessageLimit: 2,
    uncompactedMessageLimit: 3,
    summarizer: async () => '',
  })

  const { messages } = await contextEngine.build({
    sessionId: 'session-validation-fallback',
    systemPrompt: 'system',
    text: 'current request',
    messageId: 'current-message',
  })

  assert.equal(messages.at(-1).role, 'user')
  assert.equal(messages.at(-1).content, 'current request')
  assert.equal((await store.getOrCreateSession('session-validation-fallback')).conversationSummaries.length, 0)
})
