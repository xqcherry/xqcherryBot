import { TokenEstimator } from './tokenEstimator.mjs'
import { SummaryValidator } from './summaryValidator.mjs'
import { MessagePruner } from './messagePruner.mjs'
import { SummaryQualityChecker } from './summaryQualityChecker.mjs'

export class CompactionPolicy {
  constructor({
    recentMessageLimit = 20,
    uncompactedMessageLimit = 80,
    tokenEstimator = null,
    contextWindowTokens = null,
    thresholdRatio = 0.55,
    safetyRatio = 0.85,
    reservedOutputTokens = 0,
    recentTailTokenBudget = null,
  } = {}) {
    this.recentMessageLimit = recentMessageLimit
    this.uncompactedMessageLimit = uncompactedMessageLimit
    this.tokenEstimator = tokenEstimator
    this.contextWindowTokens = contextWindowTokens
    this.thresholdRatio = thresholdRatio
    this.safetyRatio = safetyRatio
    this.reservedOutputTokens = reservedOutputTokens
    this.recentTailTokenBudget = recentTailTokenBudget
  }

  plan({ messages, latestSummary = null, currentMessageId = null }) {
    if (this.contextWindowTokens) {
      return this.#tokenAwarePlan({ messages, latestSummary, currentMessageId })
    }

    if (messages.length <= this.uncompactedMessageLimit) {
      return { shouldCompact: false, reason: 'below_message_threshold', compactable: [] }
    }

    const compactable = this.#selectCompactable({ messages, latestSummary, currentMessageId })
    if (compactable.length === 0) {
      return { shouldCompact: false, reason: 'no_uncovered_compactable_messages', compactable }
    }

    return {
      shouldCompact: true,
      reason: 'message_threshold_exceeded',
      compactable,
    }
  }

  #tokenAwarePlan({ messages, latestSummary, currentMessageId }) {
    const estimator = this.tokenEstimator ?? new TokenEstimator()
    const rawTokenEstimate = estimator.estimateMessages(messages)
    const tokenEstimate = rawTokenEstimate + this.reservedOutputTokens
    const tokenThreshold = this.#effectiveTokenLimit(this.thresholdRatio)
    const safetyTokenThreshold = this.#effectiveTokenLimit(this.safetyRatio)
    const isSafetyExceeded = tokenEstimate > safetyTokenThreshold
    if (tokenEstimate <= tokenThreshold) {
      return {
        shouldCompact: false,
        reason: 'below_token_threshold',
        compactable: [],
        rawTokenEstimate,
        tokenEstimate,
        tokenThreshold,
        safetyTokenThreshold,
        reservedOutputTokens: this.reservedOutputTokens,
      }
    }

    const compactable = this.#selectCompactable({ messages, latestSummary, currentMessageId })
    if (compactable.length === 0) {
      return {
        shouldCompact: false,
        reason: 'no_uncovered_compactable_messages',
        compactable,
        rawTokenEstimate,
        tokenEstimate,
        tokenThreshold,
        safetyTokenThreshold,
        reservedOutputTokens: this.reservedOutputTokens,
        isSafetyExceeded,
      }
    }

