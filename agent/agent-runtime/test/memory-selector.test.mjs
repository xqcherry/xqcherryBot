import assert from 'node:assert/strict'
import test from 'node:test'

import {
  InMemorySessionStore,
  MemorySelector,
  TokenEstimator,
} from '../src/index.mjs'

test('memory selector reads active session and user memories in stable order', async () => {
  const store = new InMemorySessionStore()
  const userMemory = await store.appendMemoryCandidate({
    id: 'memory-user',
    sessionId: 'qq-user:42',
    scope: 'user',
    subjectId: '42',
    summary: '用户喜欢简洁回答',
    createdAt: '2026-05-29T00:02:00.000Z',
  })
  const sessionMemory = await store.appendMemoryCandidate({
    id: 'memory-session',
    sessionId: 'qq-group:1000',
    scope: 'session',
    subjectId: 'qq-group:1000',
    summary: '本群固定九点开黑',
    createdAt: '2026-05-29T00:01:00.000Z',
  })
  const otherUserMemory = await store.appendMemoryCandidate({
    id: 'memory-other-user',
    sessionId: 'qq-user:7',
    scope: 'user',
    subjectId: '7',
    summary: '其他用户的记忆',
    createdAt: '2026-05-29T00:00:00.000Z',
  })
  await store.activateMemoryCandidate(userMemory.id)
  await store.activateMemoryCandidate(sessionMemory.id)
  await store.activateMemoryCandidate(otherUserMemory.id)

  const selector = new MemorySelector({ sessionStore: store })
  const memories = await selector.select({
    sessionId: 'qq-group:1000',
    senderId: '42',
  })

  assert.deepEqual(memories.map(memory => memory.id), ['memory-session', 'memory-user'])
})

test('memory selector builds a reusable long-term memory block', async () => {
  const store = new InMemorySessionStore()
  const memory = await store.appendMemoryCandidate({
    id: 'memory-session',
    sessionId: 'qq-group:1000',
    scope: 'session',
    subjectId: 'qq-group:1000',
    summary: '本群固定九点开黑',
  })
  await store.activateMemoryCandidate(memory.id)
  const selector = new MemorySelector({ sessionStore: store })

  const block = await selector.buildBlock({
    sessionId: 'qq-group:1000',
  })

  assert.equal(block.id, 'long-term-memory')
  assert.equal(block.type, 'memory')
  assert.equal(block.stability, 'semi-stable')
  assert.equal(block.role, 'system')
  assert.match(block.content, /Active long-term memories/)
  assert.match(block.content, /session:qq-group:1000/)
  assert.deepEqual(block.metadata.memoryIds, ['memory-session'])
})

test('memory selector can cap selected memories by token budget', async () => {
  const store = new InMemorySessionStore()
  const first = await store.appendMemoryCandidate({
    id: 'memory-1',
    sessionId: 'qq-group:1000',
    scope: 'session',
    subjectId: 'qq-group:1000',
    summary: 'short',
    createdAt: '2026-05-29T00:01:00.000Z',
  })
  const second = await store.appendMemoryCandidate({
    id: 'memory-2',
    sessionId: 'qq-group:1000',
    scope: 'session',
    subjectId: 'qq-group:1000',
    summary: 'this memory is too long for the tiny budget',
    createdAt: '2026-05-29T00:02:00.000Z',
  })
  await store.activateMemoryCandidate(first.id)
  await store.activateMemoryCandidate(second.id)
  const selector = new MemorySelector({
    sessionStore: store,
    maxMemoryTokens: 2,
    tokenEstimator: new TokenEstimator(),
  })

  const memories = await selector.select({ sessionId: 'qq-group:1000' })

  assert.deepEqual(memories.map(memory => memory.id), ['memory-1'])
})
