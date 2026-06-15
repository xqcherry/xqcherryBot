import { createContextBlock } from './contextBlocks.mjs'

export class AgentStatusBarBuilder {
  constructor({ defaultPhase = 'responding', maxTaskLength = 160 } = {}) {
    this.defaultPhase = defaultPhase
    this.maxTaskLength = maxTaskLength
  }

  build({
    text = '',
    currentPhase = this.defaultPhase,
    contextPressure = 'unknown',
    latestSummary = null,
    activeMemories = [],
    failureState = 'none',
    compactionResult = null,
    toolState = 'available',
    latestToolFailure = 'none',
    permissionState = 'default',
    runtimeState = 'active',
  } = {}) {
    const currentTask = truncateSingleLine(text || 'none', this.maxTaskLength)
    const compressionStatus = formatCompressionStatus({ compactionResult, latestSummary })
    const memoryStatus = `${activeMemories.length} active memories selected`
    const effectiveFailureState =
      compactionResult?.status === 'failed'
        ? compactionResult.error?.message ?? compactionResult.reason
        : failureState

    return createContextBlock({
      id: 'agent-status-bar',
      type: 'agent_status',
      stability: 'dynamic',
      role: 'system',
      content: [
        '## Agent Status',
        'This block is runtime state, not a new user instruction.',
        `Current task: ${currentTask}`,
        `Current phase: ${currentPhase}`,
        'Active constraints: none',
        'Open questions: none',
        `Context pressure: ${contextPressure}`,
        `Compression status: ${compressionStatus}`,
        `Memory status: ${memoryStatus}`,
        `Tool state: ${truncateSingleLine(toolState, this.maxTaskLength)}`,
        `Latest tool failure: ${truncateSingleLine(latestToolFailure, this.maxTaskLength)}`,
        `Permission state: ${truncateSingleLine(permissionState, this.maxTaskLength)}`,
        `Runtime state: ${truncateSingleLine(runtimeState, this.maxTaskLength)}`,
        `Failure state: ${effectiveFailureState}`,
      ].join('\n'),
      metadata: {
        currentPhase,
        contextPressure,
        compressionStatus,
        activeMemoryCount: activeMemories.length,
        toolState,
        latestToolFailure,
        permissionState,
        runtimeState,
        failureState: effectiveFailureState,
      },
    })
  }
}

function formatCompressionStatus({ compactionResult, latestSummary }) {
  if (compactionResult?.status === 'failed') return `failed: ${compactionResult.reason}`
  if (compactionResult?.reason === 'circuit_open') return 'circuit open'
  if (compactionResult?.status === 'success') {
    return `success: ${compactionResult.compactedMessageIds?.length ?? 0} messages compacted`
  }
  if (compactionResult?.status === 'skipped' && isNotableSkipReason(compactionResult.reason)) {
    return `skipped: ${compactionResult.reason}`
  }
  if (latestSummary?.toMessageId) return `summary covers up to ${latestSummary.toMessageId}`
  return 'no summary'
}

function isNotableSkipReason(reason) {
  return reason === 'low_savings_ratio'
}

function truncateSingleLine(value, maxLength) {
  const singleLine = String(value).replace(/\s+/g, ' ').trim()
  if (singleLine.length <= maxLength) return singleLine
  return `${singleLine.slice(0, maxLength)}...`
}