    return {
      shouldCompact: true,
      reason: isSafetyExceeded ? 'token_safety_threshold_exceeded' : 'token_threshold_exceeded',
      compactable,
      rawTokenEstimate,
      tokenEstimate,
      tokenThreshold,
      safetyTokenThreshold,
      reservedOutputTokens: this.reservedOutputTokens,
      isSafetyExceeded,
    }
  }

  estimatePostCompactionTokens({
    messages,
    compactable,
    summary,
    currentMessageId = null,
  } = {}) {
    const estimator = this.tokenEstimator ?? new TokenEstimator()
    const compactableIds = new Set(compactable.map(message => message.messageId))
    let protectedMessages = messages.filter(message => !compactableIds.has(message.messageId))
    if (currentMessageId) {
      const current = messages.find(message => message.messageId === currentMessageId)
      protectedMessages = protectedMessages.filter(message => message.messageId !== currentMessageId)
      if (current) protectedMessages.push(current)
    }
    return (
      estimator.estimateText(summary) +
      estimator.estimateMessages(protectedMessages) +
      this.reservedOutputTokens
    )
  }

  #selectCompactable({ messages, latestSummary, currentMessageId }) {
    const firstUncoveredIndex = latestSummary?.toMessageId
      ? messages.findIndex(message => message.messageId === latestSummary.toMessageId) + 1
      : 0
    const safeFirstUncoveredIndex = Math.max(0, firstUncoveredIndex)
    if (this.recentTailTokenBudget) {
      const protectedTailIds = this.#selectProtectedTailIds({
        messages: messages.slice(safeFirstUncoveredIndex),
        currentMessageId,
      })
      return messages
        .slice(safeFirstUncoveredIndex)
        .filter(message => !protectedTailIds.has(message.messageId))
        .filter(message => !currentMessageId || message.messageId !== currentMessageId)
    }

    const compactUntil = Math.max(
      safeFirstUncoveredIndex,
      messages.length - this.recentMessageLimit,
    )
    return messages
      .slice(safeFirstUncoveredIndex, compactUntil)
      .filter(message => !currentMessageId || message.messageId !== currentMessageId)
  }

  #selectProtectedTailIds({ messages, currentMessageId }) {
    const estimator = this.tokenEstimator ?? new TokenEstimator()
    const protectedIds = new Set()
    let tokenTotal = 0
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (currentMessageId && message.messageId === currentMessageId) continue
      const tokenEstimate = estimator.estimateMessage(message)
      if (protectedIds.size > 0 && tokenTotal + tokenEstimate > this.recentTailTokenBudget) {
        break
      }
      protectedIds.add(message.messageId)
      tokenTotal += tokenEstimate
      if (tokenTotal >= this.recentTailTokenBudget) break
    }
    return protectedIds
  }

  #effectiveTokenLimit(ratioValue) {
    const reservedCapacity = Math.max(0, this.contextWindowTokens - this.reservedOutputTokens)
    return Math.floor(reservedCapacity * ratioValue) + this.reservedOutputTokens
  }
}

export class ContextCompactionEngine {
  constructor({
    sessionStore,
    policy = new CompactionPolicy(),
    summarizer = defaultSummarizer,
    now = () => new Date().toISOString(),
    provider = null,
    model = null,
    promptVersion = 'legacy-summary-v1',
    format = 'markdown',
    tokenEstimator = null,
    maxFailures = 3,
    summaryValidator = new SummaryValidator(),
    minSavingsRatio = null,
    onDiagnostic = null,
    messagePruner = new MessagePruner(),
    summaryQualityChecker = null,
  }) {
    this.sessionStore = sessionStore
    this.policy = policy
    this.summarizer = summarizer
    this.now = now
    this.provider = provider
    this.model = model
    this.promptVersion = promptVersion
    this.format = format
    this.tokenEstimator = tokenEstimator ?? policy.tokenEstimator ?? new TokenEstimator()
    this.maxFailures = maxFailures
    this.sessionStatus = new Map()
    this.summaryValidator = summaryValidator
    this.minSavingsRatio = minSavingsRatio
    this.onDiagnostic = onDiagnostic
    this.messagePruner = messagePruner
    this.summaryQualityChecker = summaryQualityChecker
  }

