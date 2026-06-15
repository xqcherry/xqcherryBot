import { TokenEstimator } from '../context/tokenEstimator.mjs'
import { createContextBlock } from '../context/contextBlocks.mjs'

const SCOPE_PRIORITY = new Map([
  ['session', 0],
  ['user', 1],
])

export class MemorySelector {
  constructor({
    sessionStore,
    maxMemoryTokens = null,
    tokenEstimator = new TokenEstimator(),
  }) {
    this.sessionStore = sessionStore
    this.maxMemoryTokens = maxMemoryTokens
    this.tokenEstimator = tokenEstimator
  }

  async select({ sessionId, senderId } = {}) {
    if (!this.sessionStore?.listActiveMemories) return []
    const sessionMemories = sessionId
      ? await this.sessionStore.listActiveMemories({
          scope: 'session',
          subjectId: sessionId,
        })
      : []
    const userMemories = senderId
      ? await this.sessionStore.listActiveMemories({
          scope: 'user',
          subjectId: senderId,
        })
      : []
    const memories = [...sessionMemories, ...userMemories].sort(compareMemories)
    return this.#applyBudget(memories)
  }

  async buildBlock(input = {}) {
    const memories = await this.select(input)
    if (memories.length === 0) return null
    return memoryBlock(memories)
  }

  #applyBudget(memories) {
    if (!this.maxMemoryTokens) return memories
    const selected = []
    let totalTokens = 0
    for (const memory of memories) {
      const tokenEstimate = this.tokenEstimator.estimateText(memory.summary ?? '')
      if (selected.length > 0 && totalTokens + tokenEstimate > this.maxMemoryTokens) {
        continue
      }
      if (selected.length === 0 || totalTokens + tokenEstimate <= this.maxMemoryTokens) {
        selected.push(memory)
        totalTokens += tokenEstimate
      }
    }
    return selected
  }
}

export function memoryBlock(memories) {
  return createContextBlock({
    id: 'long-term-memory',
    type: 'memory',
    stability: 'semi-stable',
    role: 'system',
    content: `Active long-term memories:\n${memories
      .map(memory => `- (${memory.scope}:${memory.subjectId}) ${memory.summary}`)
      .join('\n')}`,
    metadata: {
      memoryIds: memories.map(memory => memory.id).filter(Boolean),
    },
  })
}

function compareMemories(left, right) {
  return (
    scopePriority(left.scope) - scopePriority(right.scope) ||
    String(left.subjectId ?? '').localeCompare(String(right.subjectId ?? '')) ||
    String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')) ||
    String(left.id ?? '').localeCompare(String(right.id ?? ''))
  )
}

function scopePriority(scope) {
  return SCOPE_PRIORITY.get(scope) ?? 99
}
