import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CachePolicy,
  ContextEngine,
  contextBlocksToMessages,
} from '../src/index.mjs'

test('cache policy preserves semantic order and marks the stable prefix boundary', () => {
  const policy = new CachePolicy()
  const blocks = [
    { id: 'recent', type: 'recent_raw_context', stability: 'dynamic', role: 'system', content: 'recent' },
    { id: 'skill', type: 'agent_skill', stability: 'stable', role: 'system', content: 'skill' },
    { id: 'current-user-message', type: 'current_user_message', stability: 'dynamic', role: 'user', content: 'hello' },
    { id: 'summary', type: 'summary', stability: 'semi-stable', role: 'system', content: 'summary' },
    { id: 'base', type: 'prompt', stability: 'stable', role: 'system', content: 'base' },
  ]

  const ordered = policy.apply(blocks)

  assert.deepEqual(
    ordered.map(block => block.id),
    ['recent', 'skill', 'current-user-message', 'summary', 'base'],
  )
  assert.equal(ordered.some(block => block.metadata?.cacheBoundary), false)
  assert.equal(blocks[1].metadata, undefined)
})

test('context engine applies cache policy before converting blocks to messages', async () => {
  const contextEngine = new ContextEngine({
    sessionStore: {
      async getOrCreateSession() {
        return { conversationSummaries: [], toolCalls: [], permissionAudit: [] }
      },
      async getPlatformMessages() {
        return []
      },
    },
    compactionEngine: null,
    memorySelector: null,
    cachePolicy: new CachePolicy(),
  })

  const result = await contextEngine.build({
    sessionId: 'cache-session',
    systemPrompt: 'unused',
    text: 'hello',
  })

  assert.deepEqual(result.blocks.map(block => block.id), [
    'chat-persona',
    'turn-context',
    'current-user-message',
  ])
  assert.deepEqual(result.messages, contextBlocksToMessages(result.blocks))
  assert.match(result.messages[0].content, /QQ chat agent/)
  assert.match(result.messages[1].content, /Current turn context/)
  assert.equal(result.messages[2].content, 'hello')
})