  async compact(sessionId, { currentMessageId = null } = {}) {
    const currentStatus = this.getStatus(sessionId)
    if (currentStatus.status === 'circuit_open') {
      return { status: 'skipped', reason: 'circuit_open' }
    }

    const messages = await this.sessionStore.getPlatformMessages(sessionId)
    const session = await this.sessionStore.getOrCreateSession(sessionId)
    const latestSummary = session.conversationSummaries.at(-1)
    const plan = this.policy.plan({ messages, latestSummary, currentMessageId })
    if (!plan.shouldCompact) {
      const result = {
        status: 'skipped',
        reason: plan.reason,
        inputTokenEstimate: plan.tokenEstimate ?? null,
      }
      this.#setStatus(sessionId, result)
      return result
    }

    try {
      const pruning = this.messagePruner?.prune(plan.compactable) ?? {
        messages: plan.compactable,
        changed: false,
        originalCount: plan.compactable.length,
        prunedCount: plan.compactable.length,
      }
      const compactableForSummary = pruning.messages
      const prunedInputTokenEstimate = pruning.changed
        ? this.tokenEstimator.estimateMessages(compactableForSummary)
        : null
      const summary = await this.summarizer(compactableForSummary, latestSummary)
      const validation = this.summaryValidator?.validate(summary) ?? { ok: true }
      if (!validation.ok) {
        throw new SummaryValidationError(validation.reason)
      }
      const quality = this.summaryQualityChecker?.check({
        summary,
        messages: compactableForSummary,
        previousSummary: latestSummary,
      }) ?? { ok: true }
      if (!quality.ok) {
        throw new SummaryQualityError(quality.reason)
      }
      const inputTokenEstimate =
        plan.tokenEstimate ?? this.tokenEstimator.estimateMessages(plan.compactable)
      const outputTokenEstimate = this.tokenEstimator.estimateText(summary)
      const postCompactionTokenEstimate =
        typeof this.policy.estimatePostCompactionTokens === 'function'
          ? this.policy.estimatePostCompactionTokens({
              messages,
              compactable: plan.compactable,
              summary,
              currentMessageId,
            })
          : null
      const compressionRatio = ratio(outputTokenEstimate, inputTokenEstimate)
      const savingsRatio = Number((1 - compressionRatio).toFixed(4))
      const range = {
        fromMessageId: plan.compactable[0].messageId,
        toMessageId: plan.compactable.at(-1).messageId,
      }
      if (this.minSavingsRatio !== null && savingsRatio < this.minSavingsRatio) {
        const result = {
          status: 'skipped',
          reason: 'low_savings_ratio',
          inputTokenEstimate,
          outputTokenEstimate,
          postCompactionTokenEstimate,
          prunedInputTokenEstimate,
          compressionRatio,
          savingsRatio,
          ...range,
          provider: this.provider,
          model: this.model,
        }
        this.#setStatus(sessionId, result)
        return result
      }
      const summaryRecord = {
        version: 2,
        promptVersion: this.promptVersion,
        format: this.format,
        summary,
        ...range,
        messageCount: plan.compactable.length,
        inputTokenEstimate,
        outputTokenEstimate,
        postCompactionTokenEstimate,
        prunedInputTokenEstimate,
        compressionRatio,
        provider: this.provider,
        model: this.model,
        status: 'success',
        pruning: pruning.changed
          ? {
              originalCount: pruning.originalCount,
              prunedCount: pruning.prunedCount,
              prunedInputTokenEstimate,
            }
          : null,
        createdAt: this.now(),
      }
      await this.sessionStore.appendConversationSummary(sessionId, summaryRecord)
      const result = {
        status: 'success',
        reason: plan.reason,
        compactedMessageIds: plan.compactable.map(message => message.messageId),
        summary: summaryRecord,
      }
      this.#setStatus(sessionId, result)
      return result
    } catch (error) {
      const previous = this.getStatus(sessionId)
      const failureCount = previous.failureCount + 1
      const reason =
        error instanceof SummaryValidationError
          ? 'summary_validation_failed'
          : error instanceof SummaryQualityError
            ? 'summary_quality_failed'
          : 'summarizer_failed'
      const result = {
        status: 'failed',
        reason,
        error,
        failureCount,
        inputTokenEstimate: plan.tokenEstimate ?? this.tokenEstimator.estimateMessages(plan.compactable),
        fromMessageId: plan.compactable[0]?.messageId ?? null,
        toMessageId: plan.compactable.at(-1)?.messageId ?? null,
        provider: this.provider,
        model: this.model,
      }
      this.#setStatus(sessionId, result)
      if (failureCount >= this.maxFailures) {
        this.sessionStatus.set(sessionId, {
          status: 'circuit_open',
          reason: 'circuit_open',
          failureCount,
          lastError: error.message,
          inputTokenEstimate: result.inputTokenEstimate,
        outputTokenEstimate: null,
        postCompactionTokenEstimate: null,
        prunedInputTokenEstimate: null,
        compressionRatio: null,
          fromMessageId: result.fromMessageId,
          toMessageId: result.toMessageId,
          provider: this.provider,
          model: this.model,
          updatedAt: this.now(),
        })
        this.#emitDiagnostic(sessionId, this.getStatus(sessionId))
      }
      return result
    }
  }

  getStatus(sessionId) {
    return this.sessionStatus.get(sessionId) ?? {
      status: 'idle',
      reason: null,
      failureCount: 0,
      lastError: null,
      inputTokenEstimate: null,
      outputTokenEstimate: null,
      postCompactionTokenEstimate: null,
      prunedInputTokenEstimate: null,
      compressionRatio: null,
      fromMessageId: null,
      toMessageId: null,
      provider: this.provider,
      model: this.model,
      updatedAt: null,
    }
  }

