export const CONTEXT_BLOCK_STABILITIES = new Set(['stable', 'semi-stable', 'dynamic'])
export const CONTEXT_BLOCK_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

export function createContextBlock(block) {
  validateContextBlock(block)
  return {
    id: block.id,
    type: block.type,
    stability: block.stability,
    role: block.role,
    content: block.content,
    ...(block.metadata ? { metadata: { ...block.metadata } } : {}),
  }
}

export function validateContextBlock(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error('Context block must be an object')
  }
  requireString(block, 'id')
  requireString(block, 'type')
  requireString(block, 'stability')
  requireString(block, 'role')
  requireString(block, 'content')
  if (!CONTEXT_BLOCK_STABILITIES.has(block.stability)) {
    throw new Error(`Context block "${block.id}" has invalid stability: ${block.stability}`)
  }
  if (!CONTEXT_BLOCK_ROLES.has(block.role)) {
    throw new Error(`Context block "${block.id}" has invalid role: ${block.role}`)
  }
  if (
    block.metadata !== undefined &&
    (!block.metadata || typeof block.metadata !== 'object' || Array.isArray(block.metadata))
  ) {
    throw new Error(`Context block "${block.id}" metadata must be an object when provided`)
  }
  return true
}

export function contextBlocksToMessages(blocks) {
  return blocks.map(block => {
    validateContextBlock(block)
    return {
      role: block.role,
      content: block.content,
    }
  })
}

function requireString(block, field) {
  if (typeof block[field] !== 'string' || block[field].length === 0) {
    throw new Error(`Context block ${field} is required`)
  }
}
