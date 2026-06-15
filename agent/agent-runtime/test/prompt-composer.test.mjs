import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ToolPolicy,
  ToolRegistry,
  ToolSelector,
  TurnProfileBuilder,
} from '../src/index.mjs'

test('turn profile builder identifies QQ chat type tools failures and memory intent', () => {
  const profile = new TurnProfileBuilder().build({
    sessionId: 'qq-group-1',
    senderId: 'u1',
    messageId: 'm1',
    text: '我喜欢以后回答简短一点',
    metadata: { platform: 'qq', chatType: 'group', addressedToAgent: true },
    selectedTools: [{ name: 'propose_memory_candidate' }, { name: 'recent_messages' }],
    latestToolFailure: 'search_chat_history: timeout',
  })

  assert.deepEqual(profile, {
    platform: 'qq',
    chatType: 'group',
    addressedToAgent: true,
    toolCapabilities: ['propose_memory_candidate', 'recent_messages'],
    hasToolFailure: true,
    memoryIntent: true,
    sessionId: 'qq-group-1',
    senderId: 'u1',
    messageId: 'm1',
    text: '我喜欢以后回答简短一点',
  })
})

test('tool registry validates and orders tool entries without composing prompts', () => {
  const call = async () => ({ ok: true })
  const registry = new ToolRegistry([
    { name: 'write_file', description: 'Write a file', inputSchema: {}, call, riskLevel: 'high', priority: 20 },
    { name: 'read_file', description: 'Read a file', inputSchema: {}, call, readOnly: true, priority: 10 },
    { name: 'disabled', description: 'Disabled tool', inputSchema: {}, call, enabled: false },
  ])

  assert.deepEqual(
    registry.list().map(tool => `${tool.priority}:${tool.name}:${tool.riskLevel}:${tool.readOnly}:${tool.requiresPermission}`),
    [
      '10:read_file:low:true:false',
      '20:write_file:high:false:false',
      '100:disabled:low:false:false',
    ],
  )
  assert.deepEqual(registry.listEnabled().map(tool => tool.name), ['read_file', 'write_file'])

  assert.throws(() => new ToolRegistry([{ name: '', description: 'x', inputSchema: {}, call }]), /Tool name/)
  assert.throws(() => new ToolRegistry([{ name: 'x', description: '', inputSchema: {}, call }]), /Tool description/)
  assert.throws(() => new ToolRegistry([{ name: 'x', description: 'x', inputSchema: null, call }]), /inputSchema/)
  assert.throws(() => new ToolRegistry([{ name: 'x', description: 'x', inputSchema: {} }]), /call/)
  assert.throws(() => new ToolRegistry([{ name: 'x', description: 'x', inputSchema: {}, call, riskLevel: 'critical' }]), /riskLevel/)
  assert.throws(
    () => new ToolRegistry([
      { name: 'x', description: 'one', inputSchema: {}, call },
      { name: 'x', description: 'two', inputSchema: {}, call },
    ]),
    /duplicate/i,
  )
})

test('tool selector applies enabled names groups policy and activation rules', () => {
  const call = async () => ({ ok: true })
  const registry = new ToolRegistry([
    { name: 'read_file', description: 'Read a file', inputSchema: {}, call, readOnly: true, group: 'files' },
    { name: 'write_file', description: 'Write a file', inputSchema: {}, call, group: 'files', requiresPermission: true },
    { name: 'qq_send', description: 'Send QQ message', inputSchema: {}, call, group: 'qq', activationRule: input => input.metadata?.platform === 'qq' },
    { name: 'blocked', description: 'Blocked tool', inputSchema: {}, call, group: 'admin' },
  ])
  const selector = new ToolSelector({
    registry,
    enabledToolNames: ['read_file', 'write_file', 'qq_send', 'blocked'],
    groups: ['files', 'qq', 'admin'],
    policy: new ToolPolicy({
      denyToolNames: ['blocked'],
      readOnlyOnly: true,
    }),
  })

  assert.deepEqual(
    selector.select({ metadata: { platform: 'qq' } }).map(tool => tool.name),
    ['read_file'],
  )
})
