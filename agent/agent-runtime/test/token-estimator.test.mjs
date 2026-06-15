import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CompactionPolicy,
  TokenEstimator,
} from '../src/index.mjs'

test('token estimator estimates text content and platform message text', () => {
  const estimator = new TokenEstimator({ charsPerToken: 4, messageOverheadTokens: 2 })

  assert.equal(estimator.estimateText('12345678'), 2)
  assert.equal(estimator.estimateMessage({ content: '12345678' }), 4)
  assert.equal(estimator.estimateMessage({ text: '123456789' }), 5)
  assert.equal(estimator.estimateMessages([{ text: '1234' }, { content: '12345678' }]), 7)
})

test('token-aware compaction triggers for long messages below the legacy message threshold', () => {
  const messages = [
    { messageId: '1', text: 'x'.repeat(120) },
    { messageId: '2', text: 'tail' },
  ]
  const policy = new CompactionPolicy({
    recentMessageLimit: 1,
    uncompactedMessageLimit: 80,
    tokenEstimator: new TokenEstimator({ charsPerToken: 4, messageOverheadTokens: 0 }),
    contextWindowTokens: 40,
    thresholdRatio: 0.5,
    reservedOutputTokens: 0,
  })

  const plan = policy.plan({ messages })

  assert.equal(plan.shouldCompact, true)
  assert.equal(plan.reason, 'token_threshold_exceeded')
  assert.deepEqual(plan.compactable.map(message => message.messageId), ['1'])
  assert.equal(plan.tokenEstimate, 31)
  assert.equal(plan.tokenThreshold, 20)
  assert.equal(plan.safetyTokenThreshold, 34)
  assert.equal(plan.reservedOutputTokens, 0)
})

test('token-aware compaction accounts for reserved output tokens in thresholds', () => {
  const messages = [
    { messageId: '1', text: 'x'.repeat(72) },
    { messageId: '2', text: 'tail' },
  ]
  const policy = new CompactionPolicy({
    recentMessageLimit: 1,
    tokenEstimator: new TokenEstimator({ charsPerToken: 4, messageOverheadTokens: 0 }),
    contextWindowTokens: 100,
    thresholdRatio: 0.5,
    safetyRatio: 0.85,
    reservedOutputTokens: 20,
  })

  const plan = policy.plan({ messages })

  assert.equal(plan.shouldCompact, false)
  assert.equal(plan.reason, 'below_token_threshold')
  assert.equal(plan.rawTokenEstimate, 19)
  assert.equal(plan.tokenEstimate, 39)
  assert.equal(plan.tokenThreshold, 60)
  assert.equal(plan.safetyTokenThreshold, 88)
  assert.equal(plan.reservedOutputTokens, 20)
})

test('token-aware compaction reports safety threshold pressure separately', () => {
  const messages = [
    { messageId: '1', text: 'x'.repeat(360) },
    { messageId: '2', text: 'tail' },
  ]
  const policy = new CompactionPolicy({
    recentMessageLimit: 1,
    tokenEstimator: new TokenEstimator({ charsPerToken: 4, messageOverheadTokens: 0 }),
    contextWindowTokens: 100,
    thresholdRatio: 0.5,
    safetyRatio: 0.85,
    reservedOutputTokens: 10,
  })

  const plan = policy.plan({ messages })

  assert.equal(plan.shouldCompact, true)
  assert.equal(plan.reason, 'token_safety_threshold_exceeded')
  assert.equal(plan.isSafetyExceeded, true)
  assert.equal(plan.tokenThreshold, 55)
  assert.equal(plan.safetyTokenThreshold, 86)
  assert.deepEqual(plan.compactable.map(message => message.messageId), ['1'])
})

test('compaction policy estimates post-compaction tokens with protected tail and reserved output', () => {
  const messages = [
    { messageId: '1', text: 'aaaaaaaaaa' },
    { messageId: '2', text: 'bbbb' },
    { messageId: '3', text: 'current' },
  ]
  const policy = new CompactionPolicy({
    recentMessageLimit: 1,
    tokenEstimator: new TokenEstimator({ charsPerToken: 1, messageOverheadTokens: 0 }),
    contextWindowTokens: 100,
    reservedOutputTokens: 5,
  })

  const estimate = policy.estimatePostCompactionTokens({
    messages,
    compactable: [messages[0]],
    summary: 'sum',
    currentMessageId: '3',
  })

  assert.equal(estimate, 3 + 4 + 7 + 5)
})

test('token-aware compaction does not compact many short messages under token threshold', () => {
  const messages = Array.from({ length: 6 }, (_, index) => ({
    messageId: String(index + 1),
    text: 'ok',
  }))
  const policy = new CompactionPolicy({
    recentMessageLimit: 1,
    uncompactedMessageLimit: 3,
    tokenEstimator: new TokenEstimator({ charsPerToken: 4, messageOverheadTokens: 0 }),
    contextWindowTokens: 100,
    thresholdRatio: 0.8,
    reservedOutputTokens: 0,
  })

  const plan = policy.plan({ messages })

  assert.equal(plan.shouldCompact, false)
  assert.equal(plan.reason, 'below_token_threshold')
})

test('compaction policy protects recent tail by token budget when configured', () => {
  const messages = [
    { messageId: '1', text: 'a' },
    { messageId: '2', text: 'bb' },
    { messageId: '3', text: 'ccc' },
    { messageId: '4', text: 'dd' },
    { messageId: '5', text: 'ee' },
  ]
  const policy = new CompactionPolicy({
    uncompactedMessageLimit: 3,
    recentMessageLimit: 1,
    recentTailTokenBudget: 4,
    tokenEstimator: new TokenEstimator({ charsPerToken: 1, messageOverheadTokens: 0 }),
  })

  const plan = policy.plan({ messages })

  assert.equal(plan.shouldCompact, true)
  assert.deepEqual(plan.compactable.map(message => message.messageId), ['1', '2', '3'])
})

test('compaction policy keeps only the newest oversized tail message when it exceeds tail budget', () => {
  const messages = [
    { messageId: '1', text: 'a' },
    { messageId: '2', text: 'bb' },
    { messageId: '3', text: 'x'.repeat(100) },
  ]
  const policy = new CompactionPolicy({
    uncompactedMessageLimit: 1,
    recentMessageLimit: 2,
    recentTailTokenBudget: 4,
    tokenEstimator: new TokenEstimator({ charsPerToken: 1, messageOverheadTokens: 0 }),
  })

  const plan = policy.plan({ messages })

  assert.equal(plan.shouldCompact, true)
  assert.deepEqual(plan.compactable.map(message => message.messageId), ['1', '2'])
})

test('compaction policy excludes current message from recent tail token budget', () => {
  const messages = [
    { messageId: '1', text: 'a' },
    { messageId: '2', text: 'bb' },
    { messageId: '3', text: 'cc' },
    { messageId: '4', text: 'dd' },
    { messageId: '5', text: 'current message is long' },
  ]
  const policy = new CompactionPolicy({
    uncompactedMessageLimit: 3,
    recentMessageLimit: 1,
    recentTailTokenBudget: 4,
    tokenEstimator: new TokenEstimator({ charsPerToken: 1, messageOverheadTokens: 0 }),
  })

  const plan = policy.plan({ messages, currentMessageId: '5' })

  assert.equal(plan.shouldCompact, true)
  assert.deepEqual(plan.compactable.map(message => message.messageId), ['1', '2'])
})