  #setStatus(sessionId, result) {
    const updatedAt = this.now()
    let status
    if (result.status === 'success') {
      status = {
        status: 'success',
        reason: result.reason ?? null,
        failureCount: 0,
        lastError: null,
        inputTokenEstimate: result.summary?.inputTokenEstimate ?? result.inputTokenEstimate ?? null,
        outputTokenEstimate: result.summary?.outputTokenEstimate ?? result.outputTokenEstimate ?? null,
        postCompactionTokenEstimate:
          result.summary?.postCompactionTokenEstimate ?? result.postCompactionTokenEstimate ?? null,
        prunedInputTokenEstimate:
          result.summary?.pruning?.prunedInputTokenEstimate ?? result.prunedInputTokenEstimate ?? null,
        compressionRatio: result.summary?.compressionRatio ?? result.compressionRatio ?? null,
        fromMessageId: result.summary?.fromMessageId ?? result.fromMessageId ?? null,
        toMessageId: result.summary?.toMessageId ?? result.toMessageId ?? null,
        provider: result.summary?.provider ?? result.provider ?? this.provider,
        model: result.summary?.model ?? result.model ?? this.model,
        updatedAt: result.summary?.createdAt ?? updatedAt,
      }
      this.sessionStatus.set(sessionId, status)
      this.#emitDiagnostic(sessionId, status)
      return
    }
    if (result.status === 'failed') {
      status = {
        status: 'failed',
        reason: result.reason ?? null,
        failureCount: result.failureCount,
        lastError: result.error?.message ?? String(result.error ?? 'unknown error'),
        inputTokenEstimate: result.inputTokenEstimate ?? null,
        outputTokenEstimate: result.outputTokenEstimate ?? null,
        postCompactionTokenEstimate: result.postCompactionTokenEstimate ?? null,
        prunedInputTokenEstimate: result.prunedInputTokenEstimate ?? null,
        compressionRatio: result.compressionRatio ?? null,
        fromMessageId: result.fromMessageId ?? null,
        toMessageId: result.toMessageId ?? null,
        provider: result.provider ?? this.provider,
        model: result.model ?? this.model,
        updatedAt,
      }
      this.sessionStatus.set(sessionId, status)
      this.#emitDiagnostic(sessionId, status)
      return
    }
    status = {
      status: 'skipped',
      reason: result.reason,
      failureCount: 0,
      lastError: null,
      inputTokenEstimate: result.inputTokenEstimate ?? null,
      outputTokenEstimate: result.outputTokenEstimate ?? null,
      postCompactionTokenEstimate: result.postCompactionTokenEstimate ?? null,
      prunedInputTokenEstimate: result.prunedInputTokenEstimate ?? null,
      compressionRatio: result.compressionRatio ?? null,
      fromMessageId: result.fromMessageId ?? null,
      toMessageId: result.toMessageId ?? null,
      provider: result.provider ?? this.provider,
      model: result.model ?? this.model,
      updatedAt,
    }
    this.sessionStatus.set(sessionId, status)
    this.#emitDiagnostic(sessionId, status)
  }

  #emitDiagnostic(sessionId, status) {
    if (!this.onDiagnostic) return
    this.onDiagnostic({
      type: 'compaction_diagnostic',
      sessionId,
      status: { ...status },
    })
  }
}

class SummaryValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SummaryValidationError'
  }
}

class SummaryQualityError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SummaryQualityError'
  }
}

function ratio(outputTokenEstimate, inputTokenEstimate) {
  if (!inputTokenEstimate) return 0
  return Number((outputTokenEstimate / inputTokenEstimate).toFixed(4))
}

async function defaultSummarizer(messages, previousSummary) {
  const previous = previousSummary?.summary
    ? `Previous summary:\n${previousSummary.summary}\n\n`
    : ''
  return `${previous}Compacted chat messages:\n${formatMessages(messages)}`
}

function formatMessages(messages) {
  return messages
    .map(message => {
      const sender = message.senderId ?? 'unknown'
      const timestamp = message.timestamp ? `[${message.timestamp}] ` : ''
      return `${timestamp}${sender}: ${message.text ?? ''}`
    })
    .join('\n')
}
