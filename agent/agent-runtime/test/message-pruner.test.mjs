import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MessagePruner,
  pruneMessagesForSummary,
} from '../src/index.mjs'

test('message pruner truncates long messages without mutating originals', () => {
  const original = { messageId: 'm1', text: 'x'.repeat(20) }
  const pruner = new MessagePruner({ maxTextLength: 8 })

  const result = pruner.prune([original])

  assert.equal(result.changed, true)
  assert.equal(result.messages[0].text.startsWith('xxxxxxxx'), true)
  assert.match(result.messages[0].text, /pruned 12 chars/)
  assert.equal(result.messages[0].metadata.prunedForSummary, true)
  assert.equal(original.text, 'x'.repeat(20))
})

test('message pruner collapses duplicate messages', () => {
  const result = pruneMessagesForSummary([
    { messageId: 'm1', text: 'same text' },
    { messageId: 'm2', text: 'same   text' },
    { messageId: 'm3', text: 'other' },
  ])

  assert.equal(result.changed, true)
  assert.equal(result.prunedCount, 2)
  assert.deepEqual(result.messages.map(message => message.messageId), ['m1', 'm3'])
  assert.match(result.messages[0].text, /duplicate message collapsed: repeated 2 times/)
  assert.equal(result.messages[0].metadata.prunedDuplicateCount, 2)
})

test('message pruner shortens tool-like JSON and attachment placeholders', () => {
  const pruner = new MessagePruner({
    maxTextLength: 200,
    maxToolResultLength: 40,
  })
  const result = pruner.prune([
    {
      messageId: 'tool-1',
      role: 'tool',
      text: JSON.stringify({ result: 'x'.repeat(120), items: [1, 2, 3] }),
    },
    {
      messageId: 'attachment-1',
      text: `see data:image/png;base64,${'a'.repeat(120)}`,
    },
  ])

  assert.match(result.messages[0].text, /pruned 109 chars/)
  assert.match(result.messages[1].text, /summary-pruned: base64 attachment/)
})
